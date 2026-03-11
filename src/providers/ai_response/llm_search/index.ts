import { http_json } from '../../../common/http.js';
import {
	BaseSearchParams,
	SearchProvider,
	SearchResult,
} from '../../../common/types.js';
import { handle_provider_error } from '../../../common/utils.js';
import { config } from '../../../config/env.js';

const RESULT_URL_TEMPLATE = 'https://search.llm';

type LlmSearchBackend = 'claude' | 'gemini' | 'codex';

interface LlmSearchResponse {
	model: string;
	text: string;
	provider: string;
	output: unknown[];
}

function create_llm_search_provider(
	backend: LlmSearchBackend,
	description: string,
): SearchProvider {
	const name = `llm_${backend}`;

	return {
		name,
		description,
		async search(params: BaseSearchParams): Promise<SearchResult[]> {
			try {
				const data = await http_json<LlmSearchResponse>(
					name,
					`${config.ai_response.llm_search.base_url}/search`,
					{
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
						},
						body: JSON.stringify({
							prompt: params.query,
							provider: backend,
						}),
						signal: AbortSignal.timeout(
							config.ai_response.llm_search.timeout,
						),
					},
				);

				const answer_text = data.text || '';

				return [
					{
						title: `${backend} (${data.model || backend})`,
						url: `${RESULT_URL_TEMPLATE}/${backend}`,
						snippet: answer_text,
						source_provider: name,
						metadata: {
							model: data.model,
							backend: data.provider,
						},
					},
				];
			} catch (error) {
				handle_provider_error(
					error,
					name,
					`fetch ${backend} answer via llm-search`,
				);
			}
		},
	};
}

export const LlmClaudeProvider = () =>
	create_llm_search_provider(
		'claude',
		'Claude with web search via llm-search service. Returns AI-generated answer grounded in real-time web results.',
	);

export const LlmGeminiProvider = () =>
	create_llm_search_provider(
		'gemini',
		'Gemini with Google Search grounding via llm-search service. Returns AI-generated answer grounded in real-time web results.',
	);

export const LlmCodexProvider = () =>
	create_llm_search_provider(
		'codex',
		'OpenAI Codex/GPT with web search via llm-search service. Returns AI-generated answer grounded in real-time web results.',
	);

export const registration = [
	{ name: 'llm_claude' as const, key: () => config.ai_response.llm_search.base_url || undefined, factory: () => LlmClaudeProvider() },
	{ name: 'llm_gemini' as const, key: () => config.ai_response.llm_search.base_url || undefined, factory: () => LlmGeminiProvider() },
	{ name: 'llm_codex' as const, key: () => config.ai_response.llm_search.base_url || undefined, factory: () => LlmCodexProvider() },
];
