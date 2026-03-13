import { http_json } from '../../../common/http.js';
import type { FetchProvider, FetchResult } from '../../../common/types.js';
import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
import { extract_markdown_title } from '../../../common/html.js';
import { config } from '../../../config/env.js';

// POST /v1/markdownify response
interface ScrapeGraphAIResponse {
	request_id: string;
	status: string;
	website_url: string;
	result: string | null;
	error: string;
}

export class ScrapeGraphAIFetchProvider implements FetchProvider {
	name = 'scrapegraphai';
	description = 'Fetch URL content using ScrapeGraphAI markdownify endpoint. Returns clean markdown.';

	async fetch_url(url: string): Promise<FetchResult> {
		const api_key = validate_api_key(config.fetch.scrapegraphai.api_key, this.name);

		try {
			const data = await http_json<ScrapeGraphAIResponse>(
				this.name,
				`${config.fetch.scrapegraphai.base_url}/v1/markdownify`,
				{
					method: 'POST',
					headers: {
						'SGAI-APIKEY': api_key,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						website_url: url,
					}),
					signal: AbortSignal.timeout(config.fetch.scrapegraphai.timeout),
				},
			);

			if (data.status === 'failed' || data.error) {
				throw new Error(`ScrapeGraphAI failed: ${data.error || 'unknown error'}`);
			}

			if (!data.result) {
				throw new Error('ScrapeGraphAI returned empty result');
			}

			return {
				url,
				title: extract_markdown_title(data.result),
				content: data.result,
				source_provider: this.name,
				metadata: { request_id: data.request_id },
			};
		} catch (error) {
			handle_provider_error(error, this.name, 'fetch URL content');
		}
	}
}

export const registration = {
	key: () => config.fetch.scrapegraphai.api_key,
};
