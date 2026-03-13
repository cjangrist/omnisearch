import type { FetchProvider, FetchResult } from '../../../common/types.js';
import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
import { http_json } from '../../../common/http.js';
import { extract_markdown_title } from '../../../common/html.js';
import { config } from '../../../config/env.js';

export class OxylabsFetchProvider implements FetchProvider {
	name = 'oxylabs';
	description = 'Fetch URL content using Oxylabs Web Scraper API. Returns markdown via realtime endpoint.';

	async fetch_url(url: string): Promise<FetchResult> {
		const username = validate_api_key(config.fetch.oxylabs.username, this.name);
		const password = validate_api_key(config.fetch.oxylabs.password, this.name);

		try {
			const auth = btoa(`${username}:${password}`);
			const data = await http_json<{
				results: Array<{ content: string; status_code: number }>;
			}>(this.name, `${config.fetch.oxylabs.base_url}/v1/queries`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Basic ${auth}`,
				},
				body: JSON.stringify({
					source: 'universal',
					url,
					markdown: true,
				}),
				signal: AbortSignal.timeout(config.fetch.oxylabs.timeout),
			});

			const result = data.results?.[0];
			if (!result?.content) {
				throw new Error('Oxylabs returned empty content');
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
	key: () => config.fetch.oxylabs.username && config.fetch.oxylabs.password ? config.fetch.oxylabs.username : undefined,
};
