// Tool registry and MCP tool handler registration

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { create_error_response } from '../common/utils.js';
import type {
	UnifiedWebSearchProvider,
} from '../providers/unified/web_search.js';
import type {
	UnifiedAISearchProvider,
} from '../providers/unified/ai_search.js';
import type {
	UnifiedFetchProvider,
} from '../providers/unified/fetch.js';
import { run_web_search_fanout, truncate_web_results, type FanoutResult } from './web_search_fanout.js';
import { run_answer_fanout } from './answer_orchestrator.js';
import { run_fetch_race } from './fetch_orchestrator.js';
import { type FetchProviderName } from '../providers/unified/fetch.js';

// Populated by initialize_providers() with individual provider names (tavily, brave, etc.)
export const active_providers = {
	search: new Set<string>(),
	ai_response: new Set<string>(),
	fetch: new Set<string>(),
};

class ToolRegistry {
	private web_search_provider?: UnifiedWebSearchProvider;
	private ai_search_provider?: UnifiedAISearchProvider;
	private fetch_provider?: UnifiedFetchProvider;

	get_web_search_provider() {
		return this.web_search_provider;
	}

	get_fetch_provider() {
		return this.fetch_provider;
	}

	reset() {
		this.web_search_provider = undefined;
		this.ai_search_provider = undefined;
		this.fetch_provider = undefined;
		active_providers.search.clear();
		active_providers.ai_response.clear();
		active_providers.fetch.clear();
	}

	register_web_search_provider(provider: UnifiedWebSearchProvider) {
		this.web_search_provider = provider;
	}

	register_ai_search_provider(provider: UnifiedAISearchProvider) {
		this.ai_search_provider = provider;
	}

	register_fetch_provider(provider: UnifiedFetchProvider) {
		this.fetch_provider = provider;
	}

	setup_tool_handlers(server: McpServer) {
		if (this.web_search_provider) {
			this.register_web_search_tool(server, this.web_search_provider);
		}
		if (this.ai_search_provider) {
			this.register_answer_tool(server, this.ai_search_provider, this.web_search_provider);
		}
		if (this.fetch_provider) {
			this.register_fetch_tool(server, this.fetch_provider);
		}
	}

	private register_web_search_tool(server: McpServer, web_ref: UnifiedWebSearchProvider) {
		server.registerTool(
			'web_search',
			{
				description: `PREFERRED over any single-provider search tool. Fans out your query to 9 search engines IN PARALLEL (Tavily, Brave, Kagi, Exa, Firecrawl, Perplexity, SerpAPI, Linkup, You.com), deduplicates results across all engines, and ranks them using Reciprocal Rank Fusion (RRF) — pages found by multiple independent engines rank highest. Handles provider failures gracefully. For AI-written answers with citations, use the "answer" tool instead.`,
				inputSchema: {
					query: z.string().min(1).max(2000).describe('The search query'),
					timeout_ms: z.number().positive().optional()
						.describe('DO NOT SET unless latency is critical — omitting this waits for all providers, enabling full deduplication and token savings. If set, returns partial results after this many milliseconds.'),
					include_snippets: z.boolean().optional()
						.describe('Include page snippet text in results (default true). Set false to save tokens when you only need titles, URLs, and scores.'),
				},
				outputSchema: {
					query: z.string(),
					total_duration_ms: z.number(),
					providers_succeeded: z.array(z.object({ provider: z.string(), duration_ms: z.number() })),
					providers_failed: z.array(z.object({ provider: z.string(), error: z.string(), duration_ms: z.number() })),
					truncation: z.object({ total_before: z.number(), kept: z.number(), rescued: z.number() }),
					web_results: z.array(z.object({
						title: z.string(),
						url: z.string(),
						snippets: z.array(z.string()).optional(),
						source_providers: z.array(z.string()),
						score: z.number(),
					})),
				},
			},
			async ({ query, timeout_ms, include_snippets }) => {
				try {
					const result = await run_web_search_fanout(web_ref, query, {
						timeout_ms,
					});
					return this.format_web_search_response(query, result, include_snippets);
				} catch (error) {
					return this.format_error(error as Error);
				}
			},
		);
	}

	private register_answer_tool(
		server: McpServer,
		ai_ref: UnifiedAISearchProvider,
		web_ref: UnifiedWebSearchProvider | undefined,
	) {
		server.registerTool(
			'answer',
			{
				description: `PREFERRED over any single AI answer tool. Queries multiple AI providers IN PARALLEL — Perplexity, Kagi FastGPT, Exa, Brave Answer, Tavily, You.com, ChatGPT, Claude, Gemini, plus Gemini Grounded (web search URLs fed to Gemini via URL context) — each independently searching the web and synthesizing its own answer with citations. Returns all answers so you can compare: when most providers agree, the answer is almost certainly correct; when they disagree, you know the topic is genuinely contested. Use "web_search" instead when you need raw URLs/links rather than prose answers.`,
				inputSchema: {
					query: z.string().min(1).max(2000).describe('The question or search query to answer'),
				},
				outputSchema: {
					query: z.string(),
					total_duration_ms: z.number(),
					providers_queried: z.array(z.string()),
					providers_succeeded: z.array(z.string()),
					providers_failed: z.array(z.object({ provider: z.string(), error: z.string(), duration_ms: z.number() })),
					answers: z.array(z.object({
						source: z.string(),
						answer: z.string(),
						duration_ms: z.number(),
						citations: z.array(z.object({ title: z.string(), url: z.string(), snippet: z.string().optional() })),
					})),
				},
			},
			async ({ query }) => {
				try {
					const answer_result = await run_answer_fanout(ai_ref, web_ref, query);
					if (!answer_result) {
						return {
							content: [{ type: 'text' as const, text: 'No AI providers configured. Set API keys for at least one AI response provider.' }],
							isError: true,
						};
					}
					const json = JSON.stringify(answer_result);
					return {
						structuredContent: JSON.parse(json) as Record<string, unknown>,
						content: [{ type: 'text' as const, text: JSON.stringify(answer_result, null, 2) }],
					};
				} catch (error) {
					return this.format_error(error as Error);
				}
			},
		);
	}

	private register_fetch_tool(server: McpServer, fetch_ref: UnifiedFetchProvider) {
		server.registerTool(
			'fetch',
			{
				description: `Fetch a URL's content as clean markdown. When no provider is specified, uses an automatic tiered waterfall: tries Tavily first, then escalates through Firecrawl, parallel groups (Linkup+CF Browser, Diffbot+Olostep, ScrapFly+Scrape.do+Decodo), Zyte, Bright Data, and remaining providers — stopping at the first success. Social media URLs (TikTok, Instagram, YouTube, LinkedIn, etc.) are automatically routed to SociaVault. Specify a provider to bypass the waterfall.`,
				inputSchema: {
					url: z.string().url().describe('The URL to fetch'),
					provider: z.enum(['tavily', 'firecrawl', 'jina', 'you', 'brightdata', 'linkup', 'diffbot', 'sociavault', 'spider', 'scrapfly', 'scrapegraphai', 'scrapedo', 'scrapeless', 'opengraph', 'scrapingbee', 'scraperapi', 'zyte', 'scrapingant', 'oxylabs', 'olostep', 'decodo', 'scrappey', 'leadmagic', 'cloudflare_browser']).optional()
						.describe('Specific provider (omit for automatic waterfall).'),
				},
				outputSchema: {
					url: z.string(),
					title: z.string(),
					content: z.string(),
					source_provider: z.string(),
					total_duration_ms: z.number(),
					metadata: z.record(z.string(), z.unknown()).optional(),
				},
			},
			async ({ url, provider }) => {
				try {
					const result = await run_fetch_race(fetch_ref, url, {
						provider: provider as FetchProviderName | undefined,
					});
					const response = {
						url: result.result.url,
						title: result.result.title,
						content: result.result.content,
						source_provider: result.provider_used,
						total_duration_ms: result.total_duration_ms,
						metadata: result.result.metadata,
					};
					return {
						structuredContent: response as Record<string, unknown>,
						content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
					};
				} catch (error) {
					return this.format_error(error as Error);
				}
			},
		);
	}

	private format_web_search_response(query: string, result: FanoutResult, include_snippets?: boolean) {
		const { results: truncated_results, truncation } = truncate_web_results(result.web_results);
		const web_results = (include_snippets ?? true)
			? truncated_results
			: truncated_results.map(({ snippets: _s, ...rest }) => rest);

		const structuredContent = {
			query,
			total_duration_ms: result.total_duration_ms,
			providers_succeeded: result.providers_succeeded,
			providers_failed: result.providers_failed,
			truncation,
			web_results,
		};
		return {
			structuredContent: structuredContent as Record<string, unknown>,
			content: [{ type: 'text' as const, text: JSON.stringify(structuredContent, null, 2) }],
		};
	}

	private format_error(error: Error) {
		const error_response = create_error_response(error);
		return {
			content: [{ type: 'text' as const, text: error_response.error }],
			isError: true,
		};
	}
}

// Singleton instance
const registry = new ToolRegistry();

export const get_web_search_provider = () => registry.get_web_search_provider();
export const get_fetch_provider = () => registry.get_fetch_provider();
export const reset_registry = () => { registry.reset(); };
export const register_tools = (server: McpServer) => { registry.setup_tool_handlers(server); };
export const register_web_search_provider = (provider: UnifiedWebSearchProvider) => { registry.register_web_search_provider(provider); };
export const register_ai_search_provider = (provider: UnifiedAISearchProvider) => { registry.register_ai_search_provider(provider); };
export const register_fetch_provider = (provider: UnifiedFetchProvider) => { registry.register_fetch_provider(provider); };
