import type { FetchProvider, FetchResult } from '../../../common/types.js';
import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
import { http_text } from '../../../common/http.js';
import { extract_markdown_title } from '../../../common/html.js';
import { config } from '../../../config/env.js';

export class ScrapingBeeFetchProvider implements FetchProvider {
	name = 'scrapingbee';
	description = 'Fetch URL content using ScrapingBee. Returns native markdown output.';

	async fetch_url(url: string): Promise<FetchResult> {
		const api_key = validate_api_key(config.fetch.scrapingbee.api_key, this.name);

		try {
			const api_url = new URL(`${config.fetch.scrapingbee.base_url}/api/v1`);
			api_url.searchParams.set('api_key', api_key);
			api_url.searchParams.set('url', url);
			api_url.searchParams.set('render_js', 'false');
			api_url.searchParams.set('return_page_markdown', 'true');

			const content = await http_text(this.name, api_url.toString(), {
				method: 'GET',
				signal: AbortSignal.timeout(config.fetch.scrapingbee.timeout),
			});

			if (!content) throw new Error('ScrapingBee returned empty markdown');

			return {
				url,
				title: extract_markdown_title(content),
				content,
				source_provider: this.name,
			};
		} catch (error) {
			handle_provider_error(error, this.name, 'fetch URL content');
		}
	}
}

export const registration = {
	key: () => config.fetch.scrapingbee.api_key,
};
