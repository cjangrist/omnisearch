# Architecture Scorecard & Code Review: OmniSearch MCP Server (Round 6)

**Reviewer:** Claude Opus 4.6 (1M context)
**Date:** 2026-03-22
**Codebase snapshot:** commit `5ef32b9` (main)

---

## Part 1: Architecture Scorecard

### Area 1: CONCURRENCY & ASYNC PATTERNS — Score: 8/10

**Justification:** The codebase demonstrates sophisticated understanding of Promise composition patterns. `answer_orchestrator.ts` uses `Promise.race([Promise.all(tracked), deadline])` correctly with an `is_done` flag and defensive array copying to prevent post-deadline mutations. `fetch_orchestrator.ts` uses `Promise.any` for parallel racing with a `resolved` flag to suppress late `.catch()` mutations. `web_search_fanout.ts` properly snapshots results at deadline with `new Map()` and spread copies. The `AbortController`/`AbortSignal` threading is consistently applied through `make_signal()` which composes external signals with per-provider timeouts using `AbortSignal.any()` with a manual polyfill fallback. Timer cleanup is consistently handled (`clearInterval(progress_interval)`, `clearTimeout(timer_id!)`).

**To reach 10/10:**
1. **`answer_orchestrator.ts` L130-166:** The `is_done` flag prevents mutation but the promises themselves still run to completion after deadline. The `abort_controller.abort()` on L192 fires, but tracked promises (L130) are `.then()`/`.catch()` wrappers that don't propagate the signal to already-settled promises. The late-arriving `.then()` callbacks will still execute (checking `is_done`), consuming CPU. This is acceptable given CF Workers' short lifetime, but documenting this as intentional would strengthen the pattern.
2. **`web_search_fanout.ts` L80-91:** The `AbortSignal.any` polyfill fallback on L87 drops the external signal entirely when `AbortSignal.any` is unavailable: `combined_signal = deadline_controller.signal` ignores `signal`. The comment acknowledges this but the fix is simple: wire both into a manual `AbortController` the same way `make_signal` does in `utils.ts` L14-22.
3. **`make_signal` polyfill (utils.ts L14-22):** The `clearTimeout(timer)` in `on_abort` only fires when the external signal aborts. If the timeout fires first, the external signal's listener is never removed. On CF Workers this is fine (short-lived), but for correctness, add cleanup of the external listener after timeout fires.

### Area 2: STREAM HANDLING & SSE — Score: 8/10

**Justification:** The SSE keepalive injection in `worker.ts` L62-169 is carefully engineered. It buffers incoming chunks, scans for SSE event boundaries (`\n\n`, `\r\n\r\n`, `\r\r`), and only flushes complete events. Keepalive pings are only injected when the buffer is empty (`total_len === 0`), preventing mid-event corruption. The `safe_write` serialization via promise chaining (L76-79) correctly prevents concurrent writes to the same `WritableStreamDefaultWriter`. The `closed` flag with idempotent `cleanup()` prevents double-close. The pump runs asynchronously with `.catch(cleanup)` for error propagation.

**To reach 10/10:**
1. **`worker.ts` L76-79 (safe_write):** The `.catch(cleanup)` on `write_lock` means that if any write fails, ALL subsequent writes (including legitimate ones queued in the chain) are silently dropped because `cleanup()` closes the writer. This is probably the desired behavior (connection dead = stop writing), but `safe_write` returns a promise that resolves to `undefined` on error rather than rejecting, so callers in `flush_complete_events` cannot distinguish success from failure. Consider having `safe_write` re-throw after cleanup so the pump's `for(;;)` loop breaks immediately rather than continuing to read and buffer chunks that will never be written.
2. **Client disconnect detection:** There is no explicit detection of client disconnect. When the client drops the connection, the `writer.write()` call will eventually throw, triggering `cleanup()` which cancels the reader. This works but is reactive rather than proactive. The response could register a `signal` on the incoming request (`request.signal`) and abort the upstream read when the client disconnects. This would save resources on long-running MCP calls where the client navigates away.
3. **`worker.ts` L119-128 (flush_complete_events):** `flatten()` is called on every `flush_complete_events` invocation, and if the buffer has multiple chunks, it allocates a new `Uint8Array` and copies everything. After flushing, `buf.subarray(offset)` creates a view into the flattened array but then wraps it in a new array `[remainder]`. If events arrive in small frequent chunks, flatten is called repeatedly. Consider tracking a byte offset into an existing flat buffer instead of re-flattening each time.

### Area 3: ERROR HANDLING & RESILIENCE — Score: 9/10

**Justification:** Error handling is thorough and well-layered. Provider errors are classified via `ErrorType` enum (API_ERROR, RATE_LIMIT, INVALID_INPUT, PROVIDER_ERROR) and wrapped in `ProviderError` with causal chaining (`handle_provider_error` preserves stack traces). The `http_core` function in `http.ts` handles 401/403/429/5xx uniformly with provider-specific error messages. The REST endpoints properly map error types to HTTP status codes (429 for RATE_LIMIT, 400 for INVALID_INPUT, 502 for PROVIDER_ERROR). The fanout patterns isolate provider failures -- one provider crashing never affects others. The `catch {} /* cache miss */` pattern in KV reads is appropriate since cache failures should not block primary operations. All three REST endpoints have catch-all try/catch blocks in `worker.ts` L273-288, L296-310.

**To reach 10/10:**
1. **`worker.ts` L347:** The MCP handler catch block returns `add_cors_headers(Response.json({...}))` but the MCP response path on L341-345 does NOT add CORS headers (the agents package handles CORS via its own `corsOptions`). If the agents package's CORS fails or doesn't cover error responses, the MCP error response on L353 could have inconsistent CORS headers compared to success responses. Minor concern since the agents package likely handles this.

### Area 4: DATA FLOW & PROVIDER ORCHESTRATION — Score: 9/10

**Justification:** The three orchestration patterns are well-designed and appropriate for their use cases. Web search uses parallel fanout with RRF ranking -- a well-established information retrieval technique with the standard k=60 constant. The answer fanout uses `Promise.race` between `Promise.all` and a deadline, with AbortController cancellation on timeout. The fetch waterfall with domain breakers is a smart optimization -- YouTube URLs skip straight to Supadata, social media to SociaVault. The `is_fetch_failure` heuristic with challenge pattern detection (L91-98) catches common anti-bot responses. Provider registration follows a consistent `config -> key check -> factory -> unified dispatcher` pattern across all three categories. KV caching (24h TTL) across all three tools with appropriate cache key design (excluding timeout_ms from search cache keys since it affects speed not results). The quality filter in RRF ranking (`MIN_RRF_SCORE`, `MIN_SNIPPET_CHARS_SINGLE_PROVIDER`) provides intelligent result filtering. The snippet collapse algorithm using Jaccard similarity and sentence-level greedy set cover is sophisticated.

**To reach 10/10:**
1. **`answer_orchestrator.ts` L86-98 (gemini-grounded):** The gemini-grounded task runs a nested `run_web_search_fanout` with a 10-second timeout inside the answer fanout. If the web search results are cached (from a prior `web_search` tool call), this is instant. But if not cached, the 10s timeout may return partial or no results, and the gemini-grounded provider gets weak grounding. Consider making the inner web search timeout configurable or documenting why 10s was chosen.
2. **`fetch_orchestrator.ts` L189-205 (run_parallel):** The `resolved` flag prevents post-winner mutations to `ctx.failed`, but in-flight HTTP requests from losing providers continue running to completion. Since fetch providers don't receive an AbortSignal, there's no way to cancel them. Adding signal threading to `UnifiedFetchProvider.fetch_url()` -> individual provider `fetch_url()` would allow cancellation of losers.

### Area 5: CODE ORGANIZATION & MODULARITY — Score: 9/10

**Justification:** The file structure is clean and logical: `common/` for shared utilities, `config/` for environment, `providers/` split by category (search, ai_response, fetch) with unified dispatchers, `server/` for orchestration and endpoints, `types/` for shared interfaces. There are no circular dependencies -- the dependency graph flows strictly downward: `worker.ts` -> `server/*` -> `providers/unified/*` -> `providers/*/index.ts` -> `common/*` -> `config/*`. Each provider follows an identical template: interface definition, class implementation, exported `registration` object. The unified dispatchers use a consistent factory pattern. Module-level state (`config`, `active_providers`, `ToolRegistry`) is initialized once and swapped atomically. The `registration` export pattern with `key: () => config.X.api_key` is elegant -- lazy evaluation means the config can be populated after module load.

**To reach 10/10:**
1. **`server/tools.ts` (ToolRegistry singleton):** The `ToolRegistry` class is a singleton holding `web_search_provider`, `ai_search_provider`, and `fetch_provider` as optional fields, but it's only used via module-level exported functions (`register_tools`, `register_web_search_provider`, etc.). The class adds a layer of indirection that doesn't provide meaningful encapsulation since all its methods are exposed through free functions. It could be simplified to three module-level `let` variables with direct export functions, matching the pattern used in `config/env.ts`.

### Area 6: TYPE SAFETY & INTERFACES — Score: 7/10

**Justification:** TypeScript strict mode is enabled. The core interfaces (`SearchResult`, `FetchResult`, `BaseSearchParams`, `ProviderError`) are well-designed and consistently used. The `config` object uses typed literals for known defaults. Zod schemas in tool definitions provide runtime validation. However, there are several type safety gaps.

**To reach 10/10:**
1. **`config/env.ts` L19-253:** The `config` object uses `undefined as string | undefined` type assertions throughout (e.g., `api_key: undefined as string | undefined`). This is a workaround for TypeScript's type narrowing on object literals. A cleaner approach would be to define a proper interface for each provider config and use `Partial<>` or explicit optional fields.
2. **`server/tools.ts` L156:** `structuredContent: answer_result as unknown as Record<string, unknown>` is a double type assertion that bypasses type checking entirely. The `AnswerResult` type is well-defined, so this cast could be eliminated by adjusting the MCP SDK's expected type or using a proper serialization function.
3. **`server/tools.ts` L199:** Same `as Record<string, unknown>` pattern for fetch results.
4. **`common/search_operators.ts` L103:** `return params as unknown as SearchParams` is another double assertion. The function builds params dynamically using string keys, making type safety impossible. Consider building the `SearchParams` object with explicit field assignments instead of `Record<string, unknown>`.
5. **Fetch providers lack AbortSignal support:** The `FetchProvider` interface (`common/types.ts` L35-39) defines `fetch_url(url: string): Promise<FetchResult>` with no signal parameter. This means individual fetch providers cannot be cancelled. The `SearchProvider` interface correctly includes `signal?: AbortSignal` via `BaseSearchParams`, but `FetchProvider` does not. Adding `signal?: AbortSignal` to `fetch_url` would enable cancellation in the fetch waterfall's parallel racing.
6. **`validate_config` (config/env.ts L357-394):** Uses `as { api_key?: string }` and `as { api_key?: string; username?: string; account_id?: string }` type assertions to access provider config fields generically. A discriminated union or shared interface for provider configs would eliminate these casts.

### Area 7: CONFIGURATION & ENVIRONMENT — Score: 8/10

**Justification:** The config initialization pattern is pragmatic for Cloudflare Workers' execution model. `initialize_config(env)` runs once per isolate (guarded by the `_rest_init` / `_init_promise` patterns), writing env bindings into module-level config. The `validate_config()` function logs all available and missing providers, which is excellent for debugging deployments. Provider auto-discovery is automatic -- adding a new provider requires only: (1) create the provider file, (2) add config entry in `config/env.ts`, (3) add env var in `types/env.ts`, (4) add registration line in the unified dispatcher. The `wrangler.toml` is minimal and correct: DO binding name matches the class export, SQLite migration is properly tagged, `nodejs_compat` flag enables AsyncLocalStorage.

**To reach 10/10:**
1. **`config/env.ts` L282-298 (LLM config reset):** The reset-before-reapply pattern (`config.ai_response.chatgpt.base_url = ''`) prevents stale values but is fragile -- if a new LLM provider is added, forgetting to add its reset line causes stale config. A more robust approach: define default values as a frozen object and spread-copy before applying env overrides.
2. **Timeout constants are not overridable:** All provider timeouts are hardcoded in `config/env.ts` (e.g., `timeout: 30000`). The `GLOBAL_TIMEOUT_MS` in `answer_orchestrator.ts` is also hardcoded at 120s. These cannot be overridden via env vars. Adding env-var overrides (e.g., `ANSWER_TIMEOUT_MS`) would allow tuning without redeployment.
3. **`config/env.ts` L94-116 (LLM providers):** The `chatgpt`, `claude`, and `gemini` ai_response entries use `api_key: '' as string` (empty string, typed as non-optional string) rather than `undefined as string | undefined`. This inconsistency means they bypass the `p.key()?.trim()` truthiness check differently from other providers -- empty string is falsy, so they're correctly excluded, but the type doesn't communicate optionality.

### Area 8: OBSERVABILITY & DEBUGGING — Score: 8/10

**Justification:** Structured JSON logging is consistently applied throughout the codebase. Every key operation has `op:` tags for filtering (e.g., `op: 'waterfall_start'`, `op: 'provider_done'`). Timing is captured at appropriate granularity: per-provider `duration_ms` in fanouts, total `total_duration_ms` for orchestrators, and per-request duration in `worker.ts`. The `run_with_request_id` using AsyncLocalStorage enables cross-cutting request correlation without threading IDs through every function signature. The `sanitize_url` function in `http.ts` redacts API keys from logged URLs. The `logger.response()` method automatically adjusts log level based on status code (500+ = error, 400+ = warn).

**To reach 10/10:**
1. **Missing log in SSE keepalive:** The `inject_sse_keepalive` function (`worker.ts` L62-169) has no logging at all. When debugging SSE timeout issues, there's no visibility into how many pings were sent, whether the pump is still running, or why cleanup was triggered. Adding a debug-level log on keepalive send and an info-level log on cleanup with reason (reader done, write error, etc.) would be valuable.
2. **`http.ts` L122-128:** The success response log includes `content_length_bytes` but does not log the response `Content-Type`, which is useful for debugging providers that return HTML instead of JSON.
3. **Fetch waterfall has no per-step logging:** `fetch_orchestrator.ts` logs waterfall start and end but does not log which step is currently being attempted. The individual `run_solo`/`run_parallel`/`run_sequential` functions don't log step transitions. Adding `step_index` or `step_type` to the per-provider attempt logs would make waterfall debugging easier.

### Area 9: API DESIGN & PROTOCOL COMPLIANCE — Score: 8/10

**Justification:** The MCP tool schemas use Zod with proper `inputSchema` and `outputSchema` definitions. Tool descriptions are detailed and actionable (telling the LLM when to use each tool and what to expect). The REST API follows standard conventions: 400 for bad input, 401 for auth failure, 413 for oversized bodies, 502 for upstream failures, 503 for no providers. CORS handling covers the necessary headers including `mcp-session-id` and `mcp-protocol-version`. Input validation is thorough: query length limits (2000 chars), URL format validation, body size limits (64KB), provider name validation against active providers. The `event: ping` keepalive uses a named SSE event that MCP SDK clients correctly ignore (they only process unnamed events or `event: message`).

**To reach 10/10:**
1. **REST `/search` response format diverges from MCP format:** The MCP `web_search` tool returns `{ web_results: [{url, title, snippets, source_providers, score}] }` while REST `/search` returns `[{link, title, snippet}]`. This inconsistency means clients must handle two different schemas. While the REST format is intentionally simplified for Open WebUI compatibility, documenting this divergence or offering a `?format=full` option would help.
2. **`rest_search.ts` L43:** `count = Math.min(100, Math.max(0, body.count ?? 0))` -- when `count` is 0 (default), the REST endpoint returns ALL results (L122: `count > 0 ? slice : all`). This means the default behavior returns an unbounded number of results. Consider defaulting to a reasonable limit (e.g., 15, matching `DEFAULT_TOP_N`).
3. **MCP tool output schemas don't fully match returns:** The `web_search` tool's `outputSchema` defines `web_results` with `snippets: z.array(z.string()).optional()`, but the `format_web_search_response` method on L211-213 conditionally strips snippets when `include_snippets` is false, returning results without the `snippets` field. The schema should reflect that `snippets` is truly optional.

### Area 10: PERFORMANCE & RESOURCE EFFICIENCY — Score: 8/10

**Justification:** The codebase makes smart performance decisions. `SSE_PING` is a pre-encoded `Uint8Array` constant (L60), avoiding repeated `TextEncoder.encode` calls on the hot path. The `text_encoder` in `utils.ts` is a module-level singleton. The `http_core` function uses streaming reads with a byte counter to prevent OOM from unbounded `res.text()` calls (L62-84). The flatten-on-demand approach in the SSE buffer avoids O(n^2) concatenation on every chunk. The RRF ranking is O(n*m) where n=results and m=providers, which is appropriate for the scale (9 providers, ~20 results each). KV caching prevents redundant API calls for repeated queries within 24 hours. The factory pattern in unified dispatchers means provider instances are only created for providers with valid API keys.

**To reach 10/10:**
1. **`rrf_ranking.ts` L69-76 (snippet dedup):** Uses `!existing.snippets.includes(result.snippet)` for dedup, which is O(n) per check. For the typical case (2-3 snippets per URL) this is fine, but a Set would be more idiomatic and O(1).
2. **`http.ts` L66-84 (streaming read):** Collects decoded string chunks into an array and joins them at the end. This is efficient for moderate responses but for the 5MB limit, the string concatenation at L81 (`chunks.join('')`) creates a single large string allocation. Since most responses are well under 1MB, this is acceptable, but the `TextDecoder` with `stream: true` correctly handles multi-byte character boundaries across chunks.
3. **`snippet_selector.ts` L129-156 (greedy set-cover):** The sentence merge uses O(n*m) loop where n=sentences and m=bigrams. For the typical case (<20 sentences), this is negligible. The `splice` on L155 modifies the array in-place during iteration, which is technically correct since the outer while loop re-evaluates `deduped.length`, but a filter-based approach would be cleaner.
4. **`fetch_orchestrator.ts` L118:** `result.content.toLowerCase()` is called on every fetch result validation. For large pages (hundreds of KB), this creates a full lowercase copy. Since the challenge patterns are short and rare, consider using a case-insensitive regex or checking only the first ~2KB of content.

---

## Part 2: Traditional Code Review

### CRITICAL -- Must fix

No critical issues found. The codebase is production-quality with no bugs that would cause data loss or outages.

### HIGH -- Should fix

**H1: Fetch providers don't support AbortSignal, preventing cancellation of HTTP requests in parallel racing**
- **File:** `src/common/types.ts` L35-39, `src/providers/fetch/*/index.ts`
- **What:** The `FetchProvider` interface defines `fetch_url(url: string): Promise<FetchResult>` with no `signal` parameter. All 25 fetch provider implementations use `AbortSignal.timeout(config.fetch.X.timeout)` as a standalone signal rather than composing with an external signal.
- **Why:** In `fetch_orchestrator.ts` `run_parallel`, when `Promise.any` resolves with a winner, the losing providers' HTTP requests continue running to completion, consuming Workers CPU time and provider API quotas. With 2-3 providers racing in parallel, this means 1-2 providers worth of wasted HTTP calls on every parallel step.
- **Fix:** Add `signal?: AbortSignal` to the `FetchProvider.fetch_url` interface. In `fetch_orchestrator.ts`, create an `AbortController` per parallel group, pass its signal through to providers, and abort it when `Promise.any` resolves. Each provider uses `make_signal(timeout, signal)` to compose it with their own timeout.

**H2: `answer_orchestrator.ts` post-deadline array mutation is defended but not fully prevented**
- **File:** `src/server/answer_orchestrator.ts` L130-166, L221-226
- **What:** The `is_done` flag on L133/150 prevents post-deadline `.then()`/`.catch()` callbacks from pushing into `answers`/`failed`. The defensive copy on L223-224 (`[...answers]`, `[...failed]`) creates snapshots. However, there's a race window: between `is_done = true` (L190) and the spread copy (L223), a late-arriving callback could still be scheduled (but won't execute due to `is_done`). The current approach works because JavaScript is single-threaded, but it's worth noting that the `is_done` check and array push are not atomic.
- **Why:** In practice this is safe on CF Workers (single-threaded), but the code comment on L221 ("late-arriving promises may still push") contradicts the `is_done` guard. The comment is misleading.
- **Fix:** Update the comment on L221 to accurately describe the actual behavior: the `is_done` flag prevents mutation, and the defensive copy is a belt-and-suspenders safeguard.

### MEDIUM -- Should fix soon

**M1: REST search returns 200 with potentially very large payload (no default result limit)**
- **File:** `src/server/rest_search.ts` L43, L122
- **What:** When `count` is not provided (default 0), `sorted` returns all results without limit. After RRF ranking across 9 providers with 20 results each, plus rescue from tail, this could be 50+ results with full snippets.
- **Why:** Large payloads increase latency and bandwidth costs. Downstream consumers (Open WebUI) typically only display 5-10 results.
- **Fix:** Default `count` to `DEFAULT_TOP_N` (15) instead of 0 when not provided, and apply `truncate_web_results` before mapping to the REST format.

**M2: `web_search_fanout.ts` retries search providers but `answer_orchestrator.ts` does not**
- **File:** `src/server/web_search_fanout.ts` L100-103, `src/server/answer_orchestrator.ts` L79-83
- **What:** `dispatch_to_providers` wraps each search provider call in `retry_with_backoff` with `max_retries: 1`. The answer orchestrator dispatches AI providers without retry. The comment on L77 explains why ("multi-provider fanout IS the redundancy strategy"), which is a valid design decision.
- **Why:** This is an asymmetry worth calling out. For search, a retry makes sense because each provider returns different results. For AI answers, the fanout across 9 providers provides natural redundancy, making retry less valuable and potentially doubling latency. The current approach is correct.
- **Fix:** No code change needed, but the comment on `answer_orchestrator.ts` L77 could be more prominent (e.g., a `// DESIGN DECISION:` prefix) to prevent future developers from "fixing" this by adding retry.

**M3: `p-retry` dependency for a single usage site**
- **File:** `package.json` L13, `src/common/utils.ts` L134-158
- **What:** The `p-retry` package is imported solely for the `retry_with_backoff` function, which is used only in `web_search_fanout.ts` L100. The `p-retry` package adds a dependency for ~30 lines of retry logic that could be implemented inline.
- **Why:** Reducing dependencies in a Cloudflare Workers context reduces bundle size and attack surface. `p-retry` is well-maintained but adds a transitive dependency tree.
- **Fix:** Consider implementing retry logic inline (it's a simple exponential backoff loop with jitter) and removing the `p-retry` dependency.

**M4: KV cache key collision risk for answer results**
- **File:** `src/server/answer_orchestrator.ts` L237, L285
- **What:** The answer cache key is `answer:` + the raw query string. Two different users with the same query will get the same cached result. This is intentional for deduplication, but the cache includes provider-specific answers that may change over time (e.g., breaking news).
- **Why:** The 24h TTL mitigates staleness, but for time-sensitive queries ("latest news about X"), a cached answer from 23 hours ago could be misleading.
- **Fix:** Consider adding a TTL parameter to the answer tool or using a shorter TTL for queries containing temporal keywords ("today", "latest", "current", "breaking").

### LOW -- Nice to have

**L1: `worker.ts` L178 `@ts-expect-error` for McpServer version mismatch**
- **File:** `src/worker.ts` L178-179
- **What:** The `@ts-expect-error` suppresses a type mismatch between the `agents` package's bundled MCP SDK version (1.26.0) and the project's version (1.27.1). The comment explains the situation well.
- **Why:** This is a known issue with the agents package and the comment is appropriate. When `agents` updates its bundled SDK version, this can be removed.
- **Fix:** Monitor `agents` package updates and remove the suppression when versions align.

**L2: `loggers` factory creates new Logger instances on every call**
- **File:** `src/common/logger.ts` L201-214
- **What:** `loggers.search()`, `loggers.fetch()`, etc. create a new `Logger` instance every time they're called. Most callers assign to a module-level `const logger = loggers.search()` so this is fine, but `web_search_fanout.ts` L95 creates a new logger per provider per search: `const provider = loggers.search(p.name)`.
- **Why:** Logger instances are lightweight (just store a component string), so the allocation overhead is negligible. No real impact.
- **Fix:** No change needed. The current pattern is clear and the overhead is minimal.

### POSITIVE -- What was done well

**P1: SSE keepalive with event-boundary buffering** -- The `inject_sse_keepalive` implementation in `worker.ts` is production-grade. The decision to buffer partial events and only inject pings between complete events prevents protocol corruption. The `safe_write` serialization prevents concurrent writer access. This solves a real problem (Claude web's 45s timeout) elegantly.

**P2: Provider registration pattern** -- The `registration` export with `key: () => config.X.api_key` lazy evaluation is a clean solution to the chicken-and-egg problem of provider registration before config initialization. Adding a new provider requires touching exactly 4 files with one line each, which is excellent for a system with 25+ providers.

**P3: Atomic provider state swap** -- `providers/index.ts` builds new state locally then swaps `active_providers.search = new_search` atomically. This prevents concurrent DO instances from seeing an empty-state window during initialization.

**P4: RRF ranking with quality filters and snippet intelligence** -- The RRF implementation is textbook-correct (k=60), and the quality filters (`MIN_RRF_SCORE`, `MIN_SNIPPET_CHARS_SINGLE_PROVIDER`, rescue from tail) add genuine value over naive deduplication. The snippet selector using Jaccard similarity and sentence-level greedy set cover is a sophisticated touch that reduces token waste.

**P5: Fetch waterfall with domain breakers** -- The two-phase approach (breaker check for known domains, then tiered waterfall) is a smart optimization. YouTube URLs go straight to Supadata instead of wasting 5 providers' quotas on a domain they can't scrape. The challenge pattern detection catches common anti-bot responses that would otherwise be returned as "successful" fetches.

**P6: Defensive error handling in fanout patterns** -- Each orchestrator handles the "all providers failed" case explicitly, returning structured error information (which providers were tried, what errors occurred, duration of each). This is far more useful for debugging than a generic "search failed" error.

**P7: HTTP client with streaming size guard** -- `http.ts` `http_core` reads responses via streaming with a byte counter rather than calling `res.text()`, which prevents OOM from malicious or oversized upstream responses. The 5MB guard with early cancellation (`reader.cancel()`) is the correct approach.

**P8: Request ID correlation via AsyncLocalStorage** -- Using `run_with_request_id` with AsyncLocalStorage (available via `nodejs_compat`) provides cross-cutting request tracing without threading IDs through every function parameter. The lazy initialization of ALS (`get_als()`) with a fallback for environments where it's unavailable is robust.
