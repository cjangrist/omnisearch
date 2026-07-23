// Environment variable configuration for the MCP Omnisearch server
// Populated per-request via initialize_config(env) on Cloudflare Workers

import type { Env } from '../types/env.js';
import { loggers } from '../common/logger.js';
import { set_trace_r2_bucket } from '../common/r2_trace.js';
import { set_analytics_datasets } from '../common/metrics.js';

const logger = loggers.config();

// REST auth keys (used directly by rest_search.ts)
export let OPENWEBUI_API_KEY: string | undefined;
export let OMNISEARCH_API_KEY: string | undefined;

// omnifetch service base URL — the external service that owns all URL fetching
// (the multi-provider waterfall, now externalized). omnisearch's `fetch` tool
// and the web_search grounded-snippets stage both POST {url} to
// ${OMNIFETCH_ENDPOINT}/web_fetch. Public endpoint (no auth). Set via env;
// defaults to the local docker-compose service for dev.
export let OMNIFETCH_ENDPOINT: string;

// KV namespace for caching (set during initialize_config)
export let kv_cache: KVNamespace | undefined;

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
		parallel: {
			api_key: undefined as string | undefined,
			base_url: 'https://api.parallel.ai',
			timeout: 30000,
		},
	},
	snippet_grounding: {
		llm: {
			api_key: undefined as string | undefined,
			base_url: 'https://api.cerebras.ai/v1',
			// Snippet-grounding LLM. Provider-neutral config key (`llm`) and labels;
			// active provider is CEREBRAS as of 2026-06-20 (key from CEREBRAS_API_KEY).
			// Same model as the prior provider (gpt-oss-120b), ~3x faster on the grounding
			// workload: median ~0.45s vs ~1.3s/call, ~1100 vs ~400 tok/s, identical
			// prompt+params. Cerebras drops the `openai/` model prefix the prior provider
			// required. 120b over 20b: 20b emitted "hhgghghvgegggg"-style degenerate
			// sampling under the detailed prompt + 6k-token context.
			model: 'gpt-oss-120b',
			timeout: 60000,
			max_content_chars: 24000,
			// Grounding pool width = how many of the top-N URLs ground at once.
			// Makespan is WAVE-bound: R2 grounding_aggregate over 409 prod runs shows
			// makespan ≈ 3-4x the slowest single URL, because ~64% of runs have at least
			// one URL pegged at the 15s per_url_deadline and each wave waits on its
			// straggler. So waves = ceil(top_n / concurrency) is the lever:
			//   c=3 → ~7 waves → makespan p90 ~105s (old default)
			//   c=6 → ~4 waves → ~60s
			//   c=10 → ~2 waves for the typical 20-URL set → target ~30s
			// 10 (not higher) because saturation is real at the top: 20 (one worker/URL)
			// measured ~2x SLOWER (per-URL p50 750→1200ms, everything hits the 15s
			// deadline) — high fan-out overwhelms the fetch providers + grounding LLM.
			// NB: the old "6 = Cloudflare connection cap" rationale is obsolete — CF
			// relaxed the 6-conn limit on 2026-04-09 to only count the waiting-for-headers
			// phase, so >6 no longer gets spuriously cancelled.
			concurrency: 10,
			// 7.5s (was 15s, 2026-06-21, data-driven): R2 grounding_aggregate shows
			// per-URL p50 ~3.2s and a bimodal tail — URLs either finish by ~4s or run
			// the deadline out. Each wave waits on its slowest straggler, so halving the
			// deadline ~halves per-wave cost. The cut-off URLs fall back to the
			// aggregated snippet (grounded_count was already ~19/20), so quality barely
			// moves while makespan drops sharply.
			per_url_deadline_ms: 7500,
			fetch_min_content_chars: 50,
			llm_min_snippet_chars: 1,
		},
	},
};

// Populate config from Workers env bindings (called per-request)
export const initialize_config = (env: Env) => {
	logger.debug('Initializing configuration from environment bindings');

	OPENWEBUI_API_KEY = env.OPENWEBUI_API_KEY;
	OMNISEARCH_API_KEY = env.OMNISEARCH_API_KEY;
	OMNIFETCH_ENDPOINT = env.OMNIFETCH_ENDPOINT?.trim() || 'http://127.0.0.1:8000';
	kv_cache = env.CACHE;
	set_trace_r2_bucket(env.TRACE_BUCKET);
	set_analytics_datasets({ requests: env.AE_REQUESTS, search: env.AE_SEARCH });

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
	config.search.parallel.api_key = env.PARALLEL_API_KEY;

	// Snippet grounding (gpt-oss-120b via OpenAI-compatible endpoint). Cerebras as of
	// 2026-06-20; ~3x faster than the prior provider, same model.
	config.snippet_grounding.llm.api_key = env.CEREBRAS_API_KEY;

	logger.debug('Configuration initialized successfully');
};

// Validate environment variables and log availability
export const validate_config = () => {
	const all_keys: Array<[string, string | undefined]> = [
		...Object.entries(config.search).map(([name, c]) => [`search.${name}`, c.api_key] as [string, string | undefined]),
		['omnifetch', OMNIFETCH_ENDPOINT || undefined],
		['snippet_grounding.llm', config.snippet_grounding.llm.api_key || undefined],
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
