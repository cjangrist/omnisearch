// Parallel.ai web search via POST /v1/search with mode:"advanced".
// Owns its own crawler/index — head-to-head eval (tmp/parallel_ai_eval_2026-05-04)
// showed 46% URL uniqueness vs omnisearch top-15, joining as a peer RRF participant.
// Response excerpts are markdown-rich; we concatenate them as the snippet so the
// grounded-snippets stage and downstream ranking get full context.

import { http_json } from '../../../common/http.js';
import {
	BaseSearchParams,
	SearchProvider,
	SearchResult,
} from '../../../common/types.js';
import {
	handle_provider_error,
	make_signal,
	validate_api_key,
} from '../../../common/utils.js';
import { config } from '../../../config/env.js';

const DEFAULT_LIMIT = 20;
const DEFAULT_MODE = 'advanced';
const DEFAULT_OBJECTIVE = 'Return the most relevant, recent, high-signal sources for this query.';
const SNIPPET_JOIN = '\n\n';

interface ParallelSourcePolicy {
	include_domains?: string[];
	exclude_domains?: string[];
}

interface ParallelAdvancedSettings {
	max_results?: number;
	source_policy?: ParallelSourcePolicy;
}

interface ParallelSearchRequest {
	objective: string;
	search_queries: string[];
	mode: 'base' | 'advanced';
	advanced_settings?: ParallelAdvancedSettings;
}

interface ParallelSearchResultItem {
	url: string;
	title?: string;
	publish_date?: string | null;
	excerpts?: string[];
}

interface ParallelSearchResponse {
	search_id?: string;
	results: ParallelSearchResultItem[];
}

export class ParallelSearchProvider implements SearchProvider {
	name = 'parallel';
	description =
		'Parallel.ai web search via the v1/search endpoint (mode:"advanced"). Owns its own crawler index — strong on multi-hop synthesis, obscure-entity queries, and structured excerpts.';

	async search(params: BaseSearchParams): Promise<SearchResult[]> {
		const api_key = validate_api_key(
			config.search.parallel.api_key,
			this.name,
		);

		try {
			const max_results = params.limit ?? DEFAULT_LIMIT;
			const advanced_settings: ParallelAdvancedSettings = { max_results };
			if (params.include_domains && params.include_domains.length > 0) {
				advanced_settings.source_policy = {
					...(advanced_settings.source_policy ?? {}),
					include_domains: params.include_domains,
				};
			}
			if (params.exclude_domains && params.exclude_domains.length > 0) {
				advanced_settings.source_policy = {
					...(advanced_settings.source_policy ?? {}),
					exclude_domains: params.exclude_domains,
				};
			}

			const request_body: ParallelSearchRequest = {
				objective: DEFAULT_OBJECTIVE,
				search_queries: [params.query],
				mode: DEFAULT_MODE,
				advanced_settings,
			};

			const data = await http_json<ParallelSearchResponse>(
				this.name,
				`${config.search.parallel.base_url}/v1/search`,
				{
					method: 'POST',
					headers: {
						'x-api-key': api_key,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify(request_body),
					signal: make_signal(config.search.parallel.timeout, params.signal),
				},
			);

			if (!Array.isArray(data.results)) return [];

			return data.results
				.filter((r) => r.url)
				.map((r) => ({
					title: r.title || r.url,
					url: r.url,
					snippet: (r.excerpts ?? []).join(SNIPPET_JOIN),
					source_provider: this.name,
					metadata: {
						search_id: data.search_id,
						publish_date: r.publish_date ?? null,
						excerpt_count: (r.excerpts ?? []).length,
					},
				}));
		} catch (error) {
			handle_provider_error(error, this.name, 'fetch search results');
		}
	}
}

export const registration = {
	key: () => config.search.parallel.api_key,
};
