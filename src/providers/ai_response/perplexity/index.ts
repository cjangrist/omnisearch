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

const MODEL = 'sonar-pro';
const TEMPERATURE = 0.2;
const MAX_TOKENS = 1024;
const RESULT_URL = 'https://perplexity.ai';

interface PerplexityAPIResponse {
	choices?: Array<{
		message?: {
			content?: string;
		};
	}>;
	citations?: string[];
	usage?: {
		total_tokens?: number;
	};
}

export interface PerplexityResponse {
	answer: string;
	context: {
		sources: Array<{
			title: string;
			url: string;
			content: string;
		}>;
		follow_up_questions?: string[];
	};
	metadata: {
		model: string;
		processing_time: number;
		token_count: number;
	};
}

export class PerplexityProvider implements SearchProvider {
	name = 'perplexity';
	description =
		'AI-powered response generation combining real-time web search with advanced language models. Best for complex queries requiring reasoning and synthesis across multiple sources. Features contextual memory for follow-up questions.';

	async search(params: BaseSearchParams): Promise<SearchResult[]> {
		const response = await this.get_answer(params.query, params.signal);

		// Return the full answer as a single result
		const results: SearchResult[] = [
			{
				title: 'Perplexity AI',
				url: RESULT_URL,
				snippet: response.answer,
				source_provider: this.name,
			},
		];

		// Add sources if available
		if (
			response.context?.sources &&
			response.context.sources.length > 0
		) {
			results.push(
				...response.context.sources.map((source) => ({
					title: source.title || 'Source',
					url: source.url || RESULT_URL,
					snippet: source.content,
					source_provider: this.name,
				})),
			);
		}

		// Filter out any results with missing required fields
		const filtered_results = results.filter(
			(result) => result.title && result.url && result.snippet,
		);

		// Respect the limit parameter
		if (params.limit && params.limit > 0) {
			return filtered_results.slice(0, params.limit);
		}

		return filtered_results;
	}

	async get_answer(query: string, external_signal?: AbortSignal): Promise<PerplexityResponse> {
		const api_key = validate_api_key(
			config.ai_response.perplexity.api_key,
			this.name,
		);

		try {
			const data = await http_json<PerplexityAPIResponse>(
				this.name,
				`${config.ai_response.perplexity.base_url}/chat/completions`,
				{
					method: 'POST',
					headers: {
						accept: 'application/json',
						'content-type': 'application/json',
						Authorization: `Bearer ${api_key}`,
					},
					body: JSON.stringify({
						model: MODEL,
						messages: [
							{
								role: 'user',
								content: query,
							},
						],
						temperature: TEMPERATURE,
						max_tokens: MAX_TOKENS,
					}),
					signal: make_signal(config.ai_response.perplexity.timeout, external_signal),
				},
			);

			// Extract the full content from choices
			if (!data.choices?.[0]?.message?.content) {
				throw new Error(
					'Invalid response format from Perplexity API',
				);
			}

			const answer = data.choices[0].message.content;
			const citations = data.citations || [];

			return {
				answer,
				context: {
					sources: citations.map((citation: string) => ({
						title: 'Citation',
						url: citation,
						content: 'Source citation',
					})),
					follow_up_questions: [],
				},
				metadata: {
					model: MODEL,
					processing_time: 0,
					token_count: data.usage?.total_tokens || 0,
				},
			};
		} catch (error) {
			handle_provider_error(
				error,
				this.name,
				'fetch Perplexity answer',
			);
		}
	}
}

export const registration = {
	key: () => config.ai_response.perplexity.api_key,
};
