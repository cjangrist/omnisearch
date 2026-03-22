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

interface YouWebResult {
	url: string;
	title: string;
	description: string;
	snippets?: string[];
	page_age?: string;
	authors?: string[];
	thumbnail_url?: string;
}

interface YouSearchResponse {
	results: {
		web?: YouWebResult[];
		news?: Array<{
			title: string;
			url: string;
			description: string;
		}>;
	};
	metadata?: {
		search_uuid: string;
		query: string;
		latency: number;
	};
}

export class YouSearchProvider implements SearchProvider {
	name = 'you';
	description =
		'You.com web search with LLM-optimized snippets. Returns structured results with multiple query-aware text excerpts per page. Supports search operators, freshness filtering, and domain/language targeting.';

	async search(params: BaseSearchParams): Promise<SearchResult[]> {
		const api_key = validate_api_key(
			config.search.you.api_key,
			this.name,
		);

		try {
			const query_params = new URLSearchParams({
				query: params.query,
				count: (params.limit ?? DEFAULT_LIMIT).toString(),
			});

			const data = await http_json<YouSearchResponse>(
				this.name,
				`${config.search.you.base_url}/search?${query_params}`,
				{
					method: 'GET',
					headers: {
						'X-API-Key': api_key,
						Accept: 'application/json',
					},
					signal: make_signal(config.search.you.timeout, params.signal),
				},
			);

			return (data.results?.web || []).map((result) => ({
				title: result.title,
				url: result.url,
				snippet:
					result.snippets?.join(' ') ||
					result.description ||
					'',
				source_provider: this.name,
			}));
		} catch (error) {
			handle_provider_error(error, this.name, 'fetch search results');
		}
	}
}

export const registration = {
	key: () => config.search.you.api_key,
};
