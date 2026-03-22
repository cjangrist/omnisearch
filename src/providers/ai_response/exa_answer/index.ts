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

const DEFAULT_SEARCH_TYPE = 'auto';
const DEFAULT_LIVECRAWL = 'fallback';
const RESULT_URL = 'https://exa.ai';
const PRIMARY_SCORE = 1.0;
const SOURCE_SCORE_BASE = 0.9;
const SOURCE_SCORE_DECAY = 0.1;

interface ExaAnswerRequest {
	query: string;
	type?: string;
	livecrawl?: 'always' | 'fallback' | 'preferred';
	includeDomains?: string[];
	excludeDomains?: string[];
	useAutoprompt?: boolean;
}

interface ExaAnswerResponse {
	answer: string;
	sources?: Array<{
		id: string;
		title: string;
		url: string;
		text?: string;
		publishedDate?: string;
		author?: string;
	}>;
	requestId: string;
}

export class ExaAnswerProvider implements SearchProvider {
	name = 'exa_answer';
	description =
		'Get direct AI-generated answers to questions using Exa Answer API';

	async search(params: BaseSearchParams): Promise<SearchResult[]> {
		const api_key = validate_api_key(
			config.ai_response.exa_answer.api_key,
			this.name,
		);

		try {
			const request_body: ExaAnswerRequest = {
				query: params.query,
				type: DEFAULT_SEARCH_TYPE,
				livecrawl: DEFAULT_LIVECRAWL,
				useAutoprompt: true,
			};

			// Add domain filtering if provided
			if (
				params.include_domains &&
				params.include_domains.length > 0
			) {
				request_body.includeDomains = params.include_domains;
			}
			if (
				params.exclude_domains &&
				params.exclude_domains.length > 0
			) {
				request_body.excludeDomains = params.exclude_domains;
			}

			const data = await http_json<ExaAnswerResponse>(
				this.name,
				`${config.ai_response.exa_answer.base_url}/answer`,
				{
					method: 'POST',
					headers: {
						'x-api-key': api_key,
						Authorization: `Bearer ${api_key}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify(request_body),
					signal: make_signal(config.ai_response.exa_answer.timeout, params.signal),
				},
			);

			// Create a result with the AI answer and sources
			const results: SearchResult[] = [
				{
					title: 'AI Answer',
					url: RESULT_URL,
					snippet: data.answer,
					score: PRIMARY_SCORE,
					source_provider: this.name,
					metadata: {
						requestId: data.requestId,
						type: 'ai_answer',
						sources_count: data.sources?.length || 0,
					},
				},
			];

			// Add sources as additional results if they exist
			if (data.sources && data.sources.length > 0) {
				const source_results = data.sources.map((source, index) => ({
					title: source.title,
					url: source.url,
					snippet: source.text || 'Source reference',
					score: Math.max(0, SOURCE_SCORE_BASE - index * SOURCE_SCORE_DECAY),
					source_provider: this.name,
					metadata: {
						id: source.id,
						author: source.author,
						publishedDate: source.publishedDate,
						type: 'source',
						requestId: data.requestId,
					},
				}));
				results.push(...source_results);
			}

			return results;
		} catch (error) {
			handle_provider_error(error, this.name, 'fetch AI response');
		}
	}
}

export const registration = {
	key: () => config.ai_response.exa_answer.api_key,
};
