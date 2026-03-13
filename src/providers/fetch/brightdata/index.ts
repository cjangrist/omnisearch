import type { FetchProvider, FetchResult } from '../../../common/types.js';
import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
import { http_text } from '../../../common/http.js';
import { extract_markdown_title } from '../../../common/html.js';
import { config } from '../../../config/env.js';

export class BrightDataFetchProvider implements FetchProvider {
	name = 'brightdata';
	description = 'Fetch URL content using BrightData Web Unlocker. Returns native markdown with anti-bot bypass.';

	async fetch_url(url: string): Promise<FetchResult> {
		const api_key = validate_api_key(config.fetch.brightdata.api_key, this.name);

		try {
			const content = await http_text(
				this.name,
				`${config.fetch.brightdata.base_url}/request`,
				{
					method: 'POST',
					headers: {
						Authorization: `Bearer ${api_key}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						zone: config.fetch.brightdata.zone,
						url,
						format: 'raw',
						data_format: 'markdown',
					}),
					signal: AbortSignal.timeout(config.fetch.brightdata.timeout),
				},
			);

			if (!content) {
				throw new Error('BrightData returned empty markdown');
			}

			return {
				url,
				title: extract_markdown_title(content),
				content,
				source_provider: this.name,
			};
		} catch (error) {
			handle_provider_error(error, this.name, 'fetch URL content');
		}
	}
}

export const registration = {
	key: () => config.fetch.brightdata.api_key,
};
