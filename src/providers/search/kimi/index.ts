// Kimi coding-API search — backs the SearchWeb tool in Kimi CLI.
// Sends the same identity headers Kimi CLI emits so requests look identical
// on the wire. Reference: tmp/kimi_search_fetch_demo.py
//
// Endpoint: POST https://api.kimi.com/coding/v1/search
// Body:     { text_query, limit, enable_page_crawling: false, timeout_seconds: 30 }
// Response: { search_results: [{ title, url, snippet, date, site_name }] }
//
// Routed through Scrapfly residential proxy because api.kimi.com's CF WAF
// blocks Cloudflare-Workers ASN egress (TLS fingerprint + IP reputation).

import {
	BaseSearchParams,
	ErrorType,
	ProviderError,
	SearchProvider,
	SearchResult,
} from '../../../common/types.js';
import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
import { config } from '../../../config/env.js';
import { build_kimi_search_headers } from './headers.js';
import { proxy_post_via_scrapfly } from './scrapfly_proxy.js';

const DEFAULT_LIMIT = 20;
const ENABLE_PAGE_CRAWLING = false;
const REMOTE_TIMEOUT_SECONDS = 30;
const SEARCH_PATH = '/coding/v1/search';

interface KimiSearchResult {
	title?: string;
	url?: string;
	snippet?: string;
	date?: string;
	site_name?: string;
}

interface KimiSearchResponse {
	search_results?: KimiSearchResult[];
}

export class KimiSearchProvider implements SearchProvider {
	name = 'kimi';
	description =
		'Kimi (Moonshot AI) coding-API web search. Returns titled, dated snippets with site attribution. Powers the SearchWeb tool in the Kimi CLI.';

	async search(params: BaseSearchParams): Promise<SearchResult[]> {
		const api_key = validate_api_key(config.search.kimi.api_key, this.name);
		const target_url = `${config.search.kimi.base_url}${SEARCH_PATH}`;
		const target_body = JSON.stringify({
			text_query: params.query,
			limit: params.limit ?? DEFAULT_LIMIT,
			enable_page_crawling: ENABLE_PAGE_CRAWLING,
			timeout_seconds: REMOTE_TIMEOUT_SECONDS,
		});

		try {
			const proxied = await proxy_post_via_scrapfly(
				this.name,
				target_url,
				build_kimi_search_headers(api_key),
				target_body,
				config.search.kimi.timeout,
			);

			if (proxied.status < 200 || proxied.status >= 300) {
				throw new ProviderError(
					ErrorType.PROVIDER_ERROR,
					`Kimi search HTTP ${proxied.status}: ${proxied.body.slice(0, 200)}`,
					this.name,
				);
			}

			const data = JSON.parse(proxied.body) as KimiSearchResponse;
			return (data.search_results ?? [])
				.filter((r): r is KimiSearchResult & { url: string } => Boolean(r.url))
				.map((result) => ({
					title: result.title ?? '',
					url: result.url,
					snippet: (result.snippet ?? '').trim(),
					source_provider: this.name,
					metadata: {
						...(result.date ? { date: result.date } : {}),
						...(result.site_name ? { site_name: result.site_name } : {}),
					},
				}));
		} catch (error) {
			handle_provider_error(error, this.name, 'fetch search results');
		}
	}
}

export const registration = {
	key: () => config.search.kimi.api_key,
};
