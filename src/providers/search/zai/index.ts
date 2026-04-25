// Z.AI web search provider — uses the General API endpoint
// (api.z.ai/api/paas/v4/web_search). Despite the GLM Coding Plan
// supposedly including web search quota, in practice the backend
// debits from the pay-as-you-go balance (zai-org/GLM-5#36) — the
// Coding Plan keys still need a small PAYG top-up for search to
// return any results.
//
// Engine choice: `search-pro` returns real results; `search-prime`,
// `search_pro_bing`, and `search_pro_jina` all return HTTP 200 with
// an empty `search_result` array regardless of query (Z.AI bug).
//
// Endpoint: POST {base_url}/web_search
// Docs:     https://docs.z.ai/api-reference/tools/web-search
//
// Body:     { search_engine, search_query, count, search_domain_filter?, search_recency_filter? }
// Response: { id, created, search_result: [{ title, content, link, media, icon, refer, publish_date }] }

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
import {
	apply_search_operators,
	parse_search_operators,
} from '../../../common/search_operators.js';
import { config } from '../../../config/env.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const DEFAULT_SEARCH_ENGINE = 'search-pro';
const SEARCH_PATH = '/web_search';

interface ZAISearchResultItem {
	title?: string;
	content?: string;
	link?: string;
	media?: string;
	icon?: string;
	refer?: string;
	publish_date?: string;
}

interface ZAISearchResponse {
	id?: string;
	created?: number;
	search_result?: ZAISearchResultItem[];
}

export class ZAISearchProvider implements SearchProvider {
	name = 'zai';
	description =
		'Z.AI web search (search-prime engine). LLM-optimized search returning titled, dated snippets with media attribution. Supports single-domain filtering and recency windows.';

	async search(params: BaseSearchParams): Promise<SearchResult[]> {
		const api_key = validate_api_key(config.search.zai.api_key, this.name);

		const parsed_query = parse_search_operators(params.query);
		const search_params = apply_search_operators(parsed_query);

		const merged_include = [
			...(params.include_domains ?? []),
			...(search_params.include_domains ?? []),
		];

		const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

		const request_body: Record<string, unknown> = {
			search_engine: DEFAULT_SEARCH_ENGINE,
			search_query: search_params.query,
			count: limit,
		};
		if (merged_include.length > 0) {
			request_body.search_domain_filter = merged_include[0];
		}

		try {
			const data = await http_json<ZAISearchResponse>(
				this.name,
				`${config.search.zai.base_url}${SEARCH_PATH}`,
				{
					method: 'POST',
					headers: {
						Authorization: `Bearer ${api_key}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify(request_body),
					signal: make_signal(config.search.zai.timeout, params.signal),
				},
			);

			return (data.search_result ?? [])
				.filter((r): r is ZAISearchResultItem & { link: string } => Boolean(r.link))
				.map((r) => ({
					title: r.title ?? '',
					url: r.link,
					snippet: (r.content ?? '').trim(),
					source_provider: this.name,
					metadata: {
						...(r.media ? { media: r.media } : {}),
						...(r.publish_date ? { publish_date: r.publish_date } : {}),
						...(r.icon ? { icon: r.icon } : {}),
					},
				}));
		} catch (error) {
			handle_provider_error(error, this.name, 'fetch search results');
		}
	}
}

export const registration = {
	key: () => config.search.zai.api_key,
};
