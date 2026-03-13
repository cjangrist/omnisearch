import { http_json } from '../../../common/http.js';
import type { FetchProvider, FetchResult } from '../../../common/types.js';
import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
import { config } from '../../../config/env.js';

// GET /api/1.1/extract/{url} returns structured extracted content
interface OpenGraphExtractResponse {
	tags: Array<{ tag: string; innerText: string; position: number }>;
	concatenatedText: string;
	requestInfo: {
		host: string;
		responseCode: number;
	};
}

export class OpenGraphFetchProvider implements FetchProvider {
	name = 'opengraph';
	description = 'Fetch URL content using OpenGraph.io Extract API. Returns structured text extraction.';

	async fetch_url(url: string): Promise<FetchResult> {
		const api_key = validate_api_key(config.fetch.opengraph.api_key, this.name);

		try {
			const encoded_url = encodeURIComponent(url);
			const api_url = `${config.fetch.opengraph.base_url}/api/1.1/extract/${encoded_url}?app_id=${api_key}`;

			const data = await http_json<OpenGraphExtractResponse>(
				this.name,
				api_url,
				{
					method: 'GET',
					signal: AbortSignal.timeout(config.fetch.opengraph.timeout),
				},
			);

			if (!data.concatenatedText && (!data.tags || data.tags.length === 0)) {
				throw new Error('OpenGraph.io returned empty extraction');
			}

			// Use concatenatedText if available, otherwise build from tags
			const content = data.concatenatedText ||
				data.tags.map((t) => t.innerText).join('\n\n');

			if (!content) {
				throw new Error('OpenGraph.io returned empty content');
			}

			// Extract title from tags if available
			const title_tag = data.tags?.find((t) => t.tag === 'title' || t.tag === 'h1');

			return {
				url,
				title: title_tag?.innerText ?? '',
				content,
				source_provider: this.name,
				metadata: {
					response_code: data.requestInfo?.responseCode,
					tag_count: data.tags?.length,
				},
			};
		} catch (error) {
			handle_provider_error(error, this.name, 'fetch URL content');
		}
	}
}

export const registration = {
	key: () => config.fetch.opengraph.api_key,
};
