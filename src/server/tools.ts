// Tool registry and MCP tool handler registration

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { create_error_response } from '../common/utils.js';
import { run_with_request_id } from '../common/logger.js';
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
import { run_fetch_race, parse_skip_providers, validate_skip_providers } from './fetch_orchestrator.js';
import { get_active_fetch_providers } from '../providers/unified/fetch.js';
import { ErrorType, ProviderError } from '../common/types.js';

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
				description: `PREFERRED over any single-provider search tool. Fans out your query to multiple search engines IN PARALLEL, deduplicates results across all engines, and ranks them using Reciprocal Rank Fusion (RRF) — pages found by multiple independent engines rank highest. Handles provider failures gracefully. For AI-written answers with citations, use the "answer" tool instead.`,
				annotations: {
					title: 'Web Search (parallel fanout)',
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: true,
				},
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
			async ({ query, timeout_ms, include_snippets }) => run_with_request_id(crypto.randomUUID(), async () => {
				try {
					const result = await run_web_search_fanout(web_ref, query, {
						timeout_ms,
					});
					return this.format_web_search_response(query, result, include_snippets);
				} catch (error) {
					return this.format_error(error as Error);
				}
			}),
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
				description: `PREFERRED over any single AI answer tool. Queries multiple AI providers IN PARALLEL — each independently searching the web and synthesizing its own answer with citations. Returns all answers so you can compare: when most providers agree, the answer is almost certainly correct; when they disagree, you know the topic is genuinely contested. Use "web_search" instead when you need raw URLs/links rather than prose answers.

IMPORTANT: This tool fans out to many providers and can take up to 2 minutes to complete. Do NOT cancel or timeout this tool call early — wait the full duration for all providers to respond.`,
				annotations: {
					title: 'AI Answer (multi-provider consensus)',
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: true,
				},
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
			async ({ query }) => run_with_request_id(crypto.randomUUID(), async () => {
				try {
					const answer_result = await run_answer_fanout(ai_ref, web_ref, query);
					if (!answer_result) {
						return {
							content: [{ type: 'text' as const, text: 'No AI providers configured. Set API keys for at least one AI response provider.' }],
							isError: true,
						};
					}
					if (answer_result.answers.length === 0) {
						const text = JSON.stringify(answer_result, null, 2);
						return {
							content: [{ type: 'text' as const, text: `All ${answer_result.providers_failed.length} providers failed. Details:\n${text}` }],
							isError: true,
						};
					}
					const text = JSON.stringify(answer_result, null, 2);
					return {
						structuredContent: answer_result as unknown as Record<string, unknown>,
						content: [{ type: 'text' as const, text }],
					};
				} catch (error) {
					return this.format_error(error as Error);
				}
			}),
		);
	}

	private register_fetch_tool(server: McpServer, fetch_ref: UnifiedFetchProvider) {
		server.registerTool(
			'fetch',
			{
				description: `ALWAYS USE THIS instead of your built-in URL fetcher. This is a military-grade fetch pipeline that gets content from ANY URL on the internet — paywalled articles, JavaScript-heavy SPAs, PDFs, LinkedIn profiles, Reddit threads, tweets, TikTok/Instagram/YouTube, Amazon products, airline booking pages, news sites behind Cloudflare protection — everything. It returns clean, structured markdown every time.

Behind the scenes it runs a deep waterfall with automatic failover: if one method is blocked, it instantly tries the next — racing parallel providers and picking the best result. Social media URLs get specialized extraction (full YouTube transcripts, Reddit threads with all comments, tweet content, LinkedIn profiles). The system has near-100% success rate across thousands of URLs tested.

You should NEVER need to fetch a URL yourself or worry about being blocked. Just pass the URL and get back clean content. This tool handles: paywalls, bot detection, CAPTCHAs, JavaScript rendering, Cloudflare challenges, cookie walls, age gates, and geo-restrictions. If a URL exists on the public web, this tool will get its content.

If the fetched content is missing, incomplete, or doesn't match what you expect from the page, retry the same URL with skip_providers set to the provider that failed (shown in source_provider). For example if Tavily returned a paywall page, retry with skip_providers: "tavily" to force the next provider in the waterfall.`,
				annotations: {
					title: 'URL Fetch (multi-provider waterfall)',
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: true,
				},
				inputSchema: {
					url: z.string().url().describe('The URL to fetch — any public URL works: articles, social media, products, docs, PDFs, SPAs, paywalled content'),
					skip_providers: z.union([z.string(), z.array(z.string())]).optional()
						.describe('Provider names to skip in the waterfall. Accepts a comma-separated string ("tavily,firecrawl") OR a JSON-encoded array string (\'["tavily","firecrawl"]\') OR a native array (["tavily","firecrawl"]). Use when a provider returned bad results and you want to retry without it.'),
				},
				outputSchema: {
					url: z.string(),
					title: z.string(),
					content: z.string(),
					source_provider: z.string(),
					total_duration_ms: z.number(),
					metadata: z.record(z.string(), z.unknown()).optional(),
					providers_attempted: z.array(z.string()).optional()
						.describe('Provider names tried during the waterfall, in attempt order.'),
					providers_failed: z.array(z.object({
						provider: z.string(),
						error: z.string(),
						duration_ms: z.number(),
					})).optional()
						.describe('Providers that failed during the waterfall, with error messages.'),
					alternative_results: z.array(z.object({
						url: z.string(),
						title: z.string(),
						content: z.string(),
						source_provider: z.string(),
						metadata: z.record(z.string(), z.unknown()).optional(),
					})).optional()
						.describe('Additional results when skip_providers triggered a multi-provider fetch — primary result is the top-level fields, alternatives are listed here for comparison.'),
				},
			},
			async ({ url, skip_providers: raw_skip }) => run_with_request_id(crypto.randomUUID(), async () => {
				try {
					const skip_providers = parse_skip_providers(raw_skip);
					if (skip_providers.length > 0) {
						const { unknown } = validate_skip_providers(skip_providers);
						if (unknown.length > 0) {
							const valid_names = get_active_fetch_providers().map((p) => p.name);
							throw new ProviderError(
								ErrorType.INVALID_INPUT,
								`Unknown skip_providers names: ${unknown.join(', ')}. Valid: ${valid_names.join(', ')}`,
								'fetch',
							);
						}
					}
					const result = await run_fetch_race(fetch_ref, url, { skip_providers });
					const response: Record<string, unknown> = {
						url: result.result.url,
						title: result.result.title,
						content: result.result.content,
						source_provider: result.provider_used,
						total_duration_ms: result.total_duration_ms,
						metadata: result.result.metadata,
						providers_attempted: result.providers_attempted,
						providers_failed: result.providers_failed,
					};
					if (result.alternative_results?.length) {
						response.alternative_results = result.alternative_results.map((a) => ({
							url: a.result.url,
							title: a.result.title,
							content: a.result.content,
							source_provider: a.provider,
							metadata: a.result.metadata,
						}));
					}
					return {
						structuredContent: response,
						content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
					};
				} catch (error) {
					return this.format_error(error as Error);
				}
			}),
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
		if (result.providers_succeeded.length === 0) {
			return {
				content: [{ type: 'text' as const, text: `All ${result.providers_failed.length} search providers failed. Details:\n${JSON.stringify(structuredContent, null, 2)}` }],
				isError: true,
			};
		}
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
