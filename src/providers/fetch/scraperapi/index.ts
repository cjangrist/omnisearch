import type { FetchProvider, FetchResult } from '../../../common/types.js';
import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
import { http_text } from '../../../common/http.js';
import { extract_markdown_title } from '../../../common/html.js';
import { config } from '../../../config/env.js';

export class ScraperAPIFetchProvider implements FetchProvider {
	name = 'scraperapi';
	description = 'Fetch URL content using ScraperAPI. Returns native markdown output.';

	async fetch_url(url: string): Promise<FetchResult> {
		const api_key = validate_api_key(config.fetch.scraperapi.api_key, this.name);

		try {
			const api_url = new URL(config.fetch.scraperapi.base_url);
			api_url.searchParams.set('api_key', api_key);
			api_url.searchParams.set('url', url);
			api_url.searchParams.set('output_format', 'markdown');

			const content = await http_text(this.name, api_url.toString(), {
				method: 'GET',
				signal: AbortSignal.timeout(config.fetch.scraperapi.timeout),
			});

			if (!content) throw new Error('ScraperAPI returned empty content');

			return { url, title: extract_markdown_title(content), content, source_provider: this.name };
		} catch (error) {
			handle_provider_error(error, this.name, 'fetch URL content');
		}
	}
}

export const registration = {
	key: () => config.fetch.scraperapi.api_key,
};
