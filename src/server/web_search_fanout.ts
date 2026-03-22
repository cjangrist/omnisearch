// Web search fanout: dispatches a query to all configured search providers
// in parallel and merges results using RRF ranking.

import type { SearchResult } from '../common/types.js';
import { loggers } from '../common/logger.js';
import { rank_and_merge, truncate_web_results, type RankedWebResult } from '../common/rrf_ranking.js';
import { retry_with_backoff } from '../common/utils.js';
import { get_active_search_providers, type WebSearchProvider } from '../providers/unified/web_search.js';
import { kv_cache } from '../config/env.js';

const logger = loggers.search();

const DEFAULT_TOP_N = 15;
const KV_SEARCH_TTL_SECONDS = 86_400; // 24 hours
const KV_SEARCH_PREFIX = 'search:';

// Cache key includes options that affect results — prevents partial/filtered results
// from poisoning later calls that expect full results.
const make_cache_key = (query: string, options?: { skip_quality_filter?: boolean; timeout_ms?: number }): string => {
	const base = options?.skip_quality_filter || options?.timeout_ms
		? `${query}\0sqf=${options.skip_quality_filter ?? false}\0t=${options.timeout_ms ?? 0}`
		: query;
	return KV_SEARCH_PREFIX + base;
};

const get_cached = async (key: string): Promise<FanoutResult | undefined> => {
	if (!kv_cache) return undefined;
	try {
		const cached = await kv_cache.get(key, 'json');
		return cached as FanoutResult | undefined;
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
	const combined_signal = deadline_controller
		? (signal ? AbortSignal.any([signal, deadline_controller.signal]) : deadline_controller.signal)
		: signal;

	const provider_promises = active.map(async (p) => {
		const t0 = Date.now();
		const provider = loggers.search(p.name);

		try {
			provider.debug('Starting search', { op: 'provider_search_start' });

			const results = await retry_with_backoff(
				() => web_provider.search({ query, provider: p.name as WebSearchProvider, limit: per_provider_limit, signal: combined_signal }),
				1,
			);

			results_by_provider.set(p.name, results);
			const duration_ms = Date.now() - t0;
			providers_succeeded.push({ provider: p.name, duration_ms });

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
	options?: { skip_quality_filter?: boolean; limit?: number; timeout_ms?: number; signal?: AbortSignal },
): Promise<FanoutResult> => {
	// Return cached result if available (deduplicates gemini-grounded web search inside answer fanout)
	const cache_key = make_cache_key(query, options);
	const cached = await get_cached(cache_key);
	if (cached) {
		logger.debug('Returning cached fanout result', { op: 'fanout_cache_hit', query: query.slice(0, 100) });
		return cached;
	}

	const per_provider_limit = options?.limit ?? DEFAULT_TOP_N;
	const active = get_active_search_providers();

	if (active.length === 0) {
		logger.warn('No search providers available', { op: 'fanout_check' });
		return { total_duration_ms: 0, providers_succeeded: [], providers_failed: [], web_results: [] };
	}

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

	logger.debug('Ranking and merging results', {
		op: 'ranking_start',
		provider_results: results_by_provider.size,
		results_by_provider: Object.fromEntries(
			Array.from(results_by_provider.entries()).map(([k, v]) => [k, v.length]),
		),
	});

	const web_results = rank_and_merge(results_by_provider, query, options?.skip_quality_filter);

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
	});

	const result: FanoutResult = {
		total_duration_ms: total_duration,
		providers_succeeded,
		providers_failed,
		web_results,
	};

	// Await KV write — prevents REST path from killing the promise after response is sent
	await set_cached(cache_key, result);
	return result;
};

export { truncate_web_results };
