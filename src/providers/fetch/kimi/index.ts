// Kimi coding-API fetch — backs the FetchURL tool in Kimi CLI.
// Sends the same identity headers Kimi CLI emits so requests look identical
// on the wire. Reference: tmp/kimi_search_fetch_demo.py
//
// Endpoint: POST https://api.kimi.com/coding/v1/fetch
// Body:     { url }
// Response (Accept: application/json): { url, markdown, title }
//
// Routed through Scrapfly residential proxy because api.kimi.com's CF WAF
// blocks Cloudflare-Workers ASN egress (TLS fingerprint + IP reputation).

import { ErrorType, ProviderError, type FetchProvider, type FetchResult } from '../../../common/types.js';
import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
import { extract_markdown_title } from '../../../common/html.js';
import { config } from '../../../config/env.js';
import { build_kimi_fetch_headers } from '../../search/kimi/headers.js';
import { proxy_post_via_scrapfly } from '../../search/kimi/scrapfly_proxy.js';

const FETCH_PATH = '/coding/v1/fetch';

interface KimiFetchResponse {
	url?: string;
	markdown?: string;
	title?: string;
}

export class KimiFetchProvider implements FetchProvider {
	name = 'kimi';
	description = 'Fetch URL content via Kimi (Moonshot AI) coding-API. Returns clean markdown.';

	async fetch_url(url: string): Promise<FetchResult> {
		const api_key = validate_api_key(config.fetch.kimi.api_key, this.name);
		const target_url = `${config.fetch.kimi.base_url}${FETCH_PATH}`;

		try {
			const proxied = await proxy_post_via_scrapfly(
				this.name,
				target_url,
				build_kimi_fetch_headers(api_key),
				JSON.stringify({ url }),
				config.fetch.kimi.timeout,
			);

			if (proxied.status < 200 || proxied.status >= 300) {
				throw new ProviderError(
					ErrorType.PROVIDER_ERROR,
					`Kimi fetch HTTP ${proxied.status}: ${proxied.body.slice(0, 200)}`,
					this.name,
				);
			}

			const data = JSON.parse(proxied.body) as KimiFetchResponse;
			const content = (data.markdown ?? '').trim();
			if (!content) {
				throw new Error('Kimi fetch returned empty markdown');
			}

			return {
				url: data.url ?? url,
				title: data.title?.trim() || extract_markdown_title(content),
				content,
				source_provider: this.name,
			};
		} catch (error) {
			handle_provider_error(error, this.name, 'fetch URL content');
		}
	}
}

export const registration = {
	key: () => config.fetch.kimi.api_key,
};
