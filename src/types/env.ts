// Cloudflare Workers environment bindings

export interface Env {
	// Web-search provider API keys
	TAVILY_API_KEY?: string;
	BRAVE_API_KEY?: string;
	KAGI_API_KEY?: string;
	EXA_API_KEY?: string;
	SERPAPI_API_KEY?: string;
	LINKUP_API_KEY?: string;
	PARALLEL_API_KEY?: string;
	PERPLEXITY_API_KEY?: string;
	FIRECRAWL_API_KEY?: string;
	YOU_API_KEY?: string;
	KIMI_API_KEY?: string;

	// Scrapfly residential-proxy egress for the kimi search provider
	SCRAPFLY_API_KEY?: string;

	// Snippet grounding for web_search (gpt-oss-120b, OpenAI-compatible endpoint).
	// Active provider: Cerebras as of 2026-06-20 (~3x faster than the prior provider).
	CEREBRAS_API_KEY?: string;

	// omnifetch service — owns all URL fetching (externalized multi-provider
	// waterfall). Public endpoint (no auth). The fetch tool and the web_search
	// grounded-snippets stage both POST {url} to ${OMNIFETCH_ENDPOINT}/web_fetch.
	OMNIFETCH_ENDPOINT?: string;

	// REST auth
	OPENWEBUI_API_KEY?: string;
	OMNISEARCH_API_KEY?: string;

	// KV namespace for caching search and fetch results (36h TTL)
	CACHE: KVNamespace;

	// R2 bucket for full request/response tracing
	TRACE_BUCKET: R2Bucket;

	// Durable Object namespace for the stateful MCP agent
	OmnisearchMCP: DurableObjectNamespace;

	// Analytics Engine datasets — cheap queryable time-series metrics.
	// Optional so local dev / partial configs degrade to silent no-ops.
	AE_REQUESTS?: AnalyticsEngineDataset;
	AE_SEARCH?: AnalyticsEngineDataset;
}
