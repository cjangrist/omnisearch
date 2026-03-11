// Web search fanout: dispatches a query to all configured search providers
// in parallel and merges results using RRF ranking.

import type { SearchResult } from '../common/types.js';
import { rank_and_merge, truncate_web_results, type RankedWebResult } from '../common/rrf_ranking.js';
import { retry_with_backoff } from '../common/utils.js';
import { get_active_search_providers, type WebSearchProvider } from '../providers/unified/web_search.js';

const DEFAULT_TOP_N = 15;

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

	const provider_promises = active.map(async (p) => {
		const t0 = Date.now();
		try {
			const results = await retry_with_backoff(
				() => web_provider.search({ query, provider: p.name as WebSearchProvider, limit: per_provider_limit }),
				1,
			);
			results_by_provider.set(p.name, results);
			providers_succeeded.push({ provider: p.name, duration_ms: Date.now() - t0 });
		} catch (err) {
			providers_failed.push({
				provider: p.name,
				error: err instanceof Error ? err.message : String(err),
				duration_ms: Date.now() - t0,
			});
		}
	});

	if (timeout_ms && timeout_ms > 0) {
		// Race all providers against a deadline — return partial results when time's up
		let timer_id: ReturnType<typeof setTimeout>;
		const deadline = new Promise<void>((resolve) => { timer_id = setTimeout(resolve, timeout_ms); });
		await Promise.race([Promise.allSettled(provider_promises), deadline]);
		clearTimeout(timer_id!);
		// Snapshot results at deadline to prevent post-deadline mutations from in-flight promises
		return {
			results_by_provider: new Map(results_by_provider),
			providers_succeeded: [...providers_succeeded],
			providers_failed: [...providers_failed],
		};
	} else {
		await Promise.allSettled(provider_promises);
	}

	return { results_by_provider, providers_succeeded, providers_failed };
};

export const run_web_search_fanout = async (
	web_provider: SearchDispatcher,
	query: string,
	options?: { skip_quality_filter?: boolean; limit?: number; timeout_ms?: number },
): Promise<FanoutResult> => {
	const per_provider_limit = options?.limit ?? DEFAULT_TOP_N;
	const active = get_active_search_providers();

	if (active.length === 0) {
		return { total_duration_ms: 0, providers_succeeded: [], providers_failed: [], web_results: [] };
	}

	const fanout_start = Date.now();
	const { results_by_provider, providers_succeeded, providers_failed } =
		await dispatch_to_providers(web_provider, query, active, per_provider_limit, options?.timeout_ms);

	const web_results = rank_and_merge(results_by_provider, query, options?.skip_quality_filter);

	return {
		total_duration_ms: Date.now() - fanout_start,
		providers_succeeded,
		providers_failed,
		web_results,
	};
};

export { truncate_web_results };
