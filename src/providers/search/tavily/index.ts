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
import {
	apply_search_operators,
	parse_search_operators,
} from '../../../common/search_operators.js';
import { config } from '../../../config/env.js';

const DEFAULT_LIMIT = 20;
const DEFAULT_SEARCH_DEPTH = 'basic';
const DEFAULT_TOPIC = 'general';

interface TavilySearchResponse {
	results: {
		title: string;
		url: string;
		content: string;
		score: number;
	}[];
	response_time: string;
}

export class TavilySearchProvider implements SearchProvider {
	name = 'tavily';
	description =
		'Search the web using Tavily Search API. Best for factual queries requiring reliable sources and citations. Supports domain filtering through API parameters (include_domains/exclude_domains). Provides high-quality results for technical, scientific, and academic topics. Use when you need verified information with strong citation support.';

	async search(params: BaseSearchParams): Promise<SearchResult[]> {
		const api_key = validate_api_key(
			config.search.tavily.api_key,
			this.name,
		);

		// Parse search operators from the query
		const parsed_query = parse_search_operators(params.query);
		const search_params = apply_search_operators(parsed_query);

		try {
			// Merge operator-derived domains with explicit params
			const include_domains = [
				...(params.include_domains ?? []),
				...(search_params.include_domains ?? []),
			];
			const exclude_domains = [
				...(params.exclude_domains ?? []),
				...(search_params.exclude_domains ?? []),
			];

			// Only use officially supported parameters
			const request_body: Record<string, unknown> = {
				query: search_params.query,
				max_results: params.limit ?? DEFAULT_LIMIT,
				include_domains,
				exclude_domains,
				search_depth: DEFAULT_SEARCH_DEPTH,
				topic: DEFAULT_TOPIC,
			};

			const data = await http_json<
				TavilySearchResponse & { message?: string }
			>(this.name, `${config.search.tavily.base_url}/search`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${api_key}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(request_body),
			signal: make_signal(config.search.tavily.timeout, params.signal),
			});

			return (data.results || []).map((result) => ({
				title: result.title,
				url: result.url,
				snippet: result.content,
				score: result.score,
				source_provider: this.name,
			}));
		} catch (error) {
			handle_provider_error(error, this.name, 'fetch search results');
		}
	}
}

export const registration = {
	key: () => config.search.tavily.api_key,
};
