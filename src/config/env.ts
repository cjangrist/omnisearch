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
	fetch: {
		tavily: {
			api_key: undefined as string | undefined,
			base_url: 'https://api.tavily.com',
			timeout: 30000,
		},
		firecrawl: {
			api_key: undefined as string | undefined,
			base_url: 'https://api.firecrawl.dev',
			timeout: 30000,
		},
		jina: {
			api_key: undefined as string | undefined,
			base_url: 'https://r.jina.ai',
			timeout: 30000,
		},
		you: {
			api_key: undefined as string | undefined,
			base_url: 'https://ydc-index.io',
			timeout: 30000,
		},
		brightdata: {
			api_key: undefined as string | undefined,
			base_url: 'https://api.brightdata.com',
			zone: 'unblocker' as string,
			timeout: 30000,
		},
		linkup: {
			api_key: undefined as string | undefined,
			base_url: 'https://api.linkup.so',
			timeout: 30000,
		},
		diffbot: {
			api_key: undefined as string | undefined,
			base_url: 'https://api.diffbot.com',
			timeout: 30000,
		},
		sociavault: {
			api_key: undefined as string | undefined,
			base_url: 'https://api.sociavault.com',
			timeout: 30000,
		},
		spider: {
			api_key: undefined as string | undefined,
			base_url: 'https://api.spider.cloud',
			timeout: 30000,
		},
		scrapfly: {
			api_key: undefined as string | undefined,
			base_url: 'https://api.scrapfly.io',
			timeout: 30000,
		},
		scrapegraphai: {
			api_key: undefined as string | undefined,
			base_url: 'https://api.scrapegraphai.com',
			timeout: 30000,
		},
		scrapedo: {
			api_key: undefined as string | undefined,
			base_url: 'https://api.scrape.do',
			timeout: 30000,
		},
		scrapeless: {
			api_key: undefined as string | undefined,
			base_url: 'https://api.scrapeless.com',
			timeout: 30000,
		},
		opengraph: {
			api_key: undefined as string | undefined,
			base_url: 'https://opengraph.io',
			timeout: 30000,
		},
		scrapingbee: {
			api_key: undefined as string | undefined,
			base_url: 'https://app.scrapingbee.com',
			timeout: 30000,
		},
		scraperapi: {
			api_key: undefined as string | undefined,
			base_url: 'https://api.scraperapi.com',
			timeout: 30000,
		},
		zyte: {
			api_key: undefined as string | undefined,
			base_url: 'https://api.zyte.com',
			timeout: 30000,
		},
		scrapingant: {
			api_key: undefined as string | undefined,
			base_url: 'https://api.scrapingant.com',
			timeout: 30000,
		},
		oxylabs: {
			username: undefined as string | undefined,
			password: undefined as string | undefined,
			base_url: 'https://realtime.oxylabs.io',
			timeout: 30000,
		},
		olostep: {
			api_key: undefined as string | undefined,
			base_url: 'https://api.olostep.com',
			timeout: 30000,
		},
		decodo: {
			api_key: undefined as string | undefined,
			base_url: 'https://scraper-api.decodo.com',
			timeout: 60000,
		},
		scrappey: {
			api_key: undefined as string | undefined,
			base_url: 'https://publisher.scrappey.com',
			timeout: 30000,
		},
		leadmagic: {
			api_key: undefined as string | undefined,
			base_url: 'https://api.web2md.app',
			timeout: 30000,
		},
		cloudflare_browser: {
			account_id: undefined as string | undefined,
			email: undefined as string | undefined,
			api_key: undefined as string | undefined,
			timeout: 45000,
		},
	},
	fetch_retry: {
		max_retries: 2,
		min_timeout_ms: 1000,
		max_timeout_ms: 5000,
		request_timeout_ms: 30000,
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

	// Fetch providers (reuse shared keys where applicable)
	config.fetch.tavily.api_key = env.TAVILY_API_KEY;
	config.fetch.firecrawl.api_key = env.FIRECRAWL_API_KEY;
	config.fetch.jina.api_key = env.JINA_API_KEY;
	config.fetch.you.api_key = env.YOU_API_KEY;
	config.fetch.brightdata.api_key = env.BRIGHT_DATA_API_KEY;
	if (env.BRIGHT_DATA_ZONE) {
		config.fetch.brightdata.zone = env.BRIGHT_DATA_ZONE;
	}
	config.fetch.linkup.api_key = env.LINKUP_API_KEY;
	config.fetch.diffbot.api_key = env.DIFFBOT_TOKEN;
	config.fetch.sociavault.api_key = env.SOCIAVAULT_API_KEY;
	config.fetch.spider.api_key = env.SPIDER_CLOUD_API_TOKEN;
	config.fetch.scrapfly.api_key = env.SCRAPFLY_API_KEY;
	config.fetch.scrapegraphai.api_key = env.SCRAPEGRAPHAI_API_KEY;
	config.fetch.scrapedo.api_key = env.SCRAPE_DO_API_TOKEN;
	config.fetch.scrapeless.api_key = env.SCRAPELESS_API_KEY;
	config.fetch.opengraph.api_key = env.OPENGRAPH_IO_API_KEY;
	config.fetch.scrapingbee.api_key = env.SCRAPINGBEE_API_KEY;
	config.fetch.scraperapi.api_key = env.SCRAPERAPI_API_KEY;
	config.fetch.zyte.api_key = env.ZYTE_API_KEY;
	config.fetch.scrapingant.api_key = env.SCRAPINGANT_API_KEY;
	config.fetch.oxylabs.username = env.OXYLABS_WEB_SCRAPER_USERNAME;
	config.fetch.oxylabs.password = env.OXYLABS_WEB_SCRAPER_PASSWORD;
	config.fetch.olostep.api_key = env.OLOSTEP_API_KEY;
	config.fetch.decodo.api_key = env.DECODO_WEB_SCRAPING_API_KEY;
	config.fetch.scrappey.api_key = env.SCRAPPEY_API_KEY;
	config.fetch.leadmagic.api_key = env.LEADMAGIC_API_KEY;
	config.fetch.cloudflare_browser.account_id = env.CLOUDFLARE_ACCOUNT_ID;
	config.fetch.cloudflare_browser.email = env.CLOUDFLARE_EMAIL;
	config.fetch.cloudflare_browser.api_key = env.CLOUDFLARE_API_KEY;

	// Fetch retry/timeout tuning
	if (env.FETCH_MAX_RETRIES) config.fetch_retry.max_retries = parseInt(env.FETCH_MAX_RETRIES, 10);
	if (env.FETCH_RETRY_MIN_TIMEOUT_MS) config.fetch_retry.min_timeout_ms = parseInt(env.FETCH_RETRY_MIN_TIMEOUT_MS, 10);
	if (env.FETCH_RETRY_MAX_TIMEOUT_MS) config.fetch_retry.max_timeout_ms = parseInt(env.FETCH_RETRY_MAX_TIMEOUT_MS, 10);
	if (env.FETCH_TIMEOUT_MS) config.fetch_retry.request_timeout_ms = parseInt(env.FETCH_TIMEOUT_MS, 10);

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
		...Object.entries(config.fetch).map(([name, c]) => {
			const cfg = c as { api_key?: string; username?: string; account_id?: string };
			return [`fetch.${name}`, cfg.api_key ?? cfg.username ?? cfg.account_id] as [string, string | undefined];
		}),
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
