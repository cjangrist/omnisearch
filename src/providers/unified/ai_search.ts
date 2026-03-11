// Unified AI search dispatcher — auto-built from provider registrations.
// To add a provider: create its file + add config entry. That's it.

import {
	BaseSearchParams,
	ErrorType,
	ProviderError,
	SearchProvider,
	SearchResult,
} from '../../common/types.js';

import { BraveAnswerProvider, registration as brave_answer_reg } from '../ai_response/brave_answer/index.js';
import { ExaAnswerProvider, registration as exa_answer_reg } from '../ai_response/exa_answer/index.js';
import { KagiFastGPTProvider, registration as kagi_fastgpt_reg } from '../ai_response/kagi_fastgpt/index.js';
import { registration as llm_reg } from '../ai_response/llm_search/index.js';
import { PerplexityProvider, registration as perplexity_reg } from '../ai_response/perplexity/index.js';
import { TavilyAnswerProvider, registration as tavily_answer_reg } from '../ai_response/tavily_answer/index.js';
import { YouSearchProvider, registration as you_search_reg } from '../ai_response/you_search/index.js';

// ─── ADD ONE LINE HERE TO REGISTER A NEW AI PROVIDER ────────────────
const PROVIDERS = [
	{ name: 'perplexity', ...perplexity_reg, factory: () => new PerplexityProvider() },
	{ name: 'kagi_fastgpt', ...kagi_fastgpt_reg, factory: () => new KagiFastGPTProvider() },
	{ name: 'exa_answer', ...exa_answer_reg, factory: () => new ExaAnswerProvider() },
	{ name: 'brave_answer', ...brave_answer_reg, factory: () => new BraveAnswerProvider() },
	{ name: 'tavily_answer', ...tavily_answer_reg, factory: () => new TavilyAnswerProvider() },
	{ name: 'you_search', ...you_search_reg, factory: () => new YouSearchProvider() },
	...llm_reg,
] as const;
// ─────────────────────────────────────────────────────────────────────

export type AISearchProvider = (typeof PROVIDERS)[number]['name'];

export const get_active_ai_providers = (): Array<{ name: string; key: () => string | undefined }> =>
	PROVIDERS.filter((p) => p.key()?.trim()).map((p) => ({ name: p.name, key: p.key }));

export const has_any_ai_provider = (): boolean =>
	PROVIDERS.some((p) => p.key()?.trim());

export interface UnifiedAISearchParams extends BaseSearchParams {
	provider: AISearchProvider;
}

export class UnifiedAISearchProvider implements SearchProvider {
	name = 'ai_search';
	description = `AI-powered search with reasoning. Providers: ${PROVIDERS.map((p) => p.name).join(', ')}.`;

	private providers: Map<string, SearchProvider>;

	constructor() {
		this.providers = new Map(PROVIDERS.map((p) => [p.name, p.factory()]));
	}

	async search(params: UnifiedAISearchParams): Promise<SearchResult[]> {
		const { provider, ...searchParams } = params;
		if (!provider) {
			throw new ProviderError(ErrorType.INVALID_INPUT, 'Provider parameter is required', this.name);
		}
		const selected = this.providers.get(provider);
		if (!selected) {
			throw new ProviderError(
				ErrorType.INVALID_INPUT,
				`Invalid provider: ${provider}. Valid: ${Array.from(this.providers.keys()).join(', ')}`,
				this.name,
			);
		}
		return selected.search(searchParams);
	}
}
