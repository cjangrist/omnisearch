import { http_json } from '../../../common/http.js';
import type { FetchProvider, FetchResult } from '../../../common/types.js';
import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
import { config } from '../../../config/env.js';

interface FirecrawlScrapeResponse {
	success: boolean;
	data: {
		markdown?: string;
		metadata?: {
			title?: string;
			description?: string;
			sourceURL?: string;
			statusCode?: number;
		};
	};
}

export class FirecrawlFetchProvider implements FetchProvider {
	name = 'firecrawl';
	description = 'Scrape a single URL using Firecrawl v2 API. Returns clean markdown with metadata.';

	async fetch_url(url: string): Promise<FetchResult> {
		const api_key = validate_api_key(config.fetch.firecrawl.api_key, this.name);

		try {
			const data = await http_json<FirecrawlScrapeResponse>(
				this.name,
				`${config.fetch.firecrawl.base_url}/v2/scrape`,
				{
					method: 'POST',
					headers: {
						Authorization: `Bearer ${api_key}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						url,
						formats: ['markdown'],
						onlyMainContent: true,
					}),
					signal: AbortSignal.timeout(config.fetch.firecrawl.timeout),
				},
			);

			if (!data.success || !data.data?.markdown) {
				throw new Error('Firecrawl scrape returned no content');
			}

			return {
				url: data.data.metadata?.sourceURL ?? url,
				title: data.data.metadata?.title ?? '',
				content: data.data.markdown,
				source_provider: this.name,
				metadata: data.data.metadata ? {
					description: data.data.metadata.description,
					status_code: data.data.metadata.statusCode,
				} : undefined,
			};
		} catch (error) {
			handle_provider_error(error, this.name, 'fetch URL content');
		}
	}
}

export const registration = {
	key: () => config.fetch.firecrawl.api_key,
};
