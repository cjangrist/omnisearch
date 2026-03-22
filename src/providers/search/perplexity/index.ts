import { http_json } from '../../../common/http.js';
import {
	BaseSearchParams,
	SearchProvider,
	SearchResult,
} from '../../../common/types.js';
import {
	handle_provider_error,
	make_signal,
	validate_api_key,
} from '../../../common/utils.js';
import { config } from '../../../config/env.js';

const DEFAULT_LIMIT = 20;
const SEARCH_MODEL = 'sonar';
const SEARCH_TEMPERATURE = 0.1;
const SEARCH_MAX_TOKENS = 256;
const SEARCH_CONTEXT_SIZE = 'high';
const DEFAULT_TITLE = 'Source';

interface PerplexitySearchResponse {
	choices?: Array<{
		message?: {
			content?: string;
		};
	}>;
	citations?: string[];
	search_results?: Array<{
		title?: string;
		url: string;
		snippet?: string;
	}>;
}

export class PerplexitySearchProvider implements SearchProvider {
	name = 'perplexity';
	description =
		'Perplexity web search via sonar model. Returns citation URLs from AI-grounded web search.';

	async search(params: BaseSearchParams): Promise<SearchResult[]> {
		const api_key = validate_api_key(
			config.search.perplexity.api_key,
			this.name,
		);

		try {
			const data = await http_json<PerplexitySearchResponse>(
				this.name,
				`${config.search.perplexity.base_url}/chat/completions`,
				{
					method: 'POST',
					headers: {
						accept: 'application/json',
						'content-type': 'application/json',
						Authorization: `Bearer ${api_key}`,
					},
					body: JSON.stringify({
						model: SEARCH_MODEL,
						messages: [
							{
								role: 'user',
								content: params.query,
							},
						],
						temperature: SEARCH_TEMPERATURE,
						max_tokens: SEARCH_MAX_TOKENS,
						web_search_options: {
							search_context_size: SEARCH_CONTEXT_SIZE,
						},
					}),
					signal: make_signal(
						config.search.perplexity.timeout, params.signal,
					),
				},
			);

			// Extract structured search_results if available
			if (data.search_results && data.search_results.length > 0) {
				return data.search_results
					.filter((r) => r.url)
					.slice(0, params.limit ?? DEFAULT_LIMIT)
					.map((r) => ({
						title: r.title || DEFAULT_TITLE,
						url: r.url,
						snippet: r.snippet || '',
						source_provider: this.name,
					}));
			}

			// Fall back to citations (URL-only)
			const citations = data.citations || [];
			if (citations.length === 0) {
				return [];
			}

			return citations.slice(0, params.limit ?? DEFAULT_LIMIT).map((url) => ({
				title: DEFAULT_TITLE,
				url,
				snippet: '',
				source_provider: this.name,
			}));
		} catch (error) {
			handle_provider_error(
				error,
				this.name,
				'fetch Perplexity search results',
			);
		}
	}
}

export const registration = {
	key: () => config.search.perplexity.api_key,
};
