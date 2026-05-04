// Grounded snippets: after the web_search RRF ranker picks the top-N results,
// fetch each URL through the existing fetch waterfall (concurrency-capped to
// avoid hammering providers) and use Groq (openai/gpt-oss-20b) to write a
// snippet summarizing what the page says (in the context of the query).
//
// Conceptual model (intentionally narrow):
//   - The search engines have already decided these pages are relevant.
//   - Our reranker picked the best subset.
//   - Groq's job is just to SUMMARIZE WHAT THE PAGE CONTAINS, framed by the
//     query topic. It is NOT Groq's job to decide whether the page actually
//     addresses the query — even an off-topic page should get a summary
//     describing what it IS about. The user (or upstream LLM) decides
//     relevance from the snippet.
//   - Therefore: the only legitimate reason to RETRY a fetch is a fetch-side
//     pipeline error (paywall surfaced as the body, login wall, cookie wall,
//     JavaScript-required shell, etc.) — anything where the bytes returned
//     are not the page's real content. We detect those PRE-Groq via pattern
//     matching and retry with skip_providers={winner_of_attempt_1}. We do
//     NOT retry based on Groq's output.
//
// Robustness model:
//   1. Bounded worker pool (default concurrency=3). Providers see at most N
//      simultaneous calls — the waterfall has room to do its within-URL
//      failover (Tavily fails → Firecrawl tries → ...).
//   2. Per-URL hard deadline (default 15s) — no single bad URL stalls a worker.
//   3. Junk-content detection (paywall / login-wall / etc.) BEFORE Groq.
//      Triggers a single retry with skip_providers. No retry when fetch_race
//      throws (waterfall already exhausted) and no retry on Groq's verdict.
//   4. Failure classification (8 outcomes) — every path produces exactly one.
//   5. Structured logging at every phase boundary with timestamps, durations,
//      provider attribution. Plus a single grounding_aggregate line for
//      monitoring.

import { http_json } from '../common/http.js';
import { make_signal } from '../common/utils.js';
import { loggers } from '../common/logger.js';
import { config } from '../config/env.js';
import { get_active_trace } from '../common/r2_trace.js';
import type { RankedWebResult, SnippetSource } from '../common/rrf_ranking.js';
import type { UnifiedFetchProvider } from '../providers/unified/fetch.js';
import { run_fetch_race, type FetchRaceResult } from './fetch_orchestrator.js';
import {
	GROUNDED_SNIPPET_MAX_CHARS,
	GROUNDED_SYSTEM_PROMPT,
	build_grounded_user_message,
	detect_grounded_junk,
	detect_grounded_sentinel,
} from './grounded_prompts.js';

const logger = loggers.search();

// ── Types ────────────────────────────────────────────────────────────────────

export type GroundingOutcome =
	| 'grounded'
	| 'grounded_via_retry'
	| 'fallback:fetch_exhausted'
	| 'fallback:fetch_too_short'
	| 'fallback:fetch_junk_after_retry'
	| 'fallback:groq_sentinel'
	| 'fallback:groq_error'
	| 'fallback:groq_empty'
	| 'fallback:pipeline_timeout';

interface PipelineOutcome {
	outcome: GroundingOutcome;
	attempts: 0 | 1 | 2;
	duration_ms: number;
	fetch_provider_used?: string;
	fetch_providers_attempted?: string[];
	fetch_providers_failed_count?: number;
	content_length?: number;
	snippet_length?: number;
	error?: string;
}

interface PipelineResult {
	result: RankedWebResult;
	outcome: PipelineOutcome;
}

interface GroqChatResponse {
	id?: string;
	model?: string;
	choices?: Array<{
		message?: { role?: string; content?: string };
		finish_reason?: string;
	}>;
	usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const safe_hostname = (url: string): string => {
	try { return new URL(url).hostname; } catch { return 'unknown'; }
};

const truncate_url = (url: string, max = 200): string =>
	url.length <= max ? url : url.slice(0, max);

const error_message = (err: unknown): string =>
	err instanceof Error ? err.message : String(err);

// Bounded worker pool. At most `concurrency` workers run concurrently; each
// pulls the next item from the shared cursor when free. Returns
// PromiseSettledResult-style array preserving input order. Workers never throw
// — exceptions are captured per-item.
const run_with_concurrency = async <T, R>(
	items: T[],
	concurrency: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> => {
	if (items.length === 0) return [];
	const results: Array<PromiseSettledResult<R>> = new Array(items.length);
	let cursor = 0;
	const work = async (): Promise<void> => {
		while (true) {
			const i = cursor++;
			if (i >= items.length) return;
			try {
				results[i] = { status: 'fulfilled', value: await worker(items[i], i) };
			} catch (reason) {
				results[i] = { status: 'rejected', reason };
			}
		}
	};
	const worker_count = Math.min(concurrency, items.length);
	await Promise.all(Array.from({ length: worker_count }, () => work()));
	return results;
};

// Deadline wrapper. If the inner promise doesn't settle within deadline_ms,
// resolve with on_timeout()'s value. on_timeout() is responsible for any
// cancellation it wants — typically firing an AbortController whose signal
// was threaded into the inner promise's work (see fetch_then_ground).
// Without that abort, the inner promise's pending awaits keep running and
// can outlive the worker that resumes pulling from the queue, scaling with
// the number of timing-out items rather than the concurrency cap.
const with_deadline = async <T>(
	promise: Promise<T>,
	deadline_ms: number,
	on_timeout: () => T,
): Promise<T> => {
	let timer_id: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((resolve) => {
				timer_id = setTimeout(() => resolve(on_timeout()), deadline_ms);
			}),
		]);
	} finally {
		if (timer_id !== undefined) clearTimeout(timer_id);
	}
};

const percentile = (sorted_asc: number[], p: number): number => {
	if (sorted_asc.length === 0) return 0;
	const idx = Math.min(sorted_asc.length - 1, Math.floor(sorted_asc.length * p));
	return sorted_asc[idx];
};

// ── Groq client ──────────────────────────────────────────────────────────────

interface GroqExtractResult {
	snippet: string;
	finish_reason: string;
	prompt_tokens: number;
	completion_tokens: number;
}

// If the snippet ends with an unbalanced ``` fence (because the SDK truncation
// or natural model stop landed mid-block), append a closing fence so downstream
// markdown renderers don't bleed the rest of the response into a code block.
//
// Only counts LINE-START triple-backticks (with up to 3 spaces of indent per
// CommonMark) — inline literal ``` inside prose or inside a fenced code block
// (e.g., a markdown tutorial showing how to write fences) is correctly ignored.
// R6 cleanup: prior version counted all ``` occurrences and produced spurious
// closing fences on tutorial-style snippets that taught fence syntax.
const FENCE_LINE_START_RE = /^[ ]{0,3}```/gm;
const close_unbalanced_fence = (snippet: string): string => {
	const fence_count = (snippet.match(FENCE_LINE_START_RE) ?? []).length;
	if (fence_count % 2 === 0) return snippet;
	const trimmed = snippet.trimEnd();
	const newline = trimmed.endsWith('\n') ? '' : '\n';
	return `${trimmed}${newline}\`\`\``;
};

const extract_grounded_snippet = async (
	provider_name: string,
	query: string,
	title: string,
	content: string,
	signal: AbortSignal | undefined,
): Promise<GroqExtractResult> => {
	const cfg = config.snippet_grounding.groq;
	const response = await http_json<GroqChatResponse>(
		provider_name,
		`${cfg.base_url}/chat/completions`,
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${cfg.api_key ?? ''}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				model: cfg.model,
				messages: [
					{ role: 'system', content: GROUNDED_SYSTEM_PROMPT },
					{ role: 'user', content: build_grounded_user_message(query, title, content, cfg.max_content_chars) },
				],
				// Low temp for factual fidelity (verbatim code / citations). top_p + frequency_penalty
				// guard against degenerate-sampling repetition loops ("hhgghghvgegggg"-style mash)
				// observed on smaller open-weight models under heavy long-context prompts.
				// max_tokens intentionally omitted — the prompt's length guidance handles
				// bounding output naturally; SDK-side GROUNDED_SNIPPET_MAX_CHARS truncation
				// is a hard safety net only. The mid-fence trail-off seen in V2.2 (vCluster
				// sample) is addressed by close_unbalanced_fence post-process below.
				temperature: 0.2,
				top_p: 0.9,
				frequency_penalty: 0.3,
			}),
			signal: make_signal(cfg.timeout, signal),
		},
	);
	const choice = response.choices?.[0];
	const raw = choice?.message?.content?.trim() ?? '';
	const truncated = raw.length > GROUNDED_SNIPPET_MAX_CHARS ? raw.slice(0, GROUNDED_SNIPPET_MAX_CHARS) : raw;
	const snippet = close_unbalanced_fence(truncated);
	return {
		snippet,
		finish_reason: choice?.finish_reason ?? 'unknown',
		prompt_tokens: response.usage?.prompt_tokens ?? 0,
		completion_tokens: response.usage?.completion_tokens ?? 0,
	};
};

// ── Per-URL pipeline ─────────────────────────────────────────────────────────

interface PipelineCtx {
	pipeline_index: number;
	url_short: string;
	host: string;
}

const log_phase = (
	ctx: PipelineCtx,
	phase: string,
	pipeline_t0: number,
	step_t0: number,
	extras: Record<string, unknown> = {},
): void => {
	logger.info('Grounding phase', {
		op: 'grounding_phase',
		ts: new Date().toISOString(),
		pipeline_index: ctx.pipeline_index,
		url: ctx.url_short,
		host: ctx.host,
		phase,
		elapsed_ms: Date.now() - pipeline_t0,
		step_ms: Date.now() - step_t0,
		...extras,
	});
};

interface PipelineRunResult {
	outcome: GroundingOutcome;
	attempts: 0 | 1 | 2;
	winning_fetch?: FetchRaceResult;
	winning_snippet?: string;
	last_error?: string;
}

// Run a single fetch + Groq pair. Used by both attempt 1 and the retry path.
// Returns either a winning snippet or a structured failure indicator.
interface FetchAndGroundResult {
	kind: 'success' | 'fetch_throw' | 'fetch_too_short' | 'fetch_junk' | 'groq_error' | 'groq_empty' | 'groq_sentinel';
	fetch_result?: FetchRaceResult;
	snippet?: string;
	error?: string;
	junk_reason?: string;
	sentinel?: string;
}

const fetch_and_ground = async (
	ctx: PipelineCtx,
	pipeline_t0: number,
	query: string,
	url: string,
	fetch_provider: UnifiedFetchProvider,
	signal: AbortSignal | undefined,
	attempt: 1 | 2,
	skip_providers?: string[],
): Promise<FetchAndGroundResult> => {
	const cfg = config.snippet_grounding.groq;
	const fetch_phase = `fetch_attempt_${attempt}`;
	const groq_phase = `groq_attempt_${attempt}`;
	const trace_provider_key = attempt === 1
		? `groq_grounding_${ctx.pipeline_index}`
		: `groq_grounding_${ctx.pipeline_index}_retry`;

	// Fetch
	const fetch_t0 = Date.now();
	let fetch_result: FetchRaceResult;
	try {
		fetch_result = await run_fetch_race(
			fetch_provider,
			url,
			skip_providers && skip_providers.length > 0 ? { skip_providers } : undefined,
		);
		log_phase(ctx, fetch_phase, pipeline_t0, fetch_t0, {
			attempt,
			skip_providers: skip_providers ?? [],
			provider_used: fetch_result.provider_used,
			providers_attempted: fetch_result.providers_attempted,
			providers_failed_count: fetch_result.providers_failed.length,
			content_length: fetch_result.result.content.length,
		});
	} catch (err) {
		const msg = error_message(err);
		log_phase(ctx, fetch_phase, pipeline_t0, fetch_t0, {
			attempt,
			skip_providers: skip_providers ?? [],
			error: msg,
		});
		return { kind: 'fetch_throw', error: msg };
	}

	// Length guard
	if (fetch_result.result.content.length < cfg.fetch_min_content_chars) {
		log_phase(ctx, `${fetch_phase}_filter`, pipeline_t0, fetch_t0, {
			attempt,
			content_length: fetch_result.result.content.length,
			reason: 'too_short',
		});
		return { kind: 'fetch_too_short', fetch_result };
	}

	// Junk content guard (paywall/login-wall/etc.) — pre-Groq detection.
	// On attempt 1, this triggers a retry with skip_providers={winner}. On
	// attempt 2, it surfaces as fallback:fetch_junk_after_retry.
	const junk_reason = detect_grounded_junk(fetch_result.result.content);
	if (junk_reason) {
		log_phase(ctx, `${fetch_phase}_filter`, pipeline_t0, fetch_t0, {
			attempt,
			content_length: fetch_result.result.content.length,
			reason: 'junk',
			junk_reason,
		});
		return { kind: 'fetch_junk', fetch_result, junk_reason };
	}

	// Groq
	const groq_t0 = Date.now();
	try {
		const groq_out = await extract_grounded_snippet(
			trace_provider_key,
			query,
			fetch_result.result.title,
			fetch_result.result.content,
			signal,
		);
		log_phase(ctx, groq_phase, pipeline_t0, groq_t0, {
			attempt,
			snippet_length: groq_out.snippet.length,
			finish_reason: groq_out.finish_reason,
			prompt_tokens: groq_out.prompt_tokens,
			completion_tokens: groq_out.completion_tokens,
		});
		if (groq_out.snippet.length < cfg.groq_min_snippet_chars) {
			return { kind: 'groq_empty', fetch_result, snippet: groq_out.snippet };
		}
		// Sentinel detection: model signals "this page genuinely has no usable
		// content for the query" via one of the bracketed strings in the system
		// prompt. We map back to the original aggregated snippet (fallback) so
		// users don't see "[no usable content]" in the response. Treated like
		// fetch_junk for retry purposes — a different fetcher might rescue.
		const sentinel = detect_grounded_sentinel(groq_out.snippet);
		if (sentinel) {
			log_phase(ctx, `${groq_phase}_sentinel`, pipeline_t0, groq_t0, {
				attempt,
				sentinel,
			});
			return { kind: 'groq_sentinel', fetch_result, snippet: groq_out.snippet, sentinel };
		}
		return { kind: 'success', fetch_result, snippet: groq_out.snippet };
	} catch (err) {
		const msg = error_message(err);
		log_phase(ctx, groq_phase, pipeline_t0, groq_t0, {
			attempt,
			error: msg,
		});
		return { kind: 'groq_error', fetch_result, error: msg };
	}
};

const run_pipeline = async (
	ctx: PipelineCtx,
	pipeline_t0: number,
	query: string,
	url: string,
	fetch_provider: UnifiedFetchProvider,
	signal: AbortSignal | undefined,
): Promise<PipelineRunResult> => {
	const cfg = config.snippet_grounding.groq;

	// Attempt 1: fetch + ground. Retry only on fetch_throw (waterfall pointlessly
	// already exhausted, no retry there) is NOT triggered — instead we retry on
	// fetch_junk (pipeline error: paywall, login wall, etc.).
	const a1 = await fetch_and_ground(ctx, pipeline_t0, query, url, fetch_provider, signal, 1);

	if (a1.kind === 'success' && a1.snippet && a1.fetch_result) {
		return { outcome: 'grounded', attempts: 1, winning_fetch: a1.fetch_result, winning_snippet: a1.snippet };
	}
	if (a1.kind === 'fetch_throw') {
		return { outcome: 'fallback:fetch_exhausted', attempts: 1, last_error: a1.error };
	}
	if (a1.kind === 'fetch_too_short') {
		return { outcome: 'fallback:fetch_too_short', attempts: 1, winning_fetch: a1.fetch_result };
	}
	if (a1.kind === 'groq_error') {
		return { outcome: 'fallback:groq_error', attempts: 1, winning_fetch: a1.fetch_result, last_error: a1.error };
	}
	if (a1.kind === 'groq_empty') {
		return { outcome: 'fallback:groq_empty', attempts: 1, winning_fetch: a1.fetch_result };
	}

	// a1.kind === 'fetch_junk' OR 'groq_sentinel' — both signal "the page returned
	// content but it isn't real page content for this query" (paywall fragment,
	// login shell, 404 body, nav-only homepage, etc.). Both warrant retry with a
	// different fetcher; that path is unified.
	if (!cfg.retry_on_groq_empty) {
		// Tunable kept for back-compat — false disables the retry path entirely.
		const a1_outcome: GroundingOutcome = a1.kind === 'groq_sentinel'
			? 'fallback:groq_sentinel'
			: 'fallback:fetch_junk_after_retry';
		return { outcome: a1_outcome, attempts: 1, winning_fetch: a1.fetch_result };
	}
	const skip = a1.fetch_result?.provider_used ? [a1.fetch_result.provider_used] : [];
	const a2 = await fetch_and_ground(ctx, pipeline_t0, query, url, fetch_provider, signal, 2, skip);

	if (a2.kind === 'success' && a2.snippet && a2.fetch_result) {
		return { outcome: 'grounded_via_retry', attempts: 2, winning_fetch: a2.fetch_result, winning_snippet: a2.snippet };
	}
	if (a2.kind === 'fetch_throw') {
		return { outcome: 'fallback:fetch_exhausted', attempts: 2, last_error: a2.error };
	}
	if (a2.kind === 'fetch_too_short' || a2.kind === 'fetch_junk') {
		return { outcome: 'fallback:fetch_junk_after_retry', attempts: 2, winning_fetch: a2.fetch_result };
	}
	if (a2.kind === 'groq_sentinel') {
		// Both fetchers' content prompted the model to declare no usable content.
		// Likely the page genuinely has nothing for this query (404, nav, SERP).
		return { outcome: 'fallback:groq_sentinel', attempts: 2, winning_fetch: a2.fetch_result };
	}
	if (a2.kind === 'groq_error') {
		return { outcome: 'fallback:groq_error', attempts: 2, winning_fetch: a2.fetch_result, last_error: a2.error };
	}
	return { outcome: 'fallback:groq_empty', attempts: 2, winning_fetch: a2.fetch_result };
};

const fetch_then_ground = async (
	query: string,
	result: RankedWebResult,
	fetch_provider: UnifiedFetchProvider,
	signal: AbortSignal | undefined,
	index: number,
): Promise<PipelineResult> => {
	const cfg = config.snippet_grounding.groq;
	const pipeline_t0 = Date.now();
	const ctx: PipelineCtx = {
		pipeline_index: index,
		url_short: truncate_url(result.url),
		host: safe_hostname(result.url),
	};
	const trace = get_active_trace();
	const trace_provider_key = `groq_grounding_${index}`;
	trace?.record_provider_start(trace_provider_key, { url: result.url, host: ctx.host });

	log_phase(ctx, 'pipeline_start', pipeline_t0, pipeline_t0);

	// Per-URL deadline aborts the inner pipeline (Groq half) when fired. R1 H2
	// (round-2 confirmed 9/9 consensus): the prior implementation resolved the
	// outer promise on timeout but left the inner fetch + Groq calls running,
	// silently violating the concurrency=3 cap. Now: deadline triggers
	// AbortController.abort(); the abort signal is threaded into run_pipeline →
	// fetch_and_ground → extract_grounded_snippet's make_signal(timeout, signal),
	// so the outstanding Groq HTTP request fails fast with AbortError.
	// Caveat: run_fetch_race doesn't accept a signal yet (separate orchestrator
	// change), so the fetch waterfall side still runs to its own timeouts —
	// that's a future commit.
	const deadline_controller = new AbortController();
	const pipeline_signal = signal
		? (typeof AbortSignal.any === 'function'
			? AbortSignal.any([signal, deadline_controller.signal])
			: deadline_controller.signal)
		: deadline_controller.signal;
	const run = await with_deadline<PipelineRunResult>(
		run_pipeline(ctx, pipeline_t0, query, result.url, fetch_provider, pipeline_signal),
		cfg.per_url_deadline_ms,
		() => {
			deadline_controller.abort();
			return { outcome: 'fallback:pipeline_timeout', attempts: 0 };
		},
	);

	const total_ms = Date.now() - pipeline_t0;
	const outcome_meta: PipelineOutcome = {
		outcome: run.outcome,
		attempts: run.attempts,
		duration_ms: total_ms,
		fetch_provider_used: run.winning_fetch?.provider_used,
		fetch_providers_attempted: run.winning_fetch?.providers_attempted,
		fetch_providers_failed_count: run.winning_fetch?.providers_failed.length,
		content_length: run.winning_fetch?.result.content.length,
		snippet_length: run.winning_snippet?.length,
		error: run.last_error,
	};

	log_phase(ctx, 'pipeline_complete', pipeline_t0, pipeline_t0, {
		outcome: run.outcome,
		attempts: run.attempts,
		fetch_provider_used: outcome_meta.fetch_provider_used,
		snippet_length: outcome_meta.snippet_length,
		total_pipeline_ms: total_ms,
	});

	const grounded_outcome = run.outcome === 'grounded' || run.outcome === 'grounded_via_retry';
	if (grounded_outcome && run.winning_snippet && run.winning_fetch) {
		trace?.record_provider_complete(trace_provider_key, {
			url: result.url,
			host: ctx.host,
			outcome: run.outcome,
			attempts: run.attempts,
			provider_used: run.winning_fetch.provider_used,
			snippet_length: run.winning_snippet.length,
		}, total_ms);
		return {
			result: {
				...result,
				title: run.winning_fetch.result.title || result.title,
				snippets: [run.winning_snippet],
				snippet_source: 'grounded' as SnippetSource,
			},
			outcome: outcome_meta,
		};
	}

	trace?.record_provider_error(trace_provider_key, run.outcome, total_ms);
	return {
		result: { ...result, snippet_source: 'fallback' as SnippetSource },
		outcome: outcome_meta,
	};
};

// ── Public entry ─────────────────────────────────────────────────────────────

export const ground_top_results = async (
	query: string,
	results: RankedWebResult[],
	fetch_provider: UnifiedFetchProvider,
	signal?: AbortSignal,
): Promise<RankedWebResult[]> => {
	if (results.length === 0) return results;

	const cfg = config.snippet_grounding.groq;
	const aggregate_t0 = Date.now();
	const trace = get_active_trace();

	logger.info('Grounding start', {
		op: 'grounding_start',
		ts: new Date().toISOString(),
		query: query.slice(0, 100),
		count: results.length,
		concurrency: cfg.concurrency,
		per_url_deadline_ms: cfg.per_url_deadline_ms,
		retry_on_groq_empty: cfg.retry_on_groq_empty,
	});

	const settled = await run_with_concurrency(
		results,
		cfg.concurrency,
		(r, i) => fetch_then_ground(query, r, fetch_provider, signal, i),
	);

	// Reduce settled results into final list + aggregate metrics. Rejected
	// outcomes (worker threw — shouldn't happen since fetch_then_ground catches
	// everything, but defensive) get the raw fallback shape.
	const final_results: RankedWebResult[] = [];
	const outcome_counts: Record<string, number> = {};
	const provider_wins: Record<string, number> = {};
	const provider_failures: Record<string, number> = {};
	const durations: number[] = [];
	let retried_count = 0;
	let timeout_count = 0;
	let grounded_count = 0;

	for (let i = 0; i < settled.length; i++) {
		const s = settled[i];
		const original = results[i];
		if (s.status === 'fulfilled') {
			final_results.push(s.value.result);
			const o = s.value.outcome;
			outcome_counts[o.outcome] = (outcome_counts[o.outcome] || 0) + 1;
			durations.push(o.duration_ms);
			if (o.attempts === 2) retried_count++;
			if (o.outcome === 'fallback:pipeline_timeout') timeout_count++;
			if (o.outcome === 'grounded' || o.outcome === 'grounded_via_retry') {
				grounded_count++;
				if (o.fetch_provider_used) {
					provider_wins[o.fetch_provider_used] = (provider_wins[o.fetch_provider_used] || 0) + 1;
				}
			}
			// Tally per-provider failures across the attempted providers minus
			// the winner. Gives visibility into which providers commonly fail
			// during grounding fanout.
			if (o.fetch_providers_attempted) {
				for (const p of o.fetch_providers_attempted) {
					if (p !== o.fetch_provider_used) {
						provider_failures[p] = (provider_failures[p] || 0) + 1;
					}
				}
			}
		} else {
			const err_msg = error_message(s.reason);
			logger.warn('Grounding worker rejected unexpectedly', {
				op: 'grounding_worker_rejected',
				pipeline_index: i,
				url: truncate_url(original.url),
				error: err_msg,
			});
			outcome_counts['fallback:worker_rejected'] = (outcome_counts['fallback:worker_rejected'] || 0) + 1;
			final_results.push({ ...original, snippet_source: 'fallback' as SnippetSource });
		}
	}

	const sorted_durations = [...durations].sort((a, b) => a - b);
	const total_duration_ms = Date.now() - aggregate_t0;
	const aggregate = {
		op: 'grounding_aggregate',
		ts: new Date().toISOString(),
		query: query.slice(0, 100),
		total_urls: settled.length,
		grounded_count,
		fallback_count: settled.length - grounded_count,
		grounded_ratio: settled.length > 0 ? grounded_count / settled.length : 0,
		total_duration_ms,
		outcomes: outcome_counts,
		duration_percentiles: {
			p50: percentile(sorted_durations, 0.5),
			p95: percentile(sorted_durations, 0.95),
			max: sorted_durations[sorted_durations.length - 1] ?? 0,
		},
		provider_wins,
		provider_failures,
		retried_count,
		timeout_count,
		concurrency: cfg.concurrency,
		per_url_deadline_ms: cfg.per_url_deadline_ms,
	};

	logger.info('Grounding aggregate', aggregate);
	trace?.record_decision('grounding_aggregate', aggregate);

	return final_results;
};
