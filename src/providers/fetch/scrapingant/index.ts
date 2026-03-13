import { http_json } from '../../../common/http.js';
import type { FetchProvider, FetchResult } from '../../../common/types.js';
import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
import { extract_markdown_title } from '../../../common/html.js';
import { config } from '../../../config/env.js';

interface ScrapingAntMarkdownResponse {
	url: string;
	markdown: string;
}

export class ScrapingAntFetchProvider implements FetchProvider {
	name = 'scrapingant';
	description = 'Extract page content as markdown using ScrapingAnt LLM-ready endpoint.';

	async fetch_url(url: string): Promise<FetchResult> {
		const api_key = validate_api_key(config.fetch.scrapingant.api_key, this.name);

		try {
			const params = new URLSearchParams({
				url,
				'x-api-key': api_key,
			});
			const api_url = `${config.fetch.scrapingant.base_url}/v2/markdown?${params.toString()}`;

			const data = await http_json<ScrapingAntMarkdownResponse>(
				this.name,
				api_url,
				{
					method: 'GET',
					signal: AbortSignal.timeout(config.fetch.scrapingant.timeout),
				},
			);

			if (!data.markdown) {
				throw new Error('ScrapingAnt returned no markdown content');
			}

			return {
				url: data.url ?? url,
				title: extract_markdown_title(data.markdown),
				content: data.markdown,
				source_provider: this.name,
			};
		} catch (error) {
			handle_provider_error(error, this.name, 'fetch URL content');
		}
	}
}

export const registration = {
	key: () => config.fetch.scrapingant.api_key,
};
