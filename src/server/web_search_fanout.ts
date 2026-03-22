// Web search fanout: dispatches a query to all configured search providers
// in parallel and merges results using RRF ranking.

import type { SearchResult } from '../common/types.js';
import { loggers } from '../common/logger.js';
import { rank_and_merge, truncate_web_results, type RankedWebResult } from '../common/rrf_ranking.js';
import { retry_with_backoff } from '../common/utils.js';
import { get_active_search_providers, type WebSearchProvider } from '../providers/unified/web_search.js';

const logger = loggers.search();

const DEFAULT_TOP_N = 15;

// Short-lived cache to deduplicate identical queries across tool calls
// (e.g., web_search followed by answer with the same query, or gemini-grounded
// inside the answer fanout). TTL is short to avoid stale results.
const CACHE_TTL_MS = 30_000;
const fanout_cache = new Map<string, { result: FanoutResult; expires: number }>();

const get_cached = (query: string): FanoutResult | undefined => {
	const entry = fanout_cache.get(query);
	if (!entry) return undefined;
	if (Date.now() > entry.expires) {
		fanout_cache.delete(query);
		return undefined;
	}
	return entry.result;
};

const set_cached = (query: string, result: FanoutResult) => {
	fanout_cache.set(query, { result, expires: Date.now() + CACHE_TTL_MS });
	// Evict stale entries lazily (keep map bounded)
	if (fanout_cache.size > 50) {
		const now = Date.now();
		for (const [k, v] of fanout_cache) {
			if (now > v.expires) fanout_cache.delete(k);
		}
	}
};

export interface FanoutResult {
	total_duration_ms: number;
	providers_succeeded: Array<{ provider: string; duration_ms: number }>;
	providers_failed: Array<{ provider: string; error: string; duration_ms: number }>;
	web_results: RankedWebResult[];
}

interface SearchDispatcher {
	search: (params: { query: string; provider: WebSearchProvider; limit?: number }) => Promise<SearchResult[]>;
}

const dispatch_to_providers = async (
	web_provider: SearchDispatcher,
	query: string,
	active: Array<{ name: string }>,
	per_provider_limit: number,
	timeout_ms?: number,
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

	const provider_promises = active.map(async (p) => {
		const t0 = Date.now();
		const provider = loggers.search(p.name);

		try {
			provider.debug('Starting search', { op: 'provider_search_start' });

			const results = await retry_with_backoff(
				() => web_provider.search({ query, provider: p.name as WebSearchProvider, limit: per_provider_limit }),
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
		await Promise.race([Promise.allSettled(provider_promises), deadline]);
		clearTimeout(timer_id!);

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
	options?: { skip_quality_filter?: boolean; limit?: number; timeout_ms?: number },
): Promise<FanoutResult> => {
	// Return cached result if available (deduplicates gemini-grounded web search inside answer fanout)
	const cached = get_cached(query);
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
		await dispatch_to_providers(web_provider, query, active, per_provider_limit, options?.timeout_ms);

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

	set_cached(query, result);
	return result;
};

export { truncate_web_results };
