// Tool registry and MCP tool handler registration

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { create_error_response } from '../common/utils.js';
import { loggers, run_with_request_id } from '../common/logger.js';

const tool_logger = loggers.mcp();
import type {
	UnifiedWebSearchProvider,
} from '../providers/unified/web_search.js';
import { run_web_search_fanout, truncate_web_results, type FanoutResult } from './web_search_fanout.js';
import { fetch_url } from './omnifetch_client.js';
import { omnifetch_available } from './omnifetch_client.js';
import { TraceContext, run_with_trace, run_with_execution_context, type WaitUntilCapable } from '../common/r2_trace.js';

// Per-MCP-tool-call ctx scoping. The DO's `this.ctx` (DurableObjectState) is
// passed at registration time via a getter so trace flush_background calls
// inside tool handlers can attach R2 writes to the DO's waitUntil — without
// this, MCP tool R2 traces are detached fire-and-forget promises that can be
// cancelled when the DO completes its current invocation.
type CtxGetter = () => WaitUntilCapable | undefined;

const noop_ctx_getter: CtxGetter = () => undefined;

// Populated by initialize_providers() with individual provider names (tavily, brave, etc.)
// `fetch` holds a single entry — 'omnifetch' — now that URL fetching is delegated
// to the external omnifetch service instead of an internal provider waterfall.
export const active_providers = {
	search: new Set<string>(),
	fetch: new Set<string>(),
};

// Tool callbacks close over a per-DO get_ctx, NOT a singleton field — `registry`
// is module-scoped and shared across DO instances in the same isolate, so any
// per-DO ctx state on the registry would be overwritten by the most-recent
// registration. Capturing get_ctx in each closure keeps every McpServer's
// handlers bound to the DO that registered them.
const with_ctx_scope = <R>(get_ctx: CtxGetter, fn: () => Promise<R>): Promise<R> => {
	const ctx = get_ctx();
	return ctx ? run_with_execution_context(ctx, fn) : fn();
};

class ToolRegistry {
	private web_search_provider?: UnifiedWebSearchProvider;

	get_web_search_provider() {
		return this.web_search_provider;
	}

	reset() {
		this.web_search_provider = undefined;
	}

	register_web_search_provider(provider: UnifiedWebSearchProvider) {
		this.web_search_provider = provider;
	}

	setup_tool_handlers(server: McpServer, get_ctx: CtxGetter = noop_ctx_getter) {
		// Snapshot the singleton provider ref at registration time. Tool callbacks
		// MUST NOT read `this.X` at request time — `this` is the module-scoped
		// `registry` shared across DO instances in the same isolate, and a
		// concurrent DO's `initialize_providers()` overwrites this field with a
		// fresh Unified* instance mid-flight. Snapshotting binds each McpServer's
		// handlers to the provider ref that existed when the handlers were
		// registered. (Companion to the prior get_ctx capture fix, d4279cd.)
		const web_ref = this.web_search_provider;
		if (web_ref) {
			this.register_web_search_tool(server, web_ref, get_ctx);
		}
		// The fetch tool is backed by the external omnifetch service — no internal
		// provider registry, just a single REST call. Register it whenever the
		// service endpoint is configured.
		if (omnifetch_available()) {
			this.register_fetch_tool(server, get_ctx);
		}
	}

	private register_web_search_tool(server: McpServer, web_ref: UnifiedWebSearchProvider, get_ctx: CtxGetter) {
		server.registerTool(
			'web_search',
			{
				description: `PREFERRED over any single-provider search tool. Fans out your query to multiple search engines IN PARALLEL, deduplicates results across all engines, and ranks them using Reciprocal Rank Fusion (RRF) — pages found by multiple independent engines rank highest. Handles provider failures gracefully.

Snippets are grounded by default: after ranking, the top-20 URLs are fetched in parallel and snippets are regenerated from actual page content via Cerebras's gpt-oss-120b for query relevance. Each result reports snippet_source ("grounded", "fallback", or "aggregated"). Set grounded_snippets:false to skip and return raw aggregated provider snippets for minimum latency.`,
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
					grounded_snippets: z.boolean().optional()
						.describe('Replace aggregated provider snippets with query-grounded snippets extracted via Cerebras from the actual page content. Default true. Set false for raw aggregated snippets and minimum latency.'),
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
						snippet_source: z.enum(['aggregated', 'grounded', 'fallback']).optional(),
					})),
				},
			},
			async ({ query, timeout_ms, include_snippets, grounded_snippets }, extra) => with_ctx_scope(get_ctx, () => {
				const request_id = crypto.randomUUID();
				return run_with_request_id(request_id, async () => {
					tool_logger.info('web_search tool invoked', {
						op: 'tool_invoke',
						tool: 'web_search',
						request_id,
						jsonrpc_id: extra?.requestId ?? null,
						session_id: extra?.sessionId ?? null,
						query,
						query_len: query.length,
						timeout_ms,
						include_snippets,
						grounded_snippets,
					});
					try {
						const result = await run_web_search_fanout(web_ref, query, {
							timeout_ms,
							grounded_snippets,
						});
						return this.format_web_search_response(query, result, include_snippets);
					} catch (error) {
						return this.format_error(error as Error);
					}
				});
			}),
		);
	}

	private register_fetch_tool(server: McpServer, get_ctx: CtxGetter) {
		server.registerTool(
			'fetch',
			{
				description: `Fetch clean content from any public URL via the omnifetch service. Returns markdown for the page. Handles paywalled articles, JavaScript-heavy SPAs, PDFs, social media (Reddit threads, tweets, LinkedIn, TikTok/Instagram/YouTube transcripts), Cloudflare-protected sites, and more — all delegated to the external omnifetch service which runs its own multi-provider waterfall with automatic failover.

Just pass the URL and get back clean content. If a URL exists on the public web, this tool will get its content.`,
				annotations: {
					title: 'URL Fetch (via omnifetch)',
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: true,
				},
				inputSchema: {
					url: z.string().url().describe('The URL to fetch — any public URL works: articles, social media, products, docs, PDFs, SPAs, paywalled content'),
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
			async ({ url }, extra) => with_ctx_scope(get_ctx, () => {
				const request_id = crypto.randomUUID();
				return run_with_request_id(request_id, async () => {
					tool_logger.info('fetch tool invoked', {
						op: 'tool_invoke',
						tool: 'fetch',
						request_id,
						jsonrpc_id: extra?.requestId ?? null,
						session_id: extra?.sessionId ?? null,
						url,
					});
					// Scope an R2 trace so the omnifetch HTTP round-trip is captured for
					// debugging (parity with the prior waterfall trace).
					const trace = new TraceContext(request_id, 'fetch');
					trace.request_environment = { url };
					return run_with_trace(trace, async () => {
						try {
							const result = await fetch_url(url);
							const response: Record<string, unknown> = {
								url: result.url,
								title: result.title,
								content: result.content,
								source_provider: result.source_provider,
								total_duration_ms: result.total_duration_ms,
								...(result.metadata ? { metadata: result.metadata } : {}),
							};
							trace.flush_background(response);
							return {
								structuredContent: response,
								content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
							};
						} catch (error) {
							return this.format_error(error as Error);
						}
					});
				});
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
export const reset_registry = () => { registry.reset(); };
export const register_tools = (server: McpServer, get_ctx?: CtxGetter) => { registry.setup_tool_handlers(server, get_ctx); };
export const register_web_search_provider = (provider: UnifiedWebSearchProvider) => { registry.register_web_search_provider(provider); };
