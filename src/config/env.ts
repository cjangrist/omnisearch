// Environment variable configuration for the MCP Omnisearch server
// Populated per-request via initialize_config(env) on Cloudflare Workers

import type { Env } from '../types/env.js';

// REST auth keys (used directly by rest_search.ts)
export let OPENWEBUI_API_KEY: string | undefined;
export let OMNISEARCH_API_KEY: string | undefined;

// Provider configuration — single source of truth for API keys and endpoints.
// To add a provider: add one entry here, one env var in types/env.ts,
// one line in initialize_config(), and one line in the unified dispatcher.
export const config = {
	search: {
		tavily: {
			api_key: undefined as string | undefined,
			base_url: 'https://api.tavily.com',
			timeout: 30000,
		},
		brave: {
			api_key: undefined as string | undefined,
			base_url: 'https://api.search.brave.com/res/v1',
			timeout: 10000,
		},
		kagi: {
			api_key: undefined as string | undefined,
			base_url: 'https://kagi.com/api/v0',
			timeout: 20000,
		},
		exa: {
			api_key: undefined as string | undefined,
			base_url: 'https://api.exa.ai',
			timeout: 30000,
		},
		perplexity: {
			api_key: undefined as string | undefined,
			base_url: 'https://api.perplexity.ai',
			timeout: 20000,
		},
		firecrawl: {
			api_key: undefined as string | undefined,
			base_url: 'https://api.firecrawl.dev',
			timeout: 20000,
		},
		serpapi: {
			api_key: undefined as string | undefined,
			base_url: 'https://serpapi.com/search.json',
			timeout: 15000,
		},
		linkup: {
			api_key: undefined as string | undefined,
			base_url: 'https://api.linkup.so',
			timeout: 30000,
		},
		you: {
			api_key: undefined as string | undefined,
			base_url: 'https://ydc-index.io/v1',
			timeout: 20000,
		},
	},
	ai_response: {
		perplexity: {
			api_key: undefined as string | undefined,
			base_url: 'https://api.perplexity.ai',
			timeout: 60000,
		},
		kagi_fastgpt: {
			api_key: undefined as string | undefined,
			base_url: 'https://kagi.com/api/v0/fastgpt',
			timeout: 30000,
		},
		exa_answer: {
			api_key: undefined as string | undefined,
			base_url: 'https://api.exa.ai',
			timeout: 30000,
		},
		brave_answer: {
			api_key: undefined as string | undefined,
			base_url: 'https://api.search.brave.com/res/v1',
			timeout: 60000,
		},
		tavily_answer: {
			api_key: undefined as string | undefined,
			base_url: 'https://api.tavily.com',
			timeout: 90000,
		},
		you_search: {
			api_key: undefined as string | undefined,
			base_url: 'https://api.you.com/v1/agents/runs',
			timeout: 90000,
		},
		llm_search: {
			base_url: '',
			timeout: 60000,
		},
	},
};

// Populate config from Workers env bindings (called per-request)
export const initialize_config = (env: Env) => {
	OPENWEBUI_API_KEY = env.OPENWEBUI_API_KEY;
	OMNISEARCH_API_KEY = env.OMNISEARCH_API_KEY;

	// Search providers
	config.search.tavily.api_key = env.TAVILY_API_KEY;
	config.search.brave.api_key = env.BRAVE_API_KEY;
	config.search.kagi.api_key = env.KAGI_API_KEY;
	config.search.exa.api_key = env.EXA_API_KEY;
	config.search.perplexity.api_key = env.PERPLEXITY_API_KEY;
	config.search.firecrawl.api_key = env.FIRECRAWL_API_KEY;
	config.search.serpapi.api_key = env.SERPAPI_API_KEY;
	config.search.linkup.api_key = env.LINKUP_API_KEY;
	config.search.you.api_key = env.YOU_API_KEY;

	// AI response providers
	config.ai_response.perplexity.api_key = env.PERPLEXITY_API_KEY;
	config.ai_response.kagi_fastgpt.api_key = env.KAGI_API_KEY;
	config.ai_response.exa_answer.api_key = env.EXA_API_KEY;
	config.ai_response.brave_answer.api_key = env.BRAVE_ANSWER_API_KEY;
	config.ai_response.tavily_answer.api_key = env.TAVILY_API_KEY;
	config.ai_response.you_search.api_key = env.YOU_API_KEY;
	config.ai_response.llm_search.base_url = env.LLM_SEARCH_BASE_URL ?? '';
};

// Validate environment variables and log availability
export const validate_config = () => {
	const all_keys: Array<[string, string | undefined]> = [
		...Object.entries(config.search).map(([name, c]) => [`search.${name}`, c.api_key] as [string, string | undefined]),
		...Object.entries(config.ai_response)
			.filter(([name]) => name !== 'llm_search')
			.map(([name, c]) => [`ai.${name}`, (c as { api_key?: string }).api_key] as [string, string | undefined]),
		['ai.llm_search', config.ai_response.llm_search.base_url || undefined],
	];

	const available = all_keys.filter(([, v]) => v).map(([n]) => n);
	const missing = all_keys.filter(([, v]) => !v).map(([n]) => n);

	if (available.length > 0) {
		console.error(`Found keys for: ${available.join(', ')}`);
	} else {
		console.error('Warning: No API keys found. No providers will be available.');
	}
	if (missing.length > 0) {
		console.warn(`Missing keys for: ${missing.join(', ')}`);
	}
};
