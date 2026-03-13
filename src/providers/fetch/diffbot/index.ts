import { http_json } from '../../../common/http.js';
import type { FetchProvider, FetchResult } from '../../../common/types.js';
import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
import { config } from '../../../config/env.js';

interface DiffbotArticleResponse {
	objects?: Array<{
		title?: string;
		text?: string;
		html?: string;
		author?: string;
		date?: string;
		siteName?: string;
		images?: Array<{ url: string; caption?: string }>;
	}>;
}

export class DiffbotFetchProvider implements FetchProvider {
	name = 'diffbot';
	description = 'Extract structured article content using Diffbot Article API. Rich metadata including author, date, images.';

	async fetch_url(url: string): Promise<FetchResult> {
		const token = validate_api_key(config.fetch.diffbot.api_key, this.name);

		try {
			const api_url = `${config.fetch.diffbot.base_url}/v3/article?token=${encodeURIComponent(token)}&url=${encodeURIComponent(url)}`;

			const data = await http_json<DiffbotArticleResponse>(
				this.name,
				api_url,
				{
					method: 'GET',
					signal: AbortSignal.timeout(config.fetch.diffbot.timeout),
				},
			);

			const article = data.objects?.[0];
			if (!article?.text) {
				throw new Error('Diffbot returned no article content');
			}

			return {
				url,
				title: article.title ?? '',
				content: article.text,
				source_provider: this.name,
				metadata: {
					...(article.author && { author: article.author }),
					...(article.date && { date: article.date }),
					...(article.siteName && { site_name: article.siteName }),
					...(article.images?.length && { image_count: article.images.length }),
				},
			};
		} catch (error) {
			handle_provider_error(error, this.name, 'fetch URL content');
		}
	}
}

export const registration = {
	key: () => config.fetch.diffbot.api_key,
};
