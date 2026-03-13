import { http_json } from '../../../common/http.js';
import type { FetchProvider, FetchResult } from '../../../common/types.js';
import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
import { extract_markdown_title } from '../../../common/html.js';
import { config } from '../../../config/env.js';

// POST /api/v2/unlocker/request response
interface ScrapelessResponse {
	code: number;
	data: string;
}

export class ScrapelessFetchProvider implements FetchProvider {
	name = 'scrapeless';
	description = 'Fetch URL content using Scrapeless Web Unlocker. Returns markdown with JS rendering.';

	async fetch_url(url: string): Promise<FetchResult> {
		const api_key = validate_api_key(config.fetch.scrapeless.api_key, this.name);

		try {
			const data = await http_json<ScrapelessResponse>(
				this.name,
				`${config.fetch.scrapeless.base_url}/api/v2/unlocker/request`,
				{
					method: 'POST',
					headers: {
						'x-api-token': api_key,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						actor: 'unlocker.webunlocker',
						input: {
							url,
							method: 'GET',
							redirect: false,
							jsRender: {
								enabled: true,
								response: { type: 'markdown' },
							},
						},
						proxy: { country: 'ANY' },
					}),
					signal: AbortSignal.timeout(config.fetch.scrapeless.timeout),
				},
			);

			if (data.code !== 200) {
				throw new Error(`Scrapeless returned code ${data.code}`);
			}

			if (!data.data) {
				throw new Error('Scrapeless returned empty data');
			}

			return {
				url,
				title: extract_markdown_title(data.data),
				content: data.data,
				source_provider: this.name,
			};
		} catch (error) {
			handle_provider_error(error, this.name, 'fetch URL content');
		}
	}
}

export const registration = {
	key: () => config.fetch.scrapeless.api_key,
};
