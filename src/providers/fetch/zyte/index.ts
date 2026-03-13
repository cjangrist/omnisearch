import { http_json } from '../../../common/http.js';
import type { FetchProvider, FetchResult } from '../../../common/types.js';
import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
import { config } from '../../../config/env.js';

interface ZytePageContent {
	headline?: string;
	title?: string;
	itemMain?: string;
	canonicalUrl?: string;
	metadata?: Record<string, unknown>;
}

interface ZyteExtractResponse {
	url: string;
	statusCode: number;
	pageContent?: ZytePageContent;
}

export class ZyteFetchProvider implements FetchProvider {
	name = 'zyte';
	description = 'Extract clean page content using Zyte API automatic extraction. Returns structured text with headline, title, and main content.';

	async fetch_url(url: string): Promise<FetchResult> {
		const api_key = validate_api_key(config.fetch.zyte.api_key, this.name);

		try {
			const data = await http_json<ZyteExtractResponse>(
				this.name,
				`${config.fetch.zyte.base_url}/v1/extract`,
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Basic ${btoa(`${api_key}:`)}`,
					},
					body: JSON.stringify({
						url,
						pageContent: true,
					}),
					signal: AbortSignal.timeout(config.fetch.zyte.timeout),
				},
			);

			const page = data.pageContent;
			if (!page?.itemMain) {
				throw new Error('Zyte returned no page content');
			}

			return {
				url: page.canonicalUrl ?? data.url ?? url,
				title: page.title ?? page.headline ?? '',
				content: page.itemMain,
				source_provider: this.name,
				metadata: {
					...(page.headline && { headline: page.headline }),
					...(page.metadata && { zyte_metadata: page.metadata }),
				},
			};
		} catch (error) {
			handle_provider_error(error, this.name, 'fetch URL content');
		}
	}
}

export const registration = {
	key: () => config.fetch.zyte.api_key,
};
