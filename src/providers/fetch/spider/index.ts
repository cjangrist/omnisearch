import { http_json } from '../../../common/http.js';
import type { FetchProvider, FetchResult } from '../../../common/types.js';
import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
import { extract_markdown_title } from '../../../common/html.js';
import { config } from '../../../config/env.js';

// POST /scrape returns an array of page objects
interface SpiderPage {
	url: string;
	status: number;
	content: string;
	error: string | null;
}

export class SpiderFetchProvider implements FetchProvider {
	name = 'spider';
	description = 'Fetch URL content using Spider.cloud. Returns markdown via smart request mode.';

	async fetch_url(url: string): Promise<FetchResult> {
		const api_key = validate_api_key(config.fetch.spider.api_key, this.name);

		try {
			const data = await http_json<SpiderPage[]>(
				this.name,
				`${config.fetch.spider.base_url}/scrape`,
				{
					method: 'POST',
					headers: {
						Authorization: `Bearer ${api_key}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						url,
						return_format: 'markdown',
					}),
					signal: AbortSignal.timeout(config.fetch.spider.timeout),
				},
			);

			if (!Array.isArray(data) || data.length === 0) {
				throw new Error('Spider returned empty response');
			}

			const page = data[0];
			if (page.error) {
				throw new Error(`Spider scrape error: ${page.error}`);
			}
			if (!page.content) {
				throw new Error('Spider returned empty content');
			}

			return {
				url,
				title: extract_markdown_title(page.content),
				content: page.content,
				source_provider: this.name,
				metadata: { status: page.status },
			};
		} catch (error) {
			handle_provider_error(error, this.name, 'fetch URL content');
		}
	}
}

export const registration = {
	key: () => config.fetch.spider.api_key,
};
