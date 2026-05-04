// Web search fanout: dispatches a query to all configured search providers
// in parallel and merges results using RRF ranking.

import type { SearchResult } from '../common/types.js';
import { loggers } from '../common/logger.js';
import { rank_and_merge, truncate_web_results, type RankedWebResult, type SnippetSource } from '../common/rrf_ranking.js';
import { retry_with_backoff, hash_key } from '../common/utils.js';
import { get_active_search_providers, type WebSearchProvider } from '../providers/unified/web_search.js';
import type { UnifiedFetchProvider } from '../providers/unified/fetch.js';
import { config, kv_cache } from '../config/env.js';
import { TraceContext, get_active_trace, run_with_trace } from '../common/r2_trace.js';
import { ground_top_results } from './grounded_snippets.js';

const logger = loggers.search();

const DEFAULT_TOP_N = 20;
const GROUNDING_TOP_N = 20;
const KV_SEARCH_TTL_SECONDS = 129_600; // 36 hours
const VALID_SNIPPET_SOURCES: ReadonlySet<SnippetSource> = new Set<SnippetSource>(['aggregated', 'grounded', 'fallback']);

const make_cache_key = (query: string, options?: { skip_quality_filter?: boolean; grounded?: boolean }): Promise<string> => {
	const sqf_suffix = options?.skip_quality_filter ? '\0sqf=true' : '';
	const grounded_suffix = options?.grounded ? '\0gnd=true' : '';
	return hash_key('search:', `${query}${sqf_suffix}${grounded_suffix}`);
};

const is_valid_cached_fanout = (raw: unknown): raw is FanoutResult => {
	if (!raw || typeof raw !== 'object') return false;
	const r = raw as Record<string, unknown>;
	if (typeof r.query !== 'string') return false;
	if (typeof r.total_duration_ms !== 'number') return false;
	if (!Array.isArray(r.providers_succeeded)) return false;
	if (!r.providers_succeeded.every((p) =>
		p && typeof p === 'object' &&
		typeof (p as Record<string, unknown>).provider === 'string' &&
		typeof (p as Record<string, unknown>).duration_ms === 'number'
	)) return false;
	if (!Array.isArray(r.providers_failed)) return false;
	if (!r.providers_failed.every((f) =>
		f && typeof f === 'object' &&
		typeof (f as Record<string, unknown>).provider === 'string' &&
		typeof (f as Record<string, unknown>).error === 'string' &&
		typeof (f as Record<string, unknown>).duration_ms === 'number'
	)) return false;
	if (!Array.isArray(r.web_results)) return false;
	if (!r.web_results.every((w) => {
		if (!w || typeof w !== 'object') return false;
		const rec = w as Record<string, unknown>;
		if (typeof rec.title !== 'string') return false;
		if (typeof rec.url !== 'string') return false;
		if (!Array.isArray(rec.snippets)) return false;
		if (!Array.isArray(rec.source_providers)) return false;
		if (typeof rec.score !== 'number') return false;
		if (rec.snippet_source !== undefined &&
			!(typeof rec.snippet_source === 'string' && VALID_SNIPPET_SOURCES.has(rec.snippet_source as SnippetSource))) return false;
		return true;
	})) return false;
	return true;
};

const get_cached = async (key: string): Promise<FanoutResult | undefined> => {
	if (!kv_cache) return undefined;
	try {
		const cached = await kv_cache.get(key, 'json') as unknown;
		return is_valid_cached_fanout(cached) ? cached : undefined;
	} catch {
		return undefined;
	}
};

const set_cached = async (key: string, result: FanoutResult): Promise<void> => {
	if (!kv_cache) return;
	try {
		await kv_cache.put(key, JSON.stringify(result), { expirationTtl: KV_SEARCH_TTL_SECONDS });
	} catch (err) {
		logger.warn('KV cache write failed', { op: 'kv_write_error', error: err instanceof Error ? err.message : String(err) });
	}
};

export interface FanoutResult {
	query: string;
	total_duration_ms: number;
	providers_succeeded: Array<{ provider: string; duration_ms: number }>;
	providers_failed: Array<{ provider: string; error: string; duration_ms: number }>;
	web_results: RankedWebResult[];
}

interface SearchDispatcher {
	search: (params: { query: string; provider: WebSearchProvider; limit?: number; signal?: AbortSignal }) => Promise<SearchResult[]>;
}

const dispatch_to_providers = async (
	web_provider: SearchDispatcher,
	query: string,
	active: Array<{ name: string }>,
	per_provider_limit: number,
	timeout_ms?: number,
	signal?: AbortSignal,
): Promise<{
	results_by_provider: Map<string, SearchResult[]>;
	providers_succeeded: Array<{ provider: string; duration_ms: number }>;
	providers_failed: Array<{ provider: string; error: string; duration_ms: number }>;
}> => {
	const results_by_provider = new Map<string, SearchResult[]>();
	const providers_succeeded: Array<{ provider: string; duration_ms: number }> = [];
	const providers_failed: Array<{ provider: string; error: string; duration_ms: number }> = [];

	logger.debug('Dispatching to search providers', {
		op: 'dispatch_start',
		provider_count: active.length,
		providers: active.map((p) => p.name),
		per_provider_limit,
		timeout_ms: timeout_ms ?? 'none',
	});

	// Create a deadline controller that we abort when timeout_ms fires,
	// so in-flight provider HTTP requests are cancelled instead of running to completion.
	const deadline_controller = timeout_ms ? new AbortController() : undefined;
	// Combine external signal with deadline signal, using polyfill-safe path
	let combined_signal = signal;
	if (deadline_controller) {
		if (signal) {
			combined_signal = typeof AbortSignal.any === 'function'
				? AbortSignal.any([signal, deadline_controller.signal])
				: deadline_controller.signal; // fallback: deadline only (external signal still respected by providers via make_signal)
		} else {
			combined_signal = deadline_controller.signal;
		}
	}

	const provider_promises = active.map(async (p) => {
		const t0 = Date.now();
		const provider = loggers.search(p.name);
		const trace = get_active_trace();

		trace?.record_provider_start(p.name, { query, limit: per_provider_limit });

		try {
			provider.debug('Starting search', { op: 'provider_search_start' });

			const results = await retry_with_backoff(
				() => web_provider.search({ query, provider: p.name as WebSearchProvider, limit: per_provider_limit, signal: combined_signal }),
				{ max_retries: 1, signal: combined_signal },
			);

			results_by_provider.set(p.name, results);
			const duration_ms = Date.now() - t0;
			providers_succeeded.push({ provider: p.name, duration_ms });
			trace?.record_provider_complete(p.name, results, duration_ms);

			provider.info('Search completed', {
				op: 'provider_search_complete',
				result_count: results.length,
				duration_ms,
			});
		} catch (err) {
			const duration_ms = Date.now() - t0;
			const error_msg = err instanceof Error ? err.message : String(err);
			providers_failed.push({
				provider: p.name,
				error: error_msg,
				duration_ms,
			});
			trace?.record_provider_error(p.name, error_msg, duration_ms);

			provider.warn('Search failed', {
				op: 'provider_search_failed',
				error: error_msg,
				duration_ms,
			});
		}
	});

	if (timeout_ms && timeout_ms > 0) {
		// Race all providers against a deadline — return partial results when time's up
		let timer_id: ReturnType<typeof setTimeout>;
		const deadline = new Promise<void>((resolve) => { timer_id = setTimeout(resolve, timeout_ms); });
		const winner = await Promise.race([
			Promise.allSettled(provider_promises).then(() => 'done' as const),
			deadline.then(() => 'timeout' as const),
		]);
		clearTimeout(timer_id!);
		if (winner === 'timeout' && deadline_controller) {
			deadline_controller.abort();
		}

		const pending = active.filter((p) => !providers_succeeded.some((s) => s.provider === p.name) &&
			!providers_failed.some((f) => f.provider === p.name));

		if (pending.length > 0) {
			logger.info('Timeout reached with pending providers', {
				op: 'dispatch_timeout',
				completed: providers_succeeded.length,
				failed: providers_failed.length,
				pending: pending.map((p) => p.name),
			});
			// Mark pending as failed — without this, providers_failed underreports the
			// real fanout state and downstream cache-gating would write a partial result.
			const deadline_duration = timeout_ms;
			for (const p of pending) {
				providers_failed.push({
					provider: p.name,
					error: `Timed out (fanout deadline ${timeout_ms}ms)`,
					duration_ms: deadline_duration,
				});
			}
		}

		// Snapshot results at deadline to prevent post-deadline mutations from in-flight promises
		return {
			results_by_provider: new Map(results_by_provider),
			providers_succeeded: [...providers_succeeded],
			providers_failed: [...providers_failed],
		};
	} else {
		await Promise.allSettled(provider_promises);
	}

	logger.debug('Dispatch complete', {
		op: 'dispatch_complete',
		succeeded: providers_succeeded.length,
		failed: providers_failed.length,
	});

	return { results_by_provider, providers_succeeded, providers_failed };
};

export const run_web_search_fanout = async (
	web_provider: SearchDispatcher,
	query: string,
	options?: {
		skip_quality_filter?: boolean;
		limit?: number;
		timeout_ms?: number;
		signal?: AbortSignal;
		grounded_snippets?: boolean;
		fetch_provider?: UnifiedFetchProvider;
	},
): Promise<FanoutResult> => {
	const want_grounding = options?.grounded_snippets !== false
		&& !!config.snippet_grounding.groq.api_key
		&& !!options?.fetch_provider;
	const trace = new TraceContext(crypto.randomUUID(), 'web_search');
	const parent = get_active_trace();
	if (parent) trace.parent_trace_id = parent.trace_id;
	trace.set_strategy('parallel_fanout');
	trace.request_environment = {
		query,
		skip_quality_filter: options?.skip_quality_filter,
		limit: options?.limit,
		timeout_ms: options?.timeout_ms,
		grounded_snippets: want_grounding,
	};

	return run_with_trace(trace, async () => {
		// Return cached result if available (deduplicates gemini-grounded web search inside answer fanout).
		// Defense-in-depth: also require cached.query === query so a SHA-256-collision-defying
		// future bug couldn't silently serve a different query's results.
		const cache_key = await make_cache_key(query, { skip_quality_filter: options?.skip_quality_filter, grounded: want_grounding });
		const cached_raw = await get_cached(cache_key);
		const cached = cached_raw && cached_raw.query === query ? cached_raw : undefined;
		if (cached) {
			logger.debug('Returning cached fanout result', { op: 'fanout_cache_hit', query: query.slice(0, 100), grounded: want_grounding });
			trace.cache_hit = true;
			trace.record_decision('cache_hit', { query: query.slice(0, 100), grounded: want_grounding });
			trace.flush_background(cached);
			return cached;
		}

		const per_provider_limit = options?.limit ?? DEFAULT_TOP_N;
		const active = get_active_search_providers();

		if (active.length === 0) {
			logger.warn('No search providers available', { op: 'fanout_check' });
			const empty_result: FanoutResult = { query, total_duration_ms: 0, providers_succeeded: [], providers_failed: [], web_results: [] };
			trace.record_decision('no_providers_available', {});
			trace.flush_background(empty_result);
			return empty_result;
		}

		trace.set_active_providers(active.map((p) => p.name));
		trace.record_decision('dispatch_start', {
			provider_count: active.length,
			providers: active.map((p) => p.name),
			per_provider_limit,
			timeout_ms: options?.timeout_ms ?? null,
		});

		logger.info('Starting web search fanout', {
			op: 'web_fanout_start',
			query: query.slice(0, 100),
			provider_count: active.length,
			providers: active.map((p) => p.name),
			skip_quality_filter: options?.skip_quality_filter ?? false,
		});

		const fanout_start = Date.now();
		const { results_by_provider, providers_succeeded, providers_failed } =
			await dispatch_to_providers(web_provider, query, active, per_provider_limit, options?.timeout_ms, options?.signal);

		const dispatch_duration = Date.now() - fanout_start;

		trace.record_decision('dispatch_complete', {
			succeeded: providers_succeeded.length,
			failed: providers_failed.length,
			dispatch_duration_ms: dispatch_duration,
		});

		logger.debug('Ranking and merging results', {
			op: 'ranking_start',
			provider_results: results_by_provider.size,
			results_by_provider: Object.fromEntries(
				Array.from(results_by_provider.entries()).map(([k, v]) => [k, v.length]),
			),
		});

		const ranked_results = rank_and_merge(results_by_provider, query, options?.skip_quality_filter);

		trace.record_decision('ranking_complete', {
			total_results: ranked_results.length,
		});

		// Grounding: after RRF + dedup + tail rescue + quality filter, fetch the
		// top-N URLs in parallel and use Groq (openai/gpt-oss-20b) to extract
		// query-grounded snippets from the actual page content. Failures fall
		// back to the original aggregated snippet so a single bad URL never
		// breaks the result set. Gated on want_grounding (default true when
		// GROQ_API_KEY is set and a fetch_provider was threaded through).
		let web_results = ranked_results;
		if (want_grounding && options?.fetch_provider && ranked_results.length > 0) {
			const { results: top, truncation } = truncate_web_results(ranked_results, GROUNDING_TOP_N);
			trace.record_decision('grounding_start', { top_n: top.length, truncation });
			const grounding_t0 = Date.now();
			const grounded_top = await ground_top_results(query, top, options.fetch_provider, options.signal);
			const grounded_urls = new Set(grounded_top.map((r) => r.url));
			const ungrounded_remainder = ranked_results.filter((r) => !grounded_urls.has(r.url));
			web_results = [...grounded_top, ...ungrounded_remainder];
			trace.record_decision('grounding_complete', {
				duration_ms: Date.now() - grounding_t0,
				grounded: grounded_top.filter((r) => r.snippet_source === 'grounded').length,
				fallback: grounded_top.filter((r) => r.snippet_source === 'fallback').length,
				total: grounded_top.length,
			});
		}

		const total_duration = Date.now() - fanout_start;

		logger.info('Web search fanout complete', {
			op: 'web_fanout_complete',
			query: query.slice(0, 100),
			dispatch_duration_ms: dispatch_duration,
			total_duration_ms: total_duration,
			providers_succeeded: providers_succeeded.length,
			providers_failed: providers_failed.length,
			failed_providers: providers_failed.map((f) => f.provider),
			final_result_count: web_results.length,
			grounded_snippets: want_grounding,
		});

		const result: FanoutResult = {
			query,
			total_duration_ms: total_duration,
			providers_succeeded,
			providers_failed,
			web_results,
		};

		// Only cache COMPLETE fanouts (every active provider settled successfully).
		// Otherwise a partial — including timeout-limited internal calls from
		// gemini-grounded — would poison the shared cache key with a one-provider
		// result that subsequent unconstrained /search calls would receive for 36h.
		const is_complete_fanout = providers_succeeded.length > 0 && providers_failed.length === 0;
		if (is_complete_fanout) {
			await set_cached(cache_key, result);
		} else if (providers_succeeded.length > 0) {
			logger.debug('Skipping search cache write (partial fanout)', {
				op: 'search_cache_skip_partial',
				succeeded: providers_succeeded.length,
				failed: providers_failed.length,
			});
		}

		trace.flush_background(result);
		return result;
	});
};

export { truncate_web_results };
