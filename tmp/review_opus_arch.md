# Architecture Scorecard & Code Review: Omnisearch MCP Server

---

## Part 1: Architecture Scorecard

---

### Area 1: CONCURRENCY & ASYNC PATTERNS

**Score: 7/10**

**Justification:** The Promise composition is generally well-chosen -- `Promise.allSettled` for web search fanout (wait for all), `Promise.any` for fetch parallel racing (first success wins), and `Promise.race` for the answer deadline. The answer orchestrator's deadline pattern correctly tracks pending providers and aborts via AbortController. However, signal threading is incomplete: search providers ignore `BaseSearchParams.signal` entirely, and the web search fanout never creates or passes an AbortController signal at all. The module-level `fanout_cache` Map is mutable shared state across concurrent requests in the same isolate, but the 30s TTL and read-only-after-write pattern make races benign rather than catastrophic.

**To reach 10/10:**
1. **All 9 search providers use `AbortSignal.timeout()` directly, ignoring `params.signal`.** Change every search provider's `search()` to call `make_signal(config.search.<provider>.timeout, params.signal)` instead, so the web search fanout (and answer fanout's internal web search) can cancel in-flight HTTP requests when a deadline fires.
2. **`run_web_search_fanout` never creates an AbortController.** When `timeout_ms` fires and `dispatch_to_providers` returns partial results, the still-in-flight provider HTTP requests continue running until their individual timeouts expire. Create an `AbortController`, pass its signal through to each provider via `params.signal`, and call `abort()` at the deadline.
3. **`execute_tasks` in `answer_orchestrator.ts` (line 212-213) copies `answers` and `failed` arrays defensively, but late-arriving `.then()` callbacks can still mutate the *original* arrays after the function returns.** The root cause is that the tracked promises' `.then()` closures close over `answers` and `failed` by reference. After the deadline fires and `execute_tasks` returns its defensive copies, a late-arriving provider result pushes into the original `answers` array -- harmless for the caller (who got a copy) but the closures continue to run and allocate. Abort the controller *and* guard the `.then()` callbacks with `if (closed) return;` to prevent post-deadline mutation entirely.
4. **`fanout_cache` has no maximum size bound independent of TTL.** If 50+ unique queries arrive within 30 seconds, the lazy eviction at size > 50 only removes expired entries. Add a hard cap (e.g., evict oldest entry when at capacity) to bound memory in burst scenarios.

---

### Area 2: STREAM HANDLING & SSE

**Score: 8/10**

**Justification:** The SSE keepalive injection is well-designed. The event-boundary buffering (`find_event_boundary` looking for `\n\n`) prevents keepalive pings from being injected mid-event, which would corrupt the SSE framing. The `closed` flag prevents double cleanup. The `event: ping` named event is correctly ignored by MCP SDK clients. The 5-second interval is appropriate for Claude web's ~45s timeout.

**To reach 10/10:**
1. **Buffer concatenation allocates a new `Uint8Array` on every chunk (lines 118-120 in `worker.ts`).** Each `reader.read()` creates `merged = new Uint8Array(buffer.length + value.length)` plus two `.set()` copies. For long SSE streams with many small chunks, this is O(n^2) total allocation. Use a list-of-chunks approach: accumulate chunks in an array, only concatenate when scanning for `\n\n`, or scan the latest chunk for boundaries and only concatenate the tail.
2. **Client disconnect detection is implicit.** When the downstream client disconnects, `writer.write()` will eventually throw, which triggers `cleanup()`. But the pump loop may have already read a chunk from the upstream before attempting to write it, meaning one chunk is lost. This is acceptable for SSE (idempotent events), but documenting this behavior would be helpful.
3. **The `cleanup()` function calls `reader.cancel()` but the pump loop may be blocked on `reader.read()`.** On Cloudflare Workers, `reader.cancel()` should unblock the pending `read()` with `{ done: true }`, but this is runtime-specific. A comment noting this assumption would improve maintainability.

---

### Area 3: ERROR HANDLING & RESILIENCE

**Score: 8/10**

**Justification:** Provider failure isolation is excellent -- every fanout pattern wraps individual provider calls in try/catch, logs failures with timing, and continues to the next provider. The REST endpoints return appropriate status codes (502 when all providers fail, 503 when none configured, 429 for rate limits, 413 for oversized bodies). The `ProviderError` class with `ErrorType` enum provides consistent error classification throughout. The `http_core` utility handles response size limits, JSON parse failures, and HTTP error codes uniformly.

**To reach 10/10:**
1. **The MCP tool handlers catch errors and call `this.format_error()`, but `run_web_search_fanout` is called inside `run_answer_fanout` (for gemini-grounded) without try/catch.** If the internal web search fanout throws an unexpected error (not a provider error), it would propagate as an unhandled rejection inside the gemini-grounded task's promise. Wrap the `run_web_search_fanout` call inside the gemini-grounded task builder (line 85 of `answer_orchestrator.ts`) in a try/catch.
2. **`http_core` on 429 calls `handle_rate_limit()` which always throws, but the `switch` statement has a `break` after it (line 107 of `http.ts`).** This `break` is dead code. While harmless, it obscures the control flow -- the reader expects fall-through to the default case, but `handle_rate_limit` is `(): never`. Remove the `break` to clarify that `handle_rate_limit` throws unconditionally.
3. **The health endpoint (`/` and `/health`) does not add CORS headers.** If a browser-based client pings `/health`, the response will lack `Access-Control-Allow-Origin`.

---

### Area 4: DATA FLOW & PROVIDER ORCHESTRATION

**Score: 9/10**

**Justification:** The three orchestration patterns are cleanly separated and well-suited to their use cases. The web search fanout's `dispatch -> merge -> RRF rank -> quality filter -> truncate with rescue` pipeline is sophisticated and effective -- the rescue mechanism that promotes unique-domain high-rank results from the tail is a smart detail. The fetch waterfall with domain breakers is pragmatic and the tiered waterfall (solo -> parallel -> sequential) provides a good balance of speed vs. coverage. The answer fanout correctly uses the web search fanout's cache to avoid a redundant search for gemini-grounded.

**To reach 10/10:**
1. **The fetch orchestrator's `CONFIG` (breakers and waterfall) is hardcoded in TypeScript.** The comment says "keep the const below in sync with config.yaml" but there is no config.yaml -- this is the only source of truth. Remove the misleading comment, or better, make the waterfall order configurable via environment variables or a wrangler var so it can be tuned without redeployment.
2. **`retry_with_backoff` is used in `web_search_fanout.ts` with `1` retry, meaning it retries once.** The multi-provider fanout IS the redundancy strategy (as the comment in `answer_orchestrator.ts` notes), so retrying individual search providers adds latency without much benefit -- a 30s timeout + 1 retry = potentially 60s for one slow provider. Consider removing the retry from the web search fanout entirely (pass `0` retries), relying purely on the multi-provider redundancy.

---

### Area 5: CODE ORGANIZATION & MODULARITY

**Score: 9/10**

**Justification:** The file structure is clean and predictable: `common/` for shared utilities, `config/` for environment handling, `providers/{category}/{name}/index.ts` for each provider, `providers/unified/` for dispatchers, `server/` for orchestration and API handlers. The dependency graph is acyclic -- providers depend on `common/` and `config/`, orchestrators depend on providers and common, worker depends on everything. Each provider follows an identical pattern (class + `registration` export), making it trivial to add new providers. The unified dispatchers use a clean registration table pattern.

**To reach 10/10:**
1. **Module-level mutable state is spread across three files: `config/env.ts` (the `config` object + `let` exports), `server/tools.ts` (`active_providers` + `ToolRegistry` singleton), and `web_search_fanout.ts` (`fanout_cache`).** Consider consolidating all mutable state into a single `state.ts` module, or even better, pass state through the DO's `this` context rather than relying on module-level singletons. This would make the code testable without module-level side effects.
2. **The `active_providers` set in `tools.ts` is exported and mutated directly by `providers/index.ts`.** This creates a tight coupling between the provider initialization module and the tool registry. Instead, `initialize_providers` could return the sets and the caller could pass them to wherever they're needed.

---

### Area 6: TYPE SAFETY & INTERFACES

**Score: 7/10**

**Justification:** TypeScript strict mode is enabled and the core types (`SearchResult`, `FetchResult`, `BaseSearchParams`, `ProviderError`) are well-designed and consistently used. The Zod schemas in tool definitions match the actual return shapes. The `config` object uses `as string | undefined` type assertions for initial values, which is functional if ugly. Provider registration uses `as const` for literal types on provider names, enabling the `WebSearchProvider` and `FetchProviderName` union types.

**To reach 10/10:**
1. **The `config` object in `config/env.ts` uses inline `as` casts (`undefined as string | undefined`, `'' as string`) rather than a proper type definition.** Define a `ProviderConfig` interface (or per-category interfaces) and type the config object properly. This would enable the compiler to catch missing fields when adding new providers.
2. **`structuredContent` is cast to `Record<string, unknown>` in multiple places (tools.ts lines 155, 229).** Define proper output types that match the Zod output schemas and use those types directly, eliminating the `as unknown as Record<string, unknown>` casts.
3. **`validate_config` casts entries to `(c as { api_key?: string })` (line 347 of `config/env.ts`) because the config object's type is inferred from its value rather than declared.** With proper config typing this cast would be unnecessary.
4. **`apply_search_operators` returns `params as unknown as SearchParams` (line 103 of `search_operators.ts`).** Build the result object with proper typing rather than accumulating into `Record<string, unknown>` and casting.
5. **The `@ts-expect-error` on the McpServer property in `worker.ts` is well-documented and justified (SDK version mismatch between `agents` and the project's own dependency).** No change needed there.

---

### Area 7: CONFIGURATION & ENVIRONMENT

**Score: 8/10**

**Justification:** The `initialize_config` / `validate_config` pattern is well-structured -- it maps all env bindings to the typed `config` object in a single place, logs which providers are available vs missing, and the atomic swap in `initialize_providers` prevents a half-initialized state. The provider auto-discovery pattern (each provider exports a `registration` with a `key()` function that reads from config) is elegant and means adding a new provider requires exactly 3 changes. The wrangler.toml is correct with the DO binding, SQLite migration, and `nodejs_compat` flag.

**To reach 10/10:**
1. **`initialize_config` is called on every REST request (lines 216-218 and 237-239 of `worker.ts`) and on every DO init.** For REST requests, this means every single request re-writes all ~60 config fields. Since env bindings are immutable within a Worker isolate's lifetime, this is wasted work on all but the first request. Add a `let initialized = false` guard to skip re-initialization if config is already populated (similar to the `_init_promise` pattern in the DO class).
2. **Timeouts are hardcoded per-provider in `config/env.ts` with no way to override via environment variables.** Add optional env vars like `TAVILY_TIMEOUT_MS` that override the defaults, enabling timeout tuning without redeployment.
3. **The `wrangler.toml` uses `new_sqlite_classes` in the migration, but the code never uses SQLite storage on the DO.** The `McpAgent` base class may use it internally for session state, but this should be verified. If not needed, `new_classes` would be more appropriate than `new_sqlite_classes` to avoid the SQLite storage overhead.

---

### Area 8: OBSERVABILITY & DEBUGGING

**Score: 8/10**

**Justification:** Structured JSON logging is consistent throughout. Every orchestrator logs start/complete/failure with timing (`duration_ms`), provider names, and operation tags (`op` field). The `request_id` is generated at the Worker entry point and passed through to log context. The `http_core` utility logs every outbound HTTP request and response with sanitized URLs (sensitive query params redacted). Provider-specific loggers include the provider name in the component field.

**To reach 10/10:**
1. **`request_id` is generated in the Worker fetch handler but never propagated to the DO's `init()` or tool handlers.** MCP tool calls arrive through the DO, so the request_id from the Worker's fetch handler is logged only for the initial routing -- all downstream orchestrator and provider logs lack a request_id. Thread the request_id through tool handler context (e.g., store it on the DO instance when the request arrives).
2. **The logger creates a new `Logger` instance on every call to `loggers.search()`, `loggers.fetch()`, etc.** These are cheap objects, but the factory pattern means there's no way to set a request-scoped request_id on a logger and have it flow through to all downstream calls. Consider a request-scoped logger pattern using AsyncLocalStorage (available on CF Workers with `nodejs_compat`).
3. **The SSE keepalive injection has no logging.** When `inject_sse_keepalive` starts pumping, when pings are sent, or when the stream closes -- none of these are logged. Add debug-level logging for SSE lifecycle events.
4. **The `fanout_cache` hit/miss is logged at debug level, which is good.** However, cache eviction (the lazy cleanup at size > 50) is not logged at all. Add a debug log when entries are evicted.

---

### Area 9: API DESIGN & PROTOCOL COMPLIANCE

**Score: 8/10**

**Justification:** The MCP protocol implementation is correct -- tool schemas use Zod with proper input/output definitions, resources are registered with URIs and MIME types, and the Streamable HTTP transport is handled by the `agents` package. REST API design is solid with appropriate status codes, input validation (query length, body size, URL format), and error shapes. The tool descriptions are detailed and helpful for LLM consumers, clearly explaining what each tool does and when to use which.

**To reach 10/10:**
1. **The `web_search` tool description mentions "You.com" as one of the 9 providers, but the You.com AI search provider was removed (commit `7e226a6`).** The You.com *web search* provider still exists, but the tool description could be misleading. Update the description to reflect the actual current provider list dynamically, or at least ensure the count and names are accurate.
2. **The `answer` tool description claims "9 providers" but the actual count depends on which API keys are configured.** Consider making the description dynamic (populated at registration time from `get_active_ai_providers()`) so it reflects reality rather than a hardcoded claim.
3. **The REST `/search` endpoint returns `[{ link, title, snippet }]` while the MCP tool returns `{ web_results: [{ url, title, snippets, score, source_providers }] }`.** The field name mismatch (`link` vs `url`, `snippet` singular vs `snippets` array) could confuse consumers switching between REST and MCP. This is likely intentional for Open WebUI compatibility, but documenting the mapping would be helpful.
4. **The `404` response for unknown routes does not include CORS headers.** A browser-based client hitting an incorrect path would get a CORS error instead of a clear 404.

---

### Area 10: PERFORMANCE & RESOURCE EFFICIENCY

**Score: 8/10**

**Justification:** The architecture is fundamentally sound for performance -- parallel fanout with early-return patterns, short-lived caching to deduplicate the web search inside the answer fanout, and the waterfall pattern that stops at the first successful fetch. The `SSE_PING` constant is pre-encoded as a `Uint8Array` at module load, avoiding repeated `TextEncoder` allocations. The `http_core` utility guards against oversized responses (5MB limit).

**To reach 10/10:**
1. **`timing_safe_equal` in `utils.ts` creates a new `TextEncoder` on every call (line 14).** Move the encoder to module scope (`const encoder = new TextEncoder()`) since `TextEncoder` is stateless and reusable.
2. **The SSE buffer concatenation is O(n^2) as noted in Area 2.** This is the most impactful performance issue on the hot path for long-running MCP sessions.
3. **Every provider `search()` call that goes through `retry_with_backoff` in the web search fanout creates a new `pRetry` wrapper.** Since the web search fanout dispatches to all providers in parallel with only 1 retry, and the answer fanout doesn't retry at all, the overhead is minimal -- but the `pRetry` dependency could be replaced with a simple inline retry loop, eliminating the dependency entirely.
4. **`UnifiedWebSearchProvider`, `UnifiedAISearchProvider`, and `UnifiedFetchProvider` each instantiate all provider classes in their constructor (via `PROVIDERS.map(p => [p.name, p.factory()])`), including providers whose API keys are not configured.** These unused provider instances are small (just a name + description), but it's wasteful. Filter the PROVIDERS list to only instantiate providers with valid keys.

---

## Part 2: Traditional Code Review

---

### CRITICAL

None found.

---

### HIGH

**H1. Search providers do not respect `params.signal`, making web search fanout uncancellable**

- **Files:** All 9 files under `src/providers/search/*/index.ts`
- **What:** Every search provider passes `AbortSignal.timeout(config.search.<name>.timeout)` directly to `fetch()`, completely ignoring `params.signal` from `BaseSearchParams`. The `make_signal()` utility exists specifically for this purpose but is not used by any search provider.
- **Why:** When the web search fanout's `timeout_ms` deadline fires and returns partial results, the remaining in-flight HTTP requests continue running until their individual timeouts (10-30s) expire, consuming Worker CPU time and billable subrequests. More critically, when the answer orchestrator's 2-minute global deadline fires and aborts, the gemini-grounded task's internal web search fanout cannot be cancelled.
- **Fix:** In each search provider's `search()` method, change `signal: AbortSignal.timeout(config.search.<name>.timeout)` to `signal: make_signal(config.search.<name>.timeout, params.signal)`. Then in `web_search_fanout.ts`, create an `AbortController` and pass its signal as part of the search params.

**H2. `initialize_config` + `initialize_providers` run on every REST request with no idempotency guard**

- **File:** `src/worker.ts`, lines 216-219, 237-240
- **What:** Every `POST /search` and `POST /fetch` request calls `initialize_config(env)`, `validate_config()`, and `initialize_providers()`. These functions overwrite all module-level config fields, reconstruct all unified provider instances (instantiating 25+ fetch provider classes, 9 search provider classes, 8 AI provider classes), and rebuild the `active_providers` sets.
- **Why:** On a busy Worker with many concurrent requests, this is pure waste -- env bindings don't change within an isolate's lifetime. More concerning, `initialize_providers()` calls `register_web_search_provider(new UnifiedWebSearchProvider())` which replaces the singleton in the `ToolRegistry`, potentially during a concurrent in-flight tool call that holds a reference to the previous provider instance. The "atomic swap" in `initialize_providers` only protects `active_providers`, not the ToolRegistry's provider references.
- **Fix:** Add `let _initialized = false;` at module scope. In the REST handler, check `if (!_initialized) { initialize_config(env); validate_config(); initialize_providers(); _initialized = true; }`. The DO already handles this correctly with `_init_promise`.

---

### MEDIUM

**M1. `fanout_cache` is a module-level Map shared across all DO instances in the same isolate**

- **File:** `src/server/web_search_fanout.ts`, lines 18-38
- **What:** The `fanout_cache` Map is module-scoped. On Cloudflare Workers, multiple DO instances can share the same isolate, meaning one user's query cache can serve a different user's request.
- **Why:** This is actually beneficial for performance (deduplication) and the data is not sensitive (just search results for a query). However, it means cache hits are non-deterministic -- they depend on isolate scheduling. This could cause confusion during debugging if one request gets cached results from a different session.
- **Fix:** If this is intentional (it appears to be), add a comment explicitly noting the cross-DO cache sharing behavior. If session isolation is desired, scope the cache to the DO instance (pass a cache Map as a parameter rather than using module scope).

**M2. `validate_config` logs all available and missing provider names at `info` level on every call**

- **File:** `src/config/env.ts`, lines 342-379
- **What:** Every time `validate_config()` is called, it logs the full list of available and missing providers. Combined with H2 (called on every REST request), this generates two info-level log lines with 40+ provider names per request.
- **Why:** Log volume. On a busy server, this generates significant log noise for zero diagnostic value after the first call.
- **Fix:** Log at `debug` level instead of `info`, or only log on first initialization.

**M3. `answer_orchestrator` builds gemini-grounded task outside the tracked promise pattern**

- **File:** `src/server/answer_orchestrator.ts`, lines 82-93
- **What:** The gemini-grounded task is built with an immediately-invoked async IIFE that first calls `run_web_search_fanout` and then `gemini_grounded_search`. If `run_web_search_fanout` throws, the error propagates as a rejection of the task's promise (which is correctly caught by `execute_tasks`). However, the web search fanout call does not receive the `signal` parameter, so it cannot be aborted when the global deadline fires.
- **Why:** If the answer orchestrator's 2-minute deadline fires while gemini-grounded is still waiting for its internal web search fanout, those HTTP requests continue running.
- **Fix:** Pass `signal` to `run_web_search_fanout` (which would require adding signal support to the web search fanout, per H1).

**M4. The `fetch` tool description is hyperbolic**

- **File:** `src/server/tools.ts`, lines 169-173
- **What:** The fetch tool description claims "military-grade", "near-100% success rate", handles "CAPTCHAs", "age gates", and "geo-restrictions". These claims may not be accurate for all URL types and could set incorrect expectations for LLM consumers.
- **Why:** An LLM that trusts this description may not implement fallback logic when the fetch tool fails, or may make excessive retry attempts.
- **Fix:** Tone down the description to be factual: describe the waterfall mechanism, the number of providers, and what types of content it handles well, without superlative claims about success rates.

---

### LOW

**L1. `TextEncoder` instantiation in `timing_safe_equal`**

- **File:** `src/common/utils.ts`, line 14
- **What:** A new `TextEncoder` is created on every call to `timing_safe_equal`.
- **Why:** Minor allocation overhead on the auth path for REST requests.
- **Fix:** Move `const encoder = new TextEncoder()` to module scope.

**L2. `supadata` fetch provider uses a hardcoded 10-second timeout for transcript metadata**

- **File:** `src/providers/fetch/supadata/index.ts`, line 60
- **What:** `AbortSignal.timeout(10000)` instead of using the configured timeout.
- **Why:** Inconsistency -- if the configured timeout is changed, this one is missed.
- **Fix:** Use `config.fetch.supadata.timeout` or a fraction thereof.

**L3. Dead `break` after `handle_rate_limit` in `http_core`**

- **File:** `src/common/http.ts`, line 107
- **What:** `handle_rate_limit()` has return type `never` (it always throws), but there's a `break` statement after it.
- **Why:** Dead code that obscures control flow.
- **Fix:** Remove the `break`.

**L4. `p-retry` dependency could be eliminated**

- **File:** `package.json`, `src/common/utils.ts`
- **What:** The `p-retry` package is used only in `retry_with_backoff`, which is called with 1 retry in web search fanout and 3 retries in... nothing else (the default is 3 but no caller uses the default).
- **Why:** An additional dependency for a simple retry loop. The `shouldRetry` logic is already custom.
- **Fix:** Replace with a ~15-line inline retry function, reducing the dependency count.

---

### POSITIVE

**P1. Excellent provider registration pattern.** The `{ name, key, factory }` registration tuple combined with the unified dispatcher's `PROVIDERS` array makes adding a new provider a mechanical 3-step process. This is a textbook example of the Open/Closed Principle applied well.

**P2. The RRF ranking with rescue mechanism is well-engineered.** The `rescue_tail_results` function that promotes unique-domain, high-intra-rank results from beyond the top-N cutoff is a thoughtful addition that prevents good results from being lost just because they're from a unique domain that only one provider returned.

**P3. The SSE keepalive with event-boundary buffering is exactly correct.** Injecting `event: ping` (a named event that MCP SDK ignores) only between complete events (when `buffer.length === 0`) is a robust solution to a real operational problem. Many implementations get this wrong by injecting keepalives mid-event.

**P4. The defensive copy in `execute_tasks` (lines 212-213 of `answer_orchestrator.ts`).** The comment explicitly explains why: "late-arriving promises may still push into the original arrays after we return." This shows awareness of the subtle concurrency hazard with Promise.race returning before all promises settle.

**P5. `make_signal` composing AbortSignal.any.** The utility correctly composes an external cancellation signal with a per-provider timeout into a single signal. It's just underutilized (see H1).

**P6. The `http_core` shared utility.** Centralizing HTTP call mechanics (timing, size guards, error classification, URL sanitization for logging) in one place ensures consistent behavior across 35+ providers. This is a major maintainability win.

**P7. The fetch waterfall's challenge/block detection.** The `is_fetch_failure` function that checks content length and common bot-detection patterns (`'just a moment'`, `'checking your browser'`, etc.) is a pragmatic approach to detecting when a fetch "succeeded" at the HTTP level but returned garbage.

**P8. Clean separation between MCP and REST paths.** Both paths converge on the same orchestrators (`run_web_search_fanout`, `run_answer_fanout`, `run_fetch_race`), meaning there's zero logic duplication between the two API surfaces. This is a good architectural decision.
