import type { FetchProvider, FetchResult } from '../../../common/types.js';
import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
import { http_json } from '../../../common/http.js';
import { extract_markdown_title } from '../../../common/html.js';
import { config } from '../../../config/env.js';

export class OlostepFetchProvider implements FetchProvider {
	name = 'olostep';
	description = 'Fetch URL content using Olostep. Returns markdown with JS rendering and residential proxies by default.';

	async fetch_url(url: string): Promise<FetchResult> {
		const api_key = validate_api_key(config.fetch.olostep.api_key, this.name);

		try {
			const data = await http_json<{
				result: {
					markdown_content?: string;
					html_content?: string;
					markdown_hosted_url?: string;
				};
			}>(this.name, `${config.fetch.olostep.base_url}/v1/scrapes`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${api_key}`,
				},
				body: JSON.stringify({
					url,
					formats: ['markdown'],
				}),
				signal: AbortSignal.timeout(config.fetch.olostep.timeout),
			});

			const content = data.result?.markdown_content;
			if (!content) {
				throw new Error('Olostep returned empty markdown content');
			}

			const title = extract_markdown_title(content);

			return {
				url,
				title,
				content,
				source_provider: this.name,
			};
		} catch (error) {
			handle_provider_error(error, this.name, 'fetch URL content');
		}
	}
}

export const registration = {
	key: () => config.fetch.olostep.api_key,
};
