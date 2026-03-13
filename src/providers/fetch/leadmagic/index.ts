import type { FetchProvider, FetchResult } from '../../../common/types.js';
import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
import { http_json } from '../../../common/http.js';
import { extract_markdown_title } from '../../../common/html.js';
import { config } from '../../../config/env.js';

export class LeadMagicFetchProvider implements FetchProvider {
	name = 'leadmagic';
	description = 'Fetch URL content using LeadMagic Web2MD API. Returns clean markdown with boilerplate removed.';

	async fetch_url(url: string): Promise<FetchResult> {
		const api_key = validate_api_key(config.fetch.leadmagic.api_key, this.name);

		try {
			const data = await http_json<{
				markdown?: string;
				title?: string;
				url?: string;
			}>(this.name, `${config.fetch.leadmagic.base_url}/api/scrape`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-API-Key': api_key,
				},
				body: JSON.stringify({ url }),
				signal: AbortSignal.timeout(config.fetch.leadmagic.timeout),
			});

			const content = data.markdown;
			if (!content) {
				throw new Error('LeadMagic returned empty markdown');
			}

			const title = data.title || extract_markdown_title(content);

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
	key: () => config.fetch.leadmagic.api_key,
};
