// OpenAI-compatible chat completions answer providers.
// Each instance hits the same base URL with a different model string.
// Sends the query verbatim as the user message and returns the assistant response.

import { http_json } from '../../../common/http.js';
import {
	BaseSearchParams,
	SearchProvider,
	SearchResult,
} from '../../../common/types.js';
import { handle_provider_error } from '../../../common/utils.js';
import { config } from '../../../config/env.js';

const PRIMARY_SCORE = 1.0;

interface ChatCompletionResponse {
	id: string;
	model: string;
	choices: Array<{
		message: { role: string; content: string };
		finish_reason: string;
	}>;
}

interface LLMProviderConfig {
	api_key: string;
	base_url: string;
	model: string;
	timeout: number;
}

function create_llm_provider(
	provider_name: string,
	description: string,
	result_url: string,
	get_config: () => LLMProviderConfig,
): SearchProvider {
	return {
		name: provider_name,
		description,
		async search(params: BaseSearchParams): Promise<SearchResult[]> {
			const cfg = get_config();
			if (!cfg.base_url) {
				throw new Error(`${provider_name} base_url not configured`);
			}

			try {
				const response = await http_json<ChatCompletionResponse>(
					provider_name,
					`${cfg.base_url}/chat/completions`,
					{
						method: 'POST',
						headers: {
							Authorization: `Bearer ${cfg.api_key ?? ''}`,
							'Content-Type': 'application/json',
						},
						body: JSON.stringify({
							model: cfg.model,
							messages: [{ role: 'user', content: params.query }],
						}),
						signal: AbortSignal.timeout(cfg.timeout),
					},
				);

				const answer = response.choices?.[0]?.message?.content ?? '';
				const model = response.model || cfg.model;

				return [
					{
						title: `${provider_name} (${model})`,
						url: result_url,
						snippet: answer,
						score: PRIMARY_SCORE,
						source_provider: provider_name,
						metadata: { model },
					},
				];
			} catch (error) {
				handle_provider_error(error, provider_name, `fetch ${provider_name} answer`);
			}
		},
	};
}

export const ChatGPTProvider = () => create_llm_provider(
	'chatgpt',
	'GPT-5.4 via OpenAI-compatible endpoint. Returns AI-generated answers with web search grounding.',
	'https://chatgpt.com',
	() => config.ai_response.chatgpt,
);

export const ClaudeProvider = () => create_llm_provider(
	'claude',
	'Claude Haiku via OpenAI-compatible endpoint. Fast, concise AI-generated answers.',
	'https://claude.ai',
	() => config.ai_response.claude,
);

export const GeminiProvider = () => create_llm_provider(
	'gemini',
	'Gemini Flash via OpenAI-compatible endpoint. Fast AI-generated answers with Google Search grounding.',
	'https://gemini.google.com',
	() => config.ai_response.gemini,
);

export const registration = [
	{ name: 'chatgpt' as const, key: () => (config.ai_response.chatgpt.base_url && config.ai_response.chatgpt.api_key) || undefined, factory: ChatGPTProvider },
	{ name: 'claude' as const, key: () => (config.ai_response.claude.base_url && config.ai_response.claude.api_key) || undefined, factory: ClaudeProvider },
	{ name: 'gemini' as const, key: () => (config.ai_response.gemini.base_url && config.ai_response.gemini.api_key) || undefined, factory: GeminiProvider },
];
