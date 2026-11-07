// Grounded snippets: after the web_search RRF ranker picks the top-N results,
// fetch each URL via the external omnifetch service (concurrency-capped to
// avoid hammering omnifetch) and use Cerebras (gpt-oss-120b) to write a
// snippet summarizing what the page says (in the context of the query).
//
// Conceptual model (intentionally narrow):
//   - The search engines have already decided these pages are relevant.
//   - Our reranker picked the best subset.
//   - LLM's job is just to SUMMARIZE WHAT THE PAGE CONTAINS, framed by the
//     query topic. It is NOT LLM's job to decide whether the page actually
//     addresses the query — even an off-topic page should get a summary
//     describing what it IS about. The user (or upstream LLM) decides
//     relevance from the snippet.
//   - Therefore: the only legitimate reason a URL doesn't get a grounded
//     snippet is a fetch-side pipeline error (paywall surfaced as the body,
//     login wall, cookie wall, JavaScript-required shell, etc.) or an LLM
//     failure. We detect junk content PRE-LLM via pattern matching. There is
//     no longer a skip_providers retry — a single fetch is performed per URL,
//     and junk content falls back to the original aggregated snippet.
//
// Robustness model:
//   1. Bounded worker pool (default concurrency=3). omnifetch sees at most N
//      simultaneous calls.
//   2. Per-URL hard deadline (default 15s) — no single bad URL stalls a worker.
//   3. Junk-content detection (paywall / login-wall / etc.) BEFORE LLM.
//   4. Failure classification (7 outcomes) — every path produces exactly one.
//   5. Structured logging at every phase boundary with timestamps, durations,
//      provider attribution. Plus a single grounding_aggregate line for
//      monitoring.

import { http_json } from '../common/http.js';
import { make_signal } from '../common/utils.js';
import { loggers } from '../common/logger.js';
import { config } from '../config/env.js';
import { get_active_trace } from '../common/r2_trace.js';
import type { RankedWebResult, SnippetSource } from '../common/rrf_ranking.js';
import { fetch_url, type OmnifetchResult } from './omnifetch_client.js';
import {
	GROUNDED_SNIPPET_MAX_CHARS,
	GROUNDED_SYSTEM_PROMPT,
	build_grounded_user_message,
	detect_grounded_junk,
	detect_grounded_sentinel,
} from './grounded_prompts.js';

const logger = loggers.search();

// ── Types ────────────────────────────────────────────────────────────────────

type GroundingOutcome =
	| 'grounded'
	| 'fallback:fetch_exhausted'
	| 'fallback:fetch_too_short'
	| 'fallback:fetch_junk'
	| 'fallback:llm_sentinel'
	| 'fallback:llm_error'
	| 'fallback:llm_empty'
	| 'fallback:pipeline_timeout';

interface PipelineOutcome {
	outcome: GroundingOutcome;
	duration_ms: number;
	fetch_provider_used?: string;
	content_length?: number;
	snippet_length?: number;
	error?: string;
}

interface PipelineResult {
	result: RankedWebResult;
	outcome: PipelineOutcome;
}

interface LlmChatResponse {
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

// ── LLM client ──────────────────────────────────────────────────────────────

interface LlmExtractResult {
	snippet: string;
	finish_reason: string;
	prompt_tokens: number;
	completion_tokens: number;
}

// If the snippet ends with an unbalanced ``` fence (because the SDK truncation
// or natural model stop landed mid-block), append a closing fence so downstream
// markdown renderers don't bleed the rest of the response into a code block.
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
): Promise<LlmExtractResult> => {
	const cfg = config.snippet_grounding.llm;
	const response = await http_json<LlmChatResponse>(
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
	winning_fetch?: OmnifetchResult;
	winning_snippet?: string;
	last_error?: string;
}

// Run a single fetch + LLM pair. Returns either a winning snippet or a
// structured failure indicator. No retry — a junk/sentinel result falls back
// to the original aggregated snippet via the outcome classification.
interface FetchAndGroundResult {
	kind: 'success' | 'fetch_throw' | 'fetch_too_short' | 'fetch_junk' | 'llm_error' | 'llm_empty' | 'llm_sentinel';
	fetch_result?: OmnifetchResult;
	snippet?: string;
	error?: string;
}

const fetch_and_ground = async (
	ctx: PipelineCtx,
	pipeline_t0: number,
	query: string,
	url: string,
	signal: AbortSignal | undefined,
): Promise<FetchAndGroundResult> => {
	const cfg = config.snippet_grounding.llm;

	// Fetch (single call to the external omnifetch service)
	const fetch_t0 = Date.now();
	let fetch_result: OmnifetchResult;
	try {
		fetch_result = await fetch_url(url, signal);
		log_phase(ctx, 'fetch', pipeline_t0, fetch_t0, {
			source_provider: fetch_result.source_provider,
			content_length: fetch_result.content.length,
		});
	} catch (err) {
		const msg = error_message(err);
		log_phase(ctx, 'fetch', pipeline_t0, fetch_t0, { error: msg });
		return { kind: 'fetch_throw', error: msg };
	}

	// Length guard
	if (fetch_result.content.length < cfg.fetch_min_content_chars) {
		log_phase(ctx, 'fetch_filter', pipeline_t0, fetch_t0, {
			content_length: fetch_result.content.length,
			reason: 'too_short',
		});
		return { kind: 'fetch_too_short', fetch_result };
	}

	// Junk content guard (paywall/login-wall/etc.) — pre-LLM detection.
	const junk_reason = detect_grounded_junk(fetch_result.content);
	if (junk_reason) {
		log_phase(ctx, 'fetch_filter', pipeline_t0, fetch_t0, {
			content_length: fetch_result.content.length,
			reason: 'junk',
			junk_reason,
		});
		return { kind: 'fetch_junk', fetch_result };
	}

	// LLM
	const llm_t0 = Date.now();
	try {
		const llm_out = await extract_grounded_snippet(
			`llm_grounding_${ctx.pipeline_index}`,
			query,
			fetch_result.title,
			fetch_result.content,
			signal,
		);
		log_phase(ctx, 'llm', pipeline_t0, llm_t0, {
			snippet_length: llm_out.snippet.length,
			finish_reason: llm_out.finish_reason,
			prompt_tokens: llm_out.prompt_tokens,
			completion_tokens: llm_out.completion_tokens,
		});
		if (llm_out.snippet.length < cfg.llm_min_snippet_chars) {
			return { kind: 'llm_empty', fetch_result, snippet: llm_out.snippet };
		}
		// Sentinel detection: model signals "this page genuinely has no usable
		// content for the query" via one of the bracketed strings in the system
		// prompt. We map back to the original aggregated snippet (fallback) so
		// users don't see "[no usable content]" in the response.
		const sentinel = detect_grounded_sentinel(llm_out.snippet);
		if (sentinel) {
			log_phase(ctx, 'llm_sentinel', pipeline_t0, llm_t0, { sentinel });
			return { kind: 'llm_sentinel', fetch_result, snippet: llm_out.snippet };
		}
		return { kind: 'success', fetch_result, snippet: llm_out.snippet };
	} catch (err) {
		const msg = error_message(err);
		log_phase(ctx, 'llm', pipeline_t0, llm_t0, { error: msg });
		return { kind: 'llm_error', fetch_result, error: msg };
	}
};

const run_pipeline = async (
	ctx: PipelineCtx,
	pipeline_t0: number,
	query: string,
	url: string,
	signal: AbortSignal | undefined,
): Promise<PipelineRunResult> => {
	const result = await fetch_and_ground(ctx, pipeline_t0, query, url, signal);

	if (result.kind === 'success' && result.snippet && result.fetch_result) {
		return { outcome: 'grounded', winning_fetch: result.fetch_result, winning_snippet: result.snippet };
	}
	if (result.kind === 'fetch_throw') {
		return { outcome: 'fallback:fetch_exhausted', last_error: result.error };
	}
	if (result.kind === 'fetch_too_short') {
		return { outcome: 'fallback:fetch_too_short', winning_fetch: result.fetch_result };
	}
	if (result.kind === 'llm_error') {
		return { outcome: 'fallback:llm_error', winning_fetch: result.fetch_result, last_error: result.error };
	}
	if (result.kind === 'llm_empty') {
		return { outcome: 'fallback:llm_empty', winning_fetch: result.fetch_result };
	}
	if (result.kind === 'fetch_junk') {
		return { outcome: 'fallback:fetch_junk', winning_fetch: result.fetch_result };
	}
	// result.kind === 'llm_sentinel'
	return { outcome: 'fallback:llm_sentinel', winning_fetch: result.fetch_result };
};

const fetch_then_ground = async (
	query: string,
	result: RankedWebResult,
	index: number,
): Promise<PipelineResult> => {
	const pipeline_t0 = Date.now();
	const ctx: PipelineCtx = {
		pipeline_index: index,
		url_short: truncate_url(result.url),
		host: safe_hostname(result.url),
	};
	const trace = get_active_trace();
	const trace_provider_key = `llm_grounding_${index}`;
	trace?.record_provider_start(trace_provider_key, { url: result.url, host: ctx.host });

	log_phase(ctx, 'pipeline_start', pipeline_t0, pipeline_t0);

	// Per-URL deadline aborts the inner pipeline (LLM half) when fired. The
	// deadline triggers AbortController.abort(); the abort signal is threaded
	// into fetch_url → extract_grounded_snippet's make_signal(timeout, signal),
	// so the outstanding omnifetch + LLM HTTP requests fail fast with AbortError.
	const deadline_controller = new AbortController();
	const pipeline_signal = deadline_controller.signal;
	const run = await with_deadline<PipelineRunResult>(
		run_pipeline(ctx, pipeline_t0, query, result.url, pipeline_signal),
		config.snippet_grounding.llm.per_url_deadline_ms,
		() => {
			deadline_controller.abort();
			return { outcome: 'fallback:pipeline_timeout' };
		},
	);

	const total_ms = Date.now() - pipeline_t0;
	const outcome_meta: PipelineOutcome = {
		outcome: run.outcome,
		duration_ms: total_ms,
		fetch_provider_used: run.winning_fetch?.source_provider,
		content_length: run.winning_fetch?.content.length,
		snippet_length: run.winning_snippet?.length,
		error: run.last_error,
	};

	log_phase(ctx, 'pipeline_complete', pipeline_t0, pipeline_t0, {
		outcome: run.outcome,
		fetch_provider_used: outcome_meta.fetch_provider_used,
		snippet_length: outcome_meta.snippet_length,
		total_pipeline_ms: total_ms,
	});

	if (run.outcome === 'grounded' && run.winning_snippet && run.winning_fetch) {
		trace?.record_provider_complete(trace_provider_key, {
			url: result.url,
			host: ctx.host,
			outcome: run.outcome,
			provider_used: run.winning_fetch.source_provider,
			snippet_length: run.winning_snippet.length,
		}, total_ms);
		return {
			result: {
				...result,
				title: run.winning_fetch.title || result.title,
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

export interface GroundingStats {
	transient_fail_count: number;
	grounded_count: number;
	total_urls: number;
	// Surfaced for AE metrics (Dataset B) — same numbers as the grounding_aggregate log.
	makespan_ms: number;
	p50_ms: number;
	p95_ms: number;
	max_ms: number;
	timeout_count: number;
	retried_count: number;
}

interface GroundingOutput {
	results: RankedWebResult[];
	stats: GroundingStats;
}

// Outcomes that indicate transient infra failure (NOT durable page/URL state).
// Used by callers to decide whether to cache the fanout result — a fanout where
// LLM blipped or workers got rejected should not be cached as the steady-state
// answer because the 36h TTL would mask recovery.
const TRANSIENT_GROUNDING_OUTCOMES: ReadonlySet<GroundingOutcome> = new Set<GroundingOutcome>([
	'fallback:llm_error',
	'fallback:pipeline_timeout',
]);

export const ground_top_results = async (
	query: string,
	results: RankedWebResult[],
): Promise<GroundingOutput> => {
	if (results.length === 0) return { results, stats: { transient_fail_count: 0, grounded_count: 0, total_urls: 0, makespan_ms: 0, p50_ms: 0, p95_ms: 0, max_ms: 0, timeout_count: 0, retried_count: 0 } };

	const cfg = config.snippet_grounding.llm;
	const aggregate_t0 = Date.now();
	const trace = get_active_trace();

	logger.info('Grounding start', {
		op: 'grounding_start',
		ts: new Date().toISOString(),
		query: query.slice(0, 100),
		count: results.length,
		concurrency: cfg.concurrency,
		per_url_deadline_ms: cfg.per_url_deadline_ms,
	});

	const settled = await run_with_concurrency(
		results,
		cfg.concurrency,
		(r, i) => fetch_then_ground(query, r, i),
	);

	// Reduce settled results into final list + aggregate metrics. Rejected
	// outcomes (worker threw — shouldn't happen since fetch_then_ground catches
	// everything, but defensive) get the raw fallback shape.
	const final_results: RankedWebResult[] = [];
	const outcome_counts: Record<string, number> = {};
	const provider_wins: Record<string, number> = {};
	const durations: number[] = [];
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
			if (o.outcome === 'fallback:pipeline_timeout') timeout_count++;
			if (o.outcome === 'grounded') {
				grounded_count++;
				if (o.fetch_provider_used) {
					provider_wins[o.fetch_provider_used] = (provider_wins[o.fetch_provider_used] || 0) + 1;
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

	// worker_rejected is also transient (orchestration race, not durable URL state)
	// but it's logged from the catch branch above rather than as a GroundingOutcome
	// value. Sum it in explicitly so the cache gate sees it.
	let transient_fail_count = outcome_counts['fallback:worker_rejected'] ?? 0;
	for (const outcome of TRANSIENT_GROUNDING_OUTCOMES) {
		transient_fail_count += outcome_counts[outcome] ?? 0;
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
		timeout_count,
		concurrency: cfg.concurrency,
		per_url_deadline_ms: cfg.per_url_deadline_ms,
	};

	logger.info('Grounding aggregate', aggregate);
	trace?.record_decision('grounding_aggregate', aggregate);

	return {
		results: final_results,
		stats: {
			transient_fail_count,
			grounded_count,
			total_urls: settled.length,
			makespan_ms: total_duration_ms,
			p50_ms: percentile(sorted_durations, 0.5),
			p95_ms: percentile(sorted_durations, 0.95),
			max_ms: sorted_durations[sorted_durations.length - 1] ?? 0,
			timeout_count,
			retried_count: 0,
		},
	};
};
