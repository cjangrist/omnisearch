import { http_json } from '../../../common/http.js';
import {
	BaseSearchParams,
	ErrorType,
	ProviderError,
	SearchProvider,
	SearchResult,
} from '../../../common/types.js';
import {
	handle_provider_error,
	make_signal,
	validate_api_key,
} from '../../../common/utils.js';
import { config } from '../../../config/env.js';

const DEFAULT_SEARCH_DEPTH = 'advanced';
const DEFAULT_ANSWER_MODE = 'advanced';
const DEFAULT_MAX_RESULTS = 20;
const DEFAULT_CHUNKS_PER_SOURCE = 3;
const DEFAULT_TOPIC = 'general';
const RESULT_URL = 'https://tavily.com';
const PRIMARY_SCORE = 1.0;

interface TavilyAnswerResponse {
	query: string;
	answer?: string;
	results: Array<{
		title: string;
		url: string;
		content: string;
		score: number;
	}>;
	response_time: number;
	request_id?: string;
}

export class TavilyAnswerProvider implements SearchProvider {
	name = 'tavily_answer';
	description =
		'Tavily advanced search with synthesized AI answer. Returns a prose answer grounded in search results with citations. Uses search_depth=advanced and include_answer=advanced.';

	async search(params: BaseSearchParams): Promise<SearchResult[]> {
		const api_key = validate_api_key(
			config.ai_response.tavily_answer.api_key,
			this.name,
		);

		try {
			const response = await http_json<TavilyAnswerResponse>(
				this.name,
				`${config.ai_response.tavily_answer.base_url}/search`,
				{
					method: 'POST',
					headers: {
						Authorization: `Bearer ${api_key}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						query: params.query,
						search_depth: DEFAULT_SEARCH_DEPTH,
						include_answer: DEFAULT_ANSWER_MODE,
						max_results: DEFAULT_MAX_RESULTS,
						chunks_per_source: DEFAULT_CHUNKS_PER_SOURCE,
						topic: DEFAULT_TOPIC,
					}),
					signal: make_signal(config.ai_response.tavily_answer.timeout, params.signal),
				},
			);

			if (!response.answer) {
				throw new ProviderError(
					ErrorType.PROVIDER_ERROR,
					'No answer returned from Tavily advanced search',
					this.name,
				);
			}

			const results: SearchResult[] = [
				{
					title: 'Tavily Answer',
					url: RESULT_URL,
					snippet: response.answer,
					score: PRIMARY_SCORE,
					source_provider: this.name,
					metadata: {
						response_time: response.response_time,
						sources_count: response.results?.length,
					},
				},
			];

			// Add search results as citations
			if (response.results && response.results.length > 0) {
				for (const [index, r] of response.results.entries()) {
					results.push({
						title: r.title || `Source ${index + 1}`,
						url: r.url,
						snippet: r.content,
						score: r.score,
						source_provider: this.name,
					});
				}
			}

			if (params.limit && params.limit > 0) {
				return results.slice(0, params.limit);
			}

			return results;
		} catch (error) {
			handle_provider_error(error, this.name, 'fetch Tavily answer');
		}
	}
}

export const registration = {
	key: () => config.ai_response.tavily_answer.api_key,
};
