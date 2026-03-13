// Environment variable configuration for the MCP Omnisearch server
// Populated per-request via initialize_config(env) on Cloudflare Workers

import type { Env } from '../types/env.js';
import { loggers } from '../common/logger.js';

const logger = loggers.config();

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
			timeout: 180000,
		},
		kagi_fastgpt: {
			api_key: undefined as string | undefined,
			base_url: 'https://kagi.com/api/v0/fastgpt',
			timeout: 180000,
		},
		exa_answer: {
			api_key: undefined as string | undefined,
			base_url: 'https://api.exa.ai',
			timeout: 180000,
		},
		brave_answer: {
			api_key: undefined as string | undefined,
			base_url: 'https://api.search.brave.com/res/v1',
			timeout: 180000,
		},
		tavily_answer: {
			api_key: undefined as string | undefined,
			base_url: 'https://api.tavily.com',
			timeout: 180000,
		},
		you_search: {
			api_key: undefined as string | undefined,
			base_url: 'https://api.you.com/v1/agents/runs',
			timeout: 180000,
		},
		chatgpt: {
			api_key: '' as string,
			base_url: '',
			model: 'codex/gpt-5.4',
			timeout: 180000,
		},
		claude: {
			api_key: '' as string,
			base_url: '',
			model: 'claude/haiku',
			timeout: 180000,
		},
		gemini: {
			api_key: '' as string,
			base_url: '',
			model: 'gemini/search-fast',
			timeout: 180000,
		},
		gemini_grounded: {
			api_key: undefined as string | undefined,
			base_url: 'https://generativelanguage.googleapis.com/v1beta',
			model: 'gemini-3.1-flash-lite-preview',
			timeout: 180000,
		},
	},
};

// Populate config from Workers env bindings (called per-request)
export const initialize_config = (env: Env) => {
	logger.debug('Initializing configuration from environment bindings');

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
	// LLM search providers (ChatGPT/Claude/Gemini via OpenAI-compatible endpoint)
	if (env.LLM_SEARCH_BASE_URL) {
		config.ai_response.chatgpt.base_url = env.LLM_SEARCH_BASE_URL;
		config.ai_response.claude.base_url = env.LLM_SEARCH_BASE_URL;
		config.ai_response.gemini.base_url = env.LLM_SEARCH_BASE_URL;
	}
	if (env.LLM_SEARCH_CHATGPT_MODEL) {
		config.ai_response.chatgpt.model = env.LLM_SEARCH_CHATGPT_MODEL;
	}
	if (env.LLM_SEARCH_CLAUDE_MODEL) {
		config.ai_response.claude.model = env.LLM_SEARCH_CLAUDE_MODEL;
	}
	if (env.LLM_SEARCH_GEMINI_MODEL) {
		config.ai_response.gemini.model = env.LLM_SEARCH_GEMINI_MODEL;
	}

	// Gemini Grounded (native Gemini API with URL context)
	config.ai_response.gemini_grounded.api_key = env.GEMINI_GROUNDED_API_KEY;
	if (env.GEMINI_GROUNDED_MODEL) {
		config.ai_response.gemini_grounded.model = env.GEMINI_GROUNDED_MODEL;
	}

	logger.debug('Configuration initialized successfully');
};

// Validate environment variables and log availability
export const validate_config = () => {
	const all_keys: Array<[string, string | undefined]> = [
		...Object.entries(config.search).map(([name, c]) => [`search.${name}`, c.api_key] as [string, string | undefined]),
		...Object.entries(config.ai_response)
			.filter(([name]) => !['chatgpt', 'claude', 'gemini', 'gemini_grounded'].includes(name))
			.map(([name, c]) => [`ai.${name}`, (c as { api_key?: string }).api_key] as [string, string | undefined]),
		['ai.chatgpt', config.ai_response.chatgpt.base_url || undefined],
		['ai.claude', config.ai_response.claude.base_url || undefined],
		['ai.gemini', config.ai_response.gemini.base_url || undefined],
		['ai.gemini_grounded', config.ai_response.gemini_grounded.api_key || undefined],
	];

	const available = all_keys.filter(([, v]) => v).map(([n]) => n);
	const missing = all_keys.filter(([, v]) => !v).map(([n]) => n);

	if (available.length > 0) {
		logger.info('API keys configured', {
			op: 'config_validation',
			available_count: available.length,
			available_providers: available,
		});
	} else {
		logger.warn('No API keys found - no providers will be available', {
			op: 'config_validation',
		});
	}

	if (missing.length > 0) {
		logger.info('Optional providers not configured', {
			op: 'config_validation',
			missing_count: missing.length,
			missing_providers: missing,
		});
	}
};
