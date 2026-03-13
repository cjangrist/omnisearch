import { http_json } from '../../../common/http.js';
import type { FetchProvider, FetchResult } from '../../../common/types.js';
import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
import { extract_markdown_title } from '../../../common/html.js';
import { config } from '../../../config/env.js';

interface LinkupFetchResponse {
	markdown: string;
}

export class LinkupFetchProvider implements FetchProvider {
	name = 'linkup';
	description = 'Fetch URL content using Linkup Content Fetch API. Returns clean markdown.';

	async fetch_url(url: string): Promise<FetchResult> {
		const api_key = validate_api_key(config.fetch.linkup.api_key, this.name);

		try {
			const data = await http_json<LinkupFetchResponse>(
				this.name,
				`${config.fetch.linkup.base_url}/v1/fetch`,
				{
					method: 'POST',
					headers: {
						Authorization: `Bearer ${api_key}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({ url }),
					signal: AbortSignal.timeout(config.fetch.linkup.timeout),
				},
			);

			if (!data.markdown) {
				throw new Error('Linkup returned no markdown content');
			}

			return {
				url,
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
	key: () => config.fetch.linkup.api_key,
};
