# Architecture Scorecard & Code Review: Omnisearch MCP Server

**Reviewer:** Claude Opus 4.6
**Date:** 2026-03-22
**Scope:** Full codebase review (round 2)

---

## Part 1: Architecture Scorecard

---

### Area 1: CONCURRENCY & ASYNC PATTERNS

**Score: 8/10**

**Justification:** The fanout patterns are well-chosen and correctly applied. `Promise.allSettled` for web search, `Promise.race` with deadline for answer fanout, `Promise.any` for fetch parallel groups — each matches its use case. The `is_done` flag + defensive copy in `answer_orchestrator.ts` correctly handles the post-deadline mutation window. The `make_signal` utility with `AbortSignal.any` polyfill is solid. The `write_lock` promise chain in the SSE keepalive serializes concurrent writes correctly.

**To reach 10/10:**
1. **answer_orchestrator.ts:128-129** — The `is_done` guard prevents array mutation but late-arriving `.then()` callbacks still execute. After `abort_controller.abort()` on deadline, add a comment or consider using `WeakRef` to allow GC of the `answers`/`failed` arrays once the defensive copy is taken.
2. **answer_orchestrator.ts:84-93** — The `gemini-grounded` task calls `run_web_search_fanout` but does not pass the `signal` from the `AbortController`. If the global deadline fires and aborts, the inner web search fanout will continue running until its own timeouts expire. Thread the signal: `run_web_search_fanout(web_search_ref, query, { signal })`.
3. **web_search_fanout.ts:120-125** — When `timeout_ms` fires, pending provider promises are not cancelled. The providers will keep running and mutating `results_by_provider`, `providers_succeeded`, and `providers_failed` after the snapshot is taken. The snapshot (lines 140-143) mitigates this, but passing a signal to each provider and aborting on deadline would free network resources sooner.
4. **fetch_orchestrator.ts:167-179** — In `run_parallel`, when `Promise.any` resolves with the first success, the losing providers' HTTP requests continue running to completion. Consider creating a per-step `AbortController` and aborting it when the first provider succeeds, so losing providers' fetch calls are cancelled.

---

### Area 2: STREAM HANDLING & SSE

**Score: 8/10**

**Justification:** The SSE keepalive injection is carefully designed. The event-boundary buffering ensures pings are only injected between complete SSE events (never mid-event). The `safe_write` lock prevents concurrent writes to the `WritableStreamDefaultWriter`. The `closed` flag prevents double-cleanup. The `\n\n` boundary scanner is correct for SSE framing.

**To reach 10/10:**
1. **worker.ts:101-106** — `find_event_boundary` scans for `\n\n` (0x0a 0x0a), which is correct per the SSE spec. However, the spec also allows `\r\n\r\n` and `\r\r` as event boundaries. While the `agents` package likely only emits `\n`, defensive handling of `\r\n` would make this future-proof. Replace the `\n\n` scan with a regex-based approach or additionally check for `\r\n\r\n`.
2. **worker.ts:90-98** — `flatten()` is called on every `flush_complete_events()`, which runs on every chunk read. If the upstream sends many small chunks, this repeatedly allocates and copies the entire buffer. Consider maintaining a `Uint8Array` ring buffer or tracking the scan offset into the chunk list to avoid re-scanning already-processed bytes.
3. **worker.ts:68** — `closed` flag is not atomic. If `cleanup()` is called simultaneously from the pump's `finally` block and from a `safe_write` `.catch(cleanup)`, there is a theoretical (though practically unlikely on single-threaded JS) window where `clearInterval` is called twice. This is harmless since `clearInterval` is idempotent, but `reader.cancel()` and `writer.close()` could throw if called after already being called. They are `.catch(() => {})`'d, so this is fine in practice.
4. **worker.ts:62-160** — Client disconnect is not explicitly detected. When the SSE client drops, `writer.write()` will eventually reject, triggering cleanup via the `safe_write` catch. This is correct but reactive — the server-side pump continues until the next write attempt. There is no way to get a proactive "client gone" signal from CF Workers' `TransformStream`, so this is an inherent limitation, not a bug.

---

### Area 3: ERROR HANDLING & RESILIENCE

**Score: 9/10**

**Justification:** Error isolation is excellent. Each provider is wrapped in its own try/catch within the fanout loops, so one provider's failure never crashes others. The `ProviderError` type system (API_ERROR, RATE_LIMIT, INVALID_INPUT, PROVIDER_ERROR) enables correct retry decisions in `retry_with_backoff`. REST endpoints return appropriate status codes (400, 401, 413, 429, 502, 503). The total-failure case returns 502 instead of a misleading empty 200. The `http_core` utility handles response size limits, JSON parse failures, and rate limits consistently.

**To reach 10/10:**
1. **worker.ts:268** — The REST `/search` handler catches the `ensure_rest_initialized` error but does not catch errors thrown by `handle_rest_search` itself. If `handle_rest_search` throws an unhandled error (e.g., a bug in `run_web_search_fanout`), it would propagate to the top-level fetch handler and return a generic 500 without CORS headers. Wrap the `handle_rest_search(request)` call in a try/catch that returns `add_cors_headers(Response.json({ error: 'Internal server error' }, { status: 500 }))`.
2. **http.ts:100-113** — On a 429 response, `handle_rate_limit` throws. But the function falls through after the `switch` statement if the status is 429 (line 106 calls `handle_rate_limit` which throws, but TypeScript doesn't know that from the control flow since it's not annotated with `: never`). Actually, `handle_rate_limit` does return `never`, so this is correct. No issue here after re-reading.

---

### Area 4: DATA FLOW & PROVIDER ORCHESTRATION

**Score: 9/10**

**Justification:** The three orchestration patterns are well-differentiated and appropriate. Web search uses `allSettled` to wait for all providers (maximizing dedup via RRF). Answer fanout uses `race(all, deadline)` with abort to bound latency. Fetch uses a tiered waterfall with domain breakers for specialized providers. The RRF ranking with quality filtering and rescue-tail is sophisticated. The query cache in `web_search_fanout.ts` correctly deduplicates the `gemini-grounded` inner web search. Provider registration follows a consistent `config -> key check -> factory -> unified dispatcher` pattern.

**To reach 10/10:**
1. **web_search_fanout.ts:38-45** — The cache uses FIFO eviction (Map insertion order), not LRU. Since Map preserves insertion order but doesn't reorder on access, a cache hit at line 29-36 doesn't move the entry to the "newest" position. For a 50-entry cache with 30s TTL, this is unlikely to matter in practice, but calling `fanout_cache.delete(key)` then `fanout_cache.set(key, entry)` on hit would make it true LRU.
2. **answer_orchestrator.ts:81-93** — The `gemini-grounded` task runs a full web search fanout as a sub-step, then feeds results to Gemini. If the web search fanout is slow, this provider has a structural latency disadvantage compared to providers that do their own search server-side. This is acknowledged by the 120s global deadline, but it means `gemini-grounded` is more likely to be cut off. Consider giving it a head start by launching the web search earlier or using the cache more aggressively.

---

### Area 5: CODE ORGANIZATION & MODULARITY

**Score: 9/10**

**Justification:** The directory structure is clean and consistent: `common/` for shared utilities, `config/` for env, `providers/` with three subcategories plus `unified/` dispatchers, `server/` for orchestration, `types/` for shared interfaces. Each provider is a self-contained file with a consistent export shape (`class + registration`). There are no circular dependencies — the dependency graph flows strictly downward: `worker -> server -> providers -> common`. Module-level state (`config`, `active_providers`, `ToolRegistry` singleton, `fanout_cache`) is minimal and well-documented.

**To reach 10/10:**
1. **providers/index.ts** imports from `server/tools.ts` (`active_providers`, `register_*` functions), and `server/tools.ts` imports from `providers/unified/*.ts`. This creates a bidirectional dependency between `server/` and `providers/`. Move `active_providers` to a separate file (e.g., `common/state.ts` or `providers/state.ts`) to break the cycle.
2. **Testability** — The module-level `config` object (mutable globals), the `ToolRegistry` singleton, and the `fanout_cache` are all module-scoped state that makes unit testing harder. Passing config as a parameter to provider constructors (or using a DI-like pattern) would improve testability, though the current approach is pragmatic for a Workers project without a test framework.

---

### Area 6: TYPE SAFETY & INTERFACES

**Score: 7/10**

**Justification:** TypeScript strict mode is enabled, which is good. The core types (`SearchResult`, `FetchResult`, `BaseSearchParams`) are well-designed and consistently used. The `ProviderError` class with `ErrorType` enum enables type-safe error handling. However, there are several areas where type safety is weakened.

**To reach 10/10:**
1. **config/env.ts:16-250** — The `config` object uses `undefined as string | undefined` casts for all API keys. This works but means the config shape is not narrowed after `initialize_config` runs — callers must still check for `undefined` everywhere. Consider a two-phase approach: a raw config type (all optional) and a validated config type (keys present for active providers only).
2. **tools.ts:155** — `as unknown as Record<string, unknown>` cast on `answer_result` to satisfy `structuredContent`. This loses all type safety. The MCP SDK's `structuredContent` type should ideally be generic. Since it's not, this cast is pragmatically necessary but should be documented.
3. **search_operators.ts:103** — `params as unknown as SearchParams` double-cast discards type safety entirely. Build the `SearchParams` object using typed field assignments instead of a `Record<string, unknown>` intermediary.
4. **providers/unified/ai_search.ts:29** — `typeof PROVIDERS[number]['name']` produces a union of literal string types, which is good. But `AISearchProvider` is used in `answer_orchestrator.ts:78` via `ap.name as AISearchProvider`, an unchecked cast. The `get_active_ai_providers` return type should already carry the literal type so the cast is unnecessary.
5. **Multiple provider files** — `handle_provider_error` always returns `never` but TypeScript does not infer this from the `catch` blocks. Adding `return` before `handle_provider_error(...)` calls (even though it's dead code) would help readability and make the control flow explicit.
6. **tools.ts:103** — `error as Error` cast in catch block. If a non-Error value is thrown (e.g., a string from a third-party library), this will produce incorrect error formatting. Use `error instanceof Error ? error : new Error(String(error))`.

---

### Area 7: CONFIGURATION & ENVIRONMENT

**Score: 8/10**

**Justification:** The config initialization pattern is clear: `initialize_config(env)` populates module-level globals from Workers env bindings, then `validate_config()` logs availability. The `_rest_init` / `_init_promise` rejected-promise-retry pattern ensures initialization is retried on failure. Provider auto-discovery is driven by API key presence — if a key exists, the provider is active. Timeout values are per-provider and reasonable (10-60s for fetch, 180s for AI).

**To reach 10/10:**
1. **config/env.ts:253-339** — `initialize_config` unconditionally overwrites all config values on every call. In the DO path, `init()` is called once per activation, which is correct. But in the REST path, `ensure_rest_initialized` uses the memoized `_rest_init` promise, so `initialize_config` only runs once per isolate. If an isolate handles requests for different Workers environments (theoretically possible with Workers for Platforms), this would use stale config. This is not a real concern for standard Workers deployments.
2. **config/env.ts** — Timeout constants are hardcoded in the config object and not overridable via env vars. Adding optional env var overrides (e.g., `TAVILY_TIMEOUT_MS`) for the most critical timeouts would aid operational tuning without redeployment.
3. **wrangler.toml** — The migration tag is `v1` with `new_sqlite_classes`. This is correct for the initial deployment, but there is no documentation of what happens on subsequent schema changes. Adding a comment noting that future migrations require incrementing the tag would prevent deployment issues.
4. **config/env.ts:92-107** — The LLM search providers (chatgpt, claude, gemini) share a single `LLM_SEARCH_API_KEY` and `LLM_SEARCH_BASE_URL`. If different models require different endpoints (e.g., routing through different proxy paths), this shared config becomes a limitation. Consider per-model base URL overrides.

---

### Area 8: OBSERVABILITY & DEBUGGING

**Score: 8/10**

**Justification:** Logging coverage is comprehensive. Every significant operation has structured log entries with `op` fields, durations, provider names, and error details. The component-based logger factory (`loggers.search('tavily')`) enables filtering. The `sanitize_url` and `sanitize_for_log` utilities prevent sensitive data leakage. Request IDs are generated at the worker level and passed to log entries.

**To reach 10/10:**
1. **Request ID propagation** — The `request_id` generated in `worker.ts:239` is logged at the worker level but is NOT passed down to `handle_rest_search`, `handle_rest_fetch`, or the MCP tool handlers. This means provider-level logs (e.g., from `http_core`) cannot be correlated back to the originating request. Thread `request_id` through the call chain or use a per-request context (e.g., `AsyncLocalStorage` equivalent for Workers).
2. **SSE keepalive** — The keepalive injection has no logging. When debugging timeout issues, it would be useful to log when pings are sent and when the buffer is non-empty (blocking a ping). Add a `logger.debug('SSE ping sent')` inside the interval callback.
3. **Fetch waterfall** — `run_fetch_race` logs waterfall start and end, but individual step transitions are not logged. When debugging why a particular URL took 20 seconds, it's hard to see which step was being executed at each point. Add `logger.debug('Executing step', { step_index, step_type, providers })` at the top of the waterfall loop.
4. **answer_orchestrator.ts** — The progress interval logs pending providers every 5s, which is good. But when the deadline fires and providers are aborted, there is no log entry for which provider was actively in-flight vs. which hadn't started yet.

---

### Area 9: API DESIGN & PROTOCOL COMPLIANCE

**Score: 8/10**

**Justification:** MCP compliance looks correct — tool registration uses proper Zod schemas for both input and output, resources use the `ResourceTemplate` API correctly, and the `McpAgent.serve()` handles Streamable HTTP transport. REST API design is clean with appropriate status codes. CORS is comprehensive with correct headers for MCP session management. Input validation is thorough (query length, body size, URL format).

**To reach 10/10:**
1. **tools.ts:73** — The `web_search` tool description mentions "You.com" but the `you.com` provider was removed (commit `7e226a6`). The description lists 9 providers but the actual count depends on which API keys are configured. Consider generating the description dynamically from `get_active_search_providers()` at registration time.
2. **tools.ts:117** — The `answer` tool description similarly hardcodes provider names and counts. Same fix: generate dynamically.
3. **tools.ts:82-94** — The `outputSchema` for `web_search` includes `snippets: z.array(z.string()).optional()`, but the actual output sometimes returns `snippets` as an empty array rather than omitting it. This is technically schema-compliant (optional allows both), but could be tightened.
4. **rest_search.ts:59** — `count = Math.max(0, body.count ?? 0)` means `count: 0` and `count: undefined` both produce 0, which means "return all results" (line 138). This is unintuitive — a user passing `count: 0` might expect 0 results. Consider treating 0 as "all" explicitly in docs, or rejecting 0.
5. **worker.ts:293-301** — The health endpoint does not include CORS headers. While health checks are typically called by monitoring systems (not browsers), adding CORS would be consistent with other endpoints.

---

### Area 10: PERFORMANCE & RESOURCE EFFICIENCY

**Score: 8/10**

**Justification:** The codebase is generally efficient for a Workers environment. The `TextEncoder` for SSE pings is pre-allocated at module level (line 60). The `http_core` response size guard (5MB) prevents OOM. The fetch waterfall avoids redundant HTTP calls by stopping at the first success. The RRF ranking uses `Map`-based lookups, not nested loops. The `flatten()` function avoids O(n^2) concatenation by tracking chunk lists.

**To reach 10/10:**
1. **worker.ts:60** — `SSE_PING` is pre-encoded once, which is efficient. But `flush_complete_events` calls `safe_write(buf.subarray(offset, abs))` in a loop, creating new `Uint8Array` views on each iteration. These are cheap (views, not copies), so this is fine.
2. **rrf_ranking.ts:49-51** — `[...results].sort()` creates a copy of each provider's results array for sorting. With 9 providers x 20 results each = 180 items, this is negligible.
3. **snippet_selector.ts:129-155** — The greedy set-cover in `sentence_merge` has O(n*m) complexity where n = sentences, m = bigrams. For typical snippet sizes (a few sentences), this is fast. But `collapse_snippets` runs this for every result in the ranked list, so it scales as O(results * sentences * bigrams). With 50+ merged results and diverse snippets, this could become the bottleneck for very large result sets.
4. **providers/unified/*.ts constructors** — Each `UnifiedWebSearchProvider`, `UnifiedAISearchProvider`, and `UnifiedFetchProvider` constructor instantiates ALL registered providers via their factory functions, even providers without API keys. The `search()`/`fetch_url()` method then selects by name. Consider lazily instantiating providers or filtering by active keys in the constructor.
5. **web_search_fanout.ts:89-91** — `retry_with_backoff` wraps each search provider with 1 retry and 2-5s backoff. For 9 parallel providers, this means worst case a single slow provider could add 5s to the total fanout time when no `timeout_ms` is specified. The retry count of 1 is well-chosen to limit this.

---

## Part 2: Traditional Code Review

---

### CRITICAL

None found.

---

### HIGH

**H1. Gemini-grounded ignores AbortSignal for inner web search fanout**
- **File:** `src/server/answer_orchestrator.ts`, lines 84-88
- **What:** The `gemini-grounded` task calls `run_web_search_fanout(web_search_ref, query)` without passing `signal`. When the 120s global deadline fires and the AbortController aborts, the inner web search (which spawns 9 provider HTTP requests) continues running until each provider's individual timeout expires.
- **Why:** This wastes CPU and network resources in the DO/Worker isolate after the answer has already been returned. In the worst case, 9 provider requests with 30s timeouts continue for up to 30s after the deadline.
- **Fix:** Change line 85 to `run_web_search_fanout(web_search_ref, query, { signal })`.

**H2. REST endpoints can throw unhandled errors**
- **File:** `src/worker.ts`, lines 268, 286
- **What:** `handle_rest_search(request)` and `handle_rest_fetch(request)` are awaited without a try/catch. While the handlers themselves catch most errors internally, an unexpected throw (e.g., from `run_web_search_fanout` or `run_fetch_race` due to a bug) would propagate to the top-level `fetch` handler and return a response without CORS headers.
- **Why:** Without CORS headers, the browser client would see a CORS error instead of the actual error, making debugging impossible.
- **Fix:** Wrap each `await handle_rest_search(request)` / `await handle_rest_fetch(request)` in try/catch, returning `add_cors_headers(Response.json({ error: 'Internal server error' }, { status: 500 }))` on unexpected errors.

---

### MEDIUM

**M1. Module-level state shared across DO instances in same isolate**
- **File:** `src/config/env.ts` (config object), `src/server/tools.ts` (ToolRegistry singleton, active_providers), `src/server/web_search_fanout.ts` (fanout_cache)
- **What:** Multiple DO instances can share the same V8 isolate in Cloudflare Workers. The module-level `config`, `ToolRegistry`, `active_providers`, and `fanout_cache` are shared across all DO instances in that isolate. The init path uses a memoized promise to avoid re-initialization, but if two DO instances activate simultaneously in the same isolate, the second one's `init()` may see partially-initialized state from the first.
- **Why:** The `_init_promise` pattern in the DO class correctly serializes initialization per-instance, and `initialize_config` is idempotent (it just re-assigns the same env values). The atomic swap in `initialize_providers` also mitigates this. However, the `fanout_cache` is shared, meaning one user's search results could be returned to another user with the same query within 30s. This is likely acceptable for search results but worth documenting.
- **Fix:** Add a comment in `web_search_fanout.ts` documenting that the cache is intentionally shared across DO instances for performance. If per-user isolation is ever needed, scope the cache by session ID.

**M2. Unified provider constructors instantiate all providers unconditionally**
- **File:** `src/providers/unified/web_search.ts:55`, `ai_search.ts:49`, `fetch.ts:84`
- **What:** The constructor `new Map(PROVIDERS.map(p => [p.name, p.factory()]))` instantiates every registered provider, including those without API keys. When `search()` is called for a missing provider, it will fail at the `validate_api_key` step.
- **Why:** This wastes memory on provider instances that can never succeed. For fetch with 25+ providers, this creates ~25 class instances even if only 5 have keys configured.
- **Fix:** Filter by active key before instantiation: `new Map(PROVIDERS.filter(p => p.key()?.trim()).map(p => [p.name, p.factory()]))`.

**M3. Bidirectional dependency between server/ and providers/**
- **File:** `src/providers/index.ts` imports from `src/server/tools.ts`; `src/server/tools.ts` imports from `src/providers/unified/*.ts`
- **What:** `providers/index.ts` imports `active_providers`, `register_web_search_provider`, etc. from `server/tools.ts`, while `server/tools.ts` imports types and classes from `providers/unified/*.ts`.
- **Why:** Bidirectional dependencies make the module graph harder to reason about and can cause issues with tree-shaking and circular imports (though esbuild handles this case correctly).
- **Fix:** Extract `active_providers` and the `register_*` functions to a dedicated file like `src/common/registry.ts` or `src/providers/registry.ts`.

---

### LOW

**L1. Cache eviction is FIFO, not LRU**
- **File:** `src/server/web_search_fanout.ts`, lines 38-45
- **What:** Cache `get_cached` reads entries but does not promote them in insertion order. Eviction deletes the oldest inserted key, not the least recently used.
- **Why:** With a 30s TTL and 50-entry max, the practical difference is negligible. But if the cache parameters were ever increased, LRU would be more appropriate.
- **Fix:** On cache hit, delete and re-insert the entry: `fanout_cache.delete(key); fanout_cache.set(key, entry);` in `get_cached`.

**L2. `@ts-expect-error` on McpServer version mismatch**
- **File:** `src/worker.ts`, line 169
- **What:** The `agents` package bundles `@modelcontextprotocol/sdk@1.26.0` while the project uses `1.27.1`. The `@ts-expect-error` suppresses the resulting type mismatch on the `server` property.
- **Why:** This works because esbuild deduplicates to a single copy at build time. But if the packages diverge further in a future update, the runtime behavior could silently break.
- **Fix:** Pin `@modelcontextprotocol/sdk` to the exact version bundled by `agents`, or add a version check assertion in the test suite when one exists.

**L3. `count: 0` semantics in REST /search**
- **File:** `src/server/rest_search.ts`, line 59
- **What:** `count = Math.max(0, body.count ?? 0)` results in `count: 0` meaning "return all results" since line 138 does `count > 0 ? slice(0, count) : results`.
- **Why:** A caller passing `count: 0` might expect zero results returned, not all results.
- **Fix:** Either document this behavior or treat `0` as invalid input with a 400 response.

**L4. Health endpoint missing CORS headers**
- **File:** `src/worker.ts`, lines 293-301
- **What:** The `/` and `/health` endpoints return a `Response` without CORS headers.
- **Why:** If a browser-based monitoring dashboard calls `/health`, it will fail CORS.
- **Fix:** Wrap the health response with `add_cors_headers()`.

---

### POSITIVE

**P1. SSE keepalive with event-boundary buffering** (`worker.ts:53-160`)
Excellent solution to a real problem. The event-boundary-aware buffering ensures keepalive pings are never injected mid-event, which could corrupt the SSE stream. The `safe_write` lock correctly serializes concurrent access. This is the kind of infrastructure code that "just works" and never needs debugging.

**P2. Three distinct orchestration patterns** (`answer_orchestrator.ts`, `web_search_fanout.ts`, `fetch_orchestrator.ts`)
Each tool gets the concurrency pattern that matches its semantics: web search waits for all (maximize dedup), answer races against a deadline (bound latency), fetch waterfalls with parallel groups (minimize cost). This shows genuine understanding of the tradeoffs.

**P3. Provider registration pattern** (unified dispatchers + `registration` exports)
The `{ name, key: () => ..., factory: () => new Provider() }` pattern is clean and extensible. Adding a new provider is truly a 3-line change: one file, one config entry, one line in the unified dispatcher. The `key()` function closure elegantly handles providers with non-standard credential shapes (oxylabs with username/password, cloudflare_browser with account_id/email/key).

**P4. RRF ranking with rescue-tail** (`rrf_ranking.ts`)
The rescue mechanism that promotes tail results from unique domains is a smart design. It prevents the top-N cutoff from eliminating diverse results that happened to be found by only one provider but were ranked highly within that provider's results.

**P5. Snippet selection/merge** (`snippet_selector.ts`)
The bigram-based Jaccard diversity check + greedy set-cover merge is a sophisticated approach to combining snippets from multiple providers. It avoids both duplication and information loss, producing a single high-quality snippet per URL.

**P6. Defensive copies after deadline** (`answer_orchestrator.ts:218-219`)
The `[...answers].sort()` and `[...failed]` copies after the deadline prevent late-arriving promises from mutating the returned arrays. This shows awareness of a subtle concurrency hazard that most implementations miss.

**P7. `make_signal` with polyfill** (`utils.ts:8-20`)
The `AbortSignal.any` usage with a manual polyfill fallback is the correct way to compose signals. The polyfill properly cleans up the timer on abort to prevent leaks.

**P8. Domain breakers in fetch waterfall** (`fetch_orchestrator.ts:33-48`)
Routing YouTube URLs to `supadata` and social media URLs to `sociavault` before hitting the general waterfall is pragmatic and effective. It avoids wasting time on providers that would inevitably fail for these specialized domains.

**P9. Challenge/bot detection in fetch validation** (`fetch_orchestrator.ts:69-77`)
Checking for Cloudflare challenge pages, CAPTCHAs, and "just a moment" strings prevents the waterfall from returning garbage content that looks successful to the caller.

**P10. Structured logging with consistent `op` field** (throughout)
Every log entry includes an `op` field that categorizes the operation. This enables powerful log filtering in production: `op:waterfall_exhausted` to find all fetch failures, `op:provider_timeout` to find slow providers, etc.
