# Architecture Scorecard & Code Review: MCP Server on Cloudflare Workers with Durable Objects

## What To Review

Review the ENTIRE current state of this MCP server codebase — not just a diff. Read every file listed below IN FULL from disk. Explore the directory structure. Follow imports and call chains. Research external dependencies by reading their type definitions in node_modules. Search online for documentation on the `agents` npm package, `@modelcontextprotocol/sdk`, Cloudflare Durable Objects lifecycle, and the SSE spec.

## Architecture Overview

This is a Cloudflare Workers project that runs an MCP (Model Context Protocol) server. It aggregates 9+ AI/search providers in parallel via three tools:

1. **`web_search`** — Fans out to 9 search engines, deduplicates via RRF ranking
2. **`answer`** — Fans out to 9 AI providers for parallel answer synthesis with AbortController cancellation on deadline
3. **`fetch`** — Waterfall across 25+ fetch providers with domain breakers and parallel racing

The server uses **Durable Objects** (`McpAgent` from the `agents` npm package) for stateful MCP sessions. An SSE keepalive mechanism (`event: ping\ndata: keepalive\n\n` injection at the Worker level with event boundary buffering) prevents Claude web's ~45-second timeout from killing long-running tool calls.

## Files You MUST Read In Full

**Core files (read every line):**
- `src/worker.ts` — Main entry point, DO class, SSE keepalive injection with event-boundary buffering, routing
- `src/server/tools.ts` — MCP tool registration, handlers, ToolRegistry singleton
- `src/server/answer_orchestrator.ts` — Answer fanout with Promise.race deadline + AbortController
- `src/server/web_search_fanout.ts` — Web search fanout with RRF ranking + query cache
- `src/server/fetch_orchestrator.ts` — Fetch waterfall with Promise.any racing + domain breakers
- `src/types/env.ts` — Environment type definitions
- `wrangler.toml` — Cloudflare Workers + DO config
- `package.json` — Dependencies

**Context files (read for understanding):**
- `src/config/env.ts` — Config initialization (writes to module-level globals, atomic swap)
- `src/providers/index.ts` — Provider initialization with atomic active_providers swap
- `src/server/handlers.ts` — MCP resource handlers (provider-status, provider-info)
- `src/server/rest_search.ts` — REST /search endpoint with 502 on total failure
- `src/server/rest_fetch.ts` — REST /fetch endpoint
- `src/common/logger.ts` — Structured logging utilities
- `src/common/types.ts` — Shared types (BaseSearchParams with signal support)
- `src/common/http.ts` — HTTP utilities
- `src/common/utils.ts` — Shared utilities (make_signal, timing_safe_equal)
- `src/common/rrf_ranking.ts` — Reciprocal Rank Fusion implementation

**Provider implementations (read at least 2-3 in each category):**
- `src/providers/ai_response/*/index.ts` — AI providers (perplexity, kagi, exa, brave, tavily, llm_search, gemini_grounded)
- `src/providers/search/*/index.ts` — Web search providers
- `src/providers/fetch/*/index.ts` — Fetch providers (25+ implementations)
- `src/providers/unified/*.ts` — Unified dispatchers for each provider category

**External research (read type definitions + search online):**
- `node_modules/agents/dist/` — How `McpAgent` works, `serve()` options, DO↔Worker WebSocket bridge
- `node_modules/@modelcontextprotocol/sdk/` — `McpServer`, tool handlers, Streamable HTTP transport
- Cloudflare Durable Objects — lifecycle, `init()` semantics, isolate sharing, WebSocket hibernation
- SSE spec — event framing, named events, comment keepalives
- TransformStream on CF Workers — correctness of the reader pump + buffering pattern
- AbortSignal.any() — browser/runtime compatibility, composition semantics

---

## Part 1: Architecture Scorecard

For EACH of the following areas, provide:
1. **Score: X/10** — your honest assessment of the current implementation
2. **Justification** — 2-3 sentences explaining why you gave that score
3. **To reach 10/10** — specific, actionable items that would raise the score to 10/10. If already 10/10, say "No changes needed." Each item should be a concrete code change, not a vague suggestion.

**Scoring guide:**
- **10/10** — Best-in-class. No meaningful improvements possible.
- **8-9/10** — Excellent. Minor improvements possible but nothing urgent.
- **6-7/10** — Good. Some clear improvements that would meaningfully raise quality.
- **4-5/10** — Acceptable. Significant gaps that should be addressed.
- **1-3/10** — Poor. Fundamental issues that need rework.

### Area 1: CONCURRENCY & ASYNC PATTERNS
- Promise composition (race, all, allSettled, any) — correctness and appropriateness
- AbortController/signal threading — completeness and cleanup
- Interval/timer lifecycle — leak prevention
- Race conditions in shared mutable state
- Concurrent DO instance isolation
- Deadline/timeout handling across all fanout patterns

### Area 2: STREAM HANDLING & SSE
- SSE event boundary buffering correctness
- Keepalive injection timing and safety
- TransformStream pump pattern — backpressure, error propagation, cleanup
- Reader/writer lifecycle management
- Interaction between keepalive interval and pump writes
- Client disconnect detection and upstream cancellation

### Area 3: ERROR HANDLING & RESILIENCE
- Error propagation consistency across REST, MCP, and DO paths
- Provider failure isolation — one provider's failure must not crash others
- Graceful degradation when all providers fail
- Error response format consistency (CORS headers, status codes, JSON shape)
- Catch-all coverage — are there any unhandled rejection paths?
- Retry strategy (or intentional lack thereof) — is the current approach justified?

### Area 4: DATA FLOW & PROVIDER ORCHESTRATION
- Web search fanout: dispatch → merge → RRF rank → truncate pipeline
- Answer fanout: build_tasks → execute_tasks → deadline → abort pipeline
- Fetch waterfall: breaker → step → race → validate pipeline
- Provider registration pattern (config → key check → factory → unified dispatcher)
- Result normalization across heterogeneous provider APIs
- Caching strategy (web search query cache)

### Area 5: CODE ORGANIZATION & MODULARITY
- File structure and dependency graph — are there circular dependencies?
- Separation of concerns (routing vs. business logic vs. provider specifics)
- Module-level state management (config, ToolRegistry, active_providers)
- Import hygiene — unused imports, deep imports, barrel files
- Type reuse vs. duplication across provider implementations
- Testability — could you unit test each module in isolation?

### Area 6: TYPE SAFETY & INTERFACES
- TypeScript strictness — are there `any`, `as unknown as`, untyped catches?
- Interface design — are BaseSearchParams, FetchResult, SearchResult well-designed?
- Generic type usage — could generics reduce duplication?
- Discriminated unions or tagged types — are they used where appropriate?
- `@ts-expect-error` usage — are they documented and justified?
- Zod schemas in tool definitions — do they match the actual return types?

### Area 7: CONFIGURATION & ENVIRONMENT
- Config initialization pattern (module-level globals vs. scoped state)
- Environment binding validation (are missing keys handled gracefully?)
- Provider auto-discovery (how new providers are registered)
- Timeout/limit constants — are they well-chosen, documented, overridable?
- wrangler.toml correctness — DO bindings, compatibility flags, migrations

### Area 8: OBSERVABILITY & DEBUGGING
- Structured logging coverage — are all key operations logged?
- Log level usage — is debug/info/warn/error used consistently?
- Operation tracking (request_id, op fields) — can you trace a request end-to-end?
- Timing instrumentation — is duration_ms captured at the right granularity?
- Error context — do log messages include enough context to diagnose issues?
- Missing observability — what operations are NOT logged that should be?

### Area 9: API DESIGN & PROTOCOL COMPLIANCE
- MCP protocol compliance (Streamable HTTP, tool schemas, resources)
- REST API design (/search, /fetch, /health) — status codes, error shapes
- CORS handling — completeness and correctness
- Tool descriptions — are they accurate, helpful, and not misleading?
- Input validation (query length, body size, URL format)
- Output schemas — do they match what the tools actually return?

### Area 10: PERFORMANCE & RESOURCE EFFICIENCY
- Unnecessary allocations on hot paths (TextEncoder, Uint8Array copies)
- Promise overhead — are we creating more promises than needed?
- TransformStream overhead — is the SSE wrapper justified for all responses?
- Memory usage patterns — are there unbounded buffers or growing collections?
- Date.now() call frequency — is timing captured efficiently?
- Network efficiency — are we making redundant HTTP calls?

---

## Part 2: Traditional Code Review

After completing the scorecard, also provide a traditional severity-ranked review for any issues NOT already covered in the scorecard's "To reach 10/10" items.

### CRITICAL — Must fix (production bugs, data loss, outages)
### HIGH — Should fix (problems under specific conditions)
### MEDIUM — Should fix soon (quality, maintainability)
### LOW — Nice to have (theoretical concerns)
### POSITIVE — What was done well (good patterns, smart decisions)

For each finding:
- **File and line number(s)**
- **What** the issue is (specific)
- **Why** it matters (concrete impact)
- **Fix** (specific code suggestion)

---

## Rules

- Do NOT include security-related findings (auth, injection, secrets). Skip entirely.
- Do NOT include cosmetic nits (formatting, naming style preferences).
- Do NOT suggest adding comments/documentation unless the code is genuinely confusing.
- DO read every file from disk. DO follow import chains. DO research external APIs.
- DO be honest in scoring — an 8/10 with clear improvement items is more useful than a dishonest 10/10.
- DO make "To reach 10/10" items concrete enough that a developer could implement them without further clarification.
