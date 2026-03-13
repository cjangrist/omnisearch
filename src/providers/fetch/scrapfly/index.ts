import { http_json } from '../../../common/http.js';
import type { FetchProvider, FetchResult } from '../../../common/types.js';
import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
import { extract_markdown_title } from '../../../common/html.js';
import { config } from '../../../config/env.js';

// GET /scrape returns JSON with result.content
interface ScrapflyResponse {
	result: {
		content: string;
		status_code: number;
		url: string;
		format: string;
	};
	config: Record<string, unknown>;
}

export class ScrapflyFetchProvider implements FetchProvider {
	name = 'scrapfly';
	description = 'Fetch URL content using Scrapfly.io. Returns markdown with anti-bot bypass.';

	async fetch_url(url: string): Promise<FetchResult> {
		const api_key = validate_api_key(config.fetch.scrapfly.api_key, this.name);

		try {
			// Scrapfly uses API key as query param
			const api_url = new URL(`${config.fetch.scrapfly.base_url}/scrape`);
			api_url.searchParams.set('key', api_key);
			api_url.searchParams.set('url', url);
			api_url.searchParams.set('format', 'markdown');

			const data = await http_json<ScrapflyResponse>(
				this.name,
				api_url.toString(),
				{
					method: 'GET',
					signal: AbortSignal.timeout(config.fetch.scrapfly.timeout),
				},
			);

			if (!data.result?.content) {
				throw new Error('Scrapfly returned empty content');
			}

			return {
				url,
				title: extract_markdown_title(data.result.content),
				content: data.result.content,
				source_provider: this.name,
				metadata: { status_code: data.result.status_code },
			};
		} catch (error) {
			handle_provider_error(error, this.name, 'fetch URL content');
		}
	}
}

export const registration = {
	key: () => config.fetch.scrapfly.api_key,
};
