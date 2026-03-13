import type { FetchProvider, FetchResult } from '../../../common/types.js';
import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
import { http_json } from '../../../common/http.js';
import { extract_markdown_title } from '../../../common/html.js';
import { config } from '../../../config/env.js';

export class DecodoFetchProvider implements FetchProvider {
	name = 'decodo';
	description = 'Fetch URL content using Decodo (Smartproxy) Web Scraper API. Returns markdown output.';

	async fetch_url(url: string): Promise<FetchResult> {
		const api_key = validate_api_key(config.fetch.decodo.api_key, this.name);

		try {
			// api_key is already base64-encoded username:password
			const data = await http_json<{
				results: Array<{ content: string; status_code: number; task_id: string }>;
			}>(this.name, `${config.fetch.decodo.base_url}/v2/scrape`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Accept: 'application/json',
					Authorization: `Basic ${api_key}`,
				},
				body: JSON.stringify({
					url,
					markdown: true,
				}),
				signal: AbortSignal.timeout(config.fetch.decodo.timeout),
			});

			const result = data.results?.[0];
			if (!result?.content) {
				throw new Error('Decodo returned empty content');
			}

			const title = extract_markdown_title(result.content);

			return {
				url,
				title,
				content: result.content,
				source_provider: this.name,
			};
		} catch (error) {
			handle_provider_error(error, this.name, 'fetch URL content');
		}
	}
}

export const registration = {
	key: () => config.fetch.decodo.api_key,
};
