// Shared fetch+cleanup orchestrator for search results.
// Used by BOTH the MCP web_search tool and the REST /search endpoint.
// Single source of truth — no divergent implementations.

import type { UnifiedFetchProvider } from '../providers/unified/fetch.js';
import type { FanoutResult } from './web_search_fanout.js';
import { run_fetch_waterfall_collect } from './fetch_orchestrator.js';
import { run_cleanup } from '../providers/cleanup/index.js';

const MAX_CLEANUP_RESULTS = 8;
const CONCURRENCY = 8;

/**
 * Fetch+cleanup pass over search results. Walks the fetch waterfall for each
 * URL, collects up to 3 versions, then runs Groq LLM extraction to replace
 * naive snippets with grounded, query-relevant extracts.
 *
 * Processes in batches of CONCURRENCY to avoid overwhelming Groq rate limits
 * and staying within Cloudflare DO wall time.
 *
 * Failures are silently swallowed per-result — the original web_result is
 * kept unchanged if fetch or cleanup fails.
 */
export async function cleanup_search_results(
	fetch_provider: UnifiedFetchProvider,
	search_result: FanoutResult,
	query: string,
	cleanup_model?: string,
	max_results?: number,
): Promise<FanoutResult> {
	const cleanup_start = Date.now();
	const limit = max_results ?? MAX_CLEANUP_RESULTS;

	const to_cleanup = search_result.web_results.slice(0, limit);
	const passthrough = search_result.web_results.slice(limit);

	// Process in batches to avoid overwhelming Groq / hitting DO wall time
	const cleaned: typeof to_cleanup = [];
	for (let i = 0; i < to_cleanup.length; i += CONCURRENCY) {
		const batch = to_cleanup.slice(i, i + CONCURRENCY);
		const batch_settled = await Promise.allSettled(
			batch.map(async (web_result) => {
				try {
					const versions = await run_fetch_waterfall_collect(fetch_provider, web_result.url, 3);
					if (versions.length === 0) return web_result;
					const result = await run_cleanup(versions, query, cleanup_model);
					return { ...web_result, snippets: [result.content] };
				} catch {
					return web_result;
				}
			}),
		);
		cleaned.push(
			...batch_settled.map((s, idx) =>
				s.status === 'fulfilled' ? s.value : batch[idx],
			),
		);
	}

	return {
		...search_result,
		total_duration_ms: Date.now() - cleanup_start + search_result.total_duration_ms,
		web_results: [...cleaned, ...passthrough],
	};
}
