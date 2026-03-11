// Reciprocal Rank Fusion (RRF) ranking algorithm
// Merges results from multiple search providers into a single ranked list.

import type { SearchResult } from './types.js';
import { collapse_snippets } from './snippet_selector.js';

const RRF_K = 60;
const DEFAULT_TOP_N = 15;
const RESCUE_INTRA_RANK_THRESHOLD = 2;
const MIN_RRF_SCORE = 0.01;
const MIN_SNIPPET_CHARS_SINGLE_PROVIDER = 300;

// Normalize URLs for dedup: lowercase host, strip fragment, strip trailing slash
const normalize_url = (raw: string): string => {
	try {
		const u = new URL(raw);
		u.hash = '';
		// Remove trailing slash from pathname (except root "/")
		if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
			u.pathname = u.pathname.slice(0, -1);
		}
		return u.toString();
	} catch {
		return raw;
	}
};

export interface RankedWebResult {
	title: string;
	url: string;
	snippets: string[];
	source_providers: string[];
	score: number;
}

interface TruncationInfo {
	total_before: number;
	kept: number;
	rescued: number;
}

const compute_rrf_scores = (
	results_by_provider: Map<string, SearchResult[]>,
): Map<string, { data: Omit<RankedWebResult, 'score'>; score: number }> => {
	const rrf_scores = new Map<string, number>();
	const url_data = new Map<string, Omit<RankedWebResult, 'score'>>();

	for (const [provider_name, results] of results_by_provider) {
		const ranked = [...results].sort(
			(a, b) => (b.score ?? 0) - (a.score ?? 0),
		);
		for (let rank = 0; rank < ranked.length; rank++) {
			const result = ranked[rank];
			const key = normalize_url(result.url);
			const contribution = 1 / (RRF_K + rank + 1);
			rrf_scores.set(
				key,
				(rrf_scores.get(key) ?? 0) + contribution,
			);
			const existing = url_data.get(key);
			if (!existing) {
				url_data.set(key, {
					title: result.title,
					url: result.url,
					snippets: result.snippet ? [result.snippet] : [],
					source_providers: [provider_name],
				});
			} else {
				if (!existing.source_providers.includes(provider_name)) {
					existing.source_providers.push(provider_name);
				}
				if (result.snippet && !existing.snippets.includes(result.snippet)) {
					existing.snippets.push(result.snippet);
				}
			}
		}
	}

	const merged = new Map<string, { data: Omit<RankedWebResult, 'score'>; score: number }>();
	for (const [url, data] of url_data) {
		merged.set(url, { data, score: rrf_scores.get(url) ?? 0 });
	}
	return merged;
};

const rescue_tail_results = (
	top: RankedWebResult[],
	tail: RankedWebResult[],
	rescue_threshold: number,
): RankedWebResult[] => {
	const top_domains = new Set<string>();
	for (const r of top) {
		try { top_domains.add(new URL(r.url).hostname); } catch { /* skip */ }
	}

	return tail.filter((r) => {
		let domain: string;
		try { domain = new URL(r.url).hostname; } catch { return false; }
		if (top_domains.has(domain)) return false;

		const n = r.source_providers.length;
		const per_provider_score = r.score / n;
		const intra_rank = (1 / per_provider_score) - RRF_K - 1;
		return intra_rank < rescue_threshold;
	});
};

export const truncate_web_results = (
	results: RankedWebResult[],
	top_n: number = DEFAULT_TOP_N,
): { results: RankedWebResult[]; truncation: TruncationInfo } => {
	if (results.length <= top_n) {
		return { results, truncation: { total_before: results.length, kept: results.length, rescued: 0 } };
	}

	const top = results.slice(0, top_n);
	const tail = results.slice(top_n);
	const rescued = rescue_tail_results(top, tail, RESCUE_INTRA_RANK_THRESHOLD);
	const combined = [...top, ...rescued];

	return {
		results: combined,
		truncation: { total_before: results.length, kept: combined.length, rescued: rescued.length },
	};
};

const apply_quality_filters = (results: RankedWebResult[]): RankedWebResult[] =>
	results.filter((r) => {
		if (r.score < MIN_RRF_SCORE) return false;
		if (!r.url) return false;
		if (r.source_providers.length >= 2) return true;
		return r.snippets.reduce((a, s) => a + s.length, 0) >= MIN_SNIPPET_CHARS_SINGLE_PROVIDER;
	});

export const rank_and_merge = (
	results_by_provider: Map<string, SearchResult[]>,
	query: string,
	skip_quality_filter?: boolean,
): RankedWebResult[] => {
	const scored = compute_rrf_scores(results_by_provider);

	const ranked = Array.from(scored.values())
		.map(({ data, score }) => ({ ...data, score }))
		.filter((r) => r.url && r.url.trim() !== '')
		.sort((a, b) => b.score - a.score);

	const collapsed = collapse_snippets(ranked, query);

	return skip_quality_filter ? collapsed : apply_quality_filters(collapsed);
};
