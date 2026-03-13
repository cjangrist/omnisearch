import { http_json } from '../../../common/http.js';
import type { FetchProvider, FetchResult } from '../../../common/types.js';
import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
import { config } from '../../../config/env.js';

interface JinaReaderResponse {
	code: number;
	data: {
		title?: string;
		url?: string;
		content?: string;
		usage?: { tokens?: number };
	};
}

export class JinaFetchProvider implements FetchProvider {
	name = 'jina';
	description = 'Read a URL as markdown using Jina Reader API. Fast and token-efficient.';

	async fetch_url(url: string): Promise<FetchResult> {
		const api_key = validate_api_key(config.fetch.jina.api_key, this.name);

		try {
			const data = await http_json<JinaReaderResponse>(
				this.name,
				`${config.fetch.jina.base_url}/`,
				{
					method: 'POST',
					headers: {
						Authorization: `Bearer ${api_key}`,
						'Content-Type': 'application/json',
						Accept: 'application/json',
						'X-Return-Format': 'markdown',
					},
					body: JSON.stringify({ url }),
					signal: AbortSignal.timeout(config.fetch.jina.timeout),
				},
			);

			if (!data.data?.content) {
				throw new Error('Jina Reader returned no content');
			}

			return {
				url: data.data.url ?? url,
				title: data.data.title ?? '',
				content: data.data.content,
				source_provider: this.name,
				metadata: data.data.usage?.tokens ? { tokens: data.data.usage.tokens } : undefined,
			};
		} catch (error) {
			handle_provider_error(error, this.name, 'fetch URL content');
		}
	}
}

export const registration = {
	key: () => config.fetch.jina.api_key,
};
