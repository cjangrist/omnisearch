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

	// LLM search (ChatGPT/Claude/Gemini via OpenAI-compatible endpoint)
	LLM_SEARCH_BASE_URL?: string;
	LLM_SEARCH_CHATGPT_MODEL?: string;
	LLM_SEARCH_CLAUDE_MODEL?: string;
	LLM_SEARCH_GEMINI_MODEL?: string;

	// REST auth
	OPENWEBUI_API_KEY?: string;
	OMNISEARCH_API_KEY?: string;
}
