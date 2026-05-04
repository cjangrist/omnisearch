// Cloudflare Workers environment bindings

export interface Env {
	// Search provider API keys
	TAVILY_API_KEY?: string;
	BRAVE_API_KEY?: string;
	KAGI_API_KEY?: string;
	EXA_API_KEY?: string;
	SERPAPI_API_KEY?: string;
	LINKUP_API_KEY?: string;

	// AI provider API keys
	PERPLEXITY_API_KEY?: string;
	BRAVE_ANSWER_API_KEY?: string;

	// Content processing
	FIRECRAWL_API_KEY?: string;
	YOU_API_KEY?: string;

	// Gemini Grounded (native Gemini API with URL context)
	GEMINI_GROUNDED_API_KEY?: string;
	GEMINI_GROUNDED_MODEL?: string;

	// Groq (snippet grounding for web_search via openai/gpt-oss-20b)
	GROQ_API_KEY?: string;

	// LLM search (ChatGPT/Claude/Gemini via OpenAI-compatible endpoint)
	LLM_SEARCH_BASE_URL?: string;
	LLM_SEARCH_API_KEY?: string;
	LLM_SEARCH_CHATGPT_MODEL?: string;
	LLM_SEARCH_CLAUDE_MODEL?: string;
	LLM_SEARCH_GEMINI_MODEL?: string;
	LLM_SEARCH_KIMI_MODEL?: string;

	// Fetch-only provider API keys
	JINA_API_KEY?: string;
	BRIGHT_DATA_API_KEY?: string;
	BRIGHT_DATA_ZONE?: string;
	DIFFBOT_TOKEN?: string;
	SOCIAVAULT_API_KEY?: string;
	SPIDER_CLOUD_API_TOKEN?: string;
	SCRAPFLY_API_KEY?: string;
	SCRAPEGRAPHAI_API_KEY?: string;
	SCRAPE_DO_API_TOKEN?: string;
	SCRAPELESS_API_KEY?: string;
	OPENGRAPH_IO_API_KEY?: string;
	SCRAPINGBEE_API_KEY?: string;
	SCRAPERAPI_API_KEY?: string;
	ZYTE_API_KEY?: string;
	SCRAPINGANT_API_KEY?: string;
	OXYLABS_WEB_SCRAPER_USERNAME?: string;
	OXYLABS_WEB_SCRAPER_PASSWORD?: string;
	OLOSTEP_API_KEY?: string;
	DECODO_WEB_SCRAPING_API_KEY?: string;
	SCRAPPEY_API_KEY?: string;
	LEADMAGIC_API_KEY?: string;
	CLOUDFLARE_ACCOUNT_ID?: string;
	CLOUDFLARE_EMAIL?: string;
	CLOUDFLARE_API_KEY?: string;

	SUPADATA_API_KEY?: string;
	GITHUB_API_KEY?: string;
	KIMI_API_KEY?: string;

	// REST auth
	OPENWEBUI_API_KEY?: string;
	OMNISEARCH_API_KEY?: string;

	// KV namespace for caching search and fetch results (24h TTL)
	CACHE: KVNamespace;

	// R2 bucket for full request/response tracing
	TRACE_BUCKET: R2Bucket;

	// Durable Object namespace for the stateful MCP agent
	OmnisearchMCP: DurableObjectNamespace;
}
