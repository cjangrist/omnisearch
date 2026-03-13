import { http_json } from '../../../common/http.js';
import type { FetchProvider, FetchResult } from '../../../common/types.js';
import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
import { config } from '../../../config/env.js';

interface YouContentsResponse {
	url: string;
	title?: string;
	markdown?: string | null;
}

export class YouFetchProvider implements FetchProvider {
	name = 'you';
	description = 'Fetch URL content using You.com Contents API. Returns markdown with metadata.';

	async fetch_url(url: string): Promise<FetchResult> {
		const api_key = validate_api_key(config.fetch.you.api_key, this.name);

		try {
			const data = await http_json<YouContentsResponse[]>(
				this.name,
				`${config.fetch.you.base_url}/v1/contents`,
				{
					method: 'POST',
					headers: {
						'X-API-Key': api_key,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						urls: [url],
						formats: ['markdown'],
					}),
					signal: AbortSignal.timeout(config.fetch.you.timeout),
				},
			);

			const result = Array.isArray(data) ? data[0] : undefined;
			if (!result?.markdown) {
				throw new Error('You.com Contents returned no markdown');
			}

			return {
				url: result.url ?? url,
				title: result.title ?? '',
				content: result.markdown,
				source_provider: this.name,
			};
		} catch (error) {
			handle_provider_error(error, this.name, 'fetch URL content');
		}
	}
}

export const registration = {
	key: () => config.fetch.you.api_key,
};
