import { http_json } from '../../../common/http.js';
import type { FetchProvider, FetchResult } from '../../../common/types.js';
import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
import { extract_markdown_title } from '../../../common/html.js';
import { config } from '../../../config/env.js';

interface BrowserRenderingResponse {
	success: boolean;
	result?: string;
	errors?: Array<{ code: number; message: string }>;
}

export class CloudflareBrowserFetchProvider implements FetchProvider {
	name = 'cloudflare_browser';
	description = 'Fetch URL content using Cloudflare Browser Rendering. Renders JavaScript before extraction — ideal for SPAs and dynamic pages.';

	async fetch_url(url: string): Promise<FetchResult> {
		const account_id = validate_api_key(config.fetch.cloudflare_browser.account_id, this.name);
		const email = validate_api_key(config.fetch.cloudflare_browser.email, this.name);
		const api_key = validate_api_key(config.fetch.cloudflare_browser.api_key, this.name);

		try {
			const data = await http_json<BrowserRenderingResponse>(
				this.name,
				`https://api.cloudflare.com/client/v4/accounts/${account_id}/browser-rendering/markdown`,
				{
					method: 'POST',
					headers: {
						'X-Auth-Email': email,
						'X-Auth-Key': api_key,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						url,
						rejectResourceTypes: ['image', 'media', 'font'],
					}),
					signal: AbortSignal.timeout(config.fetch.cloudflare_browser.timeout),
				},
			);

			if (!data.success || !data.result) {
				const msg = data.errors?.map((e) => e.message).join('; ') ?? 'No content returned';
				throw new Error(`Cloudflare Browser Rendering failed: ${msg}`);
			}

			return {
				url,
				title: extract_markdown_title(data.result),
				content: data.result,
				source_provider: this.name,
			};
		} catch (error) {
			handle_provider_error(error, this.name, 'fetch URL content');
		}
	}
}

export const registration = {
	key: () => config.fetch.cloudflare_browser.account_id && config.fetch.cloudflare_browser.api_key && config.fetch.cloudflare_browser.email ? config.fetch.cloudflare_browser.account_id : undefined,
};
