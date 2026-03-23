OpenAI Codex v0.116.0 (research preview)
--------
workdir: /home/cjangrist/dev/omnisearch
model: gpt-5.4
provider: openai
approval: never
sandbox: danger-full-access
reasoning effort: high
reasoning summaries: none
session id: 019d15de-3ad0-7661-a02b-ce99c79f5f17
--------
user
# Extremely In-Depth Code Review: MCP Server on Cloudflare Workers with Durable Objects

## What To Review

Review the ENTIRE current state of this MCP server codebase — not just a diff. Read every file listed below IN FULL from disk. Explore the directory structure. Follow imports and call chains. Research external dependencies by reading their type definitions in node_modules. Search online for documentation on the `agents` npm package, `@modelcontextprotocol/sdk`, Cloudflare Durable Objects lifecycle, and the SSE spec.

## Architecture Overview

This is a Cloudflare Workers project that runs an MCP (Model Context Protocol) server. It aggregates 9+ AI/search providers in parallel via three tools:

1. **`web_search`** — Fans out to 9 search engines, deduplicates via RRF ranking
2. **`answer`** — Fans out to 9 AI providers for parallel answer synthesis (17–120s)
3. **`fetch`** — Waterfall across 25+ fetch providers for any URL

The server uses **Durable Objects** (`McpAgent` from the `agents` npm package) for stateful MCP sessions. An SSE keepalive mechanism (`: keepalive\n\n` comment injection at the Worker level) prevents Claude web's ~45-second timeout from killing long-running tool calls.

## Files You MUST Read In Full

**Core files (read every line):**
- `src/worker.ts` — Main entry point, DO class, SSE keepalive injection, routing
- `src/server/tools.ts` — MCP tool registration and handlers
- `src/server/answer_orchestrator.ts` — Answer fanout with Promise.race deadline
- `src/server/web_search_fanout.ts` — Web search fanout with RRF ranking
- `src/server/fetch_orchestrator.ts` — Fetch waterfall with provider racing
- `src/types/env.ts` — Environment type definitions
- `wrangler.toml` — Cloudflare Workers + DO config
- `package.json` — Dependencies

**Context files (read for understanding):**
- `src/config/env.ts` — Config initialization (writes to module-level globals)
- `src/providers/index.ts` — Provider initialization and registry
- `src/server/handlers.ts` — MCP resource handlers
- `src/server/rest_search.ts` — REST /search endpoint
- `src/server/rest_fetch.ts` — REST /fetch endpoint
- `src/common/logger.ts` — Logging utilities
- `src/common/types.ts` — Shared types
- `src/common/http.ts` — HTTP utilities

**External research (read type definitions + search online):**
- `node_modules/agents/dist/` — How `McpAgent` works, `serve()` options, DO↔Worker WebSocket bridge
- `node_modules/@modelcontextprotocol/sdk/` — `McpServer`, tool handlers, Streamable HTTP transport
- Cloudflare Durable Objects — lifecycle, `init()` semantics, isolate sharing, WebSocket hibernation
- SSE spec — whether `: comment\n\n` is the correct keepalive format
- TransformStream on CF Workers — correctness of the reader pump pattern

## Review Dimensions

### 1. CORRECTNESS
- Does every function do what it claims?
- Are there race conditions in the async fanout patterns (answer, web_search, fetch)?
- Is the SSE keepalive injection (`inject_sse_keepalive`) correct? Does the `closed` flag + `cleanup()` pattern handle all edge cases?
- Is the DO class (`OmnisearchMCP`) correctly implemented? Is the `_initialized` guard sufficient?
- Does `McpAgent.serve('/mcp', { binding, corsOptions })` work correctly with the options provided?
- Are there any paths where errors are silently swallowed that shouldn't be?

### 2. ARCHITECTURE
- Is the Durable Object approach the right choice for this use case?
- Is SSE keepalive at the Worker wrapper level the right layer?
- Is the provider initialization pattern (module-level globals set in `init()`) sound for a DO context?
- Are the REST endpoints (`/search`, `/fetch`) correctly isolated from the MCP path?
- Is the routing structure (explicit paths → fallthrough to DO → 404) correct?

### 3. STREAM HANDLING
- Can `inject_sse_keepalive` corrupt the SSE stream by interleaving keepalive bytes mid-event?
- Is `reader.cancel()` in the cleanup path sufficient to propagate client disconnects upstream?
- Is reusing the same `Uint8Array` (`SSE_PING`) across concurrent streams safe on CF Workers?
- Could the pump + interval pattern leak resources under any condition?

### 4. PERFORMANCE
- Are there unnecessary allocations on hot paths?
- Is the `TransformStream` wrapper overhead justified for all SSE responses (including fast ones)?
- Are the fanout patterns (answer, web_search, fetch) efficiently structured?
- Is `Date.now()` called more than necessary?
- Are there any N+1 patterns or redundant computations?

### 5. ERROR HANDLING
- Is error handling consistent across all paths (REST, MCP, DO)?
- Are error messages descriptive enough for production debugging?
- Is the try/catch around `mcp_handler.fetch()` sufficient?
- Are provider failures handled gracefully in all three fanout patterns?

### 6. CODE QUALITY
- Dead imports, unused exports, dead code paths?
- Comment quality — explaining "why" not "what"?
- Type safety gaps (any `as unknown as`, untyped catches, etc.)?
- Naming consistency across the codebase?
- Logging consistency (structured fields, `op` naming)?

### 7. EDGE CASES & FAILURE MODES
- What happens when all 9 providers fail?
- What happens when the DO is evicted mid-request?
- What happens with concurrent sessions on the same DO instance?
- What happens if `mcp_handler.fetch()` returns a non-SSE error response?
- What happens if the `agents` package changes its CORS behavior?

### 8. DEPENDENCY RISKS
- Is `agents@^0.7.9` stable? Breaking change risk with `^`?
- SDK version mismatch between `agents` (bundles 1.26.0) and project (1.27.1) — is the `@ts-expect-error` acceptable?
- Are there any deprecated APIs being used?

## Output Format

Structure your review EXACTLY as:

### CRITICAL — Must fix before merging
(Issues that would cause bugs, data loss, or outages in production)

### HIGH — Should fix before merging
(Issues that could cause problems under specific conditions)

### MEDIUM — Should fix soon
(Code quality, maintainability, minor inefficiencies)

### LOW — Nice to have
(Style nits, theoretical concerns)

### POSITIVE — What was done well
(Good patterns, smart decisions worth calling out)

For each finding:
- **File and line number(s)**
- **What** the issue is (specific)
- **Why** it matters (concrete impact)
- **Fix** (specific code suggestion)

Do NOT include security-related findings. Focus on correctness, architecture, performance, and code quality.
warning: Codex could not find system bubblewrap at /usr/bin/bwrap. Please install bubblewrap with your package manager. Codex will use the vendored bubblewrap in the meantime.
mcp startup: no servers
codex
Reviewing the full codebase state, dependency types, and the external docs you named. I’m starting by mapping the repository structure and loading the required files in full so I can trace imports and behavior before writing findings.
Plan update
  → Map repository structure and identify all files/import chains relevant to the MCP worker, tools, orchestrators, providers, and transports
  • Read required project files and dependency type definitions in full; inspect provider implementations and call paths
  • Research external docs for agents, MCP SDK, Durable Objects lifecycle, SSE comments/keepalive, and CF stream behavior
  • Synthesize findings by severity with exact file/line references and concrete fixes
exec
/usr/bin/zsh -lc pwd in /home/cjangrist/dev/omnisearch succeeded in 0ms:
/home/cjangrist/dev/omnisearch
exec
/usr/bin/zsh -lc 'rg --files' in /home/cjangrist/dev/omnisearch succeeded in 0ms:
test_stream.js
tsconfig.json
.env.example
config.yaml
package-lock.json
README.md
wrangler.toml
src/server/answer_orchestrator.ts
src/server/fetch_orchestrator.ts
src/server/web_search_fanout.ts
src/server/handlers.ts
src/server/tools.ts
src/server/rest_fetch.ts
src/server/rest_search.ts
src/types/env.ts
src/common/search_operators.ts
src/common/types.ts
src/common/rrf_ranking.ts
src/common/logger.ts
src/common/utils.ts
exec
/usr/bin/zsh -lc 'find . -maxdepth 3 -type d | sort' in /home/cjangrist/dev/omnisearch succeeded in 0ms:
.
./.git
./.git/hooks
./.git/info
./.git/logs
./.git/logs/refs
./.git/objects
./.git/objects/06
./.git/objects/0f
./.git/objects/1b
./.git/objects/2a
./.git/objects/3b
./.git/objects/49
./.git/objects/51
./.git/objects/53
./.git/objects/59
./.git/objects/5e
./.git/objects/68
./.git/objects/70
./.git/objects/7e
codex
I have the file map now. Next I’m reading the required source files in full, then I’ll branch into provider implementations and dependency internals where the MCP/DO behavior actually depends on library semantics.
exec
/usr/bin/zsh -lc 'wc -l src/worker.ts src/server/tools.ts src/server/answer_orchestrator.ts src/server/web_search_fanout.ts src/server/fetch_orchestrator.ts src/types/env.ts wrangler.toml package.json src/config/env.ts src/providers/index.ts src/server/handlers.ts src/server/rest_search.ts src/server/rest_fetch.ts src/common/logger.ts src/common/types.ts src/common/http.ts' in /home/cjangrist/dev/omnisearch succeeded in 0ms:
  249 src/worker.ts
  255 src/server/tools.ts
  252 src/server/answer_orchestrator.ts
  182 src/server/web_search_fanout.ts
  322 src/server/fetch_orchestrator.ts
   65 src/types/env.ts
   15 wrangler.toml
   24 package.json
  380 src/config/env.ts
   85 src/providers/index.ts
   96 src/server/handlers.ts
  175 src/server/rest_search.ts
  140 src/server/rest_fetch.ts
  193 src/common/logger.ts
   58 src/common/types.ts
  148 src/common/http.ts
 2639 total
exec
/usr/bin/zsh -lc 'rg -n "''^import|''^export|from '"'./|from '../|from \\\"\\.\\/|from \\\"\\.\\.\\/\" src/worker.ts src/server/tools.ts src/server/answer_orchestrator.ts src/server/web_search_fanout.ts src/server/fetch_orchestrator.ts src/types/env.ts src/config/env.ts src/providers/index.ts src/server/handlers.ts src/server/rest_search.ts src/server/rest_fetch.ts src/common/logger.ts src/common/types.ts src/common/http.ts" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
src/server/tools.ts:3:import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
src/server/tools.ts:4:import { z } from 'zod';
src/server/tools.ts:5:import { create_error_response } from '../common/utils.js';
src/server/tools.ts:6:import type {
src/server/tools.ts:8:} from '../providers/unified/web_search.js';
src/server/tools.ts:9:import type {
src/server/tools.ts:11:} from '../providers/unified/ai_search.js';
src/server/tools.ts:12:import type {
src/server/tools.ts:14:} from '../providers/unified/fetch.js';
src/server/tools.ts:15:import { run_web_search_fanout, truncate_web_results, type FanoutResult } from './web_search_fanout.js';
src/server/tools.ts:16:import { run_answer_fanout } from './answer_orchestrator.js';
src/server/tools.ts:17:import { run_fetch_race } from './fetch_orchestrator.js';
src/server/tools.ts:20:export const active_providers = {
src/server/tools.ts:249:export const get_web_search_provider = () => registry.get_web_search_provider();
src/server/tools.ts:250:export const get_fetch_provider = () => registry.get_fetch_provider();
src/server/tools.ts:251:export const reset_registry = () => { registry.reset(); };
src/server/tools.ts:252:export const register_tools = (server: McpServer) => { registry.setup_tool_handlers(server); };
src/server/tools.ts:253:export const register_web_search_provider = (provider: UnifiedWebSearchProvider) => { registry.register_web_search_provider(provider); };
src/server/tools.ts:254:export const register_ai_search_provider = (provider: UnifiedAISearchProvider) => { registry.register_ai_search_provider(provider); };
src/server/tools.ts:255:export const register_fetch_provider = (provider: UnifiedFetchProvider) => { registry.register_fetch_provider(provider); };
exec
/usr/bin/zsh -lc "nl -ba src/server/web_search_fanout.ts | sed -n '1,220p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	// Web search fanout: dispatches a query to all configured search providers
     2	// in parallel and merges results using RRF ranking.
     3	
     4	import type { SearchResult } from '../common/types.js';
     5	import { loggers } from '../common/logger.js';
     6	import { rank_and_merge, truncate_web_results, type RankedWebResult } from '../common/rrf_ranking.js';
     7	import { retry_with_backoff } from '../common/utils.js';
     8	import { get_active_search_providers, type WebSearchProvider } from '../providers/unified/web_search.js';
     9	
    10	const logger = loggers.search();
    11	
    12	const DEFAULT_TOP_N = 15;
    13	
    14	export interface FanoutResult {
    15		total_duration_ms: number;
    16		providers_succeeded: Array<{ provider: string; duration_ms: number }>;
    17		providers_failed: Array<{ provider: string; error: string; duration_ms: number }>;
    18		web_results: RankedWebResult[];
    19	}
    20	
exec
/usr/bin/zsh -lc "nl -ba src/server/tools.ts | sed -n '1,280p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	// Tool registry and MCP tool handler registration
     2	
     3	import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
     4	import { z } from 'zod';
     5	import { create_error_response } from '../common/utils.js';
     6	import type {
     7		UnifiedWebSearchProvider,
     8	} from '../providers/unified/web_search.js';
     9	import type {
    10		UnifiedAISearchProvider,
    11	} from '../providers/unified/ai_search.js';
    12	import type {
    13		UnifiedFetchProvider,
    14	} from '../providers/unified/fetch.js';
    15	import { run_web_search_fanout, truncate_web_results, type FanoutResult } from './web_search_fanout.js';
    16	import { run_answer_fanout } from './answer_orchestrator.js';
    17	import { run_fetch_race } from './fetch_orchestrator.js';
    18	
    19	// Populated by initialize_providers() with individual provider names (tavily, brave, etc.)
    20	export const active_providers = {
exec
/usr/bin/zsh -lc "nl -ba src/worker.ts | sed -n '1,260p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	// Cloudflare Workers entry point — stateful McpAgent (Durable Object) mode.
     2	// Each client session gets its own DO instance; GET /mcp holds a live SSE stream
     3	// that receives progress notifications every 5s during long-running answer fanouts,
     4	// preventing Claude web's 45-second timeout from killing the connection.
     5	
     6	import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
     7	import { McpAgent } from 'agents/mcp';
     8	import { initialize_config, validate_config } from './config/env.js';
     9	import { initialize_providers } from './providers/index.js';
    10	import { register_tools } from './server/tools.js';
    11	import { setup_handlers } from './server/handlers.js';
    12	import { handle_rest_search } from './server/rest_search.js';
    13	import { handle_rest_fetch } from './server/rest_fetch.js';
    14	import { loggers } from './common/logger.js';
    15	import type { Env } from './types/env.js';
    16	
    17	const logger = loggers.worker();
    18	
    19	const SERVER_NAME = 'omnisearch-mcp';
    20	const SERVER_VERSION = '1.0.0';
exec
/usr/bin/zsh -lc "nl -ba src/server/answer_orchestrator.ts | sed -n '1,280p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	// Answer tool orchestration: fans out to AI providers in parallel,
     2	// tracks progress, and aggregates results.
     3	
     4	import type { SearchResult } from '../common/types.js';
     5	import { loggers } from '../common/logger.js';
     6	import { config } from '../config/env.js';
     7	import { get_active_ai_providers, type AISearchProvider, type UnifiedAISearchProvider } from '../providers/unified/ai_search.js';
     8	import type { UnifiedWebSearchProvider } from '../providers/unified/web_search.js';
     9	import { gemini_grounded_search } from '../providers/ai_response/gemini_grounded/index.js';
    10	import { run_web_search_fanout } from './web_search_fanout.js';
    11	
    12	const logger = loggers.aiResponse();
    13	
    14	const GLOBAL_TIMEOUT_MS = 120_000; // 2 min hard deadline for the entire fanout
    15	const PROGRESS_INTERVAL_MS = 5_000;
    16	
    17	interface ProviderTask {
    18		name: string;
    19		promise: Promise<SearchResult[]>;
    20	}
exec
/usr/bin/zsh -lc "nl -ba src/server/fetch_orchestrator.ts | sed -n '1,360p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	// Fetch orchestrator: tiered waterfall with parallel groups and domain breakers
     2	//
     3	// Flow:
     4	//   1. Check domain breakers in order (youtube→supadata, social→sociavault)
     5	//   2. Walk waterfall steps top-to-bottom (tavily first, then firecrawl, etc.)
     6	//   3. Return first good result; throw if all providers exhausted
     7	//
     8	// Config: config.yaml (source of truth) — keep the const below in sync.
     9	
    10	import type { FetchResult } from '../common/types.js';
    11	import { ErrorType, ProviderError } from '../common/types.js';
    12	import { loggers } from '../common/logger.js';
    13	import {
    14		type FetchProviderName,
    15		type UnifiedFetchProvider,
    16		get_active_fetch_providers,
    17	} from '../providers/unified/fetch.js';
    18	
    19	const logger = loggers.fetch();
    20	
exec
/usr/bin/zsh -lc "nl -ba src/types/env.ts | sed -n '1,120p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	// Cloudflare Workers environment bindings
     2	
     3	export interface Env {
     4		// Search provider API keys
     5		TAVILY_API_KEY?: string;
     6		BRAVE_API_KEY?: string;
     7		KAGI_API_KEY?: string;
     8		EXA_API_KEY?: string;
     9		SERPAPI_API_KEY?: string;
    10		LINKUP_API_KEY?: string;
    11	
    12		// AI provider API keys
    13		PERPLEXITY_API_KEY?: string;
    14		BRAVE_ANSWER_API_KEY?: string;
    15	
    16		// Content processing
    17		FIRECRAWL_API_KEY?: string;
    18		YOU_API_KEY?: string;
    19	
    20		// Gemini Grounded (native Gemini API with URL context)
exec
/usr/bin/zsh -lc "nl -ba package.json | sed -n '1,120p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	{
     2		"name": "omnisearch-mcp",
     3		"version": "1.0.0",
     4		"description": "MCP server for multi-provider search aggregation with RRF ranking",
     5		"type": "module",
     6		"private": true,
     7		"scripts": {
     8			"dev": "wrangler dev",
     9			"deploy": "wrangler deploy",
    10			"typecheck": "tsc --noEmit"
    11		},
    12		"dependencies": {
    13			"@modelcontextprotocol/sdk": "^1.27.1",
    14			"agents": "^0.7.9",
    15			"p-retry": "^7.1.1",
    16			"zod": "^4.3.6"
    17		},
    18		"devDependencies": {
    19			"@cloudflare/workers-types": "^4.20260310.1",
    20			"typescript": "^5.9.3",
exec
/usr/bin/zsh -lc "nl -ba wrangler.toml | sed -n '1,80p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	name = "omnisearch-mcp"
     2	main = "src/worker.ts"
     3	compatibility_date = "2026-02-24"
     4	compatibility_flags = ["nodejs_compat"]
     5	
     6	[observability]
     7	enabled = true
     8	
     9	[[durable_objects.bindings]]
    10	name = "OmnisearchMCP"
    11	class_name = "OmnisearchMCP"
    12	
    13	[[migrations]]
    14	tag = "v1"
    15	new_sqlite_classes = ["OmnisearchMCP"]
exec
/usr/bin/zsh -lc "nl -ba src/config/env.ts | sed -n '1,220p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	// Environment variable configuration for the MCP Omnisearch server
     2	// Populated per-request via initialize_config(env) on Cloudflare Workers
     3	
     4	import type { Env } from '../types/env.js';
     5	import { loggers } from '../common/logger.js';
     6	
     7	const logger = loggers.config();
     8	
     9	// REST auth keys (used directly by rest_search.ts)
    10	export let OPENWEBUI_API_KEY: string | undefined;
    11	export let OMNISEARCH_API_KEY: string | undefined;
    12	
    13	// Provider configuration — single source of truth for API keys and endpoints.
    14	// To add a provider: add one entry here, one env var in types/env.ts,
    15	// one line in initialize_config(), and one line in the unified dispatcher.
    16	export const config = {
    17		search: {
    18			tavily: {
    19				api_key: undefined as string | undefined,
    20				base_url: 'https://api.tavily.com',
exec
/usr/bin/zsh -lc "nl -ba src/config/env.ts | sed -n '221,420p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
   221				timeout: 60000,
   222			},
   223			scrappey: {
   224				api_key: undefined as string | undefined,
   225				base_url: 'https://publisher.scrappey.com',
   226				timeout: 30000,
   227			},
   228			leadmagic: {
   229				api_key: undefined as string | undefined,
   230				base_url: 'https://api.web2md.app',
   231				timeout: 30000,
   232			},
   233			cloudflare_browser: {
   234				account_id: undefined as string | undefined,
   235				email: undefined as string | undefined,
   236				api_key: undefined as string | undefined,
   237				timeout: 45000,
   238			},
   239			serpapi: {
   240				api_key: undefined as string | undefined,
exec
/usr/bin/zsh -lc "nl -ba src/providers/index.ts | sed -n '1,140p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	// Provider initialization — derives availability from unified registries
     2	
     3	import { UnifiedAISearchProvider, has_any_ai_provider, get_active_ai_providers } from './unified/ai_search.js';
     4	import { UnifiedWebSearchProvider, has_any_search_provider, get_active_search_providers } from './unified/web_search.js';
     5	import { UnifiedFetchProvider, has_any_fetch_provider, get_active_fetch_providers } from './unified/fetch.js';
     6	import {
     7		active_providers,
     8		reset_registry,
     9		register_ai_search_provider,
    10		register_web_search_provider,
    11		register_fetch_provider,
    12	} from '../server/tools.js';
    13	import { loggers } from '../common/logger.js';
    14	
    15	const logger = loggers.providers();
    16	
    17	export const initialize_providers = () => {
    18		logger.debug('Initializing providers', { op: 'init_providers' });
    19	
    20		reset_registry();
exec
/usr/bin/zsh -lc "nl -ba src/server/handlers.ts | sed -n '1,140p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	// MCP resource handlers for provider status and provider info
     2	
     3	import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
     4	import { active_providers } from './tools.js';
     5	
     6	export const setup_handlers = (server: McpServer) => {
     7		// Provider Status Resource
     8		server.resource(
     9			'provider-status',
    10			'omnisearch://providers/status',
    11			{
    12				description: 'Current status of all providers (search, AI response, fetch)',
    13				mimeType: 'application/json',
    14			},
    15			async (uri) => {
    16				return {
    17					contents: [
    18						{
    19							uri: uri.href,
    20							mimeType: 'application/json',
exec
/usr/bin/zsh -lc "nl -ba src/server/rest_fetch.ts | sed -n '1,200p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	// REST fetch endpoint — lightweight alternative to the MCP fetch tool
     2	// POST /fetch  { url: string, provider?: string }
     3	// Returns { url, title, content, source_provider, duration_ms }
     4	// Compatible with Open WebUI and any REST client.
     5	
     6	import { ErrorType, ProviderError } from '../common/types.js';
     7	import { loggers } from '../common/logger.js';
     8	import { timing_safe_equal, sanitize_for_log } from '../common/utils.js';
     9	import { get_fetch_provider } from './tools.js';
    10	import { run_fetch_race } from './fetch_orchestrator.js';
    11	import { get_active_fetch_providers, type FetchProviderName } from '../providers/unified/fetch.js';
    12	import { OPENWEBUI_API_KEY, OMNISEARCH_API_KEY } from '../config/env.js';
    13	
    14	const logger = loggers.rest();
    15	
    16	export async function handle_rest_fetch(
    17		request: Request,
    18	): Promise<Response> {
    19		const start_time = Date.now();
    20	
exec
/usr/bin/zsh -lc "nl -ba src/server/rest_search.ts | sed -n '1,220p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	// REST search endpoint — lightweight alternative to the MCP tool
     2	// POST /search  { query: string, count?: number, raw?: boolean }
     3	// Returns [{ link, title, snippet }]
     4	// raw: true skips quality filtering (returns all results including low-quality ones)
     5	// Compatible with Open WebUI and any REST client.
     6	
     7	import { ProviderError } from '../common/types.js';
     8	import { loggers } from '../common/logger.js';
     9	import { timing_safe_equal, sanitize_for_log } from '../common/utils.js';
    10	import { get_web_search_provider } from './tools.js';
    11	import { run_web_search_fanout } from './web_search_fanout.js';
    12	import { OPENWEBUI_API_KEY, OMNISEARCH_API_KEY } from '../config/env.js';
    13	
    14	const logger = loggers.rest();
    15	
    16	export async function handle_rest_search(
    17		request: Request,
    18	): Promise<Response> {
    19		const start_time = Date.now();
    20	
exec
/usr/bin/zsh -lc "nl -ba src/common/types.ts | sed -n '1,120p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	// Common type definitions for the MCP Omnisearch server
     2	
     3	export interface SearchResult {
     4		title: string;
     5		url: string;
     6		snippet: string;
     7		score?: number;
     8		source_provider: string;
     9		metadata?: Record<string, unknown>;
    10	}
    11	
    12	export interface BaseSearchParams {
    13		query: string;
    14		limit?: number;
    15		include_domains?: string[];
    16		exclude_domains?: string[];
    17	}
    18	
    19	// Provider interfaces
    20	export interface SearchProvider {
exec
/usr/bin/zsh -lc "nl -ba src/common/logger.ts | sed -n '1,240p'" in /home/cjangrist/dev/omnisearchexec
/usr/bin/zsh -lc "nl -ba src/common/http.ts | sed -n '1,220p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	// Structured logging utility for Cloudflare Workers
     2	// Provides consistent log formatting with tags, levels, and context
     3	
     4	type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';
     5	
     6	interface LogContext {
     7		component?: string;
     8		op?: string;
     9		provider?: string;
    10		requestId?: string;
    11		[key: string]: unknown;
    12	}
    13	
    14	interface LogEntry {
    15		timestamp: string;
    16		level: LogLevel;
    17		message: string;
    18		component: string;
    19		context?: LogContext;
    20	}
 succeeded in 0ms:
     1	import { ErrorType, ProviderError } from './types.js';
     2	import { loggers } from './logger.js';
     3	import { handle_rate_limit } from './utils.js';
     4	
     5	const logger = loggers.http();
     6	
     7	interface HttpOptions extends RequestInit {
     8		expectedStatuses?: number[];
     9	}
    10	
    11	const tryParseJson = (text: string) => {
    12		if (!text) return undefined;
    13		try {
    14			return JSON.parse(text);
    15		} catch {
    16			return undefined;
    17		}
    18	};
    19	
    20	const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB guard
codex
I’ve finished the top-level worker, routing, tools, orchestrators, and config layer. Now I’m tracing the actual call chains beneath them: unified provider registries, utility/error helpers, ranking logic, and the concrete provider implementations that determine runtime behavior.
exec
/usr/bin/zsh -lc 'wc -l src/providers/unified/web_search.ts src/providers/unified/ai_search.ts src/providers/unified/fetch.ts src/common/utils.ts src/common/rrf_ranking.ts src/common/snippet_selector.ts src/common/html.ts src/common/search_operators.ts' in /home/cjangrist/dev/omnisearchexec
/usr/bin/zsh -lc "nl -ba src/providers/unified/ai_search.ts | sed -n '1,260p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	// Unified AI search dispatcher — auto-built from provider registrations.
     2	// To add a provider: create its file + add config entry. That's it.
     3	
     4	import {
     5		BaseSearchParams,
     6		ErrorType,
     7		ProviderError,
     8		SearchProvider,
     9		SearchResult,
    10	} from '../../common/types.js';
    11	
    12	import { BraveAnswerProvider, registration as brave_answer_reg } from '../ai_response/brave_answer/index.js';
    13	import { ExaAnswerProvider, registration as exa_answer_reg } from '../ai_response/exa_answer/index.js';
    14	import { KagiFastGPTProvider, registration as kagi_fastgpt_reg } from '../ai_response/kagi_fastgpt/index.js';
    15	import { registration as llm_reg } from '../ai_response/llm_search/index.js';
    16	import { PerplexityProvider, registration as perplexity_reg } from '../ai_response/perplexity/index.js';
    17	import { TavilyAnswerProvider, registration as tavily_answer_reg } from '../ai_response/tavily_answer/index.js';
    18	// ─── ADD ONE LINE HERE TO REGISTER A NEW AI PROVIDER ────────────────
    19	const PROVIDERS = [
    20		{ name: 'perplexity', ...perplexity_reg, factory: () => new PerplexityProvider() },
 succeeded in 0ms:
   73 src/providers/unified/web_search.ts
   66 src/providers/unified/ai_search.ts
  101 src/providers/unified/fetch.ts
  121 src/common/utils.ts
  150 src/common/rrf_ranking.ts
  244 src/common/snippet_selector.ts
   13 src/common/html.ts
  134 src/common/search_operators.ts
  902 total
exec
/usr/bin/zsh -lc "nl -ba src/providers/unified/web_search.ts | sed -n '1,260p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	// Unified web search dispatcher — auto-built from provider registrations.
     2	// To add a provider: create its file + add config entry. That's it.
     3	
     4	import {
     5		BaseSearchParams,
     6		ErrorType,
     7		ProviderError,
     8		SearchProvider,
     9		SearchResult,
    10	} from '../../common/types.js';
    11	
    12	import { BraveSearchProvider, registration as brave_reg } from '../search/brave/index.js';
    13	import { ExaSearchProvider, registration as exa_reg } from '../search/exa/index.js';
    14	import { FirecrawlSearchProvider, registration as firecrawl_reg } from '../search/firecrawl/index.js';
    15	import { KagiSearchProvider, registration as kagi_reg } from '../search/kagi/index.js';
    16	import { LinkupSearchProvider, registration as linkup_reg } from '../search/linkup/index.js';
    17	import { PerplexitySearchProvider, registration as perplexity_reg } from '../search/perplexity/index.js';
    18	import { SerpApiSearchProvider, registration as serpapi_reg } from '../search/serpapi/index.js';
    19	import { TavilySearchProvider, registration as tavily_reg } from '../search/tavily/index.js';
    20	import { YouSearchProvider, registration as you_reg } from '../search/you/index.js';
exec
/usr/bin/zsh -lc "nl -ba src/providers/unified/fetch.ts | sed -n '1,320p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	// Unified fetch dispatcher — auto-built from provider registrations.
     2	// To add a provider: create its file + add config entry. That's it.
     3	
     4	import {
     5		ErrorType,
     6		ProviderError,
     7		type FetchProvider,
     8		type FetchResult,
     9	} from '../../common/types.js';
    10	
    11	import { TavilyFetchProvider, registration as tavily_reg } from '../fetch/tavily/index.js';
    12	import { FirecrawlFetchProvider, registration as firecrawl_reg } from '../fetch/firecrawl/index.js';
    13	import { JinaFetchProvider, registration as jina_reg } from '../fetch/jina/index.js';
    14	import { YouFetchProvider, registration as you_reg } from '../fetch/you/index.js';
    15	import { BrightDataFetchProvider, registration as brightdata_reg } from '../fetch/brightdata/index.js';
    16	import { LinkupFetchProvider, registration as linkup_reg } from '../fetch/linkup/index.js';
    17	import { DiffbotFetchProvider, registration as diffbot_reg } from '../fetch/diffbot/index.js';
    18	import { SociaVaultFetchProvider, registration as sociavault_reg } from '../fetch/sociavault/index.js';
    19	import { SpiderFetchProvider, registration as spider_reg } from '../fetch/spider/index.js';
    20	import { ScrapflyFetchProvider, registration as scrapfly_reg } from '../fetch/scrapfly/index.js';
exec
/usr/bin/zsh -lc "nl -ba src/common/utils.ts | sed -n '1,180p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	// Common utility functions for the MCP Omnisearch server
     2	
     3	import pRetry from 'p-retry';
     4	import { ErrorType, ProviderError } from './types.js';
     5	
     6	export const timing_safe_equal = (a: string, b: string): boolean => {
     7		const encoder = new TextEncoder();
     8		const a_buf = encoder.encode(a);
     9		const b_buf = encoder.encode(b);
    10		if (a_buf.byteLength !== b_buf.byteLength) return false;
    11		return crypto.subtle.timingSafeEqual(a_buf, b_buf);
    12	};
    13	
    14	export const sanitize_for_log = (s: string): string =>
    15		s.replace(/[\x00-\x1F\x7F]/g, '').slice(0, 200);
    16	
    17	const normalize_api_key = (raw: string): string => {
    18		const trimmed = raw.trim();
    19		return trimmed.replace(/^(['"])(.*)\1$/, '$2');
    20	};
exec
/usr/bin/zsh -lc "nl -ba src/common/rrf_ranking.ts | sed -n '1,220p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	// Reciprocal Rank Fusion (RRF) ranking algorithm
     2	// Merges results from multiple search providers into a single ranked list.
     3	
     4	import type { SearchResult } from './types.js';
     5	import { collapse_snippets } from './snippet_selector.js';
     6	
     7	const RRF_K = 60;
     8	const DEFAULT_TOP_N = 15;
     9	const RESCUE_INTRA_RANK_THRESHOLD = 2;
    10	const MIN_RRF_SCORE = 0.01;
    11	const MIN_SNIPPET_CHARS_SINGLE_PROVIDER = 300;
    12	
    13	// Normalize URLs for dedup: lowercase host, strip fragment, strip trailing slash
    14	const normalize_url = (raw: string): string => {
    15		try {
    16			const u = new URL(raw);
    17			u.hash = '';
    18			// Remove trailing slash from pathname (except root "/")
    19			if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    20				u.pathname = u.pathname.slice(0, -1);
exec
/usr/bin/zsh -lc "nl -ba src/common/snippet_selector.ts | sed -n '1,280p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	// Intelligent snippet selection: given multiple provider snippets for the same URL,
     2	// select or merge into ONE optimal snippet maximizing information density and query relevance.
     3	
     4	const MERGE_CHAR_BUDGET = 500;
     5	const DIVERSITY_THRESHOLD = 0.3; // Jaccard below this triggers merge
     6	
     7	// --- Normalization ---
     8	
     9	const normalize_snippet = (s: string): string =>
    10		s
    11			.replace(/&amp;/g, '&')
    12			.replace(/&lt;/g, '<')
    13			.replace(/&gt;/g, '>')
    14			.replace(/&quot;/g, '"')
    15			.replace(/&#39;/g, "'")
    16			.replace(/&#?\w+;/g, '')
    17			.replace(/\s+/g, ' ')
    18			.replace(/\.{3,}$/, '')
    19			.trim();
    20	
exec
/usr/bin/zsh -lc "nl -ba src/common/html.ts | sed -n '1,80p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	// Shared HTML/Markdown extraction utilities used by fetch providers
     2	
     3	// Extract <title> from raw HTML
     4	export const extract_html_title = (html: string): string => {
     5		const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
     6		return match ? match[1].replace(/<[^>]+>/g, '').trim() : '';
     7	};
     8	
     9	// Extract first # heading from markdown
    10	export const extract_markdown_title = (markdown: string): string => {
    11		const match = markdown.match(/^#\s+(.+)/m);
    12		return match ? match[1].trim() : '';
    13	};
exec
/usr/bin/zsh -lc "nl -ba src/common/search_operators.ts | sed -n '1,180p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	// Search operator parsing: converts advanced query syntax (site:, filetype:, etc.)
     2	// into structured params consumed by Brave, Kagi, and Tavily providers.
     3	
     4	interface SearchOperator {
     5		type: string;
     6		value: string;
     7		original_text: string;
     8	}
     9	
    10	interface ParsedQuery {
    11		base_query: string;
    12		operators: SearchOperator[];
    13	}
    14	
    15	export interface SearchParams {
    16		query: string;
    17		include_domains?: string[];
    18		exclude_domains?: string[];
    19		file_type?: string;
    20		title_filter?: string;
exec
/usr/bin/zsh -lc 'wc -l src/providers/search/*/index.ts src/providers/ai_response/*/index.ts src/providers/fetch/*/index.ts' in /home/cjangrist/dev/omnisearch succeeded in 0ms:
   87 src/providers/search/brave/index.ts
  128 src/providers/search/exa/index.ts
   85 src/providers/search/firecrawl/index.ts
  112 src/providers/search/kagi/index.ts
   90 src/providers/search/linkup/index.ts
  113 src/providers/search/perplexity/index.ts
   74 src/providers/search/serpapi/index.ts
   94 src/providers/search/tavily/index.ts
   88 src/providers/search/you/index.ts
  239 src/providers/ai_response/brave_answer/index.ts
  134 src/providers/ai_response/exa_answer/index.ts
  127 src/providers/ai_response/gemini_grounded/index.ts
  131 src/providers/ai_response/kagi_fastgpt/index.ts
  110 src/providers/ai_response/llm_search/index.ts
  165 src/providers/ai_response/perplexity/index.ts
  119 src/providers/ai_response/tavily_answer/index.ts
   52 src/providers/fetch/brightdata/index.ts
   60 src/providers/fetch/cloudflare_browser/index.ts
   53 src/providers/fetch/decodo/index.ts
   62 src/providers/fetch/diffbot/index.ts
exec
/usr/bin/zsh -lc "rg -n \"http_json|http_text|fetch\\(|AbortController|setTimeout|Promise\\.race|Promise\\.allSettled|ProviderError|handle_provider_error|validate_api_key|registration\" src/providers/search src/providers/ai_response src/providers/fetch" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
src/providers/search/tavily/index.ts:1:import { http_json } from '../../../common/http.js';
src/providers/search/tavily/index.ts:8:	handle_provider_error,
src/providers/search/tavily/index.ts:9:	validate_api_key,
src/providers/search/tavily/index.ts:37:		const api_key = validate_api_key(
src/providers/search/tavily/index.ts:67:			const data = await http_json<
src/providers/search/tavily/index.ts:87:			handle_provider_error(error, this.name, 'fetch search results');
src/providers/search/tavily/index.ts:92:export const registration = {
src/providers/search/linkup/index.ts:1:import { http_json } from '../../../common/http.js';
src/providers/search/linkup/index.ts:8:	handle_provider_error,
src/providers/search/linkup/index.ts:9:	validate_api_key,
src/providers/search/linkup/index.ts:35:		const api_key = validate_api_key(
src/providers/search/linkup/index.ts:60:			const data = await http_json<LinkupSearchResponse>(
src/providers/search/linkup/index.ts:83:			handle_provider_error(error, this.name, 'fetch search results');
src/providers/search/linkup/index.ts:88:export const registration = {
src/providers/search/brave/index.ts:1:import { http_json } from '../../../common/http.js';
src/providers/search/brave/index.ts:8:	handle_provider_error,
src/providers/search/brave/index.ts:9:	validate_api_key,
src/providers/search/brave/index.ts:36:		const api_key = validate_api_key(
src/providers/search/brave/index.ts:58:			const data = await http_json<
src/providers/search/brave/index.ts:80:			handle_provider_error(error, this.name, 'fetch search results');
exec
/usr/bin/zsh -lc "nl -ba config.yaml | sed -n '1,220p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	# Fetch Waterfall Configuration
     2	#
     3	# Executed top-to-bottom. Unconfigured providers (no API key) are skipped.
     4	# Parallel steps race providers, pick longest content. Sequential tries one-by-one.
     5	# Runtime mirror: src/server/fetch_orchestrator.ts — update TS when editing this file.
     6	
     7	breakers:
     8	  youtube:
     9	    provider: supadata
    10	    domains: [youtube.com, youtu.be]
    11	
    12	  social_media:
    13	    provider: sociavault
    14	    domains:
    15	      - tiktok.com
    16	      - instagram.com
    17	      - youtube.com
    18	      - youtu.be
    19	      - linkedin.com
    20	      - facebook.com
codex
The remaining surface area is provider behavior. I’m reading every search and AI provider next, then the fetch providers, because most correctness and failure-mode issues here sit in adapter code rather than the orchestrators.
exec
/usr/bin/zsh -lc "nl -ba src/providers/search/brave/index.ts | sed -n '1,140p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import { http_json } from '../../../common/http.js';
     2	import {
     3		BaseSearchParams,
     4		SearchProvider,
     5		SearchResult,
     6	} from '../../../common/types.js';
     7	import {
     8		handle_provider_error,
     9		validate_api_key,
    10	} from '../../../common/utils.js';
    11	import {
    12		apply_search_operators,
    13		build_query_with_operators,
    14		parse_search_operators,
    15	} from '../../../common/search_operators.js';
    16	import { config } from '../../../config/env.js';
    17	
    18	const DEFAULT_LIMIT = 20;
    19	
    20	interface BraveSearchResponse {
exec
/usr/bin/zsh -lc "nl -ba src/providers/search/exa/index.ts | sed -n '1,180p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import { http_json } from '../../../common/http.js';
     2	import {
     3		BaseSearchParams,
     4		SearchProvider,
     5		SearchResult,
     6	} from '../../../common/types.js';
     7	import {
     8		handle_provider_error,
     9		validate_api_key,
    10	} from '../../../common/utils.js';
    11	import { config } from '../../../config/env.js';
    12	
    13	const DEFAULT_LIMIT = 20;
    14	const DEFAULT_SEARCH_TYPE = 'auto';
    15	const MAX_CONTENT_CHARS = 1500;
    16	const DEFAULT_LIVECRAWL = 'fallback';
    17	
    18	interface ExaSearchRequest {
    19		query: string;
    20		type?: string;
exec
/usr/bin/zsh -lc "nl -ba src/providers/search/firecrawl/index.ts | sed -n '1,140p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import { http_json } from '../../../common/http.js';
     2	import {
     3		BaseSearchParams,
     4		SearchProvider,
     5		SearchResult,
     6	} from '../../../common/types.js';
     7	import {
     8		handle_provider_error,
     9		validate_api_key,
    10	} from '../../../common/utils.js';
    11	import { config } from '../../../config/env.js';
    12	
    13	const DEFAULT_LIMIT = 20;
    14	const SEARCH_PATH = '/v2/search';
    15	const DEFAULT_TITLE = 'Source';
    16	
    17	interface FirecrawlWebResult {
    18		url: string;
    19		title?: string;
    20		description?: string;
exec
/usr/bin/zsh -lc "nl -ba src/providers/search/kagi/index.ts | sed -n '1,160p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import { http_json } from '../../../common/http.js';
     2	import {
     3		BaseSearchParams,
     4		SearchProvider,
     5		SearchResult,
     6	} from '../../../common/types.js';
     7	import {
     8		handle_provider_error,
     9		validate_api_key,
    10	} from '../../../common/utils.js';
    11	import {
    12		apply_search_operators,
    13		build_query_with_operators,
    14		parse_search_operators,
    15	} from '../../../common/search_operators.js';
    16	import { config } from '../../../config/env.js';
    17	
    18	const DEFAULT_LIMIT = 20;
    19	
    20	interface KagiSearchResponse {
exec
/usr/bin/zsh -lc "nl -ba src/providers/search/linkup/index.ts | sed -n '1,140p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import { http_json } from '../../../common/http.js';
     2	import {
     3		BaseSearchParams,
     4		SearchProvider,
     5		SearchResult,
     6	} from '../../../common/types.js';
     7	import {
     8		handle_provider_error,
     9		validate_api_key,
    10	} from '../../../common/utils.js';
    11	import { config } from '../../../config/env.js';
    12	
    13	const DEFAULT_LIMIT = 20;
    14	const DEFAULT_DEPTH = 'standard';
    15	const DEFAULT_OUTPUT_TYPE = 'searchResults';
    16	const SEARCH_PATH = '/v1/search';
    17	
    18	interface LinkupTextResult {
    19		type: 'text';
    20		name: string;
exec
/usr/bin/zsh -lc "nl -ba src/providers/search/perplexity/index.ts | sed -n '1,160p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import { http_json } from '../../../common/http.js';
     2	import {
     3		BaseSearchParams,
     4		SearchProvider,
     5		SearchResult,
     6	} from '../../../common/types.js';
     7	import {
     8		handle_provider_error,
     9		validate_api_key,
    10	} from '../../../common/utils.js';
    11	import { config } from '../../../config/env.js';
    12	
    13	const DEFAULT_LIMIT = 20;
    14	const SEARCH_MODEL = 'sonar';
    15	const SEARCH_TEMPERATURE = 0.1;
    16	const SEARCH_MAX_TOKENS = 256;
    17	const SEARCH_CONTEXT_SIZE = 'high';
    18	const DEFAULT_TITLE = 'Source';
    19	
    20	interface PerplexitySearchResponse {
exec
/usr/bin/zsh -lc "nl -ba src/providers/ai_response/brave_answer/index.ts | sed -n '1,280p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import {
     2		BaseSearchParams,
     3		ErrorType,
     4		ProviderError,
     5		SearchProvider,
     6		SearchResult,
     7	} from '../../../common/types.js';
     8	import {
     9		handle_provider_error,
    10		validate_api_key,
    11	} from '../../../common/utils.js';
    12	import { config } from '../../../config/env.js';
    13	
    14	const DEFAULT_MODEL = 'brave';
    15	const RESULT_URL = 'https://search.brave.com';
    16	const PRIMARY_SCORE = 1.0;
    17	const CITATION_SCORE_BASE = 0.9;
    18	const CITATION_SCORE_DECAY = 0.05;
    19	const ENABLE_ENTITIES = true;
    20	const ENABLE_CITATIONS = true;
exec
/usr/bin/zsh -lc "nl -ba src/providers/search/you/index.ts | sed -n '1,140p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import { http_json } from '../../../common/http.js';
     2	import {
     3		BaseSearchParams,
     4		SearchProvider,
     5		SearchResult,
     6	} from '../../../common/types.js';
     7	import {
     8		handle_provider_error,
     9		validate_api_key,
    10	} from '../../../common/utils.js';
    11	import { config } from '../../../config/env.js';
    12	
    13	const DEFAULT_LIMIT = 20;
    14	
    15	interface YouWebResult {
    16		url: string;
    17		title: string;
    18		description: string;
    19		snippets?: string[];
    20		page_age?: string;
exec
/usr/bin/zsh -lc "nl -ba src/providers/search/tavily/index.ts | sed -n '1,140p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import { http_json } from '../../../common/http.js';
     2	import {
     3		BaseSearchParams,
     4		SearchProvider,
     5		SearchResult,
     6	} from '../../../common/types.js';
     7	import {
     8		handle_provider_error,
     9		validate_api_key,
    10	} from '../../../common/utils.js';
    11	import {
    12		apply_search_operators,
    13		parse_search_operators,
    14	} from '../../../common/search_operators.js';
    15	import { config } from '../../../config/env.js';
    16	
    17	const DEFAULT_LIMIT = 20;
    18	const DEFAULT_SEARCH_DEPTH = 'basic';
    19	const DEFAULT_TOPIC = 'general';
    20	
exec
/usr/bin/zsh -lc "nl -ba src/providers/search/serpapi/index.ts | sed -n '1,120p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import { http_json } from '../../../common/http.js';
     2	import {
     3		BaseSearchParams,
     4		SearchProvider,
     5		SearchResult,
     6	} from '../../../common/types.js';
     7	import {
     8		handle_provider_error,
     9		validate_api_key,
    10	} from '../../../common/utils.js';
    11	import { config } from '../../../config/env.js';
    12	
    13	const DEFAULT_LIMIT = 20;
    14	const ENGINE = 'google_light';
    15	
    16	interface SerpApiOrganicResult {
    17		position: number;
    18		title: string;
    19		link: string;
    20		snippet?: string;
exec
/usr/bin/zsh -lc "nl -ba src/providers/ai_response/gemini_grounded/index.ts | sed -n '1,180p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	// Gemini Grounded: runs web search fanout, then feeds top URLs + snippets to
     2	// Gemini's native generateContent API with url_context tool enabled. Gemini
     3	// fetches the URLs server-side (when possible) and uses the inline snippets
     4	// as additional context, producing a grounded answer.
     5	
     6	import { http_json } from '../../../common/http.js';
     7	import type { SearchResult } from '../../../common/types.js';
     8	import { handle_provider_error } from '../../../common/utils.js';
     9	import { config } from '../../../config/env.js';
    10	
    11	const PROVIDER_NAME = 'gemini-grounded';
    12	const MAX_URLS = 20; // Gemini API hard limit
    13	const PRIMARY_SCORE = 1.0;
    14	
    15	const BLOCKED_URL_PATTERNS = [
    16		'youtube.com', 'youtu.be', // video — not supported
    17		'docs.google.com', 'drive.google.com', // workspace files
    18	];
    19	
    20	export interface GroundingSource {
exec
/usr/bin/zsh -lc "nl -ba src/providers/ai_response/exa_answer/index.ts | sed -n '1,180p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import { http_json } from '../../../common/http.js';
     2	import {
     3		BaseSearchParams,
     4		SearchProvider,
     5		SearchResult,
     6	} from '../../../common/types.js';
     7	import {
     8		handle_provider_error,
     9		validate_api_key,
    10	} from '../../../common/utils.js';
    11	import { config } from '../../../config/env.js';
    12	
    13	const DEFAULT_SEARCH_TYPE = 'auto';
    14	const DEFAULT_LIVECRAWL = 'fallback';
    15	const RESULT_URL = 'https://exa.ai';
    16	const PRIMARY_SCORE = 1.0;
    17	const SOURCE_SCORE_BASE = 0.9;
    18	const SOURCE_SCORE_DECAY = 0.1;
    19	
    20	interface ExaAnswerRequest {
exec
/usr/bin/zsh -lc "nl -ba src/providers/ai_response/llm_search/index.ts | sed -n '1,180p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	// OpenAI-compatible chat completions answer providers.
     2	// Each instance hits the same base URL with a different model string.
     3	// Sends the query verbatim as the user message and returns the assistant response.
     4	
     5	import { http_json } from '../../../common/http.js';
     6	import {
     7		BaseSearchParams,
     8		SearchProvider,
     9		SearchResult,
    10	} from '../../../common/types.js';
    11	import { handle_provider_error } from '../../../common/utils.js';
    12	import { config } from '../../../config/env.js';
    13	
    14	const PRIMARY_SCORE = 1.0;
    15	
    16	interface ChatCompletionResponse {
    17		id: string;
    18		model: string;
    19		choices: Array<{
    20			message: { role: string; content: string };
exec
/usr/bin/zsh -lc "nl -ba src/providers/ai_response/perplexity/index.ts | sed -n '1,220p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import { http_json } from '../../../common/http.js';
     2	import {
     3		BaseSearchParams,
     4		SearchProvider,
     5		SearchResult,
     6	} from '../../../common/types.js';
     7	import {
     8		handle_provider_error,
     9		validate_api_key,
    10	} from '../../../common/utils.js';
    11	import { config } from '../../../config/env.js';
    12	
    13	const MODEL = 'sonar-pro';
    14	const TEMPERATURE = 0.2;
    15	const MAX_TOKENS = 1024;
    16	const RESULT_URL = 'https://perplexity.ai';
    17	
    18	interface PerplexityAPIResponse {
    19		choices?: Array<{
    20			message?: {
exec
/usr/bin/zsh -lc "nl -ba src/providers/ai_response/tavily_answer/index.ts | sed -n '1,160p'" in /home/cjangrist/dev/omnisearchexec
/usr/bin/zsh -lc "nl -ba src/providers/ai_response/kagi_fastgpt/index.ts | sed -n '1,180p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import { http_json } from '../../../common/http.js';
     2	import {
     3		BaseSearchParams,
     4		SearchProvider,
     5		SearchResult,
     6	} from '../../../common/types.js';
     7	import {
     8		handle_provider_error,
     9		validate_api_key,
    10	} from '../../../common/utils.js';
    11	import { config } from '../../../config/env.js';
    12	
    13	const RESULT_URL = 'https://kagi.com/fastgpt';
    14	
    15	export interface KagiFastGPTResponse {
    16		meta: {
    17			id: string;
    18			node: string;
    19			ms: number;
    20		};
 succeeded in 0ms:
     1	import { http_json } from '../../../common/http.js';
     2	import {
     3		BaseSearchParams,
     4		ErrorType,
     5		ProviderError,
     6		SearchProvider,
     7		SearchResult,
     8	} from '../../../common/types.js';
     9	import {
    10		handle_provider_error,
    11		validate_api_key,
    12	} from '../../../common/utils.js';
    13	import { config } from '../../../config/env.js';
    14	
    15	const DEFAULT_SEARCH_DEPTH = 'advanced';
    16	const DEFAULT_ANSWER_MODE = 'advanced';
    17	const DEFAULT_MAX_RESULTS = 20;
    18	const DEFAULT_CHUNKS_PER_SOURCE = 3;
    19	const DEFAULT_TOPIC = 'general';
    20	const RESULT_URL = 'https://tavily.com';
exec
/usr/bin/zsh -lc "nl -ba src/providers/fetch/tavily/index.ts | sed -n '1,120p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import { http_json } from '../../../common/http.js';
     2	import type { FetchProvider, FetchResult } from '../../../common/types.js';
     3	import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
     4	import { extract_markdown_title } from '../../../common/html.js';
     5	import { config } from '../../../config/env.js';
     6	
     7	interface TavilyExtractResponse {
     8		results: Array<{ url: string; raw_content: string }>;
     9		failed_results: Array<{ url: string; error: string }>;
    10	}
    11	
    12	export class TavilyFetchProvider implements FetchProvider {
    13		name = 'tavily';
    14		description = 'Extract page content using Tavily Extract API. Returns markdown with basic or advanced extraction depth.';
    15	
    16		async fetch_url(url: string): Promise<FetchResult> {
    17			const api_key = validate_api_key(config.fetch.tavily.api_key, this.name);
    18	
    19			try {
    20				const data = await http_json<TavilyExtractResponse>(
exec
/usr/bin/zsh -lc "nl -ba src/providers/fetch/firecrawl/index.ts | sed -n '1,120p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import { http_json } from '../../../common/http.js';
     2	import type { FetchProvider, FetchResult } from '../../../common/types.js';
     3	import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
     4	import { config } from '../../../config/env.js';
     5	
     6	interface FirecrawlScrapeResponse {
     7		success: boolean;
     8		data: {
     9			markdown?: string;
    10			metadata?: {
    11				title?: string;
    12				description?: string;
    13				sourceURL?: string;
    14				statusCode?: number;
    15			};
    16		};
    17	}
    18	
    19	export class FirecrawlFetchProvider implements FetchProvider {
    20		name = 'firecrawl';
exec
/usr/bin/zsh -lc "nl -ba src/providers/fetch/diffbot/index.ts | sed -n '1,120p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import { http_json } from '../../../common/http.js';
     2	import type { FetchProvider, FetchResult } from '../../../common/types.js';
     3	import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
     4	import { config } from '../../../config/env.js';
     5	
     6	interface DiffbotArticleResponse {
     7		objects?: Array<{
     8			title?: string;
     9			text?: string;
    10			html?: string;
    11			author?: string;
    12			date?: string;
    13			siteName?: string;
    14			images?: Array<{ url: string; caption?: string }>;
    15		}>;
    16	}
    17	
    18	export class DiffbotFetchProvider implements FetchProvider {
    19		name = 'diffbot';
    20		description = 'Extract structured article content using Diffbot Article API. Rich metadata including author, date, images.';
exec
/usr/bin/zsh -lc "nl -ba src/providers/fetch/cloudflare_browser/index.ts | sed -n '1,120p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import { http_json } from '../../../common/http.js';
     2	import type { FetchProvider, FetchResult } from '../../../common/types.js';
     3	import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
     4	import { extract_markdown_title } from '../../../common/html.js';
     5	import { config } from '../../../config/env.js';
     6	
     7	interface BrowserRenderingResponse {
     8		success: boolean;
     9		result?: string;
    10		errors?: Array<{ code: number; message: string }>;
    11	}
    12	
    13	export class CloudflareBrowserFetchProvider implements FetchProvider {
    14		name = 'cloudflare_browser';
    15		description = 'Fetch URL content using Cloudflare Browser Rendering. Renders JavaScript before extraction — ideal for SPAs and dynamic pages.';
    16	
    17		async fetch_url(url: string): Promise<FetchResult> {
    18			const account_id = validate_api_key(config.fetch.cloudflare_browser.account_id, this.name);
    19			const email = validate_api_key(config.fetch.cloudflare_browser.email, this.name);
    20			const api_key = validate_api_key(config.fetch.cloudflare_browser.api_key, this.name);
exec
/usr/bin/zsh -lc "nl -ba src/providers/fetch/linkup/index.ts | sed -n '1,120p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import { http_json } from '../../../common/http.js';
     2	import type { FetchProvider, FetchResult } from '../../../common/types.js';
     3	import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
     4	import { extract_markdown_title } from '../../../common/html.js';
     5	import { config } from '../../../config/env.js';
     6	
     7	interface LinkupFetchResponse {
     8		markdown: string;
     9	}
    10	
    11	export class LinkupFetchProvider implements FetchProvider {
    12		name = 'linkup';
    13		description = 'Fetch URL content using Linkup Content Fetch API. Returns clean markdown.';
    14	
    15		async fetch_url(url: string): Promise<FetchResult> {
    16			const api_key = validate_api_key(config.fetch.linkup.api_key, this.name);
    17	
    18			try {
    19				const data = await http_json<LinkupFetchResponse>(
    20					this.name,
exec
/usr/bin/zsh -lc "nl -ba src/providers/fetch/olostep/index.ts | sed -n '1,120p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import type { FetchProvider, FetchResult } from '../../../common/types.js';
     2	import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
     3	import { http_json } from '../../../common/http.js';
     4	import { extract_markdown_title } from '../../../common/html.js';
     5	import { config } from '../../../config/env.js';
     6	
     7	export class OlostepFetchProvider implements FetchProvider {
     8		name = 'olostep';
     9		description = 'Fetch URL content using Olostep. Returns markdown with JS rendering and residential proxies by default.';
    10	
    11		async fetch_url(url: string): Promise<FetchResult> {
    12			const api_key = validate_api_key(config.fetch.olostep.api_key, this.name);
    13	
    14			try {
    15				const data = await http_json<{
    16					result: {
    17						markdown_content?: string;
    18						html_content?: string;
    19						markdown_hosted_url?: string;
    20					};
exec
/usr/bin/zsh -lc "nl -ba src/providers/fetch/decodo/index.ts | sed -n '1,120p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import type { FetchProvider, FetchResult } from '../../../common/types.js';
     2	import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
     3	import { http_json } from '../../../common/http.js';
     4	import { extract_markdown_title } from '../../../common/html.js';
     5	import { config } from '../../../config/env.js';
     6	
     7	export class DecodoFetchProvider implements FetchProvider {
     8		name = 'decodo';
     9		description = 'Fetch URL content using Decodo (Smartproxy) Web Scraper API. Returns markdown output.';
    10	
    11		async fetch_url(url: string): Promise<FetchResult> {
    12			const api_key = validate_api_key(config.fetch.decodo.api_key, this.name);
    13	
    14			try {
    15				// api_key is already base64-encoded username:password
    16				const data = await http_json<{
    17					results: Array<{ content: string; status_code: number; task_id: string }>;
    18				}>(this.name, `${config.fetch.decodo.base_url}/v2/scrape`, {
    19					method: 'POST',
    20					headers: {
exec
/usr/bin/zsh -lc "nl -ba src/providers/fetch/scrapfly/index.ts | sed -n '1,120p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import { http_json } from '../../../common/http.js';
     2	import type { FetchProvider, FetchResult } from '../../../common/types.js';
     3	import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
     4	import { extract_markdown_title } from '../../../common/html.js';
     5	import { config } from '../../../config/env.js';
     6	
     7	// GET /scrape returns JSON with result.content
     8	interface ScrapflyResponse {
     9		result: {
    10			content: string;
    11			status_code: number;
    12			url: string;
    13			format: string;
    14		};
    15		config: Record<string, unknown>;
    16	}
    17	
    18	export class ScrapflyFetchProvider implements FetchProvider {
    19		name = 'scrapfly';
    20		description = 'Fetch URL content using Scrapfly.io. Returns markdown with anti-bot bypass.';
exec
/usr/bin/zsh -lc "nl -ba src/providers/fetch/scrapedo/index.ts | sed -n '1,100p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import type { FetchProvider, FetchResult } from '../../../common/types.js';
     2	import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
     3	import { http_text } from '../../../common/http.js';
     4	import { extract_markdown_title } from '../../../common/html.js';
     5	import { config } from '../../../config/env.js';
     6	
     7	export class ScrapeDoFetchProvider implements FetchProvider {
     8		name = 'scrapedo';
     9		description = 'Fetch URL content using Scrape.do. Returns markdown via proxy-based scraping.';
    10	
    11		async fetch_url(url: string): Promise<FetchResult> {
    12			const api_key = validate_api_key(config.fetch.scrapedo.api_key, this.name);
    13	
    14			try {
    15				const api_url = new URL(config.fetch.scrapedo.base_url);
    16				api_url.searchParams.set('token', api_key);
    17				api_url.searchParams.set('url', url);
    18				api_url.searchParams.set('output', 'markdown');
    19	
    20				const content = await http_text(this.name, api_url.toString(), {
exec
/usr/bin/zsh -lc "nl -ba src/providers/fetch/jina/index.ts | sed -n '1,120p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import { http_json } from '../../../common/http.js';
     2	import type { FetchProvider, FetchResult } from '../../../common/types.js';
     3	import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
     4	import { config } from '../../../config/env.js';
     5	
     6	interface JinaReaderResponse {
     7		code: number;
     8		data: {
     9			title?: string;
    10			url?: string;
    11			content?: string;
    12			usage?: { tokens?: number };
    13		};
    14	}
    15	
    16	export class JinaFetchProvider implements FetchProvider {
    17		name = 'jina';
    18		description = 'Read a URL as markdown using Jina Reader API. Fast and token-efficient.';
    19	
    20		async fetch_url(url: string): Promise<FetchResult> {
exec
/usr/bin/zsh -lc "nl -ba src/providers/fetch/brightdata/index.ts | sed -n '1,120p'" in /home/cjangrist/dev/omnisearchexec
/usr/bin/zsh -lc "nl -ba src/providers/fetch/zyte/index.ts | sed -n '1,120p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import type { FetchProvider, FetchResult } from '../../../common/types.js';
     2	import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
     3	import { http_text } from '../../../common/http.js';
     4	import { extract_markdown_title } from '../../../common/html.js';
     5	import { config } from '../../../config/env.js';
     6	
     7	export class BrightDataFetchProvider implements FetchProvider {
     8		name = 'brightdata';
     9		description = 'Fetch URL content using BrightData Web Unlocker. Returns native markdown with anti-bot bypass.';
    10	
    11		async fetch_url(url: string): Promise<FetchResult> {
    12			const api_key = validate_api_key(config.fetch.brightdata.api_key, this.name);
    13	
    14			try {
    15				const content = await http_text(
    16					this.name,
    17					`${config.fetch.brightdata.base_url}/request`,
    18					{
    19						method: 'POST',
    20						headers: {
 succeeded in 0ms:
     1	import { http_json } from '../../../common/http.js';
     2	import type { FetchProvider, FetchResult } from '../../../common/types.js';
     3	import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
     4	import { config } from '../../../config/env.js';
     5	
     6	interface ZytePageContent {
     7		headline?: string;
     8		title?: string;
     9		itemMain?: string;
    10		canonicalUrl?: string;
    11		metadata?: Record<string, unknown>;
    12	}
    13	
    14	interface ZyteExtractResponse {
    15		url: string;
    16		statusCode: number;
    17		pageContent?: ZytePageContent;
    18	}
    19	
    20	export class ZyteFetchProvider implements FetchProvider {
exec
/usr/bin/zsh -lc "nl -ba src/providers/fetch/spider/index.ts | sed -n '1,120p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import { http_json } from '../../../common/http.js';
     2	import type { FetchProvider, FetchResult } from '../../../common/types.js';
     3	import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
     4	import { extract_markdown_title } from '../../../common/html.js';
     5	import { config } from '../../../config/env.js';
     6	
     7	// POST /scrape returns an array of page objects
     8	interface SpiderPage {
     9		url: string;
    10		status: number;
    11		content: string;
    12		error: string | null;
    13	}
    14	
    15	export class SpiderFetchProvider implements FetchProvider {
    16		name = 'spider';
    17		description = 'Fetch URL content using Spider.cloud. Returns markdown via smart request mode.';
    18	
    19		async fetch_url(url: string): Promise<FetchResult> {
    20			const api_key = validate_api_key(config.fetch.spider.api_key, this.name);
exec
/usr/bin/zsh -lc "nl -ba src/providers/fetch/you/index.ts | sed -n '1,120p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import { http_json } from '../../../common/http.js';
     2	import type { FetchProvider, FetchResult } from '../../../common/types.js';
     3	import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
     4	import { config } from '../../../config/env.js';
     5	
     6	interface YouContentsResponse {
     7		url: string;
     8		title?: string;
     9		markdown?: string | null;
    10	}
    11	
    12	export class YouFetchProvider implements FetchProvider {
    13		name = 'you';
    14		description = 'Fetch URL content using You.com Contents API. Returns markdown with metadata.';
    15	
    16		async fetch_url(url: string): Promise<FetchResult> {
    17			const api_key = validate_api_key(config.fetch.you.api_key, this.name);
    18	
    19			try {
    20				const data = await http_json<YouContentsResponse[]>(
exec
/usr/bin/zsh -lc "nl -ba src/providers/fetch/scrapeless/index.ts | sed -n '1,120p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import { http_json } from '../../../common/http.js';
     2	import type { FetchProvider, FetchResult } from '../../../common/types.js';
     3	import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
     4	import { extract_markdown_title } from '../../../common/html.js';
     5	import { config } from '../../../config/env.js';
     6	
     7	// POST /api/v2/unlocker/request response
     8	interface ScrapelessResponse {
     9		code: number;
    10		data: string;
    11	}
    12	
    13	export class ScrapelessFetchProvider implements FetchProvider {
    14		name = 'scrapeless';
    15		description = 'Fetch URL content using Scrapeless Web Unlocker. Returns markdown with JS rendering.';
    16	
    17		async fetch_url(url: string): Promise<FetchResult> {
    18			const api_key = validate_api_key(config.fetch.scrapeless.api_key, this.name);
    19	
    20			try {
exec
/usr/bin/zsh -lc "nl -ba src/providers/fetch/scrapingbee/index.ts | sed -n '1,100p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import type { FetchProvider, FetchResult } from '../../../common/types.js';
     2	import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
     3	import { http_text } from '../../../common/http.js';
     4	import { extract_markdown_title } from '../../../common/html.js';
     5	import { config } from '../../../config/env.js';
     6	
     7	export class ScrapingBeeFetchProvider implements FetchProvider {
     8		name = 'scrapingbee';
     9		description = 'Fetch URL content using ScrapingBee. Returns native markdown output.';
    10	
    11		async fetch_url(url: string): Promise<FetchResult> {
    12			const api_key = validate_api_key(config.fetch.scrapingbee.api_key, this.name);
    13	
    14			try {
    15				const api_url = new URL(`${config.fetch.scrapingbee.base_url}/api/v1`);
    16				api_url.searchParams.set('api_key', api_key);
    17				api_url.searchParams.set('url', url);
    18				api_url.searchParams.set('render_js', 'false');
    19				api_url.searchParams.set('return_page_markdown', 'true');
    20	
exec
/usr/bin/zsh -lc "nl -ba src/providers/fetch/scrapegraphai/index.ts | sed -n '1,120p'" in /home/cjangrist/dev/omnisearchexec
/usr/bin/zsh -lc "nl -ba src/providers/fetch/scrappey/index.ts | sed -n '1,120p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import { http_json } from '../../../common/http.js';
     2	import type { FetchProvider, FetchResult } from '../../../common/types.js';
     3	import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
     4	import { extract_markdown_title } from '../../../common/html.js';
     5	import { config } from '../../../config/env.js';
     6	
     7	// POST /v1/markdownify response
     8	interface ScrapeGraphAIResponse {
     9		request_id: string;
    10		status: string;
    11		website_url: string;
    12		result: string | null;
    13		error: string;
    14	}
    15	
    16	export class ScrapeGraphAIFetchProvider implements FetchProvider {
    17		name = 'scrapegraphai';
    18		description = 'Fetch URL content using ScrapeGraphAI markdownify endpoint. Returns clean markdown.';
    19	
    20		async fetch_url(url: string): Promise<FetchResult> {
 succeeded in 0ms:
     1	import type { FetchProvider, FetchResult } from '../../../common/types.js';
     2	import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
     3	import { http_json } from '../../../common/http.js';
     4	import { extract_html_title } from '../../../common/html.js';
     5	import { config } from '../../../config/env.js';
     6	
     7	export class ScrappeyFetchProvider implements FetchProvider {
     8		name = 'scrappey';
     9		description = 'Fetch URL content using Scrappey headless browser API. Returns extracted page text.';
    10	
    11		async fetch_url(url: string): Promise<FetchResult> {
    12			const api_key = validate_api_key(config.fetch.scrappey.api_key, this.name);
    13	
    14			try {
    15				const data = await http_json<{
    16					solution: {
    17						innerText?: string;
    18						response?: string;
    19						currentUrl?: string;
    20						statusCode?: number;
exec
/usr/bin/zsh -lc "nl -ba src/providers/fetch/scrapingant/index.ts | sed -n '1,120p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import { http_json } from '../../../common/http.js';
     2	import type { FetchProvider, FetchResult } from '../../../common/types.js';
     3	import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
     4	import { extract_markdown_title } from '../../../common/html.js';
     5	import { config } from '../../../config/env.js';
     6	
     7	interface ScrapingAntMarkdownResponse {
     8		url: string;
     9		markdown: string;
    10	}
    11	
    12	export class ScrapingAntFetchProvider implements FetchProvider {
    13		name = 'scrapingant';
    14		description = 'Extract page content as markdown using ScrapingAnt LLM-ready endpoint.';
    15	
    16		async fetch_url(url: string): Promise<FetchResult> {
    17			const api_key = validate_api_key(config.fetch.scrapingant.api_key, this.name);
    18	
    19			try {
    20				const params = new URLSearchParams({
exec
/usr/bin/zsh -lc "nl -ba src/providers/fetch/oxylabs/index.ts | sed -n '1,120p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import type { FetchProvider, FetchResult } from '../../../common/types.js';
     2	import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
     3	import { http_json } from '../../../common/http.js';
     4	import { extract_markdown_title } from '../../../common/html.js';
     5	import { config } from '../../../config/env.js';
     6	
     7	export class OxylabsFetchProvider implements FetchProvider {
     8		name = 'oxylabs';
     9		description = 'Fetch URL content using Oxylabs Web Scraper API. Returns markdown via realtime endpoint.';
    10	
    11		async fetch_url(url: string): Promise<FetchResult> {
    12			const username = validate_api_key(config.fetch.oxylabs.username, this.name);
    13			const password = validate_api_key(config.fetch.oxylabs.password, this.name);
    14	
    15			try {
    16				const auth = btoa(`${username}:${password}`);
    17				const data = await http_json<{
    18					results: Array<{ content: string; status_code: number }>;
    19				}>(this.name, `${config.fetch.oxylabs.base_url}/v1/queries`, {
    20					method: 'POST',
exec
/usr/bin/zsh -lc "nl -ba src/providers/fetch/scraperapi/index.ts | sed -n '1,100p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import type { FetchProvider, FetchResult } from '../../../common/types.js';
     2	import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
     3	import { http_text } from '../../../common/http.js';
     4	import { extract_markdown_title } from '../../../common/html.js';
     5	import { config } from '../../../config/env.js';
     6	
     7	export class ScraperAPIFetchProvider implements FetchProvider {
     8		name = 'scraperapi';
     9		description = 'Fetch URL content using ScraperAPI. Returns native markdown output.';
    10	
    11		async fetch_url(url: string): Promise<FetchResult> {
    12			const api_key = validate_api_key(config.fetch.scraperapi.api_key, this.name);
    13	
    14			try {
    15				const api_url = new URL(config.fetch.scraperapi.base_url);
    16				api_url.searchParams.set('api_key', api_key);
    17				api_url.searchParams.set('url', url);
    18				api_url.searchParams.set('output_format', 'markdown');
    19	
    20				const content = await http_text(this.name, api_url.toString(), {
exec
/usr/bin/zsh -lc "nl -ba src/providers/fetch/leadmagic/index.ts | sed -n '1,100p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import type { FetchProvider, FetchResult } from '../../../common/types.js';
     2	import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
     3	import { http_json } from '../../../common/http.js';
     4	import { extract_markdown_title } from '../../../common/html.js';
     5	import { config } from '../../../config/env.js';
     6	
     7	export class LeadMagicFetchProvider implements FetchProvider {
     8		name = 'leadmagic';
     9		description = 'Fetch URL content using LeadMagic Web2MD API. Returns clean markdown with boilerplate removed.';
    10	
    11		async fetch_url(url: string): Promise<FetchResult> {
    12			const api_key = validate_api_key(config.fetch.leadmagic.api_key, this.name);
    13	
    14			try {
    15				const data = await http_json<{
    16					markdown?: string;
    17					title?: string;
    18					url?: string;
    19				}>(this.name, `${config.fetch.leadmagic.base_url}/api/scrape`, {
    20					method: 'POST',
exec
/usr/bin/zsh -lc "nl -ba src/providers/fetch/serpapi/index.ts | sed -n '1,160p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	// SerpAPI YouTube Transcript fetch provider
     2	// Uses the youtube_video_transcript engine to get full video transcripts
     3	
     4	import { http_json } from '../../../common/http.js';
     5	import type { FetchProvider, FetchResult } from '../../../common/types.js';
     6	import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
     7	import { config } from '../../../config/env.js';
     8	
     9	interface TranscriptEntry {
    10		start: number;
    11		end: number;
    12		snippet: string;
    13	}
    14	
    15	interface SerpApiTranscriptResponse {
    16		transcript?: TranscriptEntry[];
    17		search_metadata?: { status: string };
    18		error?: string;
    19	}
    20	
exec
/usr/bin/zsh -lc "nl -ba src/providers/fetch/opengraph/index.ts | sed -n '1,120p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import { http_json } from '../../../common/http.js';
     2	import type { FetchProvider, FetchResult } from '../../../common/types.js';
     3	import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
     4	import { config } from '../../../config/env.js';
     5	
     6	// GET /api/1.1/extract/{url} returns structured extracted content
     7	interface OpenGraphExtractResponse {
     8		tags: Array<{ tag: string; innerText: string; position: number }>;
     9		concatenatedText: string;
    10		requestInfo: {
    11			host: string;
    12			responseCode: number;
    13		};
    14	}
    15	
    16	export class OpenGraphFetchProvider implements FetchProvider {
    17		name = 'opengraph';
    18		description = 'Fetch URL content using OpenGraph.io Extract API. Returns structured text extraction.';
    19	
    20		async fetch_url(url: string): Promise<FetchResult> {
exec
/usr/bin/zsh -lc "nl -ba src/providers/fetch/supadata/index.ts | sed -n '1,200p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	// Supadata YouTube Transcript fetch provider
     2	// Uses mode=auto: tries native captions first, falls back to AI-generated transcripts
     3	
     4	import { http_json } from '../../../common/http.js';
     5	import type { FetchProvider, FetchResult } from '../../../common/types.js';
     6	import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
     7	import { config } from '../../../config/env.js';
     8	
     9	interface TranscriptResponse {
    10		content: string;
    11		lang?: string;
    12		availableLangs?: string[];
    13	}
    14	
    15	interface AsyncJobResponse {
    16		jobId: string;
    17	}
    18	
    19	interface JobStatusResponse {
    20		status: 'queued' | 'active' | 'completed' | 'failed';
exec
/usr/bin/zsh -lc "nl -ba src/providers/fetch/sociavault/index.ts | sed -n '1,180p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import { http_json } from '../../../common/http.js';
     2	import type { FetchProvider, FetchResult } from '../../../common/types.js';
     3	import { ErrorType, ProviderError } from '../../../common/types.js';
     4	import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
     5	import { config } from '../../../config/env.js';
     6	
     7	// Platform detection and endpoint mapping from URL
     8	// SociaVault uses GET requests with query params (not POST)
     9	interface PlatformRoute {
    10		hosts: string[];
    11		platform: string;
    12		endpoint: string;
    13		param_name: string;
    14	}
    15	
    16	const PLATFORM_ROUTES: PlatformRoute[] = [
    17		// Reddit: GET /v1/scrape/reddit/post/comments?url=...
    18		{ hosts: ['reddit.com', 'www.reddit.com', 'old.reddit.com'], platform: 'reddit', endpoint: '/v1/scrape/reddit/post/comments', param_name: 'url' },
    19		// Twitter/X: GET /v1/scrape/twitter/tweet?url=...
    20		{ hosts: ['twitter.com', 'www.twitter.com', 'x.com', 'www.x.com'], platform: 'twitter', endpoint: '/v1/scrape/twitter/tweet', param_name: 'url' },
codex
The app code is covered. I’m switching to dependency internals now: `agents`, MCP SDK transport/server code, and the Cloudflare/runtime docs needed to validate the DO lifecycle assumptions and the SSE wrapper behavior.
exec
/usr/bin/zsh -lc "find node_modules/agents/dist -maxdepth 3 -type f | sort | sed -n '1,200p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
node_modules/agents/dist/ai-chat-agent.d.ts
node_modules/agents/dist/ai-chat-agent.js
node_modules/agents/dist/ai-chat-agent.js.map
node_modules/agents/dist/ai-chat-v5-migration.d.ts
node_modules/agents/dist/ai-chat-v5-migration.js
node_modules/agents/dist/ai-chat-v5-migration.js.map
node_modules/agents/dist/ai-react.d.ts
node_modules/agents/dist/ai-react.js
node_modules/agents/dist/ai-react.js.map
node_modules/agents/dist/ai-types.d.ts
node_modules/agents/dist/ai-types.js
node_modules/agents/dist/ai-types.js.map
node_modules/agents/dist/cli/index.d.ts
node_modules/agents/dist/cli/index.js
node_modules/agents/dist/cli/index.js.map
node_modules/agents/dist/client-K8Z-u76l.js
node_modules/agents/dist/client-K8Z-u76l.js.map
node_modules/agents/dist/client.d.ts
node_modules/agents/dist/client.js
node_modules/agents/dist/client.js.map
exec
/usr/bin/zsh -lc "find node_modules/@modelcontextprotocol/sdk -maxdepth 4 -type f | sort | sed -n '1,240p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
node_modules/@modelcontextprotocol/sdk/LICENSE
node_modules/@modelcontextprotocol/sdk/README.md
node_modules/@modelcontextprotocol/sdk/dist/cjs/client/auth-extensions.d.ts
node_modules/@modelcontextprotocol/sdk/dist/cjs/client/auth-extensions.d.ts.map
node_modules/@modelcontextprotocol/sdk/dist/cjs/client/auth-extensions.js
node_modules/@modelcontextprotocol/sdk/dist/cjs/client/auth-extensions.js.map
node_modules/@modelcontextprotocol/sdk/dist/cjs/client/auth.d.ts
node_modules/@modelcontextprotocol/sdk/dist/cjs/client/auth.d.ts.map
node_modules/@modelcontextprotocol/sdk/dist/cjs/client/auth.js
node_modules/@modelcontextprotocol/sdk/dist/cjs/client/auth.js.map
node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.d.ts
node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.d.ts.map
node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js
node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js.map
node_modules/@modelcontextprotocol/sdk/dist/cjs/client/middleware.d.ts
node_modules/@modelcontextprotocol/sdk/dist/cjs/client/middleware.d.ts.map
node_modules/@modelcontextprotocol/sdk/dist/cjs/client/middleware.js
node_modules/@modelcontextprotocol/sdk/dist/cjs/client/middleware.js.map
node_modules/@modelcontextprotocol/sdk/dist/cjs/client/sse.d.ts
node_modules/@modelcontextprotocol/sdk/dist/cjs/client/sse.d.ts.map
exec
/usr/bin/zsh -lc 'npm ls agents @modelcontextprotocol/sdk' in /home/cjangrist/dev/omnisearch succeeded in 131ms:
omnisearch-mcp@1.0.0 /home/cjangrist/dev/omnisearch
├── @modelcontextprotocol/sdk@1.27.1
└─┬ agents@0.7.9
  └── @modelcontextprotocol/sdk@1.26.0

exec
/usr/bin/zsh -lc "rg -n \"class McpAgent|serve\\(|init\\(|corsOptions|websocket|sse|streamable|mcp-session-id|Last-Event-ID|event-stream\" node_modules/agents/dist/mcp node_modules/agents/dist | sed -n '1,260p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
node_modules/agents/dist/client-K8Z-u76l.js.map:1:{"version":3,"file":"client-K8Z-u76l.js","names":[],"sources":["../src/core/events.ts","../src/mcp/errors.ts","../src/mcp/rpc.ts","../src/mcp/client-connection.ts","../src/mcp/client.ts"],"sourcesContent":["export interface Disposable {\n  dispose(): void;\n}\n\nexport function toDisposable(fn: () => void): Disposable {\n  return { dispose: fn };\n}\n\nexport class DisposableStore implements Disposable {\n  private readonly _items: Disposable[] = [];\n\n  add<T extends Disposable>(d: T): T {\n    this._items.push(d);\n    return d;\n  }\n\n  dispose(): void {\n    while (this._items.length) {\n      try {\n        this._items.pop()!.dispose();\n      } catch {\n        // best-effort cleanup\n      }\n    }\n  }\n}\n\nexport type Event<T> = (listener: (e: T) => void) => Disposable;\n\nexport class Emitter<T> implements Disposable {\n  private _listeners: Set<(e: T) => void> = new Set();\n\n  readonly event: Event<T> = (listener) => {\n    this._listeners.add(listener);\n    return toDisposable(() => this._listeners.delete(listener));\n  };\n\n  fire(data: T): void {\n    for (const listener of [...this._listeners]) {\n      try {\n        listener(data);\n      } catch (err) {\n        // do not let one bad listener break others\n        console.error(\"Emitter listener error:\", err);\n      }\n    }\n  }\n\n  dispose(): void {\n    this._listeners.clear();\n  }\n}\n","export function toErrorMessage(error: unknown): string {\n  return error instanceof Error ? error.message : String(error);\n}\n\nfunction getErrorCode(error: unknown): number | undefined {\n  if (\n    error &&\n    typeof error === \"object\" &&\n    \"code\" in error &&\n    typeof (error as { code: unknown }).code === \"number\"\n  ) {\n    return (error as { code: number }).code;\n  }\n  return undefined;\n}\n\nexport function isUnauthorized(error: unknown): boolean {\n  const code = getErrorCode(error);\n  if (code === 401) return true;\n\n  const msg = toErrorMessage(error);\n  return msg.includes(\"Unauthorized\") || msg.includes(\"401\");\n}\n\n// MCP SDK change (v1.24.0, commit 6b90e1a):\n//   - Old: Error POSTing to endpoint (HTTP 404): Not Found\n//   - New: StreamableHTTPError with code: 404 and message Error POSTing to endpoint: Not Found\nexport function isTransportNotImplemented(error: unknown): boolean {\n  const code = getErrorCode(error);\n  if (code === 404 || code === 405) return true;\n\n  const msg = toErrorMessage(error);\n  return (\n    msg.includes(\"404\") ||\n    msg.includes(\"405\") ||\n    msg.includes(\"Not Implemented\") ||\n    msg.includes(\"not implemented\")\n  );\n}\n","import type {\n  Transport,\n  TransportSendOptions\n} from \"@modelcontextprotocol/sdk/shared/transport.js\";\nimport type {\n  JSONRPCMessage,\n  MessageExtraInfo\n} from \"@modelcontextprotocol/sdk/types.js\";\nimport { JSONRPCMessageSchema } from \"@modelcontextprotocol/sdk/types.js\";\nimport { getServerByName } from \"partyserver\";\nimport type { McpAgent } from \".\";\n\nexport const RPC_DO_PREFIX = \"rpc:\";\n\nfunction makeInvalidRequestError(id: unknown): JSONRPCMessage {\n  return {\n    jsonrpc: \"2.0\",\n    id: id ?? null,\n    error: {\n      code: -32600,\n      message: \"Invalid Request\"\n    }\n  } as JSONRPCMessage;\n}\n\nfunction validateBatch(batch: JSONRPCMessage[]): void {\n  if (batch.length === 0) {\n    throw new Error(\"Invalid JSON-RPC batch: array must not be empty\");\n  }\n}\n\nexport interface RPCClientTransportOptions<T extends McpAgent = McpAgent> {\n  namespace: DurableObjectNamespace<T>;\n  name: string;\n  props?: Record<string, unknown>;\n}\n\nexport class RPCClientTransport implements Transport {\n  private _namespace: DurableObjectNamespace<McpAgent>;\n  private _name: string;\n  private _props?: Record<string, unknown>;\n  private _stub?: DurableObjectStub<McpAgent>;\n  private _started = false;\n  private _protocolVersion?: string;\n\n  sessionId?: string;\n  onclose?: () => void;\n  onerror?: (error: Error) => void;\n  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;\n\n  constructor(options: RPCClientTransportOptions<McpAgent>) {\n    this._namespace = options.namespace;\n    this._name = options.name;\n    this._props = options.props;\n  }\n\n  setProtocolVersion(version: string): void {\n    this._protocolVersion = version;\n  }\n\n  getProtocolVersion(): string | undefined {\n    return this._protocolVersion;\n  }\n\n  async start(): Promise<void> {\n    if (this._started) {\n      throw new Error(\"Transport already started\");\n    }\n\n    const doName = `${RPC_DO_PREFIX}${this._name}`;\n    this._stub = await getServerByName(this._namespace, doName, {\n      props: this._props\n    });\n\n    this._started = true;\n  }\n\n  async close(): Promise<void> {\n    this._started = false;\n    this._stub = undefined;\n    this.onclose?.();\n  }\n\n  async send(\n    message: JSONRPCMessage | JSONRPCMessage[],\n    options?: TransportSendOptions\n  ): Promise<void> {\n    if (!this._started || !this._stub) {\n      throw new Error(\"Transport not started\");\n    }\n\n    try {\n      const result: JSONRPCMessage | JSONRPCMessage[] | undefined =\n        await this._stub.handleMcpMessage(message);\n\n      if (!result) {\n        return;\n      }\n\n      const extra: MessageExtraInfo | undefined = options?.relatedRequestId\n        ? { requestInfo: { headers: {} } }\n        : undefined;\n\n      const messages = Array.isArray(result) ? result : [result];\n      for (const msg of messages) {\n        this.onmessage?.(msg, extra);\n      }\n    } catch (error) {\n      this.onerror?.(error as Error);\n      throw error;\n    }\n  }\n}\n\nexport interface RPCServerTransportOptions {\n  timeout?: number;\n}\n\nexport class RPCServerTransport implements Transport {\n  private _started = false;\n  private _pendingResponse: JSONRPCMessage | JSONRPCMessage[] | null = null;\n  private _responseResolver: (() => void) | null = null;\n  private _protocolVersion?: string;\n  private _timeout: number;\n\n  sessionId?: string;\n  onclose?: () => void;\n  onerror?: (error: Error) => void;\n  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;\n\n  constructor(options?: RPCServerTransportOptions) {\n    this._timeout = options?.timeout ?? 60000;\n  }\n\n  setProtocolVersion(version: string): void {\n    this._protocolVersion = version;\n  }\n\n  getProtocolVersion(): string | undefined {\n    return this._protocolVersion;\n  }\n\n  async start(): Promise<void> {\n    if (this._started) {\n      throw new Error(\"Transport already started\");\n    }\n    this._started = true;\n  }\n\n  async close(): Promise<void> {\n    this._started = false;\n    this.onclose?.();\n    if (this._responseResolver) {\n      this._responseResolver();\n      this._responseResolver = null;\n    }\n  }\n\n  async send(\n    message: JSONRPCMessage,\n    _options?: TransportSendOptions\n  ): Promise<void> {\n    if (!this._started) {\n      throw new Error(\"Transport not started\");\n    }\n\n    if (!this._pendingResponse) {\n      this._pendingResponse = message;\n    } else if (Array.isArray(this._pendingResponse)) {\n      this._pendingResponse.push(message);\n    } else {\n      this._pendingResponse = [this._pendingResponse, message];\n    }\n\n    if (this._responseResolver) {\n      const resolver = this._responseResolver;\n      queueMicrotask(() => resolver());\n    }\n  }\n\n  async handle(\n    message: JSONRPCMessage | JSONRPCMessage[]\n  ): Promise<JSONRPCMessage | JSONRPCMessage[] | undefined> {\n    if (!this._started) {\n      throw new Error(\"Transport not started\");\n    }\n\n    if (Array.isArray(message)) {\n      validateBatch(message);\n\n      const responses: JSONRPCMessage[] = [];\n      for (const msg of message) {\n        const response = await this.handle(msg);\n        if (response !== undefined) {\n          if (Array.isArray(response)) {\n            responses.push(...response);\n          } else {\n            responses.push(response);\n          }\n        }\n      }\n\n      return responses.length === 0 ? undefined : responses;\n    }\n\n    try {\n      JSONRPCMessageSchema.parse(message);\n    } catch {\n      const id =\n        typeof message === \"object\" && message !== null && \"id\" in message\n          ? (message as { id: unknown }).id\n          : null;\n      return makeInvalidRequestError(id);\n    }\n\n    this._pendingResponse = null;\n\n    const isNotification = !(\"id\" in message);\n    if (isNotification) {\n      this.onmessage?.(message);\n      return undefined;\n    }\n\n    let timeoutId: ReturnType<typeof setTimeout> | null = null;\n    const responsePromise = new Promise<void>((resolve, reject) => {\n      timeoutId = setTimeout(() => {\n        this._responseResolver = null;\n        reject(\n          new Error(\n            `Request timeout: No response received within ${this._timeout}ms`\n          )\n        );\n      }, this._timeout);\n\n      this._responseResolver = () => {\n        if (timeoutId) {\n          clearTimeout(timeoutId);\n          timeoutId = null;\n        }\n        this._responseResolver = null;\n        resolve();\n      };\n    });\n\n    this.onmessage?.(message);\n\n    try {\n      await responsePromise;\n    } catch (error) {\n      this._pendingResponse = null;\n      this._responseResolver = null;\n      throw error;\n    }\n\n    const response = this._pendingResponse;\n    this._pendingResponse = null;\n\n    return response ?? undefined;\n  }\n}\n","import { Client } from \"@modelcontextprotocol/sdk/client/index.js\";\nimport {\n  SSEClientTransport,\n  type SSEClientTransportOptions\n} from \"@modelcontextprotocol/sdk/client/sse.js\";\nimport {\n  StreamableHTTPClientTransport,\n  type StreamableHTTPClientTransportOptions\n} from \"@modelcontextprotocol/sdk/client/streamableHttp.js\";\n// Import types directly from MCP SDK\nimport type {\n  Prompt,\n  Resource,\n  Tool\n} from \"@modelcontextprotocol/sdk/types.js\";\nimport {\n  type ClientCapabilities,\n  type ElicitRequest,\n  ElicitRequestSchema,\n  type ElicitResult,\n  type ListPromptsResult,\n  type ListResourceTemplatesResult,\n  type ListResourcesResult,\n  type ListToolsResult,\n  PromptListChangedNotificationSchema,\n  ResourceListChangedNotificationSchema,\n  type ResourceTemplate,\n  type ServerCapabilities,\n  ToolListChangedNotificationSchema\n} from \"@modelcontextprotocol/sdk/types.js\";\nimport { Emitter, type Event } from \"../core/events\";\nimport type { MCPObservabilityEvent } from \"../observability/mcp\";\nimport type { AgentMcpOAuthProvider } from \"./do-oauth-client-provider\";\nimport {\n  isTransportNotImplemented,\n  isUnauthorized,\n  toErrorMessage\n} from \"./errors\";\nimport { RPCClientTransport, type RPCClientTransportOptions } from \"./rpc\";\nimport type {\n  BaseTransportType,\n  HttpTransportType,\n  TransportType,\n  McpClientOptions\n} from \"./types\";\n\n/**\n * Connection state machine for MCP client connections.\n *\n * State transitions:\n * - Non-OAuth: init() → CONNECTING → DISCOVERING → READY\n * - OAuth: init() → AUTHENTICATING → (callback) → CONNECTING → DISCOVERING → READY\n * - Any state can transition to FAILED on error\n */\nexport const MCPConnectionState = {\n  /** Waiting for OAuth authorization to complete */\n  AUTHENTICATING: \"authenticating\",\n  /** Establishing transport connection to MCP server */\n  CONNECTING: \"connecting\",\n  /** Transport connection established */\n  CONNECTED: \"connected\",\n  /** Discovering server capabilities (tools, resources, prompts) */\n  DISCOVERING: \"discovering\",\n  /** Fully connected and ready to use */\n  READY: \"ready\",\n  /** Connection failed at some point */\n  FAILED: \"failed\"\n} as const;\n\n/**\n * Connection state type for MCP client connections.\n */\nexport type MCPConnectionState =\n  (typeof MCPConnectionState)[keyof typeof MCPConnectionState];\n\n/**\n * Transport options for MCP client connections.\n * Combines transport-specific options with auth provider and type selection.\n */\nexport type MCPTransportOptions = (\n  | SSEClientTransportOptions\n  | StreamableHTTPClientTransportOptions\n  | RPCClientTransportOptions\n) & {\n  authProvider?: AgentMcpOAuthProvider;\n  type?: TransportType;\n};\n\nexport type MCPClientConnectionResult = {\n  state: MCPConnectionState;\n  error?: Error;\n  transport?: BaseTransportType;\n};\n\n/**\n * Result of a discovery operation.\n * success indicates whether discovery completed successfully.\n * error is present when success is false.\n */\nexport type MCPDiscoveryResult = {\n  success: boolean;\n  error?: string;\n};\n\nexport class MCPClientConnection {\n  client: Client;\n  connectionState: MCPConnectionState = MCPConnectionState.CONNECTING;\n  connectionError: string | null = null;\n  lastConnectedTransport: BaseTransportType | undefined;\n  instructions?: string;\n  tools: Tool[] = [];\n  prompts: Prompt[] = [];\n  resources: Resource[] = [];\n  resourceTemplates: ResourceTemplate[] = [];\n  serverCapabilities: ServerCapabilities | undefined;\n\n  /** Tracks in-flight discovery to allow cancellation */\n  private _discoveryAbortController: AbortController | undefined;\n\n  private readonly _onObservabilityEvent = new Emitter<MCPObservabilityEvent>();\n  public readonly onObservabilityEvent: Event<MCPObservabilityEvent> =\n    this._onObservabilityEvent.event;\n\n  constructor(\n    public url: URL,\n    info: ConstructorParameters<typeof Client>[0],\n    public options: {\n      transport: MCPTransportOptions;\n      client: McpClientOptions;\n    } = { client: {}, transport: {} }\n  ) {\n    const clientOptions = {\n      ...options.client,\n      capabilities: {\n        ...options.client?.capabilities,\n        elicitation: {}\n      } as ClientCapabilities\n    };\n\n    this.client = new Client(info, clientOptions);\n  }\n\n  /**\n   * Initialize a client connection, if authentication is required, the connection will be in the AUTHENTICATING state\n   * Sets connection state based on the result and emits observability events\n   *\n   * @returns Error message if connection failed, undefined otherwise\n   */\n  async init(): Promise<string | undefined> {\n    const transportType = this.options.transport.type;\n    if (!transportType) {\n      throw new Error(\"Transport type must be specified\");\n    }\n\n    const res = await this.tryConnect(transportType);\n\n    // Set the connection state\n    this.connectionState = res.state;\n\n    // Handle the result and emit appropriate events\n    if (res.state === MCPConnectionState.CONNECTED && res.transport) {\n      // Set up elicitation request handler after successful connection\n      this.client.setRequestHandler(\n        ElicitRequestSchema,\n        async (request: ElicitRequest) => {\n          return await this.handleElicitationRequest(request);\n        }\n      );\n\n      this.lastConnectedTransport = res.transport;\n\n      this._onObservabilityEvent.fire({\n        type: \"mcp:client:connect\",\n        payload: {\n          url: this.url.toString(),\n          transport: res.transport,\n          state: this.connectionState\n        },\n        timestamp: Date.now()\n      });\n      return undefined;\n    } else if (res.state === MCPConnectionState.FAILED && res.error) {\n      const errorMessage = toErrorMessage(res.error);\n      this._onObservabilityEvent.fire({\n        type: \"mcp:client:connect\",\n        payload: {\n          url: this.url.toString(),\n          transport: transportType,\n          state: this.connectionState,\n          error: errorMessage\n        },\n        timestamp: Date.now()\n      });\n      return errorMessage;\n    }\n    return undefined;\n  }\n\n  /**\n   * Finish OAuth by probing transports based on configured type.\n   * - Explicit: finish on that transport\n   * - Auto: try streamable-http, then sse on 404/405/Not Implemented\n   */\n  private async finishAuthProbe(code: string): Promise<void> {\n    if (!this.options.transport.authProvider) {\n      throw new Error(\"No auth provider configured\");\n    }\n\n    const configuredType = this.options.transport.type;\n    if (!configuredType) {\n      throw new Error(\"Transport type must be specified\");\n    }\n\n    const finishAuth = async (base: HttpTransportType) => {\n      const transport = this.getTransport(base);\n      if (\n        \"finishAuth\" in transport &&\n        typeof transport.finishAuth === \"function\"\n      ) {\n        await transport.finishAuth(code);\n      }\n    };\n\n    if (configuredType === \"rpc\") {\n      throw new Error(\"RPC transport does not support authentication\");\n    }\n\n    if (configuredType === \"sse\" || configuredType === \"streamable-http\") {\n      await finishAuth(configuredType);\n      return;\n    }\n\n    // For \"auto\" mode, try streamable-http first, then fall back to SSE\n    try {\n      await finishAuth(\"streamable-http\");\n    } catch (e) {\n      if (isTransportNotImplemented(e)) {\n        await finishAuth(\"sse\");\n        return;\n      }\n      throw e;\n    }\n  }\n\n  /**\n   * Complete OAuth authorization\n   */\n  async completeAuthorization(code: string): Promise<void> {\n    if (this.connectionState !== MCPConnectionState.AUTHENTICATING) {\n      throw new Error(\n        \"Connection must be in authenticating state to complete authorization\"\n      );\n    }\n\n    try {\n      // Finish OAuth by probing transports per configuration\n      await this.finishAuthProbe(code);\n\n      // Mark as connecting\n      this.connectionState = MCPConnectionState.CONNECTING;\n    } catch (error) {\n      this.connectionState = MCPConnectionState.FAILED;\n      throw error;\n    }\n  }\n\n  /**\n   * Discover server capabilities and register tools, resources, prompts, and templates.\n   * This method does the work but does not manage connection state - that's handled by discover().\n   */\n  async discoverAndRegister(): Promise<void> {\n    this.serverCapabilities = this.client.getServerCapabilities();\n    if (!this.serverCapabilities) {\n      throw new Error(\"The MCP Server failed to return server capabilities\");\n    }\n\n    // Build list of operations to perform based on server capabilities\n    type DiscoveryResult =\n      | string\n      | undefined\n      | Tool[]\n      | Resource[]\n      | Prompt[]\n      | ResourceTemplate[];\n    const operations: Promise<DiscoveryResult>[] = [];\n    const operationNames: string[] = [];\n\n    // Instructions (always try to fetch if available)\n    operations.push(Promise.resolve(this.client.getInstructions()));\n    operationNames.push(\"instructions\");\n\n    // Only register capabilities that the server advertises\n    if (this.serverCapabilities.tools) {\n      operations.push(this.registerTools());\n      operationNames.push(\"tools\");\n    }\n\n    if (this.serverCapabilities.resources) {\n      operations.push(this.registerResources());\n      operationNames.push(\"resources\");\n    }\n\n    if (this.serverCapabilities.prompts) {\n      operations.push(this.registerPrompts());\n      operationNames.push(\"prompts\");\n    }\n\n    if (this.serverCapabilities.resources) {\n      operations.push(this.registerResourceTemplates());\n      operationNames.push(\"resource templates\");\n    }\n\n    try {\n      const results = await Promise.all(operations);\n      for (let i = 0; i < results.length; i++) {\n        const result = results[i];\n        const name = operationNames[i];\n\n        switch (name) {\n          case \"instructions\":\n            this.instructions = result as string | undefined;\n            break;\n          case \"tools\":\n            this.tools = result as Tool[];\n            break;\n          case \"resources\":\n            this.resources = result as Resource[];\n            break;\n          case \"prompts\":\n            this.prompts = result as Prompt[];\n            break;\n          case \"resource templates\":\n            this.resourceTemplates = result as ResourceTemplate[];\n            break;\n        }\n      }\n    } catch (error) {\n      this._onObservabilityEvent.fire({\n        type: \"mcp:client:discover\",\n        payload: {\n          url: this.url.toString(),\n          error: toErrorMessage(error)\n        },\n        timestamp: Date.now()\n      });\n\n      throw error;\n    }\n  }\n\n  /**\n   * Discover server capabilities with timeout and cancellation support.\n   * If called while a previous discovery is in-flight, the previous discovery will be aborted.\n   *\n   * @param options Optional configuration\n   * @param options.timeoutMs Timeout in milliseconds (default: 15000)\n   * @returns Result indicating success/failure with optional error message\n   */\n  async discover(\n    options: { timeoutMs?: number } = {}\n  ): Promise<MCPDiscoveryResult> {\n    const { timeoutMs = 15000 } = options;\n\n    // Check if state allows discovery\n    if (\n      this.connectionState !== MCPConnectionState.CONNECTED &&\n      this.connectionState !== MCPConnectionState.READY\n    ) {\n      this._onObservabilityEvent.fire({\n        type: \"mcp:client:discover\",\n        payload: {\n          url: this.url.toString(),\n          state: this.connectionState\n        },\n        timestamp: Date.now()\n      });\n      return {\n        success: false,\n        error: `Discovery skipped - connection in ${this.connectionState} state`\n      };\n    }\n\n    // Cancel any previous in-flight discovery\n    if (this._discoveryAbortController) {\n      this._discoveryAbortController.abort();\n      this._discoveryAbortController = undefined;\n    }\n\n    // Create a new AbortController for this discovery\n    const abortController = new AbortController();\n    this._discoveryAbortController = abortController;\n\n    this.connectionState = MCPConnectionState.DISCOVERING;\n\n    let timeoutId: ReturnType<typeof setTimeout> | undefined;\n\n    try {\n      // Create timeout promise\n      const timeoutPromise = new Promise<never>((_, reject) => {\n        timeoutId = setTimeout(\n          () => reject(new Error(`Discovery timed out after ${timeoutMs}ms`)),\n          timeoutMs\n        );\n      });\n\n      // Check if aborted before starting\n      if (abortController.signal.aborted) {\n        throw new Error(\"Discovery was cancelled\");\n      }\n\n      // Create an abort promise that rejects when signal fires\n      const abortPromise = new Promise<never>((_, reject) => {\n        abortController.signal.addEventListener(\"abort\", () => {\n          reject(new Error(\"Discovery was cancelled\"));\n        });\n      });\n\n      await Promise.race([\n        this.discoverAndRegister(),\n        timeoutPromise,\n        abortPromise\n      ]);\n\n      // Clear timeout on success\n      if (timeoutId !== undefined) {\n        clearTimeout(timeoutId);\n      }\n\n      // Discovery succeeded - transition to ready\n      this.connectionState = MCPConnectionState.READY;\n\n      this._onObservabilityEvent.fire({\n        type: \"mcp:client:discover\",\n        payload: {\n          url: this.url.toString()\n        },\n        timestamp: Date.now()\n      });\n\n      return { success: true };\n    } catch (e) {\n      // Always clear the timeout\n      if (timeoutId !== undefined) {\n        clearTimeout(timeoutId);\n      }\n\n      // Return to CONNECTED state so user can retry discovery\n      this.connectionState = MCPConnectionState.CONNECTED;\n\n      const error = e instanceof Error ? e.message : String(e);\n      return { success: false, error };\n    } finally {\n      // Clean up the abort controller\n      this._discoveryAbortController = undefined;\n    }\n  }\n\n  /**\n   * Cancel any in-flight discovery operation.\n   * Called when closing the connection.\n   */\n  cancelDiscovery(): void {\n    if (this._discoveryAbortController) {\n      this._discoveryAbortController.abort();\n      this._discoveryAbortController = undefined;\n    }\n  }\n\n  /**\n   * Notification handler registration for tools\n   * Should only be called if serverCapabilities.tools exists\n   */\n  async registerTools(): Promise<Tool[]> {\n    if (this.serverCapabilities?.tools?.listChanged) {\n      this.client.setNotificationHandler(\n        ToolListChangedNotificationSchema,\n        async (_notification) => {\n          this.tools = await this.fetchTools();\n        }\n      );\n    }\n\n    return this.fetchTools();\n  }\n\n  /**\n   * Notification handler registration for resources\n   * Should only be called if serverCapabilities.resources exists\n   */\n  async registerResources(): Promise<Resource[]> {\n    if (this.serverCapabilities?.resources?.listChanged) {\n      this.client.setNotificationHandler(\n        ResourceListChangedNotificationSchema,\n        async (_notification) => {\n          this.resources = await this.fetchResources();\n        }\n      );\n    }\n\n    return this.fetchResources();\n  }\n\n  /**\n   * Notification handler registration for prompts\n   * Should only be called if serverCapabilities.prompts exists\n   */\n  async registerPrompts(): Promise<Prompt[]> {\n    if (this.serverCapabilities?.prompts?.listChanged) {\n      this.client.setNotificationHandler(\n        PromptListChangedNotificationSchema,\n        async (_notification) => {\n          this.prompts = await this.fetchPrompts();\n        }\n      );\n    }\n\n    return this.fetchPrompts();\n  }\n\n  async registerResourceTemplates(): Promise<ResourceTemplate[]> {\n    return this.fetchResourceTemplates();\n  }\n\n  async fetchTools() {\n    let toolsAgg: Tool[] = [];\n    let toolsResult: ListToolsResult = { tools: [] };\n    do {\n      toolsResult = await this.client\n        .listTools({\n          cursor: toolsResult.nextCursor\n        })\n        .catch(this._capabilityErrorHandler({ tools: [] }, \"tools/list\"));\n      toolsAgg = toolsAgg.concat(toolsResult.tools);\n    } while (toolsResult.nextCursor);\n    return toolsAgg;\n  }\n\n  async fetchResources() {\n    let resourcesAgg: Resource[] = [];\n    let resourcesResult: ListResourcesResult = { resources: [] };\n    do {\n      resourcesResult = await this.client\n        .listResources({\n          cursor: resourcesResult.nextCursor\n        })\n        .catch(\n          this._capabilityErrorHandler({ resources: [] }, \"resources/list\")\n        );\n      resourcesAgg = resourcesAgg.concat(resourcesResult.resources);\n    } while (resourcesResult.nextCursor);\n    return resourcesAgg;\n  }\n\n  async fetchPrompts() {\n    let promptsAgg: Prompt[] = [];\n    let promptsResult: ListPromptsResult = { prompts: [] };\n    do {\n      promptsResult = await this.client\n        .listPrompts({\n          cursor: promptsResult.nextCursor\n        })\n        .catch(this._capabilityErrorHandler({ prompts: [] }, \"prompts/list\"));\n      promptsAgg = promptsAgg.concat(promptsResult.prompts);\n    } while (promptsResult.nextCursor);\n    return promptsAgg;\n  }\n\n  async fetchResourceTemplates() {\n    let templatesAgg: ResourceTemplate[] = [];\n    let templatesResult: ListResourceTemplatesResult = {\n      resourceTemplates: []\n    };\n    do {\n      templatesResult = await this.client\n        .listResourceTemplates({\n          cursor: templatesResult.nextCursor\n        })\n        .catch(\n          this._capabilityErrorHandler(\n            { resourceTemplates: [] },\n            \"resources/templates/list\"\n          )\n        );\n      templatesAgg = templatesAgg.concat(templatesResult.resourceTemplates);\n    } while (templatesResult.nextCursor);\n    return templatesAgg;\n  }\n\n  /**\n   * Handle elicitation request from server\n   * Automatically uses the Agent's built-in elicitation handling if available\n   */\n  async handleElicitationRequest(\n    _request: ElicitRequest\n  ): Promise<ElicitResult> {\n    // Elicitation handling must be implemented by the platform\n    // For MCP servers, this should be handled by McpAgent.elicitInput()\n    throw new Error(\n      \"Elicitation handler must be implemented for your platform. Override handleElicitationRequest method.\"\n    );\n  }\n  /**\n   * Get the transport for the client\n   * @param transportType - The transport type to get\n   * @returns The transport for the client\n   */\n  getTransport(transportType: BaseTransportType) {\n    switch (transportType) {\n      case \"streamable-http\":\n        return new StreamableHTTPClientTransport(\n          this.url,\n          this.options.transport as StreamableHTTPClientTransportOptions\n        );\n      case \"sse\":\n        return new SSEClientTransport(\n          this.url,\n          this.options.transport as SSEClientTransportOptions\n        );\n      case \"rpc\":\n        return new RPCClientTransport(\n          this.options.transport as RPCClientTransportOptions\n        );\n      default:\n        throw new Error(`Unsupported transport type: ${transportType}`);\n    }\n  }\n\n  private async tryConnect(\n    transportType: TransportType\n  ): Promise<MCPClientConnectionResult> {\n    const transports: BaseTransportType[] =\n      transportType === \"auto\" ? [\"streamable-http\", \"sse\"] : [transportType];\n\n    for (const currentTransportType of transports) {\n      const isLastTransport =\n        currentTransportType === transports[transports.length - 1];\n      const hasFallback =\n        transportType === \"auto\" &&\n        currentTransportType === \"streamable-http\" &&\n        !isLastTransport;\n\n      const transport = this.getTransport(currentTransportType);\n\n      try {\n        await this.client.connect(transport);\n\n        return {\n          state: MCPConnectionState.CONNECTED,\n          transport: currentTransportType\n        };\n      } catch (e) {\n        const error = e instanceof Error ? e : new Error(String(e));\n\n        if (isUnauthorized(error)) {\n          return {\n            state: MCPConnectionState.AUTHENTICATING\n          };\n        }\n\n        if (isTransportNotImplemented(error) && hasFallback) {\n          // Try the next transport\n          continue;\n        }\n\n        return {\n          state: MCPConnectionState.FAILED,\n          error\n        };\n      }\n    }\n\n    // Should never reach here\n    return {\n      state: MCPConnectionState.FAILED,\n      error: new Error(\"No transports available\")\n    };\n  }\n\n  private _capabilityErrorHandler<T>(empty: T, method: string) {\n    return (e: { code: number }) => {\n      // server is badly behaved and returning invalid capabilities. This commonly occurs for resource templates\n      if (e.code === -32601) {\n        const url = this.url.toString();\n        this._onObservabilityEvent.fire({\n          type: \"mcp:client:discover\",\n          payload: {\n            url,\n            capability: method.split(\"/\")[0],\n            error: toErrorMessage(e)\n          },\n          timestamp: Date.now()\n        });\n        return empty;\n      }\n      throw e;\n    };\n  }\n}\n","import type { Client } from \"@modelcontextprotocol/sdk/client/index.js\";\nimport type { RequestOptions } from \"@modelcontextprotocol/sdk/shared/protocol.js\";\nimport type {\n  CallToolRequest,\n  CallToolResultSchema,\n  CompatibilityCallToolResultSchema,\n  GetPromptRequest,\n  Prompt,\n  ReadResourceRequest,\n  Resource,\n  ResourceTemplate,\n  Tool\n} from \"@modelcontextprotocol/sdk/types.js\";\nimport { CfWorkerJsonSchemaValidator } from \"@modelcontextprotocol/sdk/validation/cfworker-provider.js\";\nimport { type RetryOptions, tryN } from \"../retries\";\nimport type { ToolSet } from \"ai\";\nimport type { JSONSchema7 } from \"json-schema\";\nimport { nanoid } from \"nanoid\";\nimport { Emitter, type Event, DisposableStore } from \"../core/events\";\nimport type { MCPObservabilityEvent } from \"../observability/mcp\";\nimport {\n  MCPClientConnection,\n  MCPConnectionState,\n  type MCPTransportOptions\n} from \"./client-connection\";\nimport { toErrorMessage } from \"./errors\";\nimport { RPC_DO_PREFIX } from \"./rpc\";\nimport type { TransportType } from \"./types\";\nimport type { MCPServerRow } from \"./client-storage\";\nimport type { AgentMcpOAuthProvider } from \"./do-oauth-client-provider\";\nimport { DurableObjectOAuthClientProvider } from \"./do-oauth-client-provider\";\n\nconst defaultClientOptions: ConstructorParameters<typeof Client>[1] = {\n  jsonSchemaValidator: new CfWorkerJsonSchemaValidator()\n};\n\n/**\n * Blocked hostname patterns for SSRF protection.\n * Prevents MCP client from connecting to internal/private network addresses\n * while allowing loopback hosts for local development.\n */\nconst BLOCKED_HOSTNAMES = new Set([\n  \"0.0.0.0\",\n  \"[::]\",\n  \"metadata.google.internal\"\n]);\n\n/**\n * Check whether four IPv4 octets belong to a private/reserved range.\n * Blocks RFC 1918, link-local, cloud metadata, and unspecified addresses.\n */\nfunction isPrivateIPv4(octets: number[]): boolean {\n  const [a, b] = octets;\n  // 10.0.0.0/8\n  if (a === 10) return true;\n  // 172.16.0.0/12\n  if (a === 172 && b >= 16 && b <= 31) return true;\n  // 192.168.0.0/16\n  if (a === 192 && b === 168) return true;\n  // 169.254.0.0/16 (link-local / cloud metadata)\n  if (a === 169 && b === 254) return true;\n  // 0.0.0.0/8\n  if (a === 0) return true;\n  return false;\n}\n\n/**\n * Check whether a hostname looks like a private/internal IP address.\n * Blocks RFC 1918, link-local, unique-local, unspecified,\n * and cloud metadata endpoints. Also detects IPv4-mapped IPv6 addresses.\n */\nfunction isBlockedUrl(url: string): boolean {\n  let parsed: URL;\n  try {\n    parsed = new URL(url);\n  } catch {\n    return true; // Malformed URLs are blocked\n  }\n\n  const hostname = parsed.hostname;\n\n  if (BLOCKED_HOSTNAMES.has(hostname)) return true;\n\n  // IPv4 checks\n  const ipv4Parts = hostname.split(\".\");\n  if (ipv4Parts.length === 4 && ipv4Parts.every((p) => /^\\d{1,3}$/.test(p))) {\n    if (isPrivateIPv4(ipv4Parts.map(Number))) return true;\n  }\n\n  // IPv6 private range checks\n  // URL parser keeps brackets: hostname for [fc00::1] is \"[fc00::1]\"\n  if (hostname.startsWith(\"[\") && hostname.endsWith(\"]\")) {\n    const addr = hostname.slice(1, -1).toLowerCase();\n    // fc00::/7 — unique local addresses (fc00:: through fdff::)\n    if (addr.startsWith(\"fc\") || addr.startsWith(\"fd\")) return true;\n    // fe80::/10 — link-local addresses\n    if (addr.startsWith(\"fe80\")) return true;\n    // IPv4-mapped IPv6 (::ffff:x.x.x.x or ::ffff:XXYY:ZZWW)\n    if (addr.startsWith(\"::ffff:\")) {\n      const mapped = addr.slice(7);\n      const dotParts = mapped.split(\".\");\n      if (dotParts.length === 4 && dotParts.every((p) => /^\\d{1,3}$/.test(p))) {\n        if (isPrivateIPv4(dotParts.map(Number))) return true;\n      } else {\n        const hexParts = mapped.split(\":\");\n        if (hexParts.length === 2) {\n          const hi = parseInt(hexParts[0], 16);\n          const lo = parseInt(hexParts[1], 16);\n          if (\n            isPrivateIPv4([\n              (hi >> 8) & 0xff,\n              hi & 0xff,\n              (lo >> 8) & 0xff,\n              lo & 0xff\n            ])\n          )\n            return true;\n        }\n      }\n    }\n  }\n\n  return false;\n}\n\n/**\n * Options that can be stored in the server_options column\n * This is what gets JSON.stringify'd and stored in the database\n */\nexport type MCPServerOptions = {\n  client?: ConstructorParameters<typeof Client>[1];\n  transport?: {\n    headers?: HeadersInit;\n    type?: TransportType;\n  };\n  /** Retry options for connection and reconnection attempts */\n  retry?: RetryOptions;\n};\n\n/**\n * Result of an OAuth callback request\n */\nexport type MCPOAuthCallbackResult =\n  | { serverId: string; authSuccess: true; authError?: undefined }\n  | { serverId?: string; authSuccess: false; authError: string };\n\n/**\n * Options for registering an MCP server\n */\nexport type RegisterServerOptions = {\n  url: string;\n  name: string;\n  callbackUrl?: string;\n  client?: ConstructorParameters<typeof Client>[1];\n  transport?: MCPTransportOptions;\n  authUrl?: string;\n  clientId?: string;\n  /** Retry options for connection and reconnection attempts */\n  retry?: RetryOptions;\n};\n\n/**\n * Result of attempting to connect to an MCP server.\n * Discriminated union ensures error is present only on failure.\n */\nexport type MCPConnectionResult =\n  | {\n      state: typeof MCPConnectionState.FAILED;\n      error: string;\n    }\n  | {\n      state: typeof MCPConnectionState.AUTHENTICATING;\n      authUrl: string;\n      clientId?: string;\n    }\n  | {\n      state: typeof MCPConnectionState.CONNECTED;\n    };\n\n/**\n * Result of discovering server capabilities.\n * success indicates whether discovery completed successfully.\n * state is the current connection state at time of return.\n * error is present when success is false.\n */\nexport type MCPDiscoverResult = {\n  success: boolean;\n  state: MCPConnectionState;\n  error?: string;\n};\n\nexport type MCPClientOAuthCallbackConfig = {\n  successRedirect?: string;\n  errorRedirect?: string;\n  customHandler?: (result: MCPClientOAuthResult) => Response;\n};\n\nexport type MCPClientOAuthResult =\n  | { serverId: string; authSuccess: true; authError?: undefined }\n  | {\n      serverId?: string;\n      authSuccess: false;\n      /** May contain untrusted content from external OAuth providers. Escape appropriately for your output context. */\n      authError: string;\n    };\n\nexport type MCPClientManagerOptions = {\n  storage: DurableObjectStorage;\n  createAuthProvider?: (callbackUrl: string) => AgentMcpOAuthProvider;\n};\n\n/**\n * Utility class that aggregates multiple MCP clients into one\n */\nexport class MCPClientManager {\n  public mcpConnections: Record<string, MCPClientConnection> = {};\n  private _didWarnAboutUnstableGetAITools = false;\n  private _oauthCallbackConfig?: MCPClientOAuthCallbackConfig;\n  private _connectionDisposables = new Map<string, DisposableStore>();\n  private _storage: DurableObjectStorage;\n  private _createAuthProviderFn?: (\n    callbackUrl: string\n  ) => AgentMcpOAuthProvider;\n  private _isRestored = false;\n  private _pendingConnections = new Map<string, Promise<void>>();\n\n  /** @internal Protected for testing purposes. */\n  protected readonly _onObservabilityEvent =\n    new Emitter<MCPObservabilityEvent>();\n  public readonly onObservabilityEvent: Event<MCPObservabilityEvent> =\n    this._onObservabilityEvent.event;\n\n  private readonly _onServerStateChanged = new Emitter<void>();\n  /**\n   * Event that fires whenever any MCP server state changes (registered, connected, removed, etc.)\n   * This is useful for broadcasting server state to clients.\n   */\n  public readonly onServerStateChanged: Event<void> =\n    this._onServerStateChanged.event;\n\n  /**\n   * @param _name Name of the MCP client\n   * @param _version Version of the MCP Client\n   * @param options Storage adapter for persisting MCP server state\n   */\n  constructor(\n    private _name: string,\n    private _version: string,\n    options: MCPClientManagerOptions\n  ) {\n    if (!options.storage) {\n      throw new Error(\n        \"MCPClientManager requires a valid DurableObjectStorage instance\"\n      );\n    }\n    this._storage = options.storage;\n    this._createAuthProviderFn = options.createAuthProvider;\n  }\n\n  // SQL helper - runs a query and returns results as array\n  private sql<T extends Record<string, SqlStorageValue>>(\n    query: string,\n    ...bindings: SqlStorageValue[]\n  ): T[] {\n    return [...this._storage.sql.exec<T>(query, ...bindings)];\n  }\n\n  // Storage operations\n  private saveServerToStorage(server: MCPServerRow): void {\n    this.sql(\n      `INSERT OR REPLACE INTO cf_agents_mcp_servers (\n        id, name, server_url, client_id, auth_url, callback_url, server_options\n      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,\n      server.id,\n      server.name,\n      server.server_url,\n      server.client_id ?? null,\n      server.auth_url ?? null,\n      server.callback_url,\n      server.server_options ?? null\n    );\n  }\n\n  private removeServerFromStorage(serverId: string): void {\n    this.sql(\"DELETE FROM cf_agents_mcp_servers WHERE id = ?\", serverId);\n  }\n\n  private getServersFromStorage(): MCPServerRow[] {\n    return this.sql<MCPServerRow>(\n      \"SELECT id, name, server_url, client_id, auth_url, callback_url, server_options FROM cf_agents_mcp_servers\"\n    );\n  }\n\n  /**\n   * Get the retry options for a server from stored server_options\n   */\n  private getServerRetryOptions(serverId: string): RetryOptions | undefined {\n    const rows = this.sql<MCPServerRow>(\n      \"SELECT server_options FROM cf_agents_mcp_servers WHERE id = ?\",\n      serverId\n    );\n    if (!rows.length || !rows[0].server_options) return undefined;\n    const parsed: MCPServerOptions = JSON.parse(rows[0].server_options);\n    return parsed.retry;\n  }\n\n  private clearServerAuthUrl(serverId: string): void {\n    this.sql(\n      \"UPDATE cf_agents_mcp_servers SET auth_url = NULL WHERE id = ?\",\n      serverId\n    );\n  }\n\n  private failConnection(\n    serverId: string,\n    error: string\n  ): MCPOAuthCallbackResult {\n    this.clearServerAuthUrl(serverId);\n    if (this.mcpConnections[serverId]) {\n      this.mcpConnections[serverId].connectionState = MCPConnectionState.FAILED;\n      this.mcpConnections[serverId].connectionError = error;\n    }\n    this._onServerStateChanged.fire();\n    return { serverId, authSuccess: false, authError: error };\n  }\n\n  jsonSchema: typeof import(\"ai\").jsonSchema | undefined;\n\n  /**\n   * Create an auth provider for a server\n   * @internal\n   */\n  private createAuthProvider(\n    serverId: string,\n    callbackUrl: string,\n    clientName: string,\n    clientId?: string\n  ): AgentMcpOAuthProvider {\n    if (!this._storage) {\n      throw new Error(\n        \"Cannot create auth provider: storage is not initialized\"\n      );\n    }\n    const authProvider = new DurableObjectOAuthClientProvider(\n      this._storage,\n      clientName,\n      callbackUrl\n    );\n    authProvider.serverId = serverId;\n    if (clientId) {\n      authProvider.clientId = clientId;\n    }\n    return authProvider;\n  }\n\n  /**\n   * Get saved RPC servers from storage (servers with rpc:// URLs).\n   * These are restored separately by the Agent class since they need env bindings.\n   */\n  getRpcServersFromStorage(): MCPServerRow[] {\n    return this.getServersFromStorage().filter((s) =>\n      s.server_url.startsWith(RPC_DO_PREFIX)\n    );\n  }\n\n  /**\n   * Save an RPC server to storage for hibernation recovery.\n   * The bindingName is stored in server_options so the Agent can look up\n   * the namespace from env during restore.\n   */\n  saveRpcServerToStorage(\n    id: string,\n    name: string,\n    normalizedName: string,\n    bindingName: string,\n    props?: Record<string, unknown>\n  ): void {\n    this.saveServerToStorage({\n      id,\n      name,\n      server_url: `${RPC_DO_PREFIX}${normalizedName}`,\n      client_id: null,\n      auth_url: null,\n      callback_url: \"\",\n      server_options: JSON.stringify({ bindingName, props })\n    });\n  }\n\n  /**\n   * Restore MCP server connections from storage\n   * This method is called on Agent initialization to restore previously connected servers.\n   * RPC servers (rpc:// URLs) are skipped here -- they are restored by the Agent class\n   * which has access to env bindings.\n   *\n   * @param clientName Name to use for OAuth client (typically the agent instance name)\n   */\n  async restoreConnectionsFromStorage(clientName: string): Promise<void> {\n    if (this._isRestored) {\n      return;\n    }\n\n    const servers = this.getServersFromStorage();\n\n    if (!servers || servers.length === 0) {\n      this._isRestored = true;\n      return;\n    }\n\n    for (const server of servers) {\n      if (server.server_url.startsWith(RPC_DO_PREFIX)) {\n        continue;\n      }\n\n      const existingConn = this.mcpConnections[server.id];\n\n      // Skip if connection already exists and is in a good state\n      if (existingConn) {\n        if (existingConn.connectionState === MCPConnectionState.READY) {\n          console.warn(\n            `[MCPClientManager] Server ${server.id} already has a ready connection. Skipping recreation.`\n          );\n          continue;\n        }\n\n        // Don't interrupt in-flight OAuth or connections\n        if (\n          existingConn.connectionState === MCPConnectionState.AUTHENTICATING ||\n          existingConn.connectionState === MCPConnectionState.CONNECTING ||\n          existingConn.connectionState === MCPConnectionState.DISCOVERING\n        ) {\n          // Let the existing flow complete\n          continue;\n        }\n\n        // If failed, clean up the old connection before recreating\n        if (existingConn.connectionState === MCPConnectionState.FAILED) {\n          try {\n            await existingConn.client.close();\n          } catch (error) {\n            console.warn(\n              `[MCPClientManager] Error closing failed connection ${server.id}:`,\n              error\n            );\n          }\n          delete this.mcpConnections[server.id];\n          this._connectionDisposables.get(server.id)?.dispose();\n          this._connectionDisposables.delete(server.id);\n        }\n      }\n\n      const parsedOptions: MCPServerOptions | null = server.server_options\n        ? JSON.parse(server.server_options)\n        : null;\n\n      let authProvider: AgentMcpOAuthProvider | undefined;\n      if (server.callback_url) {\n        authProvider = this._createAuthProviderFn\n          ? this._createAuthProviderFn(server.callback_url)\n          : this.createAuthProvider(\n              server.id,\n              server.callback_url,\n              clientName,\n              server.client_id ?? undefined\n            );\n        authProvider.serverId = server.id;\n        if (server.client_id) {\n          authProvider.clientId = server.client_id;\n        }\n      }\n\n      // Create the in-memory connection object (no need to save to storage - we just read from it!)\n      const conn = this.createConnection(server.id, server.server_url, {\n        client: parsedOptions?.client ?? {},\n        transport: {\n          ...(parsedOptions?.transport ?? {}),\n          type: parsedOptions?.transport?.type ?? (\"auto\" as TransportType),\n          authProvider\n        }\n      });\n\n      // If auth_url exists, OAuth flow is in progress - set state and wait for callback\n      if (server.auth_url) {\n        conn.connectionState = MCPConnectionState.AUTHENTICATING;\n        continue;\n      }\n\n      // Start connection in background (don't await) to avoid blocking the DO\n      this._trackConnection(\n        server.id,\n        this._restoreServer(server.id, parsedOptions?.retry)\n      );\n    }\n\n    this._isRestored = true;\n  }\n\n  /**\n   * Track a pending connection promise for a server.\n   * The promise is removed from the map when it settles.\n   */\n  private _trackConnection(serverId: string, promise: Promise<void>): void {\n    const tracked = promise.finally(() => {\n      // Only delete if it's still the same promise (not replaced by a newer one)\n      if (this._pendingConnections.get(serverId) === tracked) {\n        this._pendingConnections.delete(serverId);\n      }\n    });\n    this._pendingConnections.set(serverId, tracked);\n  }\n\n  /**\n   * Wait for all in-flight connection and discovery operations to settle.\n   * This is useful when you need MCP tools to be available before proceeding,\n   * e.g. before calling getAITools() after the agent wakes from hibernation.\n   *\n   * Returns once every pending connection has either connected and discovered,\n   * failed, or timed out. Never rejects.\n   *\n   * @param options.timeout - Maximum time in milliseconds to wait.\n   *   `0` returns immediately without waiting.\n   *   `undefined` (default) waits indefinitely.\n   */\n  async waitForConnections(options?: { timeout?: number }): Promise<void> {\n    if (this._pendingConnections.size === 0) {\n      return;\n    }\n    if (options?.timeout != null && options.timeout <= 0) {\n      return;\n    }\n    const settled = Promise.allSettled(this._pendingConnections.values());\n    if (options?.timeout != null && options.timeout > 0) {\n      let timerId: ReturnType<typeof setTimeout>;\n      const timer = new Promise<void>((resolve) => {\n        timerId = setTimeout(resolve, options.timeout);\n      });\n      await Promise.race([settled, timer]);\n      clearTimeout(timerId!);\n    } else {\n      await settled;\n    }\n  }\n\n  /**\n   * Internal method to restore a single server connection and discovery\n   */\n  private async _restoreServer(\n    serverId: string,\n    retry?: RetryOptions\n  ): Promise<void> {\n    // Always try to connect - the connection logic will determine if OAuth is needed\n    // If stored OAuth tokens are valid, connection will succeed automatically\n    // If tokens are missing/invalid, connection will fail with Unauthorized\n    // and state will be set to \"authenticating\"\n    const maxAttempts = retry?.maxAttempts ?? 3;\n    const baseDelayMs = retry?.baseDelayMs ?? 500;\n    const maxDelayMs = retry?.maxDelayMs ?? 5000;\n\n    const connectResult = await tryN(\n      maxAttempts,\n      async () => this.connectToServer(serverId),\n      { baseDelayMs, maxDelayMs }\n    ).catch((error) => {\n      console.error(\n        `Error connecting to ${serverId} after ${maxAttempts} attempts:`,\n        error\n      );\n      return null;\n    });\n\n    if (connectResult?.state === MCPConnectionState.CONNECTED) {\n      const discoverResult = await this.discoverIfConnected(serverId);\n      if (discoverResult && !discoverResult.success) {\n        console.error(`Error discovering ${serverId}:`, discoverResult.error);\n      }\n    }\n  }\n\n  /**\n   * Connect to and register an MCP server\n   *\n   * @deprecated This method is maintained for backward compatibility.\n   * For new code, use registerServer() and connectToServer() separately.\n   *\n   * @param url Server URL\n   * @param options Connection options\n   * @returns Object with server ID, auth URL (if OAuth), and client ID (if OAuth)\n   */\n  async connect(\n    url: string,\n    options: {\n      // Allows you to reconnect to a server (in the case of an auth reconnect)\n      reconnect?: {\n        // server id\n        id: string;\n        oauthClientId?: string;\n        oauthCode?: string;\n      };\n      // we're overriding authProvider here because we want to be able to access the auth URL\n      transport?: MCPTransportOptions;\n      client?: ConstructorParameters<typeof Client>[1];\n    } = {}\n  ): Promise<{\n    id: string;\n    authUrl?: string;\n    clientId?: string;\n  }> {\n    /* Late initialization of jsonSchemaFn */\n    /**\n     * We need to delay loading ai sdk, because putting it in module scope is\n     * causing issues with startup time.\n     * The only place it's used is in getAITools, which only matters after\n     * .connect() is called on at least one server.\n     * So it's safe to delay loading it until .connect() is called.\n     */\n    await this.ensureJsonSchema();\n\n    const id = options.reconnect?.id ?? nanoid(8);\n\n    if (options.transport?.authProvider) {\n      options.transport.authProvider.serverId = id;\n      // reconnect with auth\n      if (options.reconnect?.oauthClientId) {\n        options.transport.authProvider.clientId =\n          options.reconnect?.oauthClientId;\n      }\n    }\n\n    if (isBlockedUrl(url)) {\n      throw new Error(\n        `Blocked URL: ${url} — MCP client connections to private/internal addresses are not allowed`\n      );\n    }\n\n    // During OAuth reconnect, reuse existing connection to preserve state\n    if (!options.reconnect?.oauthCode || !this.mcpConnections[id]) {\n      const normalizedTransport = {\n        ...options.transport,\n        type: options.transport?.type ?? (\"auto\" as TransportType)\n      };\n\n      this.mcpConnections[id] = new MCPClientConnection(\n        new URL(url),\n        {\n          name: this._name,\n          version: this._version\n        },\n        {\n          client: options.client ?? {},\n          transport: normalizedTransport\n        }\n      );\n\n      // Pipe connection-level observability events to the manager-level emitter\n      // and track the subscription for cleanup.\n      const store = new DisposableStore();\n      // If we somehow already had disposables for this id, clear them first\n      const existing = this._connectionDisposables.get(id);\n      if (existing) existing.dispose();\n      this._connectionDisposables.set(id, store);\n      store.add(\n        this.mcpConnections[id].onObservabilityEvent((event) => {\n          this._onObservabilityEvent.fire(event);\n        })\n      );\n    }\n\n    // Initialize connection first. this will try connect\n    await this.mcpConnections[id].init();\n\n    // Handle OAuth completion if we have a reconnect code\n    if (options.reconnect?.oauthCode) {\n      try {\n        await this.mcpConnections[id].completeAuthorization(\n          options.reconnect.oauthCode\n        );\n\n        // Reinitialize connection\n        await this.mcpConnections[id].init();\n      } catch (error) {\n        this._onObservabilityEvent.fire({\n          type: \"mcp:client:connect\",\n          payload: {\n            url: url,\n            transport: options.transport?.type ?? \"auto\",\n            state: this.mcpConnections[id].connectionState,\n            error: toErrorMessage(error)\n          },\n          timestamp: Date.now()\n        });\n        // Re-throw to signal failure to the caller\n        throw error;\n      }\n    }\n\n    // If connection is in authenticating state, return auth URL for OAuth flow\n    const authUrl = options.transport?.authProvider?.authUrl;\n    if (\n      this.mcpConnections[id].connectionState ===\n        MCPConnectionState.AUTHENTICATING &&\n      authUrl &&\n      options.transport?.authProvider?.redirectUrl\n    ) {\n      return {\n        authUrl,\n        clientId: options.transport?.authProvider?.clientId,\n        id\n      };\n    }\n\n    // If connection is connected, discover capabilities\n    const discoverResult = await this.discoverIfConnected(id);\n    if (discoverResult && !discoverResult.success) {\n      throw new Error(\n        `Failed to discover server capabilities: ${discoverResult.error}`\n      );\n    }\n\n    return {\n      id\n    };\n  }\n\n  /**\n   * Create an in-memory connection object and set up observability\n   * Does NOT save to storage - use registerServer() for that\n   * @returns The connection object (existing or newly created)\n   */\n  private createConnection(\n    id: string,\n    url: string,\n    options: {\n      client?: ConstructorParameters<typeof Client>[1];\n      transport: MCPTransportOptions;\n    }\n  ): MCPClientConnection {\n    // Return existing connection if already exists\n    if (this.mcpConnections[id]) {\n      return this.mcpConnections[id];\n    }\n\n    const normalizedTransport = {\n      ...options.transport,\n      type: options.transport?.type ?? (\"auto\" as TransportType)\n    };\n\n    this.mcpConnections[id] = new MCPClientConnection(\n      new URL(url),\n      {\n        name: this._name,\n        version: this._version\n      },\n      {\n        client: { ...defaultClientOptions, ...options.client },\n        transport: normalizedTransport\n      }\n    );\n\n    // Pipe connection-level observability events to the manager-level emitter\n    const store = new DisposableStore();\n    const existing = this._connectionDisposables.get(id);\n    if (existing) existing.dispose();\n    this._connectionDisposables.set(id, store);\n    store.add(\n      this.mcpConnections[id].onObservabilityEvent((event) => {\n        this._onObservabilityEvent.fire(event);\n      })\n    );\n\n    return this.mcpConnections[id];\n  }\n\n  /**\n   * Register an MCP server connection without connecting\n   * Creates the connection object, sets up observability, and saves to storage\n   *\n   * @param id Server ID\n   * @param options Registration options including URL, name, callback URL, and connection config\n   * @returns Server ID\n   */\n  async registerServer(\n    id: string,\n    options: RegisterServerOptions\n  ): Promise<string> {\n    if (isBlockedUrl(options.url)) {\n      throw new Error(\n        `Blocked URL: ${options.url} — MCP client connections to private/internal addresses are not allowed`\n      );\n    }\n\n    // Create the in-memory connection\n    this.createConnection(id, options.url, {\n      client: options.client,\n      transport: {\n        ...options.transport,\n        type: options.transport?.type ?? (\"auto\" as TransportType)\n      }\n    });\n\n    // Save to storage (exclude authProvider since it's recreated during restore)\n    const { authProvider: _, ...transportWithoutAuth } =\n      options.transport ?? {};\n    this.saveServerToStorage({\n      id,\n      name: options.name,\n      server_url: options.url,\n      callback_url: options.callbackUrl ?? \"\",\n      client_id: options.clientId ?? null,\n      auth_url: options.authUrl ?? null,\n      server_options: JSON.stringify({\n        client: options.client,\n        transport: transportWithoutAuth,\n        retry: options.retry\n      })\n    });\n\n    this._onServerStateChanged.fire();\n\n    return id;\n  }\n\n  /**\n   * Connect to an already registered MCP server and initialize the connection.\n   *\n   * For OAuth servers, returns `{ state: \"authenticating\", authUrl, clientId? }`.\n   * The user must complete the OAuth flow via the authUrl, which triggers a\n   * callback handled by `handleCallbackRequest()`.\n   *\n   * For non-OAuth servers, establishes the transport connection and returns\n   * `{ state: \"connected\" }`. Call `discoverIfConnected()` afterwards to\n   * discover capabilities and transition to \"ready\" state.\n   *\n   * @param id Server ID (must be registered first via registerServer())\n   * @returns Connection result with current state and OAuth info (if applicable)\n   */\n  async connectToServer(id: string): Promise<MCPConnectionResult> {\n    const conn = this.mcpConnections[id];\n    if (!conn) {\n      throw new Error(\n        `Server ${id} is not registered. Call registerServer() first.`\n      );\n    }\n\n    const error = await conn.init();\n    this._onServerStateChanged.fire();\n\n    switch (conn.connectionState) {\n      case MCPConnectionState.FAILED:\n        return {\n          state: conn.connectionState,\n          error: error ?? \"Unknown connection error\"\n        };\n\n      case MCPConnectionState.AUTHENTICATING: {\n        const authUrl = conn.options.transport.authProvider?.authUrl;\n        const redirectUrl = conn.options.transport.authProvider?.redirectUrl;\n\n        if (!authUrl || !redirectUrl) {\n          return {\n            state: MCPConnectionState.FAILED,\n            error: `OAuth configuration incomplete: missing ${!authUrl ? \"authUrl\" : \"redirectUrl\"}`\n          };\n        }\n\n        const clientId = conn.options.transport.authProvider?.clientId;\n\n        // Update storage with auth URL and client ID\n        const servers = this.getServersFromStorage();\n        const serverRow = servers.find((s) => s.id === id);\n        if (serverRow) {\n          this.saveServerToStorage({\n            ...serverRow,\n            auth_url: authUrl,\n            client_id: clientId ?? null\n          });\n          // Broadcast again so clients receive the auth_url\n          this._onServerStateChanged.fire();\n        }\n\n        this._onObservabilityEvent.fire({\n          type: \"mcp:client:authorize\",\n          payload: { serverId: id, authUrl, clientId },\n          timestamp: Date.now()\n        });\n\n        return {\n          state: conn.connectionState,\n          authUrl,\n          clientId\n        };\n      }\n\n      case MCPConnectionState.CONNECTED:\n        return { state: conn.connectionState };\n\n      default:\n        return {\n          state: MCPConnectionState.FAILED,\n          error: `Unexpected connection state after init: ${conn.connectionState}`\n        };\n    }\n  }\n\n  private extractServerIdFromState(state: string | null): string | null {\n    if (!state) return null;\n    const parts = state.split(\".\");\n    return parts.length === 2 ? parts[1] : null;\n  }\n\n  isCallbackRequest(req: Request): boolean {\n    if (req.method !== \"GET\") {\n      return false;\n    }\n\n    const url = new URL(req.url);\n    const state = url.searchParams.get(\"state\");\n    const serverId = this.extractServerIdFromState(state);\n    if (!serverId) {\n      return false;\n    }\n\n    // Match by server ID AND verify the request origin + pathname matches the registered callback URL.\n    // This prevents unrelated GET requests with a `state` param from being intercepted.\n    const servers = this.getServersFromStorage();\n    return servers.some((server) => {\n      if (server.id !== serverId) return false;\n      try {\n        const storedUrl = new URL(server.callback_url);\n        return (\n          storedUrl.origin === url.origin && storedUrl.pathname === url.pathname\n        );\n      } catch {\n        return false;\n      }\n    });\n  }\n\n  private validateCallbackRequest(\n    req: Request\n  ):\n    | { valid: true; serverId: string; code: string; state: string }\n    | { valid: false; serverId?: string; error: string } {\n    const url = new URL(req.url);\n    const code = url.searchParams.get(\"code\");\n    const state = url.searchParams.get(\"state\");\n    const error = url.searchParams.get(\"error\");\n    const errorDescription = url.searchParams.get(\"error_description\");\n\n    // Early validation - return errors because we can't identify the connection\n    if (!state) {\n      return {\n        valid: false,\n        error: \"Unauthorized: no state provided\"\n      };\n    }\n\n    const serverId = this.extractServerIdFromState(state);\n    if (!serverId) {\n      return {\n        valid: false,\n        error:\n          \"No serverId found in state parameter. Expected format: {nonce}.{serverId}\"\n      };\n    }\n\n    if (error) {\n      return {\n        serverId: serverId,\n        valid: false,\n        error: errorDescription || error\n      };\n    }\n\n    if (!code) {\n      return {\n        serverId: serverId,\n        valid: false,\n        error: \"Unauthorized: no code provided\"\n      };\n    }\n\n    const servers = this.getServersFromStorage();\n    const serverExists = servers.some((server) => server.id === serverId);\n    if (!serverExists) {\n      return {\n        serverId: serverId,\n        valid: false,\n        error: `No server found with id \"${serverId}\". Was the request matched with \\`isCallbackRequest()\\`?`\n      };\n    }\n\n    if (this.mcpConnections[serverId] === undefined) {\n      return {\n        serverId: serverId,\n        valid: false,\n        error: `No connection found for serverId \"${serverId}\".`\n      };\n    }\n\n    return {\n      valid: true,\n      serverId,\n      code: code,\n      state: state\n    };\n  }\n\n  async handleCallbackRequest(req: Request): Promise<MCPOAuthCallbackResult> {\n    const validation = this.validateCallbackRequest(req);\n\n    if (!validation.valid) {\n      if (validation.serverId && this.mcpConnections[validation.serverId]) {\n        return this.failConnection(validation.serverId, validation.error);\n      }\n\n      return {\n        serverId: validation.serverId,\n        authSuccess: false,\n        authError: validation.error\n      };\n    }\n\n    const { serverId, code, state } = validation;\n    const conn = this.mcpConnections[serverId]; // We have a valid connection - all errors from here should fail the connection\n\n    try {\n      if (!conn.options.transport.authProvider) {\n        throw new Error(\n          \"Trying to finalize authentication for a server connection without an authProvider\"\n        );\n      }\n\n      const authProvider = conn.options.transport.authProvider;\n      authProvider.serverId = serverId;\n\n      // Two-phase state validation: check first (non-destructive), consume later\n      // This prevents DoS attacks where attacker consumes valid state before legitimate callback\n      const stateValidation = await authProvider.checkState(state);\n      if (!stateValidation.valid) {\n        throw new Error(stateValidation.error || \"Invalid state\");\n      }\n\n      // Already authenticated - just return success\n      if (\n        conn.connectionState === MCPConnectionState.READY ||\n        conn.connectionState === MCPConnectionState.CONNECTED\n      ) {\n        this.clearServerAuthUrl(serverId);\n        return { serverId, authSuccess: true };\n      }\n\n      if (conn.connectionState !== MCPConnectionState.AUTHENTICATING) {\n        throw new Error(\n          `Failed to authenticate: the client is in \"${conn.connectionState}\" state, expected \"authenticating\"`\n        );\n      }\n\n      await authProvider.consumeState(state);\n      await conn.completeAuthorization(code);\n      await authProvider.deleteCodeVerifier();\n      this.clearServerAuthUrl(serverId);\n      conn.connectionError = null;\n      this._onServerStateChanged.fire();\n\n      return { serverId, authSuccess: true };\n    } catch (err) {\n      const message = err instanceof Error ? err.message : String(err);\n      return this.failConnection(serverId, message);\n    }\n  }\n\n  /**\n   * Discover server capabilities if connection is in CONNECTED or READY state.\n   * Transitions to DISCOVERING then READY (or CONNECTED on error).\n   * Can be called to refresh server capabilities (e.g., from a UI refresh button).\n   *\n   * If called while a previous discovery is in-flight for the same server,\n   * the previous discovery will be aborted.\n   *\n   * @param serverId The server ID to discover\n   * @param options Optional configuration\n   * @param options.timeoutMs Timeout in milliseconds (default: 30000)\n   * @returns Result with current state and optional error, or undefined if connection not found\n   */\n  async discoverIfConnected(\n    serverId: string,\n    options: { timeoutMs?: number } = {}\n  ): Promise<MCPDiscoverResult | undefined> {\n    const conn = this.mcpConnections[serverId];\n    if (!conn) {\n      this._onObservabilityEvent.fire({\n        type: \"mcp:client:discover\",\n        payload: {},\n        timestamp: Date.now()\n      });\n      return undefined;\n    }\n\n    // Delegate to connection's discover method which handles cancellation and timeout\n    const result = await conn.discover(options);\n    this._onServerStateChanged.fire();\n\n    return {\n      ...result,\n      state: conn.connectionState\n    };\n  }\n\n  /**\n   * Establish connection in the background after OAuth completion.\n   * This method connects to the server and discovers its capabilities.\n   * The connection is automatically tracked so that `waitForConnections()`\n   * will include it.\n   * @param serverId The server ID to establish connection for\n   */\n  async establishConnection(serverId: string): Promise<void> {\n    const promise = this._doEstablishConnection(serverId);\n    this._trackConnection(serverId, promise);\n    return promise;\n  }\n\n  private async _doEstablishConnection(serverId: string): Promise<void> {\n    const conn = this.mcpConnections[serverId];\n    if (!conn) {\n      this._onObservabilityEvent.fire({\n        type: \"mcp:client:preconnect\",\n        payload: { serverId },\n        timestamp: Date.now()\n      });\n      return;\n    }\n\n    // Skip if already discovering or ready - prevents duplicate work\n    if (\n      conn.connectionState === MCPConnectionState.DISCOVERING ||\n      conn.connectionState === MCPConnectionState.READY\n    ) {\n      this._onObservabilityEvent.fire({\n        type: \"mcp:client:connect\",\n        payload: {\n          url: conn.url.toString(),\n          transport: conn.options.transport.type || \"unknown\",\n          state: conn.connectionState\n        },\n        timestamp: Date.now()\n      });\n      return;\n    }\n\n    const retry = this.getServerRetryOptions(serverId);\n    const maxAttempts = retry?.maxAttempts ?? 3;\n    const baseDelayMs = retry?.baseDelayMs ?? 500;\n    const maxDelayMs = retry?.maxDelayMs ?? 5000;\n\n    const connectResult = await tryN(\n      maxAttempts,\n      async () => this.connectToServer(serverId),\n      { baseDelayMs, maxDelayMs }\n    );\n    this._onServerStateChanged.fire();\n\n    if (connectResult.state === MCPConnectionState.CONNECTED) {\n      await this.discoverIfConnected(serverId);\n    }\n\n    this._onObservabilityEvent.fire({\n      type: \"mcp:client:connect\",\n      payload: {\n        url: conn.url.toString(),\n        transport: conn.options.transport.type || \"unknown\",\n        state: conn.connectionState\n      },\n      timestamp: Date.now()\n    });\n  }\n\n  /**\n   * Configure OAuth callback handling\n   * @param config OAuth callback configuration\n   */\n  configureOAuthCallback(config: MCPClientOAuthCallbackConfig): void {\n    this._oauthCallbackConfig = config;\n  }\n\n  /**\n   * Get the current OAuth callback configuration\n   * @returns The current OAuth callback configuration\n   */\n  getOAuthCallbackConfig(): MCPClientOAuthCallbackConfig | undefined {\n    return this._oauthCallbackConfig;\n  }\n\n  /**\n   * @returns namespaced list of tools\n   */\n  listTools(): NamespacedData[\"tools\"] {\n    return getNamespacedData(this.mcpConnections, \"tools\");\n  }\n\n  /**\n   * Lazy-loads the jsonSchema function from the AI SDK.\n   *\n   * This defers importing the \"ai\" package until it's actually needed, which helps reduce\n   * initial bundle size and startup time. The jsonSchema function is required for converting\n   * MCP tools into AI SDK tool definitions via getAITools().\n   *\n   * @internal This method is for internal use only. It's automatically called before operations\n   * that need jsonSchema (like getAITools() or OAuth flows). External consumers should not need\n   * to call this directly.\n   */\n  async ensureJsonSchema() {\n    if (!this.jsonSchema) {\n      const { jsonSchema } = await import(\"ai\");\n      this.jsonSchema = jsonSchema;\n    }\n  }\n\n  /**\n   * @returns a set of tools that you can use with the AI SDK\n   */\n  getAITools(): ToolSet {\n    if (!this.jsonSchema) {\n      throw new Error(\"jsonSchema not initialized.\");\n    }\n\n    // Warn if tools are being read from non-ready connections\n    for (const [id, conn] of Object.entries(this.mcpConnections)) {\n      if (\n        conn.connectionState !== MCPConnectionState.READY &&\n        conn.connectionState !== MCPConnectionState.AUTHENTICATING\n      ) {\n        console.warn(\n          `[getAITools] WARNING: Reading tools from connection ${id} in state \"${conn.connectionState}\". Tools may not be loaded yet.`\n        );\n      }\n    }\n\n    const entries: [string, ToolSet[string]][] = [];\n    for (const tool of getNamespacedData(this.mcpConnections, \"tools\")) {\n      try {\n        const toolKey = `tool_${tool.serverId.replace(/-/g, \"\")}_${tool.name}`;\n        entries.push([\n          toolKey,\n          {\n            description: tool.description,\n            execute: async (args) => {\n              const result = await this.callTool({\n                arguments: args,\n                name: tool.name,\n                serverId: tool.serverId\n              });\n              if (result.isError) {\n                const content = result.content as\n                  | Array<{ type: string; text?: string }>\n                  | undefined;\n                const textContent = content?.[0];\n                const message =\n                  textContent?.type === \"text\" && textContent.text\n                    ? textContent.text\n                    : \"Tool call failed\";\n                throw new Error(message);\n              }\n              return result;\n            },\n            inputSchema: tool.inputSchema\n              ? this.jsonSchema!(tool.inputSchema as JSONSchema7)\n              : this.jsonSchema!({ type: \"object\" } as JSONSchema7),\n            outputSchema: tool.outputSchema\n              ? this.jsonSchema!(tool.outputSchema as JSONSchema7)\n              : undefined\n          }\n        ]);\n      } catch (e) {\n        console.warn(\n          `[getAITools] Skipping tool \"${tool.name}\" from \"${tool.serverId}\": ${e}`\n        );\n      }\n    }\n    return Object.fromEntries(entries);\n  }\n\n  /**\n   * @deprecated this has been renamed to getAITools(), and unstable_getAITools will be removed in the next major version\n   * @returns a set of tools that you can use with the AI SDK\n   */\n  unstable_getAITools(): ToolSet {\n    if (!this._didWarnAboutUnstableGetAITools) {\n      this._didWarnAboutUnstableGetAITools = true;\n      console.warn(\n        \"unstable_getAITools is deprecated, use getAITools instead. unstable_getAITools will be removed in the next major version.\"\n      );\n    }\n    return this.getAITools();\n  }\n\n  /**\n   * Closes all active in-memory connections to MCP servers.\n   *\n   * Note: This only closes the transport connections - it does NOT remove\n   * servers from storage. Servers will still be listed and their callback\n   * URLs will still match incoming OAuth requests.\n   *\n   * Use removeServer() instead if you want to fully clean up a server\n   * (closes connection AND removes from storage).\n   */\n  async closeAllConnections() {\n    const ids = Object.keys(this.mcpConnections);\n\n    // Clear all pending connection tracking\n    this._pendingConnections.clear();\n\n    // Cancel all in-flight discoveries\n    for (const id of ids) {\n      this.mcpConnections[id].cancelDiscovery();\n    }\n\n    await Promise.all(\n      ids.map(async (id) => {\n        await this.mcpConnections[id].client.close();\n      })\n    );\n    // Dispose all per-connection subscriptions\n    for (const id of ids) {\n      const store = this._connectionDisposables.get(id);\n      if (store) store.dispose();\n      this._connectionDisposables.delete(id);\n      delete this.mcpConnections[id];\n    }\n  }\n\n  /**\n   * Closes a connection to an MCP server\n   * @param id The id of the connection to close\n   */\n  async closeConnection(id: string) {\n    if (!this.mcpConnections[id]) {\n      throw new Error(`Connection with id \"${id}\" does not exist.`);\n    }\n\n    // Cancel any in-flight discovery\n    this.mcpConnections[id].cancelDiscovery();\n\n    // Remove from pending so waitForConnections() doesn't block on a closed server\n    this._pendingConnections.delete(id);\n\n    await this.mcpConnections[id].client.close();\n    delete this.mcpConnections[id];\n\n    const store = this._connectionDisposables.get(id);\n    if (store) store.dispose();\n    this._connectionDisposables.delete(id);\n  }\n\n  /**\n   * Remove an MCP server - closes connection if active and removes from storage.\n   */\n  async removeServer(serverId: string): Promise<void> {\n    if (this.mcpConnections[serverId]) {\n      try {\n        await this.closeConnection(serverId);\n      } catch (_e) {\n        // Ignore errors when closing\n      }\n    }\n    this.removeServerFromStorage(serverId);\n    this._onServerStateChanged.fire();\n  }\n\n  /**\n   * List all MCP servers from storage\n   */\n  listServers(): MCPServerRow[] {\n    return this.getServersFromStorage();\n  }\n\n  /**\n   * Dispose the manager and all resources.\n   */\n  async dispose(): Promise<void> {\n    try {\n      await this.closeAllConnections();\n    } finally {\n      // Dispose manager-level emitters\n      this._onServerStateChanged.dispose();\n      this._onObservabilityEvent.dispose();\n    }\n  }\n\n  /**\n   * @returns namespaced list of prompts\n   */\n  listPrompts(): NamespacedData[\"prompts\"] {\n    return getNamespacedData(this.mcpConnections, \"prompts\");\n  }\n\n  /**\n   * @returns namespaced list of tools\n   */\n  listResources(): NamespacedData[\"resources\"] {\n    return getNamespacedData(this.mcpConnections, \"resources\");\n  }\n\n  /**\n   * @returns namespaced list of resource templates\n   */\n  listResourceTemplates(): NamespacedData[\"resourceTemplates\"] {\n    return getNamespacedData(this.mcpConnections, \"resourceTemplates\");\n  }\n\n  /**\n   * Namespaced version of callTool\n   */\n  async callTool(\n    params: CallToolRequest[\"params\"] & { serverId: string },\n    resultSchema?:\n      | typeof CallToolResultSchema\n      | typeof CompatibilityCallToolResultSchema,\n    options?: RequestOptions\n  ) {\n    const { serverId, ...mcpParams } = params;\n    const unqualifiedName = mcpParams.name.replace(`${serverId}.`, \"\");\n    return this.mcpConnections[serverId].client.callTool(\n      {\n        ...mcpParams,\n        name: unqualifiedName\n      },\n      resultSchema,\n      options\n    );\n  }\n\n  /**\n   * Namespaced version of readResource\n   */\n  readResource(\n    params: ReadResourceRequest[\"params\"] & { serverId: string },\n    options: RequestOptions\n  ) {\n    return this.mcpConnections[params.serverId].client.readResource(\n      params,\n      options\n    );\n  }\n\n  /**\n   * Namespaced version of getPrompt\n   */\n  getPrompt(\n    params: GetPromptRequest[\"params\"] & { serverId: string },\n    options: RequestOptions\n  ) {\n    return this.mcpConnections[params.serverId].client.getPrompt(\n      params,\n      options\n    );\n  }\n}\n\ntype NamespacedData = {\n  tools: (Tool & { serverId: string })[];\n  prompts: (Prompt & { serverId: string })[];\n  resources: (Resource & { serverId: string })[];\n  resourceTemplates: (ResourceTemplate & { serverId: string })[];\n};\n\nexport function getNamespacedData<T extends keyof NamespacedData>(\n  mcpClients: Record<string, MCPClientConnection>,\n  type: T\n): NamespacedData[T] {\n  const sets = Object.entries(mcpClients).map(([name, conn]) => {\n    return { data: conn[type], name };\n  });\n\n  const namespacedData = sets.flatMap(({ name: serverId, data }) => {\n    return data.map((item) => {\n      return {\n        ...item,\n        // we add a serverId so we can easily pull it out and send the tool call to the right server\n        serverId\n      };\n    });\n  });\n\n  return namespacedData as NamespacedData[T]; // Type assertion needed due to TS limitations with conditional return types\n}\n"],"mappings":"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"}
node_modules/agents/dist/mcp/index.js.map:1:{"version":3,"file":"index.js","names":[],"sources":["../../src/mcp/utils.ts","../../src/mcp/transport.ts","../../src/mcp/client-transports.ts","../../src/mcp/worker-transport.ts","../../src/mcp/auth-context.ts","../../src/mcp/handler.ts","../../src/mcp/index.ts"],"sourcesContent":["import {\n  JSONRPCMessageSchema,\n  type JSONRPCMessage,\n  type MessageExtraInfo,\n  InitializeRequestSchema,\n  isJSONRPCResultResponse,\n  isJSONRPCNotification\n} from \"@modelcontextprotocol/sdk/types.js\";\nimport type { McpAgent } from \".\";\nimport { getAgentByName } from \"..\";\nimport type { CORSOptions } from \"./types\";\nimport { MessageType } from \"../types\";\n\n/**\n * Since we use WebSockets to bridge the client to the\n * MCP transport in the Agent, we use this header to signal\n * the method of the original request the user made, while\n * leaving the WS Upgrade request as GET.\n */\nexport const MCP_HTTP_METHOD_HEADER = \"cf-mcp-method\";\n\n/**\n * Since we use WebSockets to bridge the client to the\n * MCP transport in the Agent, we use this header to include\n * the original request body.\n */\nexport const MCP_MESSAGE_HEADER = \"cf-mcp-message\";\n\nconst MAXIMUM_MESSAGE_SIZE_BYTES = 4 * 1024 * 1024; // 4MB\n\nexport const createStreamingHttpHandler = (\n  basePath: string,\n  namespace: DurableObjectNamespace<McpAgent>,\n  options: {\n    corsOptions?: CORSOptions;\n    jurisdiction?: DurableObjectJurisdiction;\n  } = {}\n) => {\n  let pathname = basePath;\n  if (basePath === \"/\") pathname = \"/*\";\n\n  const basePattern = new URLPattern({ pathname });\n  return async (request: Request, ctx: ExecutionContext) => {\n    const url = new URL(request.url);\n    if (basePattern.test(url)) {\n      if (request.method === \"POST\") {\n        // Validate the Accept header\n        const acceptHeader = request.headers.get(\"accept\");\n        // The client MUST include an Accept header, listing both application/json and text/event-stream as supported content types.\n        if (\n          !acceptHeader?.includes(\"application/json\") ||\n          !acceptHeader.includes(\"text/event-stream\")\n        ) {\n          const body = JSON.stringify({\n            error: {\n              code: -32000,\n              message:\n                \"Not Acceptable: Client must accept both application/json and text/event-stream\"\n            },\n            id: null,\n            jsonrpc: \"2.0\"\n          });\n          return new Response(body, { status: 406 });\n        }\n\n        const ct = request.headers.get(\"content-type\");\n        if (!ct || !ct.includes(\"application/json\")) {\n          const body = JSON.stringify({\n            error: {\n              code: -32000,\n              message:\n                \"Unsupported Media Type: Content-Type must be application/json\"\n            },\n            id: null,\n            jsonrpc: \"2.0\"\n          });\n          return new Response(body, { status: 415 });\n        }\n\n        // Check content length against maximum allowed size\n        const contentLength = Number.parseInt(\n          request.headers.get(\"content-length\") ?? \"0\",\n          10\n        );\n        if (contentLength > MAXIMUM_MESSAGE_SIZE_BYTES) {\n          const body = JSON.stringify({\n            error: {\n              code: -32000,\n              message: `Request body too large. Maximum size is ${MAXIMUM_MESSAGE_SIZE_BYTES} bytes`\n            },\n            id: null,\n            jsonrpc: \"2.0\"\n          });\n          return new Response(body, { status: 413 });\n        }\n\n        let sessionId = request.headers.get(\"mcp-session-id\");\n        let rawMessage: unknown;\n\n        try {\n          rawMessage = await request.json();\n        } catch (_error) {\n          const body = JSON.stringify({\n            error: {\n              code: -32700,\n              message: \"Parse error: Invalid JSON\"\n            },\n            id: null,\n            jsonrpc: \"2.0\"\n          });\n          return new Response(body, { status: 400 });\n        }\n\n        // Make sure the message is an array to simplify logic\n        let arrayMessage: unknown[];\n        if (Array.isArray(rawMessage)) {\n          arrayMessage = rawMessage;\n        } else {\n          arrayMessage = [rawMessage];\n        }\n\n        let messages: JSONRPCMessage[] = [];\n\n        // Try to parse each message as JSON RPC. Fail if any message is invalid\n        for (const msg of arrayMessage) {\n          if (!JSONRPCMessageSchema.safeParse(msg).success) {\n            const body = JSON.stringify({\n              error: {\n                code: -32700,\n                message: \"Parse error: Invalid JSON-RPC message\"\n              },\n              id: null,\n              jsonrpc: \"2.0\"\n            });\n            return new Response(body, { status: 400 });\n          }\n        }\n\n        messages = arrayMessage.map((msg) => JSONRPCMessageSchema.parse(msg));\n\n        // Before we pass the messages to the agent, there's another error condition we need to enforce\n        // Check if this is an initialization request\n        // https://spec.modelcontextprotocol.io/specification/2025-03-26/basic/lifecycle/\n        const maybeInitializeRequest = messages.find(\n          (msg) => InitializeRequestSchema.safeParse(msg).success\n        );\n\n        if (!!maybeInitializeRequest && sessionId) {\n          const body = JSON.stringify({\n            error: {\n              code: -32600,\n              message:\n                \"Invalid Request: Initialization requests must not include a sessionId\"\n            },\n            id: null,\n            jsonrpc: \"2.0\"\n          });\n          return new Response(body, { status: 400 });\n        }\n\n        // The initialization request must be the only request in the batch\n        if (!!maybeInitializeRequest && messages.length > 1) {\n          const body = JSON.stringify({\n            error: {\n              code: -32600,\n              message:\n                \"Invalid Request: Only one initialization request is allowed\"\n            },\n            id: null,\n            jsonrpc: \"2.0\"\n          });\n          return new Response(body, { status: 400 });\n        }\n\n        // If an Mcp-Session-Id is returned by the server during initialization,\n        // clients using the Streamable HTTP transport MUST include it\n        // in the Mcp-Session-Id header on all of their subsequent HTTP requests.\n        if (!maybeInitializeRequest && !sessionId) {\n          const body = JSON.stringify({\n            error: {\n              code: -32000,\n              message: \"Bad Request: Mcp-Session-Id header is required\"\n            },\n            id: null,\n            jsonrpc: \"2.0\"\n          });\n          return new Response(body, { status: 400 });\n        }\n\n        // If we don't have a sessionId, we are serving an initialization request\n        // and need to generate a new sessionId\n        sessionId = sessionId ?? namespace.newUniqueId().toString();\n\n        // Get the agent and set props\n        const agent = await getAgentByName(\n          namespace,\n          `streamable-http:${sessionId}`,\n          {\n            props: ctx.props as Record<string, unknown> | undefined,\n            jurisdiction: options.jurisdiction\n          }\n        );\n        const isInitialized = await agent.getInitializeRequest();\n\n        if (maybeInitializeRequest) {\n          await agent.setInitializeRequest(maybeInitializeRequest);\n        } else if (!isInitialized) {\n          // if we have gotten here, then a session id that was never initialized\n          // was provided\n          const body = JSON.stringify({\n            error: {\n              code: -32001,\n              message: \"Session not found\"\n            },\n            id: null,\n            jsonrpc: \"2.0\"\n          });\n          return new Response(body, { status: 404 });\n        }\n\n        // We've evaluated all the error conditions! Now it's time to establish\n        // all the streams\n\n        // Create a Transform Stream for SSE\n        const { readable, writable } = new TransformStream();\n        const writer = writable.getWriter();\n        const encoder = new TextEncoder();\n\n        // Connect to the Durable Object via WebSocket\n        const existingHeaders: Record<string, string> = {};\n        request.headers.forEach((value, key) => {\n          existingHeaders[key] = value;\n        });\n\n        const req = new Request(request.url, {\n          headers: {\n            ...existingHeaders,\n            [MCP_HTTP_METHOD_HEADER]: \"POST\",\n            [MCP_MESSAGE_HEADER]: Buffer.from(\n              JSON.stringify(messages)\n            ).toString(\"base64\"),\n            Upgrade: \"websocket\"\n          }\n        });\n        const response = await agent.fetch(req);\n\n        // Get the WebSocket\n        const ws = response.webSocket;\n        if (!ws) {\n          console.error(\"Failed to establish WebSocket connection\");\n\n          await writer.close();\n          const body = JSON.stringify({\n            error: {\n              code: -32001,\n              message: \"Failed to establish WebSocket connection\"\n            },\n            id: null,\n            jsonrpc: \"2.0\"\n          });\n          return new Response(body, { status: 500 });\n        }\n\n        // Accept the WebSocket\n        ws.accept();\n\n        // Handle messages from the Durable Object\n        ws.addEventListener(\"message\", (event) => {\n          async function onMessage(event: MessageEvent) {\n            try {\n              const data =\n                typeof event.data === \"string\"\n                  ? event.data\n                  : new TextDecoder().decode(event.data);\n              const message = JSON.parse(data);\n\n              // We only forward events from the MCP server\n              if (message.type !== MessageType.CF_MCP_AGENT_EVENT) {\n                return;\n              }\n\n              // Send the message as an SSE event\n              await writer.write(encoder.encode(message.event));\n\n              // If we have received all the responses, close the connection\n              if (message.close) {\n                ws?.close();\n                await writer.close().catch(() => {});\n              }\n            } catch (error) {\n              console.error(\"Error forwarding message to SSE:\", error);\n            }\n          }\n          onMessage(event).catch(console.error);\n        });\n\n        // Handle WebSocket errors\n        ws.addEventListener(\"error\", (error) => {\n          async function onError(_error: Event) {\n            await writer.close().catch(() => {});\n          }\n          onError(error).catch(console.error);\n        });\n\n        // Handle WebSocket closure\n        ws.addEventListener(\"close\", () => {\n          async function onClose() {\n            await writer.close().catch(() => {});\n          }\n          onClose().catch(console.error);\n        });\n\n        // If there are no requests, we send the messages to the agent and acknowledge the request with a 202\n        // since we don't expect any responses back through this connection\n        const hasOnlyNotificationsOrResponses = messages.every(\n          (msg) => isJSONRPCNotification(msg) || isJSONRPCResultResponse(msg)\n        );\n        if (hasOnlyNotificationsOrResponses) {\n          // closing the websocket will also close the SSE connection\n          ws.close();\n\n          return new Response(null, {\n            headers: corsHeaders(request, options.corsOptions),\n            status: 202\n          });\n        }\n\n        // Return the SSE response. We handle closing the stream in the ws \"message\"\n        // handler\n        return new Response(readable, {\n          headers: {\n            \"Cache-Control\": \"no-cache\",\n            Connection: \"keep-alive\",\n            \"Content-Type\": \"text/event-stream\",\n            \"mcp-session-id\": sessionId,\n            ...corsHeaders(request, options.corsOptions)\n          },\n          status: 200\n        });\n      } else if (request.method === \"GET\") {\n        // Validate the Accept header\n        const acceptHeader = request.headers.get(\"accept\");\n        // The client MUST include an Accept header, listing both application/json and text/event-stream as supported content types.\n        if (!acceptHeader?.includes(\"text/event-stream\")) {\n          const body = JSON.stringify({\n            jsonrpc: \"2.0\",\n            error: {\n              code: -32000,\n              message: \"Not Acceptable: Client must accept text/event-stream\"\n            },\n            id: null\n          });\n          return new Response(body, { status: 406 });\n        }\n\n        // Require sessionId\n        const sessionId = request.headers.get(\"mcp-session-id\");\n        if (!sessionId)\n          return new Response(\n            JSON.stringify({\n              error: {\n                code: -32000,\n                message: \"Bad Request: Mcp-Session-Id header is required\"\n              },\n              id: null,\n              jsonrpc: \"2.0\"\n            }),\n            { status: 400 }\n          );\n\n        // Create SSE stream\n        const { readable, writable } = new TransformStream();\n        const writer = writable.getWriter();\n        const encoder = new TextEncoder();\n\n        const agent = await getAgentByName(\n          namespace,\n          `streamable-http:${sessionId}`,\n          {\n            props: ctx.props as Record<string, unknown> | undefined,\n            jurisdiction: options.jurisdiction\n          }\n        );\n        const isInitialized = await agent.getInitializeRequest();\n        if (!isInitialized) {\n          return new Response(\n            JSON.stringify({\n              jsonrpc: \"2.0\",\n              error: { code: -32001, message: \"Session not found\" },\n              id: null\n            }),\n            { status: 404 }\n          );\n        }\n\n        const existingHeaders: Record<string, string> = {};\n        request.headers.forEach((v, k) => {\n          existingHeaders[k] = v;\n        });\n\n        const response = await agent.fetch(\n          new Request(request.url, {\n            headers: {\n              ...existingHeaders,\n              [MCP_HTTP_METHOD_HEADER]: \"GET\",\n              Upgrade: \"websocket\"\n            }\n          })\n        );\n\n        const ws = response.webSocket;\n        if (!ws) {\n          await writer.close();\n          return new Response(\"Failed to establish WS to DO\", {\n            status: 500\n          });\n        }\n        ws.accept();\n\n        // Forward DO messages as SSE\n        ws.addEventListener(\"message\", (event) => {\n          try {\n            async function onMessage(ev: MessageEvent) {\n              const data =\n                typeof ev.data === \"string\"\n                  ? ev.data\n                  : new TextDecoder().decode(ev.data);\n              const message = JSON.parse(data);\n\n              // We only forward events from the MCP server\n              if (message.type !== MessageType.CF_MCP_AGENT_EVENT) {\n                return;\n              }\n              await writer.write(encoder.encode(message.event));\n            }\n            onMessage(event).catch(console.error);\n          } catch (e) {\n            console.error(\"Error forwarding message to SSE:\", e);\n          }\n        });\n\n        ws.addEventListener(\"error\", () => {\n          writer.close().catch(() => {});\n        });\n        ws.addEventListener(\"close\", () => {\n          writer.close().catch(() => {});\n        });\n\n        return new Response(readable, {\n          headers: {\n            \"Cache-Control\": \"no-cache\",\n            Connection: \"keep-alive\",\n            \"Content-Type\": \"text/event-stream\",\n            \"mcp-session-id\": sessionId,\n            ...corsHeaders(request, options.corsOptions)\n          },\n          status: 200\n        });\n      } else if (request.method === \"DELETE\") {\n        const sessionId = request.headers.get(\"mcp-session-id\");\n        if (!sessionId) {\n          return new Response(\n            JSON.stringify({\n              jsonrpc: \"2.0\",\n              error: {\n                code: -32000,\n                message: \"Bad Request: Mcp-Session-Id header is required\"\n              },\n              id: null\n            }),\n            { status: 400, headers: corsHeaders(request, options.corsOptions) }\n          );\n        }\n        const agent = await getAgentByName(\n          namespace,\n          `streamable-http:${sessionId}`,\n          { jurisdiction: options.jurisdiction }\n        );\n        const isInitialized = await agent.getInitializeRequest();\n        if (!isInitialized) {\n          return new Response(\n            JSON.stringify({\n              jsonrpc: \"2.0\",\n              error: { code: -32001, message: \"Session not found\" },\n              id: null\n            }),\n            { status: 404, headers: corsHeaders(request, options.corsOptions) }\n          );\n        }\n        // .destroy() passes an uncatchable Error, so we make sure we first return\n        // the response to the client.\n        ctx.waitUntil(\n          agent.destroy().catch(() => {\n            /* This will always throw. We silently catch here */\n          })\n        );\n        return new Response(null, {\n          status: 204,\n          headers: corsHeaders(request, options.corsOptions)\n        });\n      }\n    }\n\n    // Route not found\n    const body = JSON.stringify({\n      error: {\n        code: -32000,\n        message: \"Not found\"\n      },\n      id: null,\n      jsonrpc: \"2.0\"\n    });\n    return new Response(body, { status: 404 });\n  };\n};\n\nexport const createLegacySseHandler = (\n  basePath: string,\n  namespace: DurableObjectNamespace<McpAgent>,\n  options: {\n    corsOptions?: CORSOptions;\n    jurisdiction?: DurableObjectJurisdiction;\n  } = {}\n) => {\n  let pathname = basePath;\n  if (basePath === \"/\") pathname = \"/*\";\n\n  const basePattern = new URLPattern({ pathname });\n  const messagePattern = new URLPattern({ pathname: `${basePath}/message` }); // SSE only\n  return async (request: Request, ctx: ExecutionContext) => {\n    const url = new URL(request.url);\n    // Handle initial SSE connection\n    if (request.method === \"GET\" && basePattern.test(url)) {\n      // Use a session ID if one is passed in, or create a unique\n      // session ID for this connection\n      const sessionId =\n        url.searchParams.get(\"sessionId\") || namespace.newUniqueId().toString();\n\n      // Create a Transform Stream for SSE\n      const { readable, writable } = new TransformStream();\n      const writer = writable.getWriter();\n      const encoder = new TextEncoder();\n\n      // Send the endpoint event\n      const endpointUrl = new URL(request.url);\n      endpointUrl.pathname = encodeURI(`${basePath}/message`);\n      endpointUrl.searchParams.set(\"sessionId\", sessionId);\n      const relativeUrlWithSession =\n        endpointUrl.pathname + endpointUrl.search + endpointUrl.hash;\n      const endpointMessage = `event: endpoint\\ndata: ${relativeUrlWithSession}\\n\\n`;\n      writer.write(encoder.encode(endpointMessage));\n\n      // Get the Durable Object\n      const agent = await getAgentByName(namespace, `sse:${sessionId}`, {\n        props: ctx.props as Record<string, unknown> | undefined,\n        jurisdiction: options.jurisdiction\n      });\n\n      // Connect to the Durable Object via WebSocket\n      const existingHeaders: Record<string, string> = {};\n      request.headers.forEach((value, key) => {\n        existingHeaders[key] = value;\n      });\n      const response = await agent.fetch(\n        new Request(request.url, {\n          headers: {\n            ...existingHeaders,\n            [MCP_HTTP_METHOD_HEADER]: \"SSE\",\n            Upgrade: \"websocket\"\n          }\n        })\n      );\n\n      // Get the WebSocket\n      const ws = response.webSocket;\n      if (!ws) {\n        console.error(\"Failed to establish WebSocket connection\");\n        await writer.close();\n        return new Response(\"Failed to establish WebSocket connection\", {\n          status: 500\n        });\n      }\n\n      // Accept the WebSocket\n      ws.accept();\n\n      // Handle messages from the Durable Object\n      ws.addEventListener(\"message\", (event) => {\n        async function onMessage(event: MessageEvent) {\n          try {\n            const message = JSON.parse(event.data);\n\n            // validate that the message is a valid JSONRPC message\n            const result = JSONRPCMessageSchema.safeParse(message);\n            if (!result.success) {\n              // The message was not a valid JSONRPC message, so we will drop it\n              // PartyKit will broadcast state change messages to all connected clients\n              // and we need to filter those out so they are not passed to MCP clients\n              return;\n            }\n\n            // Send the message as an SSE event\n            const messageText = `event: message\\ndata: ${JSON.stringify(result.data)}\\n\\n`;\n            await writer.write(encoder.encode(messageText));\n          } catch (error) {\n            console.error(\"Error forwarding message to SSE:\", error);\n          }\n        }\n        onMessage(event).catch(console.error);\n      });\n\n      // Handle WebSocket errors\n      ws.addEventListener(\"error\", (error) => {\n        async function onError(_error: Event) {\n          try {\n            await writer.close();\n          } catch (_e) {\n            // Ignore errors when closing\n          }\n        }\n        onError(error).catch(console.error);\n      });\n\n      // Handle WebSocket closure\n      ws.addEventListener(\"close\", () => {\n        async function onClose() {\n          try {\n            await writer.close();\n          } catch (error) {\n            console.error(\"Error closing SSE connection:\", error);\n          }\n        }\n        onClose().catch(console.error);\n      });\n\n      // Return the SSE response\n      return new Response(readable, {\n        headers: {\n          \"Cache-Control\": \"no-cache\",\n          Connection: \"keep-alive\",\n          \"Content-Type\": \"text/event-stream\",\n          ...corsHeaders(request, options.corsOptions)\n        }\n      });\n    }\n\n    // Handle incoming MCP messages. These will be passed to McpAgent\n    // but the response will be sent back via the open SSE connection\n    // so we only need to return a 202 Accepted response for success\n    if (request.method === \"POST\" && messagePattern.test(url)) {\n      const sessionId = url.searchParams.get(\"sessionId\");\n      if (!sessionId) {\n        return new Response(\n          `Missing sessionId. Expected POST to ${basePath} to initiate new one`,\n          { status: 400 }\n        );\n      }\n\n      const contentType = request.headers.get(\"content-type\") || \"\";\n      if (!contentType.includes(\"application/json\")) {\n        return new Response(`Unsupported content-type: ${contentType}`, {\n          status: 400\n        });\n      }\n\n      // check if the request body is too large\n      const contentLength = Number.parseInt(\n        request.headers.get(\"content-length\") || \"0\",\n        10\n      );\n      if (contentLength > MAXIMUM_MESSAGE_SIZE_BYTES) {\n        return new Response(`Request body too large: ${contentLength} bytes`, {\n          status: 400\n        });\n      }\n\n      // Get the Durable Object\n      const agent = await getAgentByName(namespace, `sse:${sessionId}`, {\n        props: ctx.props as Record<string, unknown> | undefined,\n        jurisdiction: options.jurisdiction\n      });\n\n      const messageBody = await request.json();\n\n      // Build MessageExtraInfo with filtered headers\n      const headers = Object.fromEntries(request.headers.entries());\n\n      const extraInfo: MessageExtraInfo = {\n        requestInfo: { headers }\n      };\n\n      const error = await agent.onSSEMcpMessage(\n        sessionId,\n        messageBody,\n        extraInfo\n      );\n\n      if (error) {\n        return new Response(error.message, {\n          headers: {\n            \"Cache-Control\": \"no-cache\",\n            Connection: \"keep-alive\",\n            \"Content-Type\": \"text/event-stream\",\n            ...corsHeaders(request, options.corsOptions)\n          },\n          status: 400\n        });\n      }\n\n      return new Response(\"Accepted\", {\n        headers: {\n          \"Cache-Control\": \"no-cache\",\n          Connection: \"keep-alive\",\n          \"Content-Type\": \"text/event-stream\",\n          ...corsHeaders(request, options.corsOptions)\n        },\n        status: 202\n      });\n    }\n\n    return new Response(\"Not Found\", { status: 404 });\n  };\n};\n\n// CORS helper functions\nexport function corsHeaders(_request: Request, corsOptions: CORSOptions = {}) {\n  const origin = corsOptions.origin || \"*\";\n  const headers =\n    corsOptions.headers ||\n    \"Content-Type, Accept, Authorization, mcp-session-id, mcp-protocol-version\";\n\n  return {\n    \"Access-Control-Allow-Headers\": headers,\n    \"Access-Control-Allow-Methods\":\n      corsOptions.methods || \"GET, POST, DELETE, OPTIONS\",\n    \"Access-Control-Allow-Origin\": origin,\n    \"Access-Control-Expose-Headers\":\n      corsOptions.exposeHeaders || \"mcp-session-id\",\n    \"Access-Control-Max-Age\": (corsOptions.maxAge || 86400).toString()\n  };\n}\n\nexport function handleCORS(\n  request: Request,\n  corsOptions?: CORSOptions\n): Response | null {\n  if (request.method === \"OPTIONS\") {\n    return new Response(null, { headers: corsHeaders(request, corsOptions) });\n  }\n\n  return null;\n}\n\nexport function isDurableObjectNamespace(\n  namespace: unknown\n): namespace is DurableObjectNamespace<McpAgent> {\n  return (\n    typeof namespace === \"object\" &&\n    namespace !== null &&\n    \"newUniqueId\" in namespace &&\n    typeof namespace.newUniqueId === \"function\" &&\n    \"idFromName\" in namespace &&\n    typeof namespace.idFromName === \"function\"\n  );\n}\n","import type { Transport } from \"@modelcontextprotocol/sdk/shared/transport.js\";\nimport {\n  type MessageExtraInfo,\n  type RequestInfo,\n  isJSONRPCErrorResponse,\n  isJSONRPCRequest,\n  isJSONRPCResultResponse,\n  type JSONRPCMessage,\n  JSONRPCMessageSchema,\n  type RequestId\n} from \"@modelcontextprotocol/sdk/types.js\";\nimport type { AuthInfo } from \"@modelcontextprotocol/sdk/server/auth/types.js\";\nimport type {\n  EventStore,\n  StreamId,\n  EventId\n} from \"@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js\";\nimport { getCurrentAgent, type Connection } from \"..\";\nimport type { McpAgent } from \".\";\nimport { MessageType } from \"../types\";\nimport { MCP_HTTP_METHOD_HEADER, MCP_MESSAGE_HEADER } from \"./utils\";\n\nexport type { EventStore, StreamId, EventId };\n\nexport class McpSSETransport implements Transport {\n  sessionId: string;\n  // Set by the server in `server.connect(transport)`\n  onclose?: () => void;\n  onerror?: (error: Error) => void;\n  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;\n\n  private _getWebSocket: () => WebSocket | null;\n  private _started = false;\n  constructor() {\n    const { agent } = getCurrentAgent<McpAgent>();\n    if (!agent)\n      throw new Error(\"McpAgent was not found in Transport constructor\");\n\n    this.sessionId = agent.getSessionId();\n    this._getWebSocket = () => agent.getWebSocket();\n  }\n\n  async start() {\n    // The transport does not manage the WebSocket connection since it's terminated\n    // by the Durable Object in order to allow hibernation. There's nothing to initialize.\n    if (this._started) {\n      throw new Error(\"Transport already started\");\n    }\n    this._started = true;\n  }\n\n  async send(message: JSONRPCMessage) {\n    if (!this._started) {\n      throw new Error(\"Transport not started\");\n    }\n    const websocket = this._getWebSocket();\n    if (!websocket) {\n      throw new Error(\"WebSocket not connected\");\n    }\n    try {\n      websocket.send(JSON.stringify(message));\n    } catch (error) {\n      this.onerror?.(error as Error);\n    }\n  }\n\n  async close() {\n    // Similar to start, the only thing to do is to pass the event on to the server\n    this.onclose?.();\n  }\n}\n\n/**\n * Configuration options for StreamableHTTPServerTransport\n */\nexport interface StreamableHTTPServerTransportOptions {\n  /**\n   * Event store for resumability support\n   * If provided, resumability will be enabled, allowing clients to reconnect and resume messages\n   */\n  eventStore?: EventStore;\n}\n\n/**\n * Adapted from: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/src/client/streamableHttp.ts\n * - Validation and initialization are removed as they're handled in `McpAgent.serve()` handler.\n * - Replaces the Node-style `req`/`res` with Worker's `Request`.\n * - Writes events as WS messages that the Worker forwards to the client as SSE events.\n * - Replaces the in-memory maps that track requestID/stream by using `connection.setState()` and `agent.getConnections()`.\n *\n * Besides these points, the implementation is the same and should be updated to match the original as new features are added.\n */\nexport class StreamableHTTPServerTransport implements Transport {\n  private _started = false;\n  private _eventStore?: EventStore;\n\n  // This is to keep track whether all messages from a single POST request have been answered.\n  // I's fine that we don't persist this since it's only for backwards compatibility as clients\n  // should no longer batch requests, per the spec.\n  private _requestResponseMap: Map<RequestId, JSONRPCMessage> = new Map();\n\n  sessionId: string;\n  onclose?: () => void;\n  onerror?: (error: Error) => void;\n  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;\n\n  /**\n   * Optional message interceptor that can intercept messages before they are passed to onmessage.\n   * If the interceptor returns true, the message is considered handled and won't be forwarded.\n   * This is used by McpAgent to intercept elicitation responses.\n   */\n  messageInterceptor?: (\n    message: JSONRPCMessage,\n    extra?: MessageExtraInfo\n  ) => Promise<boolean>;\n\n  constructor(options: StreamableHTTPServerTransportOptions) {\n    const { agent } = getCurrentAgent<McpAgent>();\n    if (!agent)\n      throw new Error(\"McpAgent was not found in Transport constructor\");\n\n    // Initialization is handled in `McpAgent.serve()` and agents are addressed by sessionId,\n    // so we'll always have this available.\n    this.sessionId = agent.getSessionId();\n    this._eventStore = options.eventStore;\n  }\n\n  /**\n   * Starts the transport. This is required by the Transport interface but is a no-op\n   * for the Streamable HTTP transport as connections are managed per-request.\n   */\n  async start(): Promise<void> {\n    if (this._started) {\n      throw new Error(\"Transport already started\");\n    }\n    this._started = true;\n  }\n\n  /**\n   * Handles GET requests for SSE stream\n   */\n  async handleGetRequest(req: Request): Promise<void> {\n    // Get the WS connection so we can tag it as the standalone stream\n    const { connection } = getCurrentAgent();\n    if (!connection)\n      throw new Error(\"Connection was not found in handleGetRequest\");\n\n    // Handle resumability: check for Last-Event-ID header\n    if (this._eventStore) {\n      const lastEventId = req.headers.get(\"last-event-id\");\n      if (lastEventId) {\n        await this.replayEvents(lastEventId);\n        return;\n      }\n    }\n\n    connection.setState({\n      _standaloneSse: true\n    });\n  }\n\n  /**\n   * Replays events that would have been sent after the specified event ID\n   * Only used when resumability is enabled\n   */\n  private async replayEvents(lastEventId: string): Promise<void> {\n    if (!this._eventStore) {\n      return;\n    }\n\n    const { connection } = getCurrentAgent();\n    if (!connection)\n      throw new Error(\"Connection was not available in replayEvents\");\n\n    try {\n      await this._eventStore?.replayEventsAfter(lastEventId, {\n        send: async (eventId: string, message: JSONRPCMessage) => {\n          try {\n            this.writeSSEEvent(connection, message, eventId);\n          } catch (error) {\n            this.onerror?.(error as Error);\n          }\n        }\n      });\n    } catch (error) {\n      this.onerror?.(error as Error);\n    }\n  }\n\n  /**\n   * Writes an event to the SSE stream with proper formatting\n   */\n  private writeSSEEvent(\n    connection: Connection,\n    message: JSONRPCMessage,\n    eventId?: string,\n    close?: boolean\n  ) {\n    let eventData = \"event: message\\n\";\n    // Include event ID if provided - this is important for resumability\n    if (eventId) {\n      eventData += `id: ${eventId}\\n`;\n    }\n    eventData += `data: ${JSON.stringify(message)}\\n\\n`;\n\n    return connection.send(\n      JSON.stringify({\n        type: MessageType.CF_MCP_AGENT_EVENT,\n        event: eventData,\n        close\n      })\n    );\n  }\n\n  /**\n   * Handles POST requests containing JSON-RPC messages\n   */\n  async handlePostRequest(\n    req: Request & { auth?: AuthInfo },\n    parsedBody: unknown\n  ): Promise<void> {\n    const authInfo: AuthInfo | undefined = req.auth;\n    const requestInfo: RequestInfo = {\n      headers: Object.fromEntries(req.headers.entries())\n    };\n    // Remove headers that are not part of the original request\n    delete requestInfo.headers[MCP_HTTP_METHOD_HEADER];\n    delete requestInfo.headers[MCP_MESSAGE_HEADER];\n    delete requestInfo.headers.upgrade;\n\n    const rawMessage = parsedBody;\n    let messages: JSONRPCMessage[];\n\n    // handle batch and single messages\n    if (Array.isArray(rawMessage)) {\n      messages = rawMessage.map((msg) => JSONRPCMessageSchema.parse(msg));\n    } else {\n      messages = [JSONRPCMessageSchema.parse(rawMessage)];\n    }\n\n    // check if it contains requests\n    const hasRequests = messages.some(isJSONRPCRequest);\n\n    if (!hasRequests) {\n      // We process without sending anything\n      for (const message of messages) {\n        // check if message should be intercepted (i.e. elicitation responses)\n        if (this.messageInterceptor) {\n          const handled = await this.messageInterceptor(message, {\n            authInfo,\n            requestInfo\n          });\n          if (handled) {\n            continue; // msg was handled by interceptor, skip onmessage\n          }\n        }\n        this.onmessage?.(message, { authInfo, requestInfo });\n      }\n    } else if (hasRequests) {\n      const { connection } = getCurrentAgent();\n      if (!connection)\n        throw new Error(\"Connection was not found in handlePostRequest\");\n\n      // We need to track by request ID to maintain the connection\n      const requestIds = messages\n        .filter(isJSONRPCRequest)\n        .map((message) => message.id);\n\n      connection.setState({\n        requestIds\n      });\n\n      // handle each message\n      for (const message of messages) {\n        if (this.messageInterceptor) {\n          const handled = await this.messageInterceptor(message, {\n            authInfo,\n            requestInfo\n          });\n          if (handled) {\n            continue; // Message was handled by interceptor, skip onmessage\n          }\n        }\n        this.onmessage?.(message, { authInfo, requestInfo });\n      }\n      // The server SHOULD NOT close the SSE stream before sending all JSON-RPC responses\n      // This will be handled by the send() method when responses are ready\n    }\n  }\n\n  async close(): Promise<void> {\n    // Close all SSE connections\n    const { agent } = getCurrentAgent();\n    if (!agent) throw new Error(\"Agent was not found in close\");\n\n    for (const conn of agent.getConnections()) {\n      conn.close(1000, \"Session closed\");\n    }\n    this.onclose?.();\n  }\n\n  async send(\n    message: JSONRPCMessage,\n    options?: { relatedRequestId?: RequestId }\n  ): Promise<void> {\n    const { agent } = getCurrentAgent();\n    if (!agent) throw new Error(\"Agent was not found in send\");\n\n    let requestId = options?.relatedRequestId;\n    if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {\n      // If the message is a response, use the request ID from the message\n      requestId = message.id;\n    }\n\n    // Check if this message should be sent on the standalone SSE stream (no request ID)\n    // Ignore notifications from tools (which have relatedRequestId set)\n    // Those will be sent via dedicated response SSE streams\n    if (requestId === undefined) {\n      // For standalone SSE streams, we can only send requests and notifications\n      if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {\n        throw new Error(\n          \"Cannot send a response on a standalone SSE stream unless resuming a previous client request\"\n        );\n      }\n\n      let standaloneConnection: Connection | undefined;\n      for (const conn of agent.getConnections<{ _standaloneSse?: boolean }>()) {\n        if (conn.state?._standaloneSse) standaloneConnection = conn;\n      }\n\n      if (standaloneConnection === undefined) {\n        // The spec says the server MAY send messages on the stream, so it's ok to discard if no stream\n        return;\n      }\n\n      // Generate and store event ID if event store is provided\n      let eventId: string | undefined;\n      if (this._eventStore) {\n        // Stores the event and gets the generated event ID\n        eventId = await this._eventStore.storeEvent(\n          standaloneConnection.id,\n          message\n        );\n      }\n\n      // Send the message to the standalone SSE stream\n      this.writeSSEEvent(standaloneConnection, message, eventId);\n      return;\n    }\n\n    // Get the response for this request\n    const connection = Array.from(\n      agent.getConnections<{ requestIds?: number[] }>()\n    ).find((conn) => conn.state?.requestIds?.includes(requestId as number));\n    if (!connection) {\n      throw new Error(\n        `No connection established for request ID: ${String(requestId)}`\n      );\n    }\n\n    let eventId: string | undefined;\n\n    if (this._eventStore) {\n      eventId = await this._eventStore.storeEvent(connection.id, message);\n    }\n\n    let shouldClose = false;\n\n    if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {\n      this._requestResponseMap.set(requestId, message);\n      const relatedIds = connection.state?.requestIds ?? [];\n      // Check if we have responses for all requests using this connection\n      shouldClose = relatedIds.every((id) => this._requestResponseMap.has(id));\n\n      if (shouldClose) {\n        // Clean up\n        for (const id of relatedIds) {\n          this._requestResponseMap.delete(id);\n        }\n      }\n    }\n    this.writeSSEEvent(connection, message, eventId, shouldClose);\n  }\n}\n","/**\n * Deprecated transport wrappers\n */\n\nimport { SSEClientTransport } from \"@modelcontextprotocol/sdk/client/sse.js\";\nimport type { SSEClientTransportOptions } from \"@modelcontextprotocol/sdk/client/sse.js\";\nimport { StreamableHTTPClientTransport } from \"@modelcontextprotocol/sdk/client/streamableHttp.js\";\nimport type { StreamableHTTPClientTransportOptions } from \"@modelcontextprotocol/sdk/client/streamableHttp.js\";\n\nlet didWarnAboutSSEEdgeClientTransport = false;\n\n/**\n * @deprecated Use SSEClientTransport from @modelcontextprotocol/sdk/client/sse.js instead. This alias will be removed in the next major version.\n */\nexport class SSEEdgeClientTransport extends SSEClientTransport {\n  constructor(url: URL, options: SSEClientTransportOptions) {\n    super(url, options);\n    if (!didWarnAboutSSEEdgeClientTransport) {\n      didWarnAboutSSEEdgeClientTransport = true;\n      console.warn(\n        \"SSEEdgeClientTransport is deprecated. Use SSEClientTransport from @modelcontextprotocol/sdk/client/sse.js instead. SSEEdgeClientTransport will be removed in the next major version.\"\n      );\n    }\n  }\n}\n\nlet didWarnAboutStreamableHTTPEdgeClientTransport = false;\n\n/**\n * @deprecated Use StreamableHTTPClientTransport from @modelcontextprotocol/sdk/client/streamableHttp.js instead. This alias will be removed in the next major version.\n */\nexport class StreamableHTTPEdgeClientTransport extends StreamableHTTPClientTransport {\n  constructor(url: URL, options: StreamableHTTPClientTransportOptions) {\n    super(url, options);\n    if (!didWarnAboutStreamableHTTPEdgeClientTransport) {\n      didWarnAboutStreamableHTTPEdgeClientTransport = true;\n      console.warn(\n        \"StreamableHTTPEdgeClientTransport is deprecated. Use StreamableHTTPClientTransport from @modelcontextprotocol/sdk/client/streamableHttp.js instead. StreamableHTTPEdgeClientTransport will be removed in the next major version.\"\n      );\n    }\n  }\n}\n","/**\n * Based on webStandardStreamableHttp.ts (https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/server/src/server/webStandardStreamableHttp.ts)\n */\n\nimport type {\n  Transport,\n  TransportSendOptions\n} from \"@modelcontextprotocol/sdk/shared/transport.js\";\nimport type {\n  JSONRPCMessage,\n  RequestId,\n  RequestInfo,\n  MessageExtraInfo,\n  InitializeRequestParams\n} from \"@modelcontextprotocol/sdk/types.js\";\nimport {\n  isInitializeRequest,\n  isJSONRPCErrorResponse,\n  isJSONRPCRequest,\n  isJSONRPCResultResponse,\n  JSONRPCMessageSchema,\n  SUPPORTED_PROTOCOL_VERSIONS\n} from \"@modelcontextprotocol/sdk/types.js\";\nimport type { CORSOptions } from \"./types\";\nimport type {\n  EventStore,\n  EventId\n} from \"@modelcontextprotocol/sdk/server/streamableHttp.js\";\n\nconst MCP_PROTOCOL_VERSION_HEADER = \"MCP-Protocol-Version\";\n\nconst RESTORE_REQUEST_ID = \"__restore__\";\n\ninterface StreamMapping {\n  writer?: WritableStreamDefaultWriter<Uint8Array>;\n  encoder?: TextEncoder;\n  resolveJson?: (response: Response) => void;\n  cleanup: () => void;\n}\n\nexport interface MCPStorageApi {\n  get(): Promise<TransportState | undefined> | TransportState | undefined;\n  set(state: TransportState): Promise<void> | void;\n}\n\nexport interface TransportState {\n  sessionId?: string;\n  initialized: boolean;\n  initializeParams?: InitializeRequestParams;\n}\n\nexport interface WorkerTransportOptions {\n  /**\n   * Function that generates a session ID for the transport.\n   * The session ID SHOULD be globally unique and cryptographically secure.\n   * Return undefined to disable session management (stateless mode).\n   */\n  sessionIdGenerator?: () => string;\n  /**\n   * Enable traditional Request/Response mode, this will disable streaming.\n   */\n  enableJsonResponse?: boolean;\n  /**\n   * Callback fired when a new session is initialized.\n   */\n  onsessioninitialized?: (sessionId: string) => void;\n  /**\n   * Callback fired when a session is closed via DELETE request.\n   */\n  onsessionclosed?: (sessionId: string) => void;\n  corsOptions?: CORSOptions;\n  /**\n   * Optional storage api for persisting transport state.\n   * Use this to store session state in Durable Object/Agent storage\n   * so it survives hibernation/restart.\n   */\n  storage?: MCPStorageApi;\n  /**\n   * Event store for resumability support.\n   * If provided, enables clients to reconnect and resume messages using Last-Event-ID.\n   */\n  eventStore?: EventStore;\n  /**\n   * Retry interval in milliseconds to suggest to clients in SSE retry field.\n   * Controls client reconnection timing for polling behavior.\n   */\n  retryInterval?: number;\n}\n\nexport class WorkerTransport implements Transport {\n  started = false;\n  private initialized = false;\n  private sessionIdGenerator?: () => string;\n  private enableJsonResponse = false;\n  private onsessioninitialized?: (sessionId: string) => void;\n  private onsessionclosed?: (sessionId: string) => void;\n  private standaloneSseStreamId = \"_GET_stream\";\n  private streamMapping = new Map<string, StreamMapping>();\n  private requestToStreamMapping = new Map<RequestId, string>();\n  private requestResponseMap = new Map<RequestId, JSONRPCMessage>();\n  private corsOptions?: CORSOptions;\n  private storage?: MCPStorageApi;\n  private stateRestored = false;\n  private eventStore?: EventStore;\n  private retryInterval?: number;\n  private initializeParams?: TransportState[\"initializeParams\"];\n\n  sessionId?: string;\n  onclose?: () => void;\n  onerror?: (error: Error) => void;\n  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;\n\n  constructor(options?: WorkerTransportOptions) {\n    this.sessionIdGenerator = options?.sessionIdGenerator;\n    this.enableJsonResponse = options?.enableJsonResponse ?? false;\n    this.onsessioninitialized = options?.onsessioninitialized;\n    this.onsessionclosed = options?.onsessionclosed;\n    this.corsOptions = options?.corsOptions;\n    this.storage = options?.storage;\n    this.eventStore = options?.eventStore;\n    this.retryInterval = options?.retryInterval;\n  }\n\n  /**\n   * Restore transport state from persistent storage.\n   * This is automatically called on start.\n   */\n  private async restoreState() {\n    if (!this.storage || this.stateRestored) {\n      return;\n    }\n\n    const state = await Promise.resolve(this.storage.get());\n\n    if (state) {\n      this.sessionId = state.sessionId;\n      this.initialized = state.initialized;\n\n      // Restore _clientCapabilities on the Server instance by replaying the original initialize request\n      if (state.initializeParams && this.onmessage) {\n        this.onmessage({\n          jsonrpc: \"2.0\",\n          id: RESTORE_REQUEST_ID,\n          method: \"initialize\",\n          params: state.initializeParams\n        });\n      }\n    }\n\n    this.stateRestored = true;\n  }\n\n  /**\n   * Persist current transport state to storage.\n   */\n  private async saveState() {\n    if (!this.storage) {\n      return;\n    }\n\n    const state: TransportState = {\n      sessionId: this.sessionId,\n      initialized: this.initialized,\n      initializeParams: this.initializeParams\n    };\n\n    await Promise.resolve(this.storage.set(state));\n  }\n\n  async start(): Promise<void> {\n    if (this.started) {\n      throw new Error(\"Transport already started\");\n    }\n    this.started = true;\n  }\n\n  /**\n   * Validates the MCP-Protocol-Version header on incoming requests.\n   *\n   * This performs a simple check: if a version header is present, it must be\n   * in the SUPPORTED_PROTOCOL_VERSIONS list. We do not track the negotiated\n   * version or enforce version consistency across requests - the SDK handles\n   * version negotiation during initialization, and we simply reject any\n   * explicitly unsupported versions.\n   *\n   * - Header present and supported: Accept\n   * - Header present and unsupported: 400 Bad Request\n   * - Header missing: Accept (version validation is optional)\n   */\n  private validateProtocolVersion(request: Request): Response | undefined {\n    const protocolVersion = request.headers.get(MCP_PROTOCOL_VERSION_HEADER);\n\n    if (\n      protocolVersion !== null &&\n      !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)\n    ) {\n      return new Response(\n        JSON.stringify({\n          jsonrpc: \"2.0\",\n          error: {\n            code: -32000,\n            message: `Bad Request: Unsupported protocol version: ${protocolVersion} (supported versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(\", \")})`\n          },\n          id: null\n        }),\n        {\n          status: 400,\n          headers: {\n            \"Content-Type\": \"application/json\",\n            ...this.getHeaders()\n          }\n        }\n      );\n    }\n    return undefined;\n  }\n\n  private getHeaders({ forPreflight }: { forPreflight?: boolean } = {}): Record<\n    string,\n    string\n  > {\n    const defaults: CORSOptions = {\n      origin: \"*\",\n      headers:\n        \"Content-Type, Accept, Authorization, mcp-session-id, MCP-Protocol-Version\",\n      methods: \"GET, POST, DELETE, OPTIONS\",\n      exposeHeaders: \"mcp-session-id\",\n      maxAge: 86400\n    };\n\n    const options = { ...defaults, ...this.corsOptions };\n\n    // For OPTIONS preflight, return all CORS headers\n    if (forPreflight) {\n      return {\n        \"Access-Control-Allow-Origin\": options.origin!,\n        \"Access-Control-Allow-Headers\": options.headers!,\n        \"Access-Control-Allow-Methods\": options.methods!,\n        \"Access-Control-Max-Age\": options.maxAge!.toString()\n      };\n    }\n\n    // For actual requests, only return origin and expose headers\n    return {\n      \"Access-Control-Allow-Origin\": options.origin!,\n      \"Access-Control-Expose-Headers\": options.exposeHeaders!\n    };\n  }\n\n  async handleRequest(\n    request: Request,\n    parsedBody?: unknown\n  ): Promise<Response> {\n    await this.restoreState();\n\n    switch (request.method) {\n      case \"OPTIONS\":\n        return this.handleOptionsRequest(request);\n      case \"GET\":\n        return this.handleGetRequest(request);\n      case \"POST\":\n        return this.handlePostRequest(request, parsedBody);\n      case \"DELETE\":\n        return this.handleDeleteRequest(request);\n      default:\n        return this.handleUnsupportedRequest();\n    }\n  }\n\n  private async handleGetRequest(request: Request): Promise<Response> {\n    const acceptHeader = request.headers.get(\"Accept\");\n    if (!acceptHeader?.includes(\"text/event-stream\")) {\n      return new Response(\n        JSON.stringify({\n          jsonrpc: \"2.0\",\n          error: {\n            code: -32000,\n            message: \"Not Acceptable: Client must accept text/event-stream\"\n          },\n          id: null\n        }),\n        {\n          status: 406,\n          headers: {\n            \"Content-Type\": \"application/json\",\n            ...this.getHeaders()\n          }\n        }\n      );\n    }\n\n    const sessionError = this.validateSession(request);\n    if (sessionError) {\n      return sessionError;\n    }\n\n    // Validate protocol version on subsequent requests\n    const versionError = this.validateProtocolVersion(request);\n    if (versionError) {\n      return versionError;\n    }\n\n    let streamId = this.standaloneSseStreamId;\n\n    // Check for resumability via Last-Event-ID\n    const lastEventId = request.headers.get(\"Last-Event-ID\");\n    if (lastEventId && this.eventStore) {\n      // Get the stream ID for this event if available\n      const eventStreamId =\n        await this.eventStore.getStreamIdForEventId?.(lastEventId);\n      if (eventStreamId) {\n        streamId = eventStreamId;\n      }\n    }\n\n    if (this.streamMapping.get(streamId) !== undefined) {\n      return new Response(\n        JSON.stringify({\n          jsonrpc: \"2.0\",\n          error: {\n            code: -32000,\n            message: \"Conflict: Only one SSE stream is allowed per session\"\n          },\n          id: null\n        }),\n        {\n          status: 409,\n          headers: {\n            \"Content-Type\": \"application/json\",\n            ...this.getHeaders()\n          }\n        }\n      );\n    }\n\n    const { readable, writable } = new TransformStream<Uint8Array>();\n    const writer = writable.getWriter();\n    const encoder = new TextEncoder();\n\n    const headers = new Headers({\n      \"Content-Type\": \"text/event-stream\",\n      \"Cache-Control\": \"no-cache\",\n      Connection: \"keep-alive\",\n      ...this.getHeaders()\n    });\n\n    if (this.sessionId !== undefined) {\n      headers.set(\"mcp-session-id\", this.sessionId);\n    }\n\n    const keepAlive = setInterval(() => {\n      try {\n        writer.write(encoder.encode(\"event: ping\\ndata: \\n\\n\"));\n      } catch {\n        clearInterval(keepAlive);\n      }\n    }, 30000);\n\n    this.streamMapping.set(streamId, {\n      writer,\n      encoder,\n      cleanup: () => {\n        clearInterval(keepAlive);\n        this.streamMapping.delete(streamId);\n        writer.close().catch(() => {});\n      }\n    });\n\n    // Write priming event with retry interval if configured\n    if (this.retryInterval !== undefined) {\n      await writer.write(encoder.encode(`retry: ${this.retryInterval}\\n\\n`));\n    }\n\n    // Replay events if resuming and eventStore is configured\n    if (lastEventId && this.eventStore) {\n      const replayedStreamId = await this.eventStore.replayEventsAfter(\n        lastEventId,\n        {\n          send: async (eventId: EventId, message: JSONRPCMessage) => {\n            const data = `id: ${eventId}\\nevent: message\\ndata: ${JSON.stringify(message)}\\n\\n`;\n            await writer.write(encoder.encode(data));\n          }\n        }\n      );\n      // Update stream ID if different from what we had\n      if (replayedStreamId !== streamId) {\n        this.streamMapping.delete(streamId);\n        streamId = replayedStreamId;\n        this.streamMapping.set(streamId, {\n          writer,\n          encoder,\n          cleanup: () => {\n            clearInterval(keepAlive);\n            this.streamMapping.delete(streamId);\n            writer.close().catch(() => {});\n          }\n        });\n      }\n    }\n\n    return new Response(readable, { headers });\n  }\n\n  private async handlePostRequest(\n    request: Request,\n    parsedBody?: unknown\n  ): Promise<Response> {\n    const acceptHeader = request.headers.get(\"Accept\");\n    if (\n      !acceptHeader?.includes(\"application/json\") ||\n      !acceptHeader?.includes(\"text/event-stream\")\n    ) {\n      return new Response(\n        JSON.stringify({\n          jsonrpc: \"2.0\",\n          error: {\n            code: -32000,\n            message:\n              \"Not Acceptable: Client must accept both application/json and text/event-stream\"\n          },\n          id: null\n        }),\n        {\n          status: 406,\n          headers: {\n            \"Content-Type\": \"application/json\",\n            ...this.getHeaders()\n          }\n        }\n      );\n    }\n\n    const contentType = request.headers.get(\"Content-Type\");\n    if (!contentType?.includes(\"application/json\")) {\n      return new Response(\n        JSON.stringify({\n          jsonrpc: \"2.0\",\n          error: {\n            code: -32000,\n            message:\n              \"Unsupported Media Type: Content-Type must be application/json\"\n          },\n          id: null\n        }),\n        {\n          status: 415,\n          headers: {\n            \"Content-Type\": \"application/json\",\n            ...this.getHeaders()\n          }\n        }\n      );\n    }\n\n    let rawMessage = parsedBody;\n    if (rawMessage === undefined) {\n      try {\n        rawMessage = await request.json();\n      } catch {\n        return new Response(\n          JSON.stringify({\n            jsonrpc: \"2.0\",\n            error: {\n              code: -32700,\n              message: \"Parse error: Invalid JSON\"\n            },\n            id: null\n          }),\n          {\n            status: 400,\n            headers: {\n              \"Content-Type\": \"application/json\",\n              ...this.getHeaders()\n            }\n          }\n        );\n      }\n    }\n\n    let messages: JSONRPCMessage[];\n    try {\n      if (Array.isArray(rawMessage)) {\n        messages = rawMessage.map((msg) => JSONRPCMessageSchema.parse(msg));\n      } else {\n        messages = [JSONRPCMessageSchema.parse(rawMessage)];\n      }\n    } catch {\n      return new Response(\n        JSON.stringify({\n          jsonrpc: \"2.0\",\n          error: {\n            code: -32700,\n            message: \"Parse error: Invalid JSON-RPC message\"\n          },\n          id: null\n        }),\n        {\n          status: 400,\n          headers: {\n            \"Content-Type\": \"application/json\",\n            ...this.getHeaders()\n          }\n        }\n      );\n    }\n\n    const requestInfo: RequestInfo = {\n      headers: Object.fromEntries(request.headers.entries())\n    };\n\n    const isInitializationRequest = messages.some(isInitializeRequest);\n\n    if (isInitializationRequest) {\n      if (this.initialized && this.sessionId !== undefined) {\n        return new Response(\n          JSON.stringify({\n            jsonrpc: \"2.0\",\n            error: {\n              code: -32600,\n              message: \"Invalid Request: Server already initialized\"\n            },\n            id: null\n          }),\n          {\n            status: 400,\n            headers: {\n              \"Content-Type\": \"application/json\",\n              ...this.getHeaders()\n            }\n          }\n        );\n      }\n\n      if (messages.length > 1) {\n        return new Response(\n          JSON.stringify({\n            jsonrpc: \"2.0\",\n            error: {\n              code: -32600,\n              message:\n                \"Invalid Request: Only one initialization request is allowed\"\n            },\n            id: null\n          }),\n          {\n            status: 400,\n            headers: {\n              \"Content-Type\": \"application/json\",\n              ...this.getHeaders()\n            }\n          }\n        );\n      }\n\n      this.sessionId = this.sessionIdGenerator?.();\n      this.initialized = true;\n\n      const initMessage = messages.find(isInitializeRequest);\n      if (initMessage && isInitializeRequest(initMessage)) {\n        this.initializeParams = {\n          capabilities: initMessage.params.capabilities,\n          clientInfo: initMessage.params.clientInfo,\n          protocolVersion: initMessage.params.protocolVersion\n        };\n      }\n\n      await this.saveState();\n\n      if (this.sessionId && this.onsessioninitialized) {\n        this.onsessioninitialized(this.sessionId);\n      }\n    }\n\n    if (!isInitializationRequest) {\n      const sessionError = this.validateSession(request);\n      if (sessionError) {\n        return sessionError;\n      }\n\n      // Validate protocol version on subsequent requests\n      const versionError = this.validateProtocolVersion(request);\n      if (versionError) {\n        return versionError;\n      }\n    }\n\n    const hasRequests = messages.some(isJSONRPCRequest);\n\n    if (!hasRequests) {\n      for (const message of messages) {\n        this.onmessage?.(message, { requestInfo });\n      }\n      return new Response(null, {\n        status: 202,\n        headers: { ...this.getHeaders() }\n      });\n    }\n\n    const streamId = crypto.randomUUID();\n\n    if (this.enableJsonResponse) {\n      return new Promise<Response>((resolve) => {\n        this.streamMapping.set(streamId, {\n          resolveJson: resolve,\n          cleanup: () => {\n            this.streamMapping.delete(streamId);\n          }\n        });\n\n        for (const message of messages) {\n          if (isJSONRPCRequest(message)) {\n            this.requestToStreamMapping.set(message.id, streamId);\n          }\n        }\n\n        for (const message of messages) {\n          this.onmessage?.(message, { requestInfo });\n        }\n      });\n    }\n\n    const { readable, writable } = new TransformStream<Uint8Array>();\n    const writer = writable.getWriter();\n    const encoder = new TextEncoder();\n\n    const headers = new Headers({\n      \"Content-Type\": \"text/event-stream\",\n      \"Cache-Control\": \"no-cache\",\n      Connection: \"keep-alive\",\n      ...this.getHeaders()\n    });\n\n    if (this.sessionId !== undefined) {\n      headers.set(\"mcp-session-id\", this.sessionId);\n    }\n\n    const keepAlive = setInterval(() => {\n      try {\n        writer.write(encoder.encode(\"event: ping\\ndata: \\n\\n\"));\n      } catch {\n        clearInterval(keepAlive);\n      }\n    }, 30000);\n\n    this.streamMapping.set(streamId, {\n      writer,\n      encoder,\n      cleanup: () => {\n        clearInterval(keepAlive);\n        this.streamMapping.delete(streamId);\n        writer.close().catch(() => {});\n      }\n    });\n\n    for (const message of messages) {\n      if (isJSONRPCRequest(message)) {\n        this.requestToStreamMapping.set(message.id, streamId);\n      }\n    }\n\n    for (const message of messages) {\n      this.onmessage?.(message, { requestInfo });\n    }\n\n    return new Response(readable, { headers });\n  }\n\n  private async handleDeleteRequest(request: Request): Promise<Response> {\n    const sessionError = this.validateSession(request);\n    if (sessionError) {\n      return sessionError;\n    }\n\n    // Validate protocol version on subsequent requests\n    const versionError = this.validateProtocolVersion(request);\n    if (versionError) {\n      return versionError;\n    }\n\n    // Capture session ID before closing\n    const closedSessionId = this.sessionId;\n\n    await this.close();\n\n    // Fire onsessionclosed callback if configured\n    if (closedSessionId && this.onsessionclosed) {\n      this.onsessionclosed(closedSessionId);\n    }\n\n    return new Response(null, {\n      status: 200,\n      headers: { ...this.getHeaders() }\n    });\n  }\n\n  private handleOptionsRequest(_request: Request): Response {\n    return new Response(null, {\n      status: 200,\n      headers: { ...this.getHeaders({ forPreflight: true }) }\n    });\n  }\n\n  private handleUnsupportedRequest(): Response {\n    return new Response(\n      JSON.stringify({\n        jsonrpc: \"2.0\",\n        error: {\n          code: -32000,\n          message: \"Method not allowed.\"\n        },\n        id: null\n      }),\n      {\n        status: 405,\n        headers: {\n          Allow: \"GET, POST, DELETE, OPTIONS\",\n          \"Content-Type\": \"application/json\"\n        }\n      }\n    );\n  }\n\n  private validateSession(request: Request): Response | undefined {\n    if (this.sessionIdGenerator === undefined) {\n      return undefined;\n    }\n\n    if (!this.initialized) {\n      return new Response(\n        JSON.stringify({\n          jsonrpc: \"2.0\",\n          error: {\n            code: -32000,\n            message: \"Bad Request: Server not initialized\"\n          },\n          id: null\n        }),\n        {\n          status: 400,\n          headers: {\n            \"Content-Type\": \"application/json\",\n            ...this.getHeaders()\n          }\n        }\n      );\n    }\n\n    const sessionId = request.headers.get(\"mcp-session-id\");\n\n    if (!sessionId) {\n      return new Response(\n        JSON.stringify({\n          jsonrpc: \"2.0\",\n          error: {\n            code: -32000,\n            message: \"Bad Request: Mcp-Session-Id header is required\"\n          },\n          id: null\n        }),\n        {\n          status: 400,\n          headers: {\n            \"Content-Type\": \"application/json\",\n            ...this.getHeaders()\n          }\n        }\n      );\n    }\n\n    if (sessionId !== this.sessionId) {\n      return new Response(\n        JSON.stringify({\n          jsonrpc: \"2.0\",\n          error: {\n            code: -32001,\n            message: \"Session not found\"\n          },\n          id: null\n        }),\n        {\n          status: 404,\n          headers: {\n            \"Content-Type\": \"application/json\",\n            ...this.getHeaders()\n          }\n        }\n      );\n    }\n\n    return undefined;\n  }\n\n  async close(): Promise<void> {\n    for (const { cleanup } of this.streamMapping.values()) {\n      cleanup();\n    }\n\n    this.streamMapping.clear();\n    this.requestResponseMap.clear();\n    this.onclose?.();\n  }\n\n  /**\n   * Close an SSE stream for a specific request, triggering client reconnection.\n   * Use this to implement polling behavior during long-running operations -\n   * client will reconnect after the retry interval specified in the priming event.\n   */\n  closeSSEStream(requestId: RequestId): void {\n    const streamId = this.requestToStreamMapping.get(requestId);\n    if (!streamId) {\n      return;\n    }\n\n    const stream = this.streamMapping.get(streamId);\n    if (stream) {\n      stream.cleanup();\n    }\n\n    // Clean up request mappings for this stream\n    for (const [reqId, sid] of this.requestToStreamMapping.entries()) {\n      if (sid === streamId) {\n        this.requestToStreamMapping.delete(reqId);\n        this.requestResponseMap.delete(reqId);\n      }\n    }\n  }\n\n  async send(\n    message: JSONRPCMessage,\n    options?: TransportSendOptions\n  ): Promise<void> {\n    // Check relatedRequestId FIRST to route server-to-client requests through the same stream as the originating client request\n    let requestId: RequestId | undefined = options?.relatedRequestId;\n\n    // Then override with message.id for responses/errors\n    if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {\n      requestId = message.id;\n    }\n\n    if (requestId === RESTORE_REQUEST_ID) {\n      return;\n    }\n\n    if (requestId === undefined) {\n      if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {\n        throw new Error(\n          \"Cannot send a response on a standalone SSE stream unless resuming a previous client request\"\n        );\n      }\n\n      const standaloneSse = this.streamMapping.get(this.standaloneSseStreamId);\n      if (standaloneSse === undefined) {\n        return;\n      }\n\n      if (standaloneSse.writer && standaloneSse.encoder) {\n        // Store event for resumability if eventStore is configured\n        let eventId: EventId | undefined;\n        if (this.eventStore) {\n          eventId = await this.eventStore.storeEvent(\n            this.standaloneSseStreamId,\n            message\n          );\n        }\n\n        const idLine = eventId ? `id: ${eventId}\\n` : \"\";\n        const data = `${idLine}event: message\\ndata: ${JSON.stringify(message)}\\n\\n`;\n        await standaloneSse.writer.write(standaloneSse.encoder.encode(data));\n      }\n      return;\n    }\n\n    const streamId = this.requestToStreamMapping.get(requestId);\n    if (!streamId) {\n      throw new Error(\n        `No connection established for request ID: ${String(requestId)}`\n      );\n    }\n\n    const response = this.streamMapping.get(streamId);\n    if (!response) {\n      throw new Error(\n        `No connection established for request ID: ${String(requestId)}`\n      );\n    }\n\n    if (!this.enableJsonResponse) {\n      if (response.writer && response.encoder) {\n        // Store event for resumability if eventStore is configured\n        let eventId: EventId | undefined;\n        if (this.eventStore) {\n          eventId = await this.eventStore.storeEvent(streamId, message);\n        }\n\n        const idLine = eventId ? `id: ${eventId}\\n` : \"\";\n        const data = `${idLine}event: message\\ndata: ${JSON.stringify(message)}\\n\\n`;\n        await response.writer.write(response.encoder.encode(data));\n      }\n    }\n\n    if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {\n      this.requestResponseMap.set(requestId, message);\n\n      const relatedIds = Array.from(this.requestToStreamMapping.entries())\n        .filter(([, sid]) => sid === streamId)\n        .map(([id]) => id);\n\n      const allResponsesReady = relatedIds.every((id) =>\n        this.requestResponseMap.has(id)\n      );\n\n      if (allResponsesReady) {\n        if (this.enableJsonResponse && response.resolveJson) {\n          const responses = relatedIds.map(\n            (id) => this.requestResponseMap.get(id)!\n          );\n\n          const headers = new Headers({\n            \"Content-Type\": \"application/json\",\n            ...this.getHeaders()\n          });\n\n          if (this.sessionId !== undefined) {\n            headers.set(\"mcp-session-id\", this.sessionId);\n          }\n\n          const body = responses.length === 1 ? responses[0] : responses;\n          response.resolveJson(new Response(JSON.stringify(body), { headers }));\n        } else {\n          response.cleanup();\n        }\n\n        for (const id of relatedIds) {\n          this.requestResponseMap.delete(id);\n          this.requestToStreamMapping.delete(id);\n        }\n      }\n    }\n  }\n}\n","import { AsyncLocalStorage } from \"node:async_hooks\";\n\nexport interface McpAuthContext {\n  props: Record<string, unknown>;\n}\n\nconst authContextStorage = new AsyncLocalStorage<McpAuthContext>();\n\nexport function getMcpAuthContext(): McpAuthContext | undefined {\n  return authContextStorage.getStore();\n}\n\nexport function runWithAuthContext<T>(context: McpAuthContext, fn: () => T): T {\n  return authContextStorage.run(context, fn);\n}\n","import { McpServer } from \"@modelcontextprotocol/sdk/server/mcp.js\";\nimport type { Server } from \"@modelcontextprotocol/sdk/server/index.js\";\nimport {\n  WorkerTransport,\n  type WorkerTransportOptions\n} from \"./worker-transport\";\nimport { runWithAuthContext, type McpAuthContext } from \"./auth-context\";\n\nexport interface CreateMcpHandlerOptions extends WorkerTransportOptions {\n  /**\n   * The route path that this MCP handler should respond to.\n   * If specified, the handler will only process requests that match this route.\n   * @default \"/mcp\"\n   */\n  route?: string;\n  /**\n   * An optional auth context to use for handling MCP requests.\n   * If not provided, the handler will look for props in the execution context.\n   */\n  authContext?: McpAuthContext;\n  /**\n   * An optional transport to use for handling MCP requests.\n   * If not provided, a WorkerTransport will be created with the provided WorkerTransportOptions.\n   */\n  transport?: WorkerTransport;\n}\n\nexport function createMcpHandler(\n  server: McpServer | Server,\n  options: CreateMcpHandlerOptions = {}\n): (\n  request: Request,\n  env: unknown,\n  ctx: ExecutionContext\n) => Promise<Response> {\n  const route = options.route ?? \"/mcp\";\n\n  return async (\n    request: Request,\n    _env: unknown,\n    ctx: ExecutionContext\n  ): Promise<Response> => {\n    const url = new URL(request.url);\n    if (route && url.pathname !== route) {\n      return new Response(\"Not Found\", { status: 404 });\n    }\n\n    const transport =\n      options.transport ??\n      new WorkerTransport({\n        sessionIdGenerator: options.sessionIdGenerator,\n        enableJsonResponse: options.enableJsonResponse,\n        onsessioninitialized: options.onsessioninitialized,\n        corsOptions: options.corsOptions,\n        storage: options.storage\n      });\n\n    const buildAuthContext = () => {\n      if (options.authContext) {\n        return options.authContext;\n      }\n\n      if (ctx.props && Object.keys(ctx.props).length > 0) {\n        return {\n          props: ctx.props as Record<string, unknown>\n        };\n      }\n\n      return undefined;\n    };\n\n    const handleRequest = async () => {\n      return await transport.handleRequest(request);\n    };\n\n    const authContext = buildAuthContext();\n\n    // Guard for stateful usage where a pre-connected transport is passed via options.\n    // If someone passes a transport that's already connected to this server, skip reconnecting.\n    // Note: If a developer incorrectly uses a global server with per-request transports,\n    // the MCP SDK 1.26.0+ will throw an error when trying to connect an already-connected server.\n    if (!transport.started) {\n      // Check if server is already connected (McpServer has isConnected(), Server uses transport getter)\n      const isServerConnected =\n        server instanceof McpServer\n          ? server.isConnected()\n          : server.transport !== undefined;\n\n      if (isServerConnected) {\n        throw new Error(\n          \"Server is already connected to a transport. Create a new McpServer instance per request for stateless handlers.\"\n        );\n      }\n\n      await server.connect(transport);\n    }\n\n    try {\n      if (authContext) {\n        return await runWithAuthContext(authContext, handleRequest);\n      } else {\n        return await handleRequest();\n      }\n    } catch (error) {\n      console.error(\"MCP handler error:\", error);\n\n      return new Response(\n        JSON.stringify({\n          jsonrpc: \"2.0\",\n          error: {\n            code: -32603,\n            message:\n              error instanceof Error ? error.message : \"Internal server error\"\n          },\n          id: null\n        }),\n        { status: 500, headers: { \"Content-Type\": \"application/json\" } }\n      );\n    }\n  };\n}\n\nlet didWarnAboutExperimentalCreateMcpHandler = false;\n\n/**\n * @deprecated This has been renamed to createMcpHandler, and experimental_createMcpHandler will be removed in the next major version\n */\nexport function experimental_createMcpHandler(\n  server: McpServer | Server,\n  options: CreateMcpHandlerOptions = {}\n): (\n  request: Request,\n  env: unknown,\n  ctx: ExecutionContext\n) => Promise<Response> {\n  if (!didWarnAboutExperimentalCreateMcpHandler) {\n    didWarnAboutExperimentalCreateMcpHandler = true;\n    console.warn(\n      \"experimental_createMcpHandler is deprecated, use createMcpHandler instead. experimental_createMcpHandler will be removed in the next major version.\"\n    );\n  }\n  return createMcpHandler(server, options);\n}\n","import type { Server } from \"@modelcontextprotocol/sdk/server/index.js\";\nimport type { McpServer } from \"@modelcontextprotocol/sdk/server/mcp.js\";\nimport type { Transport } from \"@modelcontextprotocol/sdk/shared/transport.js\";\nimport type {\n  JSONRPCMessage,\n  MessageExtraInfo\n} from \"@modelcontextprotocol/sdk/types.js\";\nimport {\n  JSONRPCMessageSchema,\n  isJSONRPCErrorResponse,\n  isJSONRPCResultResponse,\n  type ElicitResult\n} from \"@modelcontextprotocol/sdk/types.js\";\nimport type { Connection, ConnectionContext } from \"../\";\nimport { Agent } from \"../index\";\nimport type { BaseTransportType, MaybePromise, ServeOptions } from \"./types\";\nimport {\n  createLegacySseHandler,\n  createStreamingHttpHandler,\n  handleCORS,\n  isDurableObjectNamespace,\n  MCP_HTTP_METHOD_HEADER,\n  MCP_MESSAGE_HEADER\n} from \"./utils\";\nimport { McpSSETransport, StreamableHTTPServerTransport } from \"./transport\";\nimport { RPCServerTransport, type RPCServerTransportOptions } from \"./rpc\";\n\nexport abstract class McpAgent<\n  Env extends Cloudflare.Env = Cloudflare.Env,\n  State = unknown,\n  Props extends Record<string, unknown> = Record<string, unknown>\n> extends Agent<Env, State, Props> {\n  private _transport?: Transport;\n  private _pendingElicitations = new Map<\n    string,\n    { resolve: (result: ElicitResult) => void; reject: (err: Error) => void }\n  >();\n  props?: Props;\n\n  // MCP WebSocket connections are transport bridges — they use their own\n  // protocol and don't need agent identity, state sync, or other protocol\n  // messages. Regular WebSocket connections are left untouched.\n  override shouldSendProtocolMessages(\n    _connection: Connection,\n    ctx: ConnectionContext\n  ): boolean {\n    return !ctx.request.headers.get(MCP_HTTP_METHOD_HEADER);\n  }\n\n  abstract server: MaybePromise<McpServer | Server>;\n  abstract init(): Promise<void>;\n\n  /*\n   * Helpers\n   */\n\n  async setInitializeRequest(initializeRequest: JSONRPCMessage) {\n    await this.ctx.storage.put(\"initializeRequest\", initializeRequest);\n  }\n\n  async getInitializeRequest() {\n    return this.ctx.storage.get<JSONRPCMessage>(\"initializeRequest\");\n  }\n\n  /** Read the transport type for this agent.\n   * This relies on the naming scheme being `sse:${sessionId}`,\n   * `streamable-http:${sessionId}`, or `rpc:${sessionId}`.\n   */\n  getTransportType(): BaseTransportType {\n    const [t, ..._] = this.name.split(\":\");\n    switch (t) {\n      case \"sse\":\n        return \"sse\";\n      case \"streamable-http\":\n        return \"streamable-http\";\n      case \"rpc\":\n        return \"rpc\";\n      default:\n        throw new Error(\n          \"Invalid transport type. McpAgent must be addressed with a valid protocol.\"\n        );\n    }\n  }\n\n  /** Read the sessionId for this agent.\n   * This relies on the naming scheme being `sse:${sessionId}`\n   * or `streamable-http:${sessionId}`.\n   */\n  getSessionId(): string {\n    const [_, sessionId] = this.name.split(\":\");\n    if (!sessionId) {\n      throw new Error(\n        \"Invalid session id. McpAgent must be addressed with a valid session id.\"\n      );\n    }\n    return sessionId;\n  }\n\n  /** Get the unique WebSocket. SSE transport only. */\n  getWebSocket() {\n    const websockets = Array.from(this.getConnections());\n    if (websockets.length === 0) {\n      return null;\n    }\n    return websockets[0];\n  }\n\n  /**\n   * Returns options for configuring the RPC server transport.\n   * Override this method to customize RPC transport behavior (e.g., timeout).\n   *\n   * @example\n   * ```typescript\n   * class MyMCP extends McpAgent {\n   *   protected getRpcTransportOptions() {\n   *     return { timeout: 120000 }; // 2 minutes\n   *   }\n   * }\n   * ```\n   */\n  protected getRpcTransportOptions(): RPCServerTransportOptions {\n    return {};\n  }\n\n  /** Returns a new transport matching the type of the Agent. */\n  private initTransport() {\n    switch (this.getTransportType()) {\n      case \"sse\": {\n        return new McpSSETransport();\n      }\n      case \"streamable-http\": {\n        const transport = new StreamableHTTPServerTransport({});\n        transport.messageInterceptor = (message) => {\n          return Promise.resolve(this._handleElicitationResponse(message));\n        };\n        return transport;\n      }\n      case \"rpc\": {\n        return new RPCServerTransport(this.getRpcTransportOptions());\n      }\n    }\n  }\n\n  /** Update and store the props */\n  async updateProps(props?: Props) {\n    await this.ctx.storage.put(\"props\", props ?? {});\n    this.props = props;\n  }\n\n  async reinitializeServer() {\n    // If the agent was previously initialized, we have to populate\n    // the server again by sending the initialize request to make\n    // client information available to the server.\n    const initializeRequest = await this.getInitializeRequest();\n    if (initializeRequest) {\n      this._transport?.onmessage?.(initializeRequest);\n    }\n  }\n\n  /*\n   * Base Agent / Partykit Server overrides\n   */\n\n  /** Sets up the MCP transport and server every time the Agent is started.*/\n  async onStart(props?: Props) {\n    if (props) {\n      // Fresh start with props — save to storage (also sets this.props)\n      await this.updateProps(props);\n    } else {\n      // Hibernation recovery — restore props from storage\n      this.props = await this.ctx.storage.get(\"props\");\n    }\n\n    await this.init();\n    const server = await this.server;\n    // Connect to the MCP server\n    this._transport = this.initTransport();\n\n    if (!this._transport) {\n      throw new Error(\"Failed to initialize transport\");\n    }\n    await server.connect(this._transport);\n\n    await this.reinitializeServer();\n  }\n\n  /** Validates new WebSocket connections. */\n  async onConnect(\n    conn: Connection,\n    { request: req }: ConnectionContext\n  ): Promise<void> {\n    switch (this.getTransportType()) {\n      case \"sse\": {\n        // For SSE connections, we can only have one open connection per session\n        // If we get an upgrade while already connected, we should error\n        const websockets = Array.from(this.getConnections());\n        if (websockets.length > 1) {\n          conn.close(1008, \"Websocket already connected\");\n          return;\n        }\n        break;\n      }\n      case \"streamable-http\":\n        if (this._transport instanceof StreamableHTTPServerTransport) {\n          switch (req.headers.get(MCP_HTTP_METHOD_HEADER)) {\n            case \"POST\": {\n              // This returns the response directly to the client\n              const payloadHeader = req.headers.get(MCP_MESSAGE_HEADER);\n              let rawPayload: string;\n\n              if (!payloadHeader) {\n                rawPayload = \"{}\";\n              } else {\n                try {\n                  rawPayload = Buffer.from(payloadHeader, \"base64\").toString(\n                    \"utf-8\"\n                  );\n                } catch (_error) {\n                  throw new Error(\n                    \"Internal Server Error: Failed to decode MCP message header\"\n                  );\n                }\n              }\n\n              const parsedBody = JSON.parse(rawPayload);\n              this._transport?.handlePostRequest(req, parsedBody);\n              break;\n            }\n            case \"GET\":\n              this._transport?.handleGetRequest(req);\n              break;\n          }\n        }\n    }\n  }\n\n  /*\n   * Transport ingress and routing\n   */\n\n  /** Handles MCP Messages for the legacy SSE transport. */\n  async onSSEMcpMessage(\n    _sessionId: string,\n    messageBody: unknown,\n    extraInfo?: MessageExtraInfo\n  ): Promise<Error | null> {\n    // Since we address the DO via both the protocol and the session id,\n    // this should never happen, but let's enforce it just in case\n    if (this.getTransportType() !== \"sse\") {\n      return new Error(\"Internal Server Error: Expected SSE transport\");\n    }\n\n    try {\n      let parsedMessage: JSONRPCMessage;\n      try {\n        parsedMessage = JSONRPCMessageSchema.parse(messageBody);\n      } catch (error) {\n        this._transport?.onerror?.(error as Error);\n        throw error;\n      }\n\n      // Check if this is an elicitation response before passing to transport\n      if (this._handleElicitationResponse(parsedMessage)) {\n        return null; // Message was handled by elicitation system\n      }\n\n      this._transport?.onmessage?.(parsedMessage, extraInfo);\n      return null;\n    } catch (error) {\n      console.error(\"Error forwarding message to SSE:\", error);\n      this._transport?.onerror?.(error as Error);\n      return error as Error;\n    }\n  }\n\n  /** Elicit user input with a message and schema */\n  async elicitInput(params: {\n    message: string;\n    requestedSchema: unknown;\n  }): Promise<ElicitResult> {\n    const requestId = `elicit_${Math.random().toString(36).substring(2, 11)}`;\n\n    const elicitRequest = {\n      jsonrpc: \"2.0\" as const,\n      id: requestId,\n      method: \"elicitation/create\",\n      params: {\n        message: params.message,\n        requestedSchema: params.requestedSchema\n      }\n    };\n\n    // Create a Promise that will be resolved when the response arrives.\n    // timeoutId is hoisted so error paths below can clear it and avoid\n    // an unhandled rejection on the orphaned responsePromise.\n    let timeoutId: ReturnType<typeof setTimeout>;\n    const responsePromise = new Promise<ElicitResult>((resolve, reject) => {\n      timeoutId = setTimeout(() => {\n        this._pendingElicitations.delete(requestId);\n        reject(new Error(\"Elicitation request timed out\"));\n      }, 60000);\n\n      this._pendingElicitations.set(requestId, {\n        resolve: (result: ElicitResult) => {\n          clearTimeout(timeoutId);\n          this._pendingElicitations.delete(requestId);\n          resolve(result);\n        },\n        reject: (err: Error) => {\n          clearTimeout(timeoutId);\n          this._pendingElicitations.delete(requestId);\n          reject(err);\n        }\n      });\n    });\n\n    const cleanup = () => {\n      clearTimeout(timeoutId);\n      this._pendingElicitations.delete(requestId);\n    };\n\n    // Keep the DO alive while we wait for the user's elicitation response.\n    // An unresolved Promise alone isn't enough to prevent hibernation.\n    return this.keepAliveWhile(async () => {\n      // Send through MCP transport\n      if (this._transport) {\n        try {\n          await this._transport.send(elicitRequest);\n        } catch (error) {\n          cleanup();\n          throw error;\n        }\n      } else {\n        const connections = this.getConnections();\n        if (!connections || Array.from(connections).length === 0) {\n          cleanup();\n          throw new Error(\"No active connections available for elicitation\");\n        }\n\n        const connectionList = Array.from(connections);\n        for (const connection of connectionList) {\n          try {\n            connection.send(JSON.stringify(elicitRequest));\n          } catch (error) {\n            console.error(\"Failed to send elicitation request:\", error);\n          }\n        }\n      }\n\n      return responsePromise;\n    });\n  }\n\n  /** Handle elicitation responses via in-memory resolver */\n  private _handleElicitationResponse(message: JSONRPCMessage): boolean {\n    if (isJSONRPCResultResponse(message) && message.result) {\n      const requestId = message.id?.toString();\n      if (!requestId || !requestId.startsWith(\"elicit_\")) return false;\n\n      const pending = this._pendingElicitations.get(requestId);\n      if (!pending) return false;\n\n      pending.resolve(message.result as ElicitResult);\n      return true;\n    }\n\n    if (isJSONRPCErrorResponse(message)) {\n      const requestId = message.id?.toString();\n      if (!requestId || !requestId.startsWith(\"elicit_\")) return false;\n\n      const pending = this._pendingElicitations.get(requestId);\n      if (!pending) return false;\n\n      pending.resolve({\n        action: \"cancel\",\n        content: {\n          error: message.error.message || \"Elicitation request failed\"\n        }\n      });\n      return true;\n    }\n\n    return false;\n  }\n\n  /**\n   * Handle an RPC message for MCP\n   * This method is called by the RPC stub to process MCP messages\n   * @param message The JSON-RPC message(s) to handle\n   * @returns The response message(s) or undefined\n   */\n  async handleMcpMessage(\n    message: JSONRPCMessage | JSONRPCMessage[]\n  ): Promise<JSONRPCMessage | JSONRPCMessage[] | undefined> {\n    if (!this._transport) {\n      this.props = await this.ctx.storage.get(\"props\");\n\n      await this.init();\n      const server = await this.server;\n\n      this._transport = this.initTransport();\n\n      if (!this._transport) {\n        throw new Error(\"Failed to initialize transport\");\n      }\n      await server.connect(this._transport);\n\n      await this.reinitializeServer();\n    }\n\n    if (!(this._transport instanceof RPCServerTransport)) {\n      throw new Error(\"Expected RPC transport\");\n    }\n\n    return await this._transport.handle(message);\n  }\n\n  /** Return a handler for the given path for this MCP.\n   * Defaults to Streamable HTTP transport.\n   */\n  static serve(\n    path: string,\n    {\n      binding = \"MCP_OBJECT\",\n      corsOptions,\n      transport = \"streamable-http\",\n      jurisdiction\n    }: ServeOptions = {}\n  ) {\n    return {\n      async fetch<Env>(\n        this: void,\n        request: Request,\n        env: Env,\n        ctx: ExecutionContext\n      ): Promise<Response> {\n        // Handle CORS preflight\n        const corsResponse = handleCORS(request, corsOptions);\n        if (corsResponse) {\n          return corsResponse;\n        }\n\n        const bindingValue = env[binding as keyof typeof env] as unknown;\n\n        // Ensure we have a binding of some sort\n        if (bindingValue == null || typeof bindingValue !== \"object\") {\n          throw new Error(\n            `Could not find McpAgent binding for ${binding}. Did you update your wrangler configuration?`\n          );\n        }\n\n        // Ensure that the binding is to a DurableObject\n        if (!isDurableObjectNamespace(bindingValue)) {\n          throw new Error(\n            `Invalid McpAgent binding for ${binding}. Make sure it's a Durable Object binding.`\n          );\n        }\n\n        const namespace =\n          bindingValue satisfies DurableObjectNamespace<McpAgent>;\n\n        switch (transport) {\n          case \"streamable-http\": {\n            // Streamable HTTP transport handling\n            const handleStreamableHttp = createStreamingHttpHandler(\n              path,\n              namespace,\n              { corsOptions, jurisdiction }\n            );\n            return handleStreamableHttp(request, ctx);\n          }\n          case \"sse\": {\n            // Legacy SSE transport handling\n            const handleLegacySse = createLegacySseHandler(path, namespace, {\n              corsOptions,\n              jurisdiction\n            });\n            return handleLegacySse(request, ctx);\n          }\n          default:\n            return new Response(\n              \"Invalid MCP transport mode. Only `streamable-http` or `sse` are allowed.\",\n              { status: 500 }\n            );\n        }\n      }\n    };\n  }\n  /**\n   * Legacy api\n   **/\n  static mount(path: string, opts: Omit<ServeOptions, \"transport\"> = {}) {\n    return McpAgent.serveSSE(path, opts);\n  }\n\n  static serveSSE(path: string, opts: Omit<ServeOptions, \"transport\"> = {}) {\n    return McpAgent.serve(path, { ...opts, transport: \"sse\" });\n  }\n}\n\nexport {\n  SSEEdgeClientTransport,\n  StreamableHTTPEdgeClientTransport\n} from \"./client-transports\";\nexport {\n  RPC_DO_PREFIX,\n  RPCClientTransport,\n  RPCServerTransport,\n  type RPCClientTransportOptions,\n  type RPCServerTransportOptions\n} from \"./rpc\";\n\nexport {\n  ElicitRequestSchema,\n  type ElicitRequest,\n  type ElicitResult\n} from \"@modelcontextprotocol/sdk/types.js\";\n\nexport type {\n  MCPClientOAuthResult,\n  MCPClientOAuthCallbackConfig,\n  MCPServerOptions,\n  MCPConnectionResult,\n  MCPDiscoverResult\n} from \"./client\";\n\nexport type { McpClientOptions } from \"./types\";\n\nexport {\n  createMcpHandler,\n  experimental_createMcpHandler,\n  type CreateMcpHandlerOptions\n} from \"./handler\";\n\nexport { getMcpAuthContext, type McpAuthContext } from \"./auth-context\";\n\nexport {\n  WorkerTransport,\n  type WorkerTransportOptions,\n  type TransportState\n} from \"./worker-transport\";\n"],"mappings":"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"}
node_modules/agents/dist/workflows.d.ts:31: * @template Params - User-defined params passed to the workflow (optional)
node_modules/agents/dist/workflows.d.ts:126:   * await this.reportProgress({ stage: 'extract', recordsProcessed: 100 });
node_modules/agents/dist/workflows.js:26:*       return { processed: true };
node_modules/agents/dist/workflows.js:49:* @template Params - User-defined params passed to the workflow (optional)
node_modules/agents/dist/workflows.js:231:	* await this.reportProgress({ stage: 'extract', recordsProcessed: 100 });
node_modules/agents/dist/mcp/index.js:5:import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
node_modules/agents/dist/mcp/index.js:6:import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
node_modules/agents/dist/mcp/index.js:33:				if (!acceptHeader?.includes("application/json") || !acceptHeader.includes("text/event-stream")) {
node_modules/agents/dist/mcp/index.js:37:							message: "Not Acceptable: Client must accept both application/json and text/event-stream"
node_modules/agents/dist/mcp/index.js:67:				let sessionId = request.headers.get("mcp-session-id");
node_modules/agents/dist/mcp/index.js:133:				const agent = await getAgentByName(namespace, `streamable-http:${sessionId}`, {
node_modules/agents/dist/mcp/index.js:161:					Upgrade: "websocket"
node_modules/agents/dist/mcp/index.js:210:						headers: corsHeaders(request, options.corsOptions),
node_modules/agents/dist/mcp/index.js:218:						"Content-Type": "text/event-stream",
node_modules/agents/dist/mcp/index.js:219:						"mcp-session-id": sessionId,
node_modules/agents/dist/mcp/index.js:220:						...corsHeaders(request, options.corsOptions)
node_modules/agents/dist/mcp/index.js:225:				if (!request.headers.get("accept")?.includes("text/event-stream")) {
node_modules/agents/dist/mcp/index.js:230:							message: "Not Acceptable: Client must accept text/event-stream"
exec
/usr/bin/zsh -lc "nl -ba node_modules/agents/dist/mcp/index.d.ts | sed -n '1,260p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import { $ as experimental_createMcpHandler, F as MCPClientOAuthResult, G as RPCServerTransportOptions, H as RPCClientTransport, I as MCPConnectionResult, J as ElicitRequestSchema, K as RPC_DO_PREFIX, L as MCPDiscoverResult, P as MCPClientOAuthCallbackConfig, Q as createMcpHandler, U as RPCClientTransportOptions, W as RPCServerTransport, X as McpAgent, Y as ElicitResult, Z as CreateMcpHandlerOptions, at as SSEEdgeClientTransport, et as McpAuthContext, it as WorkerTransportOptions, nt as TransportState, ot as StreamableHTTPEdgeClientTransport, q as ElicitRequest, rt as WorkerTransport, st as McpClientOptions, tt as getMcpAuthContext, z as MCPServerOptions } from "../index-B6xYRT3K.js";
     2	export { CreateMcpHandlerOptions, ElicitRequest, ElicitRequestSchema, ElicitResult, MCPClientOAuthCallbackConfig, MCPClientOAuthResult, MCPConnectionResult, MCPDiscoverResult, MCPServerOptions, McpAgent, McpAuthContext, McpClientOptions, RPCClientTransport, RPCClientTransportOptions, RPCServerTransport, RPCServerTransportOptions, RPC_DO_PREFIX, SSEEdgeClientTransport, StreamableHTTPEdgeClientTransport, TransportState, WorkerTransport, WorkerTransportOptions, createMcpHandler, experimental_createMcpHandler, getMcpAuthContext };
exec
/usr/bin/zsh -lc "nl -ba node_modules/agents/dist/index.d.ts | sed -n '1,260p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import { r as __DO_NOT_USE_WILL_BREAK__agentContext } from "./internal_context-DgcmHqS1.js";
     2	import { l as createHeaderBasedEmailResolver } from "./email-U_MG7UET.js";
     3	import { t as RetryOptions } from "./retries-DXMQGhG3.js";
     4	import {
     5	  A as routeAgentRequest,
     6	  C as SubAgentClass,
     7	  D as getAgentByName,
     8	  E as callable,
     9	  O as getCurrentAgent,
    10	  S as StreamingResponse,
    11	  T as WSMessage,
    12	  _ as RPCRequest,
    13	  a as AgentNamespace,
    14	  b as SqlError,
    15	  c as CallableMetadata,
    16	  ct as TransportType,
    17	  d as DEFAULT_AGENT_STATIC_OPTIONS,
    18	  f as EmailRoutingOptions,
    19	  g as QueueItem,
    20	  h as MCPServersState,
exec
/usr/bin/zsh -lc "nl -ba node_modules/agents/dist/index.js | sed -n '1,360p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import { MessageType } from "./types.js";
     2	import { camelCaseToKebabCase } from "./utils.js";
     3	import { createHeaderBasedEmailResolver, signAgentHeaders } from "./email.js";
     4	import { __DO_NOT_USE_WILL_BREAK__agentContext } from "./internal_context.js";
     5	import { isErrorRetryable, tryN, validateRetryOptions } from "./retries.js";
     6	import { o as RPC_DO_PREFIX, r as MCPConnectionState, s as DisposableStore, t as MCPClientManager } from "./client-K8Z-u76l.js";
     7	import { DurableObjectOAuthClientProvider } from "./mcp/do-oauth-client-provider.js";
     8	import { genericObservability } from "./observability/index.js";
     9	import { parseCronExpression } from "cron-schedule";
    10	import { nanoid } from "nanoid";
    11	import { EmailMessage } from "cloudflare:email";
    12	import { Server, getServerByName, routePartykitRequest } from "partyserver";
    13	//#region src/index.ts
    14	/**
    15	* Type guard for RPC request messages
    16	*/
    17	function isRPCRequest(msg) {
    18		return typeof msg === "object" && msg !== null && "type" in msg && msg.type === MessageType.RPC && "id" in msg && typeof msg.id === "string" && "method" in msg && typeof msg.method === "string" && "args" in msg && Array.isArray(msg.args);
    19	}
    20	/**
exec
/usr/bin/zsh -lc "nl -ba node_modules/agents/dist/mcp/index.js | sed -n '1,340p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import { MessageType } from "../types.js";
     2	import { a as RPCServerTransport, i as RPCClientTransport, o as RPC_DO_PREFIX } from "../client-K8Z-u76l.js";
     3	import { Agent, getAgentByName, getCurrentAgent } from "../index.js";
     4	import { AsyncLocalStorage } from "node:async_hooks";
     5	import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
     6	import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
     7	import { ElicitRequestSchema, InitializeRequestSchema, JSONRPCMessageSchema, SUPPORTED_PROTOCOL_VERSIONS, isInitializeRequest, isJSONRPCErrorResponse, isJSONRPCNotification, isJSONRPCRequest, isJSONRPCResultResponse } from "@modelcontextprotocol/sdk/types.js";
     8	import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
     9	//#region src/mcp/utils.ts
    10	/**
    11	* Since we use WebSockets to bridge the client to the
    12	* MCP transport in the Agent, we use this header to signal
    13	* the method of the original request the user made, while
    14	* leaving the WS Upgrade request as GET.
    15	*/
    16	const MCP_HTTP_METHOD_HEADER = "cf-mcp-method";
    17	/**
    18	* Since we use WebSockets to bridge the client to the
    19	* MCP transport in the Agent, we use this header to include
    20	* the original request body.
exec
/usr/bin/zsh -lc "nl -ba node_modules/agents/dist/mcp/index.js | sed -n '700,1120p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
   700			this.requestResponseMap = /* @__PURE__ */ new Map();
   701			this.stateRestored = false;
   702			this.sessionIdGenerator = options?.sessionIdGenerator;
   703			this.enableJsonResponse = options?.enableJsonResponse ?? false;
   704			this.onsessioninitialized = options?.onsessioninitialized;
   705			this.onsessionclosed = options?.onsessionclosed;
   706			this.corsOptions = options?.corsOptions;
   707			this.storage = options?.storage;
   708			this.eventStore = options?.eventStore;
   709			this.retryInterval = options?.retryInterval;
   710		}
   711		/**
   712		* Restore transport state from persistent storage.
   713		* This is automatically called on start.
   714		*/
   715		async restoreState() {
   716			if (!this.storage || this.stateRestored) return;
   717			const state = await Promise.resolve(this.storage.get());
   718			if (state) {
   719				this.sessionId = state.sessionId;
exec
/usr/bin/zsh -lc "nl -ba node_modules/agents/dist/mcp/index.js | sed -n '1120,1565p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
  1120					"Content-Type": "application/json",
  1121					...this.getHeaders()
  1122				}
  1123			});
  1124			if (sessionId !== this.sessionId) return new Response(JSON.stringify({
  1125				jsonrpc: "2.0",
  1126				error: {
  1127					code: -32001,
  1128					message: "Session not found"
  1129				},
  1130				id: null
  1131			}), {
  1132				status: 404,
  1133				headers: {
  1134					"Content-Type": "application/json",
  1135					...this.getHeaders()
  1136				}
  1137			});
  1138		}
  1139		async close() {
exec
/usr/bin/zsh -lc "nl -ba node_modules/agents/dist/index-B6xYRT3K.d.ts | sed -n '120,380p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
   120	}
   121	interface TransportState {
   122	  sessionId?: string;
   123	  initialized: boolean;
   124	  initializeParams?: InitializeRequestParams;
   125	}
   126	interface WorkerTransportOptions {
   127	  /**
   128	   * Function that generates a session ID for the transport.
   129	   * The session ID SHOULD be globally unique and cryptographically secure.
   130	   * Return undefined to disable session management (stateless mode).
   131	   */
   132	  sessionIdGenerator?: () => string;
   133	  /**
   134	   * Enable traditional Request/Response mode, this will disable streaming.
   135	   */
   136	  enableJsonResponse?: boolean;
   137	  /**
   138	   * Callback fired when a new session is initialized.
   139	   */
exec
/usr/bin/zsh -lc "nl -ba node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts | sed -n '1,260p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import { Server, ServerOptions } from './index.js';
     2	import { AnySchema, AnyObjectSchema, ZodRawShapeCompat, SchemaOutput, ShapeOutput } from './zod-compat.js';
     3	import { Implementation, CallToolResult, Resource, ListResourcesResult, GetPromptResult, ReadResourceResult, ServerRequest, ServerNotification, ToolAnnotations, LoggingMessageNotification, Result, ToolExecution } from '../types.js';
     4	import { UriTemplate, Variables } from '../shared/uriTemplate.js';
     5	import { RequestHandlerExtra } from '../shared/protocol.js';
     6	import { Transport } from '../shared/transport.js';
     7	import { ExperimentalMcpServerTasks } from '../experimental/tasks/mcp-server.js';
     8	import type { ToolTaskHandler } from '../experimental/tasks/interfaces.js';
     9	/**
    10	 * High-level MCP server that provides a simpler API for working with resources, tools, and prompts.
    11	 * For advanced usage (like sending notifications or setting custom request handlers), use the underlying
    12	 * Server instance available via the `server` property.
    13	 */
    14	export declare class McpServer {
    15	    /**
    16	     * The underlying Server instance, useful for advanced operations like sending notifications.
    17	     */
    18	    readonly server: Server;
    19	    private _registeredResources;
    20	    private _registeredResourceTemplates;
exec
/usr/bin/zsh -lc "rg -n \"registerTool|registerResource|class McpServer|connect\\(|listChanged|StreamableHTTPServerTransport|text/event-stream|event: message|Last-Event-ID|retry:|ping|mcp-session-id\" node_modules/@modelcontextprotocol/sdk/dist/esm/server node_modules/@modelcontextprotocol/sdk/dist/esm/client | sed -n '1,260p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
node_modules/@modelcontextprotocol/sdk/dist/esm/server/express.d.ts.map:1:{"version":3,"file":"express.d.ts","sourceRoot":"","sources":["../../../src/server/express.ts"],"names":[],"mappings":"AAAA,OAAgB,EAAE,OAAO,EAAE,MAAM,SAAS,CAAC;AAG3C;;GAEG;AACH,MAAM,WAAW,0BAA0B;IACvC;;;OAGG;IACH,IAAI,CAAC,EAAE,MAAM,CAAC;IAEd;;;;;;;OAOG;IACH,YAAY,CAAC,EAAE,MAAM,EAAE,CAAC;CAC3B;AAED;;;;;;;;;;;;;;;;;;;;;;GAsBG;AACH,wBAAgB,mBAAmB,CAAC,OAAO,GAAE,0BAA+B,GAAG,OAAO,CA0BrF"}
node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.d.ts.map:1:{"version":3,"file":"stdio.d.ts","sourceRoot":"","sources":["../../../src/server/stdio.ts"],"names":[],"mappings":"AACA,OAAO,EAAE,QAAQ,EAAE,QAAQ,EAAE,MAAM,aAAa,CAAC;AAEjD,OAAO,EAAE,cAAc,EAAE,MAAM,aAAa,CAAC;AAC7C,OAAO,EAAE,SAAS,EAAE,MAAM,wBAAwB,CAAC;AAEnD;;;;GAIG;AACH,qBAAa,oBAAqB,YAAW,SAAS;IAK9C,OAAO,CAAC,MAAM;IACd,OAAO,CAAC,OAAO;IALnB,OAAO,CAAC,WAAW,CAAgC;IACnD,OAAO,CAAC,QAAQ,CAAS;gBAGb,MAAM,GAAE,QAAwB,EAChC,OAAO,GAAE,QAAyB;IAG9C,OAAO,CAAC,EAAE,MAAM,IAAI,CAAC;IACrB,OAAO,CAAC,EAAE,CAAC,KAAK,EAAE,KAAK,KAAK,IAAI,CAAC;IACjC,SAAS,CAAC,EAAE,CAAC,OAAO,EAAE,cAAc,KAAK,IAAI,CAAC;IAG9C,OAAO,UAAW,MAAM,UAGtB;IACF,QAAQ,UAAW,KAAK,UAEtB;IAEF;;OAEG;IACG,KAAK,IAAI,OAAO,CAAC,IAAI,CAAC;IAY5B,OAAO,CAAC,iBAAiB;IAenB,KAAK,IAAI,OAAO,CAAC,IAAI,CAAC;IAkB5B,IAAI,CAAC,OAAO,EAAE,cAAc,GAAG,OAAO,CAAC,IAAI,CAAC;CAU/C"}
node_modules/@modelcontextprotocol/sdk/dist/esm/server/sse.js.map:1:{"version":3,"file":"sse.js","sourceRoot":"","sources":["../../../src/server/sse.ts"],"names":[],"mappings":"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"}
node_modules/@modelcontextprotocol/sdk/dist/esm/server/zod-json-schema-compat.js:51://# sourceMappingURL=zod-json-schema-compat.js.map
node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js.map:1:{"version":3,"file":"streamableHttp.js","sourceRoot":"","sources":["../../../src/server/streamableHttp.ts"],"names":[],"mappings":"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"}
node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.d.ts.map:1:{"version":3,"file":"index.d.ts","sourceRoot":"","sources":["../../../src/server/index.ts"],"names":[],"mappings":"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"}
node_modules/@modelcontextprotocol/sdk/dist/esm/server/completable.js:41://# sourceMappingURL=completable.js.map
node_modules/@modelcontextprotocol/sdk/dist/esm/server/completable.js.map:1:{"version":3,"file":"completable.js","sourceRoot":"","sources":["../../../src/server/completable.ts"],"names":[],"mappings":"AAEA,MAAM,CAAC,MAAM,kBAAkB,GAAkB,MAAM,CAAC,GAAG,CAAC,iBAAiB,CAAC,CAAC;AAiB/E;;;GAGG;AACH,MAAM,UAAU,WAAW,CAAsB,MAAS,EAAE,QAA6B;IACrF,MAAM,CAAC,cAAc,CAAC,MAAgB,EAAE,kBAAkB,EAAE;QACxD,KAAK,EAAE,EAAE,QAAQ,EAAwB;QACzC,UAAU,EAAE,KAAK;QACjB,QAAQ,EAAE,KAAK;QACf,YAAY,EAAE,KAAK;KACtB,CAAC,CAAC;IACH,OAAO,MAA8B,CAAC;AAC1C,CAAC;AAED;;GAEG;AACH,MAAM,UAAU,aAAa,CAAC,MAAe;IACzC,OAAO,CAAC,CAAC,MAAM,IAAI,OAAO,MAAM,KAAK,QAAQ,IAAI,kBAAkB,IAAK,MAAiB,CAAC;AAC9F,CAAC;AAED;;GAEG;AACH,MAAM,UAAU,YAAY,CAAsB,MAAS;IACvD,MAAM,IAAI,GAAI,MAAmE,CAAC,kBAAkB,CAAC,CAAC;IACtG,OAAO,IAAI,EAAE,QAA2C,CAAC;AAC7D,CAAC;AAED;;;GAGG;AACH,MAAM,UAAU,iBAAiB,CAAsB,MAA4B;IAC/E,OAAO,MAAM,CAAC;AAClB,CAAC;AAED,4CAA4C;AAC5C,wDAAwD;AACxD,MAAM,CAAN,IAAY,cAEX;AAFD,WAAY,cAAc;IACtB,gDAA8B,CAAA;AAClC,CAAC,EAFW,cAAc,KAAd,cAAc,QAEzB"}
node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js.map:1:{"version":3,"file":"index.js","sourceRoot":"","sources":["../../../src/server/index.ts"],"names":[],"mappings":"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"}
node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts.map:1:{"version":3,"file":"mcp.d.ts","sourceRoot":"","sources":["../../../src/server/mcp.ts"],"names":[],"mappings":"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"}
node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js:7: * For Node.js Express/HTTP compatibility, use `StreamableHTTPServerTransport` which wraps this transport.
node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js:20: * const statefulTransport = new WebStandardStreamableHTTPServerTransport({
node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js:25: * const statelessTransport = new WebStandardStreamableHTTPServerTransport({
node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js:53:export class WebStandardStreamableHTTPServerTransport {
node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js:57:        this._streamMapping = new Map();
node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js:58:        this._requestToStreamMapping = new Map();
node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js:177:            primingEvent = `id: ${primingEventId}\nretry: ${this._retryInterval}\ndata: \n\n`;
node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js:185:        // The client MUST include an Accept header, listing text/event-stream as a supported content type.
node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js:187:        if (!acceptHeader?.includes('text/event-stream')) {
node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js:188:            this.onerror?.(new Error('Not Acceptable: Client must accept text/event-stream'));
exec
/usr/bin/zsh -lc "nl -ba node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js | sed -n '1,360p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	/**
     2	 * Web Standards Streamable HTTP Server Transport
     3	 *
     4	 * This is the core transport implementation using Web Standard APIs (Request, Response, ReadableStream).
     5	 * It can run on any runtime that supports Web Standards: Node.js 18+, Cloudflare Workers, Deno, Bun, etc.
     6	 *
     7	 * For Node.js Express/HTTP compatibility, use `StreamableHTTPServerTransport` which wraps this transport.
     8	 */
     9	import { isInitializeRequest, isJSONRPCErrorResponse, isJSONRPCRequest, isJSONRPCResultResponse, JSONRPCMessageSchema, SUPPORTED_PROTOCOL_VERSIONS, DEFAULT_NEGOTIATED_PROTOCOL_VERSION } from '../types.js';
    10	/**
    11	 * Server transport for Web Standards Streamable HTTP: this implements the MCP Streamable HTTP transport specification
    12	 * using Web Standard APIs (Request, Response, ReadableStream).
    13	 *
    14	 * This transport works on any runtime that supports Web Standards: Node.js 18+, Cloudflare Workers, Deno, Bun, etc.
    15	 *
    16	 * Usage example:
    17	 *
    18	 * ```typescript
    19	 * // Stateful mode - server sets the session ID
    20	 * const statefulTransport = new WebStandardStreamableHTTPServerTransport({
exec
/usr/bin/zsh -lc "nl -ba node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js | sed -n '1,360p'" in /home/cjangrist/dev/omnisearchexec
/usr/bin/zsh -lc "nl -ba node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js | sed -n '1,360p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	/**
     2	 * Node.js HTTP Streamable HTTP Server Transport
     3	 *
     4	 * This is a thin wrapper around `WebStandardStreamableHTTPServerTransport` that provides
     5	 * compatibility with Node.js HTTP server (IncomingMessage/ServerResponse).
     6	 *
     7	 * For web-standard environments (Cloudflare Workers, Deno, Bun), use `WebStandardStreamableHTTPServerTransport` directly.
     8	 */
     9	import { getRequestListener } from '@hono/node-server';
    10	import { WebStandardStreamableHTTPServerTransport } from './webStandardStreamableHttp.js';
    11	/**
    12	 * Server transport for Streamable HTTP: this implements the MCP Streamable HTTP transport specification.
    13	 * It supports both SSE streaming and direct HTTP responses.
    14	 *
    15	 * This is a wrapper around `WebStandardStreamableHTTPServerTransport` that provides Node.js HTTP compatibility.
    16	 * It uses the `@hono/node-server` library to convert between Node.js HTTP and Web Standard APIs.
    17	 *
    18	 * Usage example:
    19	 *
    20	 * ```typescript
 succeeded in 0ms:
     1	import { Server } from './index.js';
     2	import { normalizeObjectSchema, safeParseAsync, getObjectShape, objectFromShape, getParseErrorMessage, getSchemaDescription, isSchemaOptional, getLiteralValue } from './zod-compat.js';
     3	import { toJsonSchemaCompat } from './zod-json-schema-compat.js';
     4	import { McpError, ErrorCode, ListResourceTemplatesRequestSchema, ReadResourceRequestSchema, ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema, CompleteRequestSchema, assertCompleteRequestPrompt, assertCompleteRequestResourceTemplate } from '../types.js';
     5	import { isCompletable, getCompleter } from './completable.js';
     6	import { UriTemplate } from '../shared/uriTemplate.js';
     7	import { validateAndWarnToolName } from '../shared/toolNameValidation.js';
     8	import { ExperimentalMcpServerTasks } from '../experimental/tasks/mcp-server.js';
     9	import { ZodOptional } from 'zod';
    10	/**
    11	 * High-level MCP server that provides a simpler API for working with resources, tools, and prompts.
    12	 * For advanced usage (like sending notifications or setting custom request handlers), use the underlying
    13	 * Server instance available via the `server` property.
    14	 */
    15	export class McpServer {
    16	    constructor(serverInfo, options) {
    17	        this._registeredResources = {};
    18	        this._registeredResourceTemplates = {};
    19	        this._registeredTools = {};
    20	        this._registeredPrompts = {};
exec
/usr/bin/zsh -lc "nl -ba node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js | sed -n '360,760p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
   360	            },
   361	            id: null
   362	        }), {
   363	            status: 405,
   364	            headers: {
   365	                Allow: 'GET, POST, DELETE',
   366	                'Content-Type': 'application/json'
   367	            }
   368	        });
   369	    }
   370	    /**
   371	     * Handles POST requests containing JSON-RPC messages
   372	     */
   373	    async handlePostRequest(req, options) {
   374	        try {
   375	            // Validate the Accept header
   376	            const acceptHeader = req.headers.get('accept');
   377	            // The client MUST include an Accept header, listing both application/json and text/event-stream as supported content types.
   378	            if (!acceptHeader?.includes('application/json') || !acceptHeader.includes('text/event-stream')) {
   379	                this.onerror?.(new Error('Not Acceptable: Client must accept both application/json and text/event-stream'));
exec
/usr/bin/zsh -lc "nl -ba node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js | sed -n '1,360p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	import { createFetchWithInit, normalizeHeaders } from '../shared/transport.js';
     2	import { isInitializedNotification, isJSONRPCRequest, isJSONRPCResultResponse, JSONRPCMessageSchema } from '../types.js';
     3	import { auth, extractWWWAuthenticateParams, UnauthorizedError } from './auth.js';
     4	import { EventSourceParserStream } from 'eventsource-parser/stream';
     5	// Default reconnection options for StreamableHTTP connections
     6	const DEFAULT_STREAMABLE_HTTP_RECONNECTION_OPTIONS = {
     7	    initialReconnectionDelay: 1000,
     8	    maxReconnectionDelay: 30000,
     9	    reconnectionDelayGrowFactor: 1.5,
    10	    maxRetries: 2
    11	};
    12	export class StreamableHTTPError extends Error {
    13	    constructor(code, message) {
    14	        super(`Streamable HTTP error: ${message}`);
    15	        this.code = code;
    16	    }
    17	}
    18	/**
    19	 * Client transport for Streamable HTTP: this implements the MCP Streamable HTTP transport specification.
    20	 * It will connect to a server using HTTP POST for sending messages and HTTP GET with Server-Sent Events
exec
/usr/bin/zsh -lc "nl -ba node_modules/@modelcontextprotocol/sdk/README.md | sed -n '1,280p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	# MCP TypeScript SDK [![NPM Version](https://img.shields.io/npm/v/%40modelcontextprotocol%2Fsdk)](https://www.npmjs.com/package/@modelcontextprotocol/sdk) [![MIT licensed](https://img.shields.io/npm/l/%40modelcontextprotocol%2Fsdk)](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/LICENSE)
     2	
     3	<details>
     4	<summary>Table of Contents</summary>
     5	
     6	- [Overview](#overview)
     7	- [Installation](#installation)
     8	- [Quick Start](#quick-start)
     9	- [Core Concepts](#core-concepts)
    10	- [Examples](#examples)
    11	- [Documentation](#documentation)
    12	- [Contributing](#contributing)
    13	- [License](#license)
    14	
    15	</details>
    16	
    17	## Overview
    18	
    19	The Model Context Protocol allows applications to provide context for LLMs in a standardized way, separating the concerns of providing context from the actual LLM interaction. This TypeScript SDK implements
    20	[the full MCP specification](https://modelcontextprotocol.io/specification/draft), making it easy to:
exec
/usr/bin/zsh -lc 'rg -n "streamable http|Streamable HTTP|SSE|text/event-stream|Last-Event-ID|mcp-session-id|WebStandardStreamableHTTPServerTransport" node_modules/@modelcontextprotocol/sdk/README.md' in /home/cjangrist/dev/omnisearch succeeded in 0ms:
24:- Use standard transports like stdio and Streamable HTTP
44:2. **Run the example Streamable HTTP server**:
56:This pair of examples demonstrates tools, resources, prompts, sampling, elicitation, tasks and logging. For a guided walkthrough and variations (stateless servers, JSON-only responses, SSE compatibility, OAuth, etc.), see [docs/server.md](docs/server.md) and
63:An MCP server is typically created with `McpServer` and connected to a transport such as Streamable HTTP or stdio. The SDK supports:
65:- **Streamable HTTP** for remote servers (recommended).
66:- **HTTP + SSE** for backwards compatibility only.
104:- Interactive Streamable HTTP client ([`simpleStreamableHttp.ts`](src/examples/client/simpleStreamableHttp.ts))
105:- Streamable HTTP client with SSE fallback ([`streamableHttpWithSseFallbackClient.ts`](src/examples/client/streamableHttpWithSseFallbackClient.ts))
122:| Streamable HTTP server (stateful)                   | Feature-rich server with tools, resources, prompts, logging, tasks, sampling, and optional OAuth. | [`simpleStreamableHttp.ts`](src/examples/server/simpleStreamableHttp.ts)                                 | [`server.md`](docs/server.md), [`capabilities.md`](docs/capabilities.md) |
123:| Streamable HTTP server (stateless)                  | No session tracking; good for simple API-style servers.                                           | [`simpleStatelessStreamableHttp.ts`](src/examples/server/simpleStatelessStreamableHttp.ts)               | [`server.md`](docs/server.md)                                            |
124:| JSON response mode (no SSE)                         | Streamable HTTP with JSON responses only and limited notifications.                               | [`jsonResponseStreamableHttp.ts`](src/examples/server/jsonResponseStreamableHttp.ts)                     | [`server.md`](docs/server.md)                                            |
125:| Server notifications over Streamable HTTP           | Demonstrates server-initiated notifications using SSE with Streamable HTTP.                       | [`standaloneSseWithGetStreamableHttp.ts`](src/examples/server/standaloneSseWithGetStreamableHttp.ts)     | [`server.md`](docs/server.md)                                            |
126:| Deprecated HTTP+SSE server                          | Legacy HTTP+SSE transport for backwards-compatibility testing.                                    | [`simpleSseServer.ts`](src/examples/server/simpleSseServer.ts)                                           | [`server.md`](docs/server.md)                                            |
127:| Backwards-compatible server (Streamable HTTP + SSE) | Single server that supports both Streamable HTTP and legacy SSE clients.                          | [`sseAndStreamableHttpCompatibleServer.ts`](src/examples/server/sseAndStreamableHttpCompatibleServer.ts) | [`server.md`](docs/server.md)                                            |
137:| Interactive Streamable HTTP client                  | CLI client that exercises tools, resources, prompts, elicitation, and tasks.       | [`simpleStreamableHttp.ts`](src/examples/client/simpleStreamableHttp.ts)                                                                                                                                                               | [`client.md`](docs/client.md)                                |
138:| Backwards-compatible client (Streamable HTTP → SSE) | Tries Streamable HTTP first, then falls back to SSE on 4xx responses.              | [`streamableHttpWithSseFallbackClient.ts`](src/examples/client/streamableHttpWithSseFallbackClient.ts)                                                                                                                                 | [`client.md`](docs/client.md), [`server.md`](docs/server.md) |
139:| SSE polling client                                  | Polls a legacy SSE server and demonstrates notification handling.                  | [`ssePollingClient.ts`](src/examples/client/ssePollingClient.ts)                                                                                                                                                                       | [`client.md`](docs/client.md)                                |
exec
/usr/bin/zsh -lc 'npm view @modelcontextprotocol/sdk version repository.url homepage description' in /home/cjangrist/dev/omnisearchexec
/usr/bin/zsh -lc 'npm view agents version repository.url homepage description' in /home/cjangrist/dev/omnisearch succeeded in 335ms:
version = '1.27.1'
repository.url = 'git+https://github.com/modelcontextprotocol/typescript-sdk.git'
homepage = 'https://modelcontextprotocol.io'
description = 'Model Context Protocol implementation for TypeScript'
 succeeded in 338ms:
version = '0.7.9'
repository.url = 'git+https://github.com/cloudflare/agents.git'
homepage = 'https://github.com/cloudflare/agents#readme'
description = 'A home for your AI agents'
Plan update
Top-level code, utilities, provider implementations, and dependency internals are now covered. I’m validating the remaining assumptions against external specs/docs before writing the final review.
  ✓ Map repository structure and identify all files/import chains relevant to the MCP worker, tools, orchestrators, providers, and transports
  ✓ Read required project files and dependency type definitions in full; inspect provider implementations and call paths
  → Research external docs for agents, MCP SDK, Durable Objects lifecycle, SSE comments/keepalive, and CF stream behavior
  • Synthesize findings by severity with exact file/line references and concrete fixes
🌐 Searching the web...
🌐 Searched: Cloudflare Durable Objects lifecycle instance may be evicted in-memory state reused docs init on start hibernation websocket
🌐 Searching the web...
🌐 Searched: site:github.com/cloudflare/agents McpAgent serve Cloudflare agents README mcp
🌐 Searching the web...
🌐 Searched: site:html.spec.whatwg.org server-sent events comment line colon comment keep-alive
🌐 Searching the web...
🌐 Searched: site:html.spec.whatwg.org multipage server-sent-events comment lines starting with colon
🌐 Searching the web...
🌐 Searched: https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
codex
I have enough structural context to start validating behavior mechanically. I’m running the repo’s own typecheck now and checking a couple of supporting files that influence the stream wrapper and deployment assumptions.
exec
/usr/bin/zsh -lc "nl -ba tsconfig.json | sed -n '1,200p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	{
     2		"compilerOptions": {
     3			"target": "ES2022",
     4			"module": "ES2022",
     5			"moduleResolution": "bundler",
     6			"lib": ["ES2022"],
     7			"types": ["@cloudflare/workers-types"],
     8			"strict": true,
     9			"outDir": "dist",
    10			"rootDir": "src",
    11			"skipLibCheck": true,
    12			"forceConsistentCasingInFileNames": true,
    13			"resolveJsonModule": true,
    14			"isolatedModules": true,
    15			"noEmit": true
    16		},
    17		"include": ["src/**/*"],
    18		"exclude": ["node_modules", "dist", "tmp"]
    19	}
exec
/usr/bin/zsh -lc 'git status --short' in /home/cjangrist/dev/omnisearch succeeded in 0ms:
?? test_stream.js
exec
/usr/bin/zsh -lc "nl -ba test_stream.js | sed -n '1,220p'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
     1	const { TransformStream } = require('node:stream/web');
     2	const { readable, writable } = new TransformStream();
     3	const writer = writable.getWriter();
     4	writer.write('a');
     5	writer.write('b');
exec
/usr/bin/zsh -lc 'npm run typecheck' in /home/cjangrist/dev/omnisearch succeeded in 1.58s:

🌐 Searching the web...
🌐 Searched: site:developers.cloudflare.com durable objects lifecycle constructor in-memory state may be reset docs
🌐 Searching the web...
🌐 Searched: whatwg server-sent events authoring notes legacy proxy servers comment line every 15 seconds
🌐 Searching the web...
🌐 Searched: https://html.spec.whatwg.org/dev/server-sent-events.html
exec
/usr/bin/zsh -lc 'npm view agents versions --json' in /home/cjangrist/dev/omnisearch succeeded in 224ms:
[
  "0.0.0-35951",
  "0.0.0-629836",
  "0.0.0-1461795",
  "0.0.0-1861528",
  "0.0.0-2662748",
  "0.0.0-3471713",
  "0.0.0-3667584",
  "0.0.0-4571036",
  "0.0.0-4605264",
  "0.0.0-5908188",
  "0.0.0-7291743",
  "0.0.0-9069759",
  "0.0.0-00ba881",
  "0.0.0-01b919d",
  "0.0.0-041b40f",
  "0.0.0-04d925e",
  "0.0.0-067cd1a",
  "0.0.0-06b2ab0",
  "0.0.0-07086ea",
🌐 Searching the web...
🌐 Searched: site:developers.cloudflare.com durable objects lifecycle in-memory state reset constructor hibernation
🌐 Searching the web...
🌐 Searched: https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
🌐 Searching the web...
🌐 Searched the web
🌐 Searching the web...
🌐 Searched: https://html.spec.whatwg.org/multipage/server-sent-events.html
🌐 Searching the web...
🌐 Searched: 'If the line starts with a U+003A COLON character (:)' in https://html.spec.whatwg.org/multipage/server-sent-events.html
🌐 Searching the web...
🌐 Searched: site:github.com/cloudflare/agents McpAgent serve README
🌐 Searching the web...
🌐 Searched: https://github.com/cloudflare/agents
exec
/usr/bin/zsh -lc "rg -n \"http_codes|min_content_chars|challenge_patterns\" src/server/fetch_orchestrator.ts src -g '"'!node_modules'"'" in /home/cjangrist/dev/omnisearch succeeded in 0ms:
src/server/fetch_orchestrator.ts:68:		min_content_chars: 200,
src/server/fetch_orchestrator.ts:69:		challenge_patterns: [
src/server/fetch_orchestrator.ts:76:		http_codes: [403, 429, 503],
src/server/fetch_orchestrator.ts:93:	if (!result.content || result.content.length < CONFIG.failure.min_content_chars) {
src/server/fetch_orchestrator.ts:97:	return CONFIG.failure.challenge_patterns.some((p) => lower.includes(p.toLowerCase()));
src/server/fetch_orchestrator.ts:68:		min_content_chars: 200,
src/server/fetch_orchestrator.ts:69:		challenge_patterns: [
src/server/fetch_orchestrator.ts:76:		http_codes: [403, 429, 503],
src/server/fetch_orchestrator.ts:93:	if (!result.content || result.content.length < CONFIG.failure.min_content_chars) {
src/server/fetch_orchestrator.ts:97:	return CONFIG.failure.challenge_patterns.some((p) => lower.includes(p.toLowerCase()));
context compacted
codex
### CRITICAL — Must fix before merging
- [worker.ts](/home/cjangrist/dev/omnisearch/src/worker.ts#L62), [worker.ts](/home/cjangrist/dev/omnisearch/src/worker.ts#L76) What: `inject_sse_keepalive()` writes keepalive bytes on a timer without understanding SSE record boundaries. Why: `ReadableStream` chunk boundaries are arbitrary, so a ping can be inserted between two chunks of the same event and change that event’s parsed fields or data; that violates the line-oriented SSE framing model in the [WHATWG SSE spec](https://html.spec.whatwg.org/dev/server-sent-events.html). Fix: buffer upstream bytes until a full `\n\n` event boundary is available, then only inject `: keepalive\n\n` between complete events; do not write timer bytes directly into the raw chunk stream.
- [rest_search.ts](/home/cjangrist/dev/omnisearch/src/server/rest_search.ts#L138), [rest_search.ts](/home/cjangrist/dev/omnisearch/src/server/rest_search.ts#L168) What: `/search` returns `200` with an empty result set when every provider fails. Why: a total upstream outage becomes indistinguishable from a legitimate “no matches” query, which masks production failures and breaks client retry/error behavior. Fix: if `providers_succeeded.length === 0` and there were failures/timeouts, return `502` or `503` with a compact provider failure summary; reserve `200 []` for cases where at least one provider succeeded and found nothing.

### HIGH — Should fix before merging
- [fetch_orchestrator.ts](/home/cjangrist/dev/omnisearch/src/server/fetch_orchestrator.ts#L259), [fetch_orchestrator.ts](/home/cjangrist/dev/omnisearch/src/server/fetch_orchestrator.ts#L92) What: the explicit `provider` path bypasses `try_provider()` and the fetch-failure heuristics entirely. Why: `/fetch?provider=...` can return challenge pages, empty bodies, or obvious provider failures that the normal waterfall would reject, so explicit-provider mode is observably less correct than default mode. Fix: run explicit providers through the same validation path as the waterfall and return the same structured failure reasons.
- [fetch_orchestrator.ts](/home/cjangrist/dev/omnisearch/src/server/fetch_orchestrator.ts#L162), [fetch_orchestrator.ts](/home/cjangrist/dev/omnisearch/src/server/fetch_orchestrator.ts#L282) What: “parallel” fetch steps are not actually raced; `Promise.allSettled()` waits for every provider in the step before moving on. Why: latency becomes the slowest provider in the group, which contradicts the stated “provider racing” design and can add tens of seconds even after a good result already exists. Fix: race acceptable results with `Promise.any()` or a custom first-success loop, then abort or ignore the losers.
- [answer_orchestrator.ts](/home/cjangrist/dev/omnisearch/src/server/answer_orchestrator.ts#L121), [config/env.ts](/home/cjangrist/dev/omnisearch/src/config/env.ts#L68) What: the global answer deadline returns early but does not cancel outstanding provider requests. Why: after the client has already timed out, providers can continue running until their own longer timeouts expire, wasting runtime, quota, and logs and increasing tail load. Fix: thread an `AbortSignal` through provider calls and abort all unfinished work when the orchestrator deadline fires.
- [config/env.ts](/home/cjangrist/dev/omnisearch/src/config/env.ts#L9), [providers/index.ts](/home/cjangrist/dev/omnisearch/src/providers/index.ts#L17), [tools.ts](/home/cjangrist/dev/omnisearch/src/server/tools.ts#L20), [worker.ts](/home/cjangrist/dev/omnisearch/src/worker.ts#L123) What: config and provider registry state are module-level singletons mutated during initialization. Why: in a Workers/DO environment, that couples REST requests, MCP sessions, and object activations through shared mutable state instead of instance-local state; it makes init order observable and weakens the separation Durable Objects are supposed to provide per activation, as noted in Cloudflare’s [DO lifecycle docs](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/). Fix: build immutable config/provider containers per Worker request or per DO instance and pass them explicitly into handlers/resources.
- [worker.ts](/home/cjangrist/dev/omnisearch/src/worker.ts#L173), [worker.ts](/home/cjangrist/dev/omnisearch/src/worker.ts#L194), [worker.ts](/home/cjangrist/dev/omnisearch/src/worker.ts#L235) What: multiple JSON error responses from the Worker bypass `add_cors_headers()`. Why: browser clients see opaque CORS failures precisely on the paths where they most need diagnostics, including init failures and MCP dispatch errors. Fix: centralize Worker error responses behind one helper that always applies the configured CORS headers.

### MEDIUM — Should fix soon
- [handlers.ts](/home/cjangrist/dev/omnisearch/src/server/handlers.ts#L73) What: the `provider-info` resource emits hard-coded capabilities and rate-limit values that do not match the actual provider categories. Why: clients can make incorrect assumptions about what a provider supports, and your own introspection resource becomes misleading rather than authoritative. Fix: derive these fields from provider metadata, or remove fields you cannot populate correctly.
- [fetch_orchestrator.ts](/home/cjangrist/dev/omnisearch/src/server/fetch_orchestrator.ts#L67), [config/env.ts](/home/cjangrist/dev/omnisearch/src/config/env.ts#L316) What: `failure.http_codes` is configured but never used in fetch failure detection. Why: the config suggests status-aware failure classification exists, but the implementation ignores it and may treat obvious 403/429/503 fetches as success if the body is non-empty. Fix: include provider status metadata in `is_fetch_failure()` and honor the configured code list, or delete the dead config.
- [package.json](/home/cjangrist/dev/omnisearch/package.json#L13), [worker.ts](/home/cjangrist/dev/omnisearch/src/worker.ts#L108) What: the transport layer depends on `agents@^0.7.9` plus `@modelcontextprotocol/sdk@^1.27.1`, while `agents` currently brings its own `sdk@1.26.0`, and the code suppresses the resulting type mismatch with `@ts-expect-error`. Why: this is working by coincidence today, not by a clean version contract; a future minor release can break either types or runtime behavior in the MCP boundary. Fix: pin exact versions and add an `overrides` entry so both packages resolve to one tested SDK version.
- [worker.ts](/home/cjangrist/dev/omnisearch/src/worker.ts#L149), [worker.ts](/home/cjangrist/dev/omnisearch/src/worker.ts#L216) What: the keepalive wrapper is applied solely by `content-type` inspection after the response is built. Why: that is correct for current `agents` behavior, but it means keepalive coverage is implicitly coupled to whatever content type the package emits; a dependency change could silently disable the workaround. Fix: add an integration test that exercises a long-lived MCP POST/streaming response and asserts the keepalive bytes are present.
- [fetch_orchestrator.ts](/home/cjangrist/dev/omnisearch/src/server/fetch_orchestrator.ts#L170) What: failed provider timings in `run_parallel()` all use the same step-level elapsed duration. Why: production telemetry will over-report some providers and under-report others, which makes tuning the waterfall materially harder. Fix: timestamp each provider promise independently and record per-provider elapsed time.

### LOW — Nice to have
- [worker.ts](/home/cjangrist/dev/omnisearch/src/worker.ts#L53), [worker.ts](/home/cjangrist/dev/omnisearch/src/worker.ts#L70) What: the keepalive payload is an SSE `ping` event instead of a comment line. Why: the [SSE spec](https://html.spec.whatwg.org/dev/server-sent-events.html) explicitly recommends comment keepalives, and comments are less semantically coupled to client event-handling behavior than a custom event type. Fix: once boundary-safe injection exists, emit `: keepalive\n\n`.
- [logger.ts](/home/cjangrist/dev/omnisearch/src/common/logger.ts#L46) What: `child()` does not really behave like a contextual child logger; it only reuses `component`/`requestId` and drops arbitrary parent context. Why: callers can think they are building structured context when they are not, which reduces log consistency. Fix: store and merge a generic context object in the logger instance.
- [config/env.ts](/home/cjangrist/dev/omnisearch/src/config/env.ts#L278), [config/env.ts](/home/cjangrist/dev/omnisearch/src/config/env.ts#L308) What: optional config fields are overwritten only when present and are never explicitly cleared. Why: if config initialization is ever reused in tests, hot reload, or future multi-config setups, stale values can survive a later init. Fix: reset all module-level config fields to defaults before overlaying parsed config.

### POSITIVE — What was done well
- [worker.ts](/home/cjangrist/dev/omnisearch/src/worker.ts#L123), [worker.ts](/home/cjangrist/dev/omnisearch/src/worker.ts#L149), [worker.ts](/home/cjangrist/dev/omnisearch/src/worker.ts#L216) The routing split is clean: REST paths are handled explicitly, MCP falls through to the DO binding, and the SSE wrapper is only applied to `text/event-stream` responses rather than every response.
- [answer_orchestrator.ts](/home/cjangrist/dev/omnisearch/src/server/answer_orchestrator.ts#L178) The answer fanout returns defensive copies of mutable arrays before returning. That is the right move given the timeout race, because late-settling promises cannot mutate the already-returned payload.
- [web_search_fanout.ts](/home/cjangrist/dev/omnisearch/src/server/web_search_fanout.ts#L112), [rrf_ranking.ts](/home/cjangrist/dev/omnisearch/src/common/rrf_ranking.ts#L1), [snippet_selector.ts](/home/cjangrist/dev/omnisearch/src/common/snippet_selector.ts#L1) The web-search pipeline is well layered: provider normalization, dedupe, RRF ranking, and snippet selection are separated cleanly, which makes the aggregation logic readable and extensible.
- [rest_search.ts](/home/cjangrist/dev/omnisearch/src/server/rest_search.ts#L34), [rest_fetch.ts](/home/cjangrist/dev/omnisearch/src/server/rest_fetch.ts#L36), [http.ts](/home/cjangrist/dev/omnisearch/src/common/http.ts#L1) The REST endpoints do the basic operational hygiene correctly: auth checking, method gating, body-size limits, and shared JSON response helpers are all in place.
- [worker.ts](/home/cjangrist/dev/omnisearch/src/worker.ts#L100), [wrangler.toml](/home/cjangrist/dev/omnisearch/wrangler.toml#L1) The overall DO-based MCP shape is reasonable for stateful MCP sessions. After reading the local `agents` runtime, the current `McpAgent.serve('/mcp', { binding, corsOptions })` usage matches how the package actually bridges Worker requests to Durable Objects; the main problems are around stream wrapping and version pinning, not the core choice of transport.
tokens used
423,651
### CRITICAL — Must fix before merging
- [worker.ts](/home/cjangrist/dev/omnisearch/src/worker.ts#L62), [worker.ts](/home/cjangrist/dev/omnisearch/src/worker.ts#L76) What: `inject_sse_keepalive()` writes keepalive bytes on a timer without understanding SSE record boundaries. Why: `ReadableStream` chunk boundaries are arbitrary, so a ping can be inserted between two chunks of the same event and change that event’s parsed fields or data; that violates the line-oriented SSE framing model in the [WHATWG SSE spec](https://html.spec.whatwg.org/dev/server-sent-events.html). Fix: buffer upstream bytes until a full `\n\n` event boundary is available, then only inject `: keepalive\n\n` between complete events; do not write timer bytes directly into the raw chunk stream.
- [rest_search.ts](/home/cjangrist/dev/omnisearch/src/server/rest_search.ts#L138), [rest_search.ts](/home/cjangrist/dev/omnisearch/src/server/rest_search.ts#L168) What: `/search` returns `200` with an empty result set when every provider fails. Why: a total upstream outage becomes indistinguishable from a legitimate “no matches” query, which masks production failures and breaks client retry/error behavior. Fix: if `providers_succeeded.length === 0` and there were failures/timeouts, return `502` or `503` with a compact provider failure summary; reserve `200 []` for cases where at least one provider succeeded and found nothing.

### HIGH — Should fix before merging
- [fetch_orchestrator.ts](/home/cjangrist/dev/omnisearch/src/server/fetch_orchestrator.ts#L259), [fetch_orchestrator.ts](/home/cjangrist/dev/omnisearch/src/server/fetch_orchestrator.ts#L92) What: the explicit `provider` path bypasses `try_provider()` and the fetch-failure heuristics entirely. Why: `/fetch?provider=...` can return challenge pages, empty bodies, or obvious provider failures that the normal waterfall would reject, so explicit-provider mode is observably less correct than default mode. Fix: run explicit providers through the same validation path as the waterfall and return the same structured failure reasons.
- [fetch_orchestrator.ts](/home/cjangrist/dev/omnisearch/src/server/fetch_orchestrator.ts#L162), [fetch_orchestrator.ts](/home/cjangrist/dev/omnisearch/src/server/fetch_orchestrator.ts#L282) What: “parallel” fetch steps are not actually raced; `Promise.allSettled()` waits for every provider in the step before moving on. Why: latency becomes the slowest provider in the group, which contradicts the stated “provider racing” design and can add tens of seconds even after a good result already exists. Fix: race acceptable results with `Promise.any()` or a custom first-success loop, then abort or ignore the losers.
- [answer_orchestrator.ts](/home/cjangrist/dev/omnisearch/src/server/answer_orchestrator.ts#L121), [config/env.ts](/home/cjangrist/dev/omnisearch/src/config/env.ts#L68) What: the global answer deadline returns early but does not cancel outstanding provider requests. Why: after the client has already timed out, providers can continue running until their own longer timeouts expire, wasting runtime, quota, and logs and increasing tail load. Fix: thread an `AbortSignal` through provider calls and abort all unfinished work when the orchestrator deadline fires.
- [config/env.ts](/home/cjangrist/dev/omnisearch/src/config/env.ts#L9), [providers/index.ts](/home/cjangrist/dev/omnisearch/src/providers/index.ts#L17), [tools.ts](/home/cjangrist/dev/omnisearch/src/server/tools.ts#L20), [worker.ts](/home/cjangrist/dev/omnisearch/src/worker.ts#L123) What: config and provider registry state are module-level singletons mutated during initialization. Why: in a Workers/DO environment, that couples REST requests, MCP sessions, and object activations through shared mutable state instead of instance-local state; it makes init order observable and weakens the separation Durable Objects are supposed to provide per activation, as noted in Cloudflare’s [DO lifecycle docs](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/). Fix: build immutable config/provider containers per Worker request or per DO instance and pass them explicitly into handlers/resources.
- [worker.ts](/home/cjangrist/dev/omnisearch/src/worker.ts#L173), [worker.ts](/home/cjangrist/dev/omnisearch/src/worker.ts#L194), [worker.ts](/home/cjangrist/dev/omnisearch/src/worker.ts#L235) What: multiple JSON error responses from the Worker bypass `add_cors_headers()`. Why: browser clients see opaque CORS failures precisely on the paths where they most need diagnostics, including init failures and MCP dispatch errors. Fix: centralize Worker error responses behind one helper that always applies the configured CORS headers.

### MEDIUM — Should fix soon
- [handlers.ts](/home/cjangrist/dev/omnisearch/src/server/handlers.ts#L73) What: the `provider-info` resource emits hard-coded capabilities and rate-limit values that do not match the actual provider categories. Why: clients can make incorrect assumptions about what a provider supports, and your own introspection resource becomes misleading rather than authoritative. Fix: derive these fields from provider metadata, or remove fields you cannot populate correctly.
- [fetch_orchestrator.ts](/home/cjangrist/dev/omnisearch/src/server/fetch_orchestrator.ts#L67), [config/env.ts](/home/cjangrist/dev/omnisearch/src/config/env.ts#L316) What: `failure.http_codes` is configured but never used in fetch failure detection. Why: the config suggests status-aware failure classification exists, but the implementation ignores it and may treat obvious 403/429/503 fetches as success if the body is non-empty. Fix: include provider status metadata in `is_fetch_failure()` and honor the configured code list, or delete the dead config.
- [package.json](/home/cjangrist/dev/omnisearch/package.json#L13), [worker.ts](/home/cjangrist/dev/omnisearch/src/worker.ts#L108) What: the transport layer depends on `agents@^0.7.9` plus `@modelcontextprotocol/sdk@^1.27.1`, while `agents` currently brings its own `sdk@1.26.0`, and the code suppresses the resulting type mismatch with `@ts-expect-error`. Why: this is working by coincidence today, not by a clean version contract; a future minor release can break either types or runtime behavior in the MCP boundary. Fix: pin exact versions and add an `overrides` entry so both packages resolve to one tested SDK version.
- [worker.ts](/home/cjangrist/dev/omnisearch/src/worker.ts#L149), [worker.ts](/home/cjangrist/dev/omnisearch/src/worker.ts#L216) What: the keepalive wrapper is applied solely by `content-type` inspection after the response is built. Why: that is correct for current `agents` behavior, but it means keepalive coverage is implicitly coupled to whatever content type the package emits; a dependency change could silently disable the workaround. Fix: add an integration test that exercises a long-lived MCP POST/streaming response and asserts the keepalive bytes are present.
- [fetch_orchestrator.ts](/home/cjangrist/dev/omnisearch/src/server/fetch_orchestrator.ts#L170) What: failed provider timings in `run_parallel()` all use the same step-level elapsed duration. Why: production telemetry will over-report some providers and under-report others, which makes tuning the waterfall materially harder. Fix: timestamp each provider promise independently and record per-provider elapsed time.

### LOW — Nice to have
- [worker.ts](/home/cjangrist/dev/omnisearch/src/worker.ts#L53), [worker.ts](/home/cjangrist/dev/omnisearch/src/worker.ts#L70) What: the keepalive payload is an SSE `ping` event instead of a comment line. Why: the [SSE spec](https://html.spec.whatwg.org/dev/server-sent-events.html) explicitly recommends comment keepalives, and comments are less semantically coupled to client event-handling behavior than a custom event type. Fix: once boundary-safe injection exists, emit `: keepalive\n\n`.
- [logger.ts](/home/cjangrist/dev/omnisearch/src/common/logger.ts#L46) What: `child()` does not really behave like a contextual child logger; it only reuses `component`/`requestId` and drops arbitrary parent context. Why: callers can think they are building structured context when they are not, which reduces log consistency. Fix: store and merge a generic context object in the logger instance.
- [config/env.ts](/home/cjangrist/dev/omnisearch/src/config/env.ts#L278), [config/env.ts](/home/cjangrist/dev/omnisearch/src/config/env.ts#L308) What: optional config fields are overwritten only when present and are never explicitly cleared. Why: if config initialization is ever reused in tests, hot reload, or future multi-config setups, stale values can survive a later init. Fix: reset all module-level config fields to defaults before overlaying parsed config.

### POSITIVE — What was done well
- [worker.ts](/home/cjangrist/dev/omnisearch/src/worker.ts#L123), [worker.ts](/home/cjangrist/dev/omnisearch/src/worker.ts#L149), [worker.ts](/home/cjangrist/dev/omnisearch/src/worker.ts#L216) The routing split is clean: REST paths are handled explicitly, MCP falls through to the DO binding, and the SSE wrapper is only applied to `text/event-stream` responses rather than every response.
- [answer_orchestrator.ts](/home/cjangrist/dev/omnisearch/src/server/answer_orchestrator.ts#L178) The answer fanout returns defensive copies of mutable arrays before returning. That is the right move given the timeout race, because late-settling promises cannot mutate the already-returned payload.
- [web_search_fanout.ts](/home/cjangrist/dev/omnisearch/src/server/web_search_fanout.ts#L112), [rrf_ranking.ts](/home/cjangrist/dev/omnisearch/src/common/rrf_ranking.ts#L1), [snippet_selector.ts](/home/cjangrist/dev/omnisearch/src/common/snippet_selector.ts#L1) The web-search pipeline is well layered: provider normalization, dedupe, RRF ranking, and snippet selection are separated cleanly, which makes the aggregation logic readable and extensible.
- [rest_search.ts](/home/cjangrist/dev/omnisearch/src/server/rest_search.ts#L34), [rest_fetch.ts](/home/cjangrist/dev/omnisearch/src/server/rest_fetch.ts#L36), [http.ts](/home/cjangrist/dev/omnisearch/src/common/http.ts#L1) The REST endpoints do the basic operational hygiene correctly: auth checking, method gating, body-size limits, and shared JSON response helpers are all in place.
- [worker.ts](/home/cjangrist/dev/omnisearch/src/worker.ts#L100), [wrangler.toml](/home/cjangrist/dev/omnisearch/wrangler.toml#L1) The overall DO-based MCP shape is reasonable for stateful MCP sessions. After reading the local `agents` runtime, the current `McpAgent.serve('/mcp', { binding, corsOptions })` usage matches how the package actually bridges Worker requests to Durable Objects; the main problems are around stream wrapping and version pinning, not the core choice of transport.
