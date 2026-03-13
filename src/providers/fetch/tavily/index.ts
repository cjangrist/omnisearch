import { http_json } from '../../../common/http.js';
import type { FetchProvider, FetchResult } from '../../../common/types.js';
import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
import { extract_markdown_title } from '../../../common/html.js';
import { config } from '../../../config/env.js';

interface TavilyExtractResponse {
	results: Array<{ url: string; raw_content: string }>;
	failed_results: Array<{ url: string; error: string }>;
}

export class TavilyFetchProvider implements FetchProvider {
	name = 'tavily';
	description = 'Extract page content using Tavily Extract API. Returns markdown with basic or advanced extraction depth.';

	async fetch_url(url: string): Promise<FetchResult> {
		const api_key = validate_api_key(config.fetch.tavily.api_key, this.name);

		try {
			const data = await http_json<TavilyExtractResponse>(
				this.name,
				`${config.fetch.tavily.base_url}/extract`,
				{
					method: 'POST',
					headers: {
						Authorization: `Bearer ${api_key}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						urls: [url],
						extract_depth: 'basic',
						format: 'markdown',
					}),
					signal: AbortSignal.timeout(config.fetch.tavily.timeout),
				},
			);

			if (data.failed_results?.length > 0 && (!data.results || data.results.length === 0)) {
				throw new Error(`Tavily extraction failed: ${data.failed_results[0].error}`);
			}

			const result = data.results?.[0];
			if (!result) throw new Error('No content returned from Tavily extract');

			return {
				url: result.url,
				title: extract_markdown_title(result.raw_content),
				content: result.raw_content,
				source_provider: this.name,
			};
		} catch (error) {
			handle_provider_error(error, this.name, 'fetch URL content');
		}
	}
}

export const registration = {
	key: () => config.fetch.tavily.api_key,
};
