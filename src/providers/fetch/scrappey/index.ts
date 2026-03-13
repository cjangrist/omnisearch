import type { FetchProvider, FetchResult } from '../../../common/types.js';
import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
import { http_json } from '../../../common/http.js';
import { extract_html_title } from '../../../common/html.js';
import { config } from '../../../config/env.js';

export class ScrappeyFetchProvider implements FetchProvider {
	name = 'scrappey';
	description = 'Fetch URL content using Scrappey headless browser API. Returns extracted page text.';

	async fetch_url(url: string): Promise<FetchResult> {
		const api_key = validate_api_key(config.fetch.scrappey.api_key, this.name);

		try {
			const data = await http_json<{
				solution: {
					innerText?: string;
					response?: string;
					currentUrl?: string;
					statusCode?: number;
				};
				data: string;
			}>(this.name, `${config.fetch.scrappey.base_url}/api/v1?key=${encodeURIComponent(api_key)}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					cmd: 'request.get',
					url,
				}),
				signal: AbortSignal.timeout(config.fetch.scrappey.timeout),
			});

			if (data.data !== 'success' || !data.solution) {
				throw new Error(`Scrappey request failed: ${data.data}`);
			}

			const content = data.solution.innerText;
			if (!content) {
				throw new Error('Scrappey returned empty innerText');
			}

			const title = data.solution.response ? extract_html_title(data.solution.response) : '';

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
	key: () => config.fetch.scrappey.api_key,
};
