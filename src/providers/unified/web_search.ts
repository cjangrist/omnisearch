// Unified web search dispatcher — auto-built from provider registrations.
// To add a provider: create its file + add config entry. That's it.

import {
	BaseSearchParams,
	ErrorType,
	ProviderError,
	SearchProvider,
	SearchResult,
} from '../../common/types.js';

import { BraveSearchProvider, registration as brave_reg } from '../search/brave/index.js';
import { ExaSearchProvider, registration as exa_reg } from '../search/exa/index.js';
import { FirecrawlSearchProvider, registration as firecrawl_reg } from '../search/firecrawl/index.js';
import { KagiSearchProvider, registration as kagi_reg } from '../search/kagi/index.js';
import { LinkupSearchProvider, registration as linkup_reg } from '../search/linkup/index.js';
import { PerplexitySearchProvider, registration as perplexity_reg } from '../search/perplexity/index.js';
import { SerpApiSearchProvider, registration as serpapi_reg } from '../search/serpapi/index.js';
import { TavilySearchProvider, registration as tavily_reg } from '../search/tavily/index.js';
import { YouSearchProvider, registration as you_reg } from '../search/you/index.js';

// ─── ADD ONE LINE HERE TO REGISTER A NEW SEARCH PROVIDER ────────────
const PROVIDERS = [
	{ name: 'tavily', ...tavily_reg, factory: () => new TavilySearchProvider() },
	{ name: 'brave', ...brave_reg, factory: () => new BraveSearchProvider() },
	{ name: 'kagi', ...kagi_reg, factory: () => new KagiSearchProvider() },
	{ name: 'exa', ...exa_reg, factory: () => new ExaSearchProvider() },
	{ name: 'firecrawl', ...firecrawl_reg, factory: () => new FirecrawlSearchProvider() },
	{ name: 'perplexity', ...perplexity_reg, factory: () => new PerplexitySearchProvider() },
	{ name: 'serpapi', ...serpapi_reg, factory: () => new SerpApiSearchProvider() },
	{ name: 'linkup', ...linkup_reg, factory: () => new LinkupSearchProvider() },
	{ name: 'you', ...you_reg, factory: () => new YouSearchProvider() },
] as const;
// ─────────────────────────────────────────────────────────────────────

export type WebSearchProvider = (typeof PROVIDERS)[number]['name'];

export const get_active_search_providers = (): Array<{ name: string; key: () => string | undefined }> =>
	PROVIDERS.filter((p) => p.key()?.trim()).map((p) => ({ name: p.name, key: p.key }));

export const has_any_search_provider = (): boolean =>
	PROVIDERS.some((p) => p.key()?.trim());

export interface UnifiedWebSearchParams extends BaseSearchParams {
	provider: WebSearchProvider;
}

export class UnifiedWebSearchProvider implements SearchProvider {
	name = 'web_search';
	description = `Search the web. Providers: ${PROVIDERS.map((p) => p.name).join(', ')}.`;

	private providers: Map<string, SearchProvider>;

	constructor() {
		this.providers = new Map(
			PROVIDERS.filter((p) => p.key()?.trim()).map((p) => [p.name, p.factory()]),
		);
	}

	async search(params: UnifiedWebSearchParams): Promise<SearchResult[]> {
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
