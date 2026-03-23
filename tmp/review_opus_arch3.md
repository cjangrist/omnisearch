# Architecture Scorecard & Code Review: omnisearch-mcp
## Round 3 -- Claude Opus 4.6

---

## Part 1: Architecture Scorecard

---

### Area 1: CONCURRENCY & ASYNC PATTERNS

**Score: 8/10**

**Justification:** Promise composition is thoughtful and well-chosen throughout. The answer orchestrator uses `Promise.race` between `Promise.all(tracked)` and a deadline timer, which is the correct pattern for "wait for all but bail after N ms." The fetch orchestrator uses `Promise.any` for parallel racing, which is semantically correct. The `is_done` flag + defensive copy in `execute_tasks` (lines 125-223 of `answer_orchestrator.ts`) prevents post-deadline mutations, and the `resolved` flag in fetch parallel racing prevents late `.catch()` handlers from mutating `ctx.failed`. The `make_signal` utility correctly composes external abort signals with per-provider timeouts via `AbortSignal.any` with a polyfill fallback.

**To reach 10/10:**
1. **Late-arriving promise mutations in `execute_tasks`**: The `is_done` flag prevents pushes, but the promises are still running after the deadline. The `abort_controller.abort()` only fires if the deadline wins -- but individual provider promises that are mid-`http_json` and not wired to the signal will complete anyway. The abort signal IS threaded through `build_tasks` via `signal`, so this is mostly fine, but `retry_with_backoff` wrapping in `web_search_fanout.ts` (line 87-89) does NOT pass the signal to `retry_with_backoff` itself -- `p-retry` will not abort retries when the signal fires. Fix: pass `signal` into p-retry's `signal` option (p-retry v7 supports this).
2. **Web search fanout timeout race has no abort**: `dispatch_to_providers` (line 118-143 in `web_search_fanout.ts`) races `Promise.allSettled(provider_promises)` against a deadline, but when the deadline wins, the pending provider promises continue running and mutating `results_by_provider`, `providers_succeeded`, and `providers_failed`. The snapshot on lines 138-142 mitigates this, but those concurrent pushes to the original arrays between the deadline firing and the snapshot being taken are a genuine (if narrow) race. Fix: use an `AbortController` signal threaded to providers, or set a flag like `execute_tasks` does.
3. **`_rest_init` promise caching shares state across isolate lifetimes**: If Cloudflare recycles env bindings (e.g., rotated secrets), the cached `_rest_init` promise will never re-run `initialize_config`. This is acceptable for the current deployment model (immutable secrets per deploy), but document the assumption explicitly.

---

### Area 2: STREAM HANDLING & SSE

**Score: 9/10**

**Justification:** The SSE keepalive injection in `worker.ts` (lines 53-166) is genuinely well-engineered. The event boundary buffering is correct -- it scans for `\n\n`, `\r\r`, and `\r\n\r\n` per the WHATWG EventSource spec. The `safe_write` serialization lock prevents concurrent writes to the TransformStream writer (keepalive interval vs. pump). The keepalive only fires when `total_len === 0` (no partial event buffered), which prevents injecting a ping mid-event. Using `event: ping` ensures MCP SDK clients ignore it. The pre-allocated `SSE_PING` Uint8Array avoids repeated encoding.

**To reach 10/10:**
1. **Client disconnect detection**: When the downstream client disconnects, the `writer.write()` will eventually throw, which triggers `cleanup()`. However, between the last `writer.write()` and the next pump iteration or keepalive, there's no proactive detection. The `readable`'s cancel signal is not wired back. This is acceptable for CF Workers (which handle disconnect at the platform level), but for defense-in-depth: listen for `readable`'s controller cancel and call `cleanup()`.
2. **`find_event_boundary` off-by-one potential on `\r\n\r\n`**: Line 108 checks `i + 3 < buf.length` but should be `i + 3 <= buf.length - 1` (equivalent to `i + 3 < buf.length`). This is actually correct as written, but the comment could be clearer. No bug here, just noting the review.

---

### Area 3: ERROR HANDLING & RESILIENCE

**Score: 8/10**

**Justification:** Error handling is consistent and well-structured. The `ProviderError` class with `ErrorType` enum provides clean error taxonomy. `handle_provider_error` re-wraps unknown errors with stack preservation. The `http_core` function handles 401/403/429/5xx with appropriate error types. Provider failures are isolated -- one provider's error in a fanout never crashes others (each provider promise has its own catch). Graceful degradation works: when all search providers fail, REST returns 502; when all answer providers fail, MCP returns `isError: true` with details. The response size guard in `http_core` (5MB limit with streaming byte counter) prevents OOM from malicious payloads.

**To reach 10/10:**
1. **`http_core` 429 handling falls through**: Line 112-113 of `http.ts` calls `handle_rate_limit(provider)` which always throws, but the `break` on line 113 is dead code that suggests the author may have intended fallthrough behavior. Remove the `break` to avoid confusion, or add a `// never reached` comment.
2. **Unhandled rejection in `pump().catch(cleanup)`**: If `cleanup()` itself throws (unlikely but possible if `reader.cancel()` or `writer.close()` throws synchronously before the `.catch(() => {})` handlers), the rejection is unhandled. Fix: `pump().catch(() => { try { cleanup(); } catch {} })`.
3. **REST `/fetch` leaks raw error messages**: Line 138 of `rest_fetch.ts` returns `error_message` directly to the client for non-ProviderError cases. This could expose internal stack traces. Fix: sanitize to a generic message for non-ProviderError cases, similar to `rest_search.ts` line 134.

---

### Area 4: DATA FLOW & PROVIDER ORCHESTRATION

**Score: 9/10**

**Justification:** The three orchestration patterns are well-designed and appropriate for their use cases. Web search fanout: parallel dispatch -> RRF merge with intelligent snippet collapse -> quality filter -> truncate with tail rescue is a sophisticated pipeline. Answer fanout: build_tasks -> execute all in parallel -> deadline race -> abort stragglers -> defensive copy is clean. Fetch waterfall: domain breakers -> tiered waterfall (solo/parallel/sequential steps) -> challenge detection is thorough. The provider registration pattern (config key check -> factory -> unified dispatcher) is simple and effective -- adding a new provider requires touching exactly 3 files. KV caching at the orchestrator level with query-aware cache keys prevents stale/poisoned results.

**To reach 10/10:**
1. **Gemini-grounded inside answer fanout triggers a full web search fanout**: `build_tasks` (line 86-95 of `answer_orchestrator.ts`) runs `run_web_search_fanout` inside the gemini-grounded task. This means the answer fanout implicitly waits for a full web search fanout to complete before gemini-grounded even starts its API call. The KV cache mitigates this for repeated queries, but on cache miss, the gemini-grounded provider has ~2x the latency. Consider pre-triggering the web search fanout outside `build_tasks` and sharing the result.
2. **Fetch waterfall CONFIG is hardcoded**: The waterfall order and domain breakers in `fetch_orchestrator.ts` (lines 52-96) are compile-time constants. Reordering requires a code change and deploy. Consider making these configurable via environment variables or KV, at least for the breaker domains.

---

### Area 5: CODE ORGANIZATION & MODULARITY

**Score: 9/10**

**Justification:** The file structure is clean and consistent. Provider implementations follow a uniform pattern: typed API response interface, class implementing `SearchProvider`/`FetchProvider`, exported `registration` object with `key()` function. The dependency graph is acyclic -- providers depend on `common/*` and `config/env`, orchestrators depend on providers and common, `worker.ts` depends on server and config. The unified dispatchers (`providers/unified/*.ts`) cleanly separate provider selection from provider implementation. Module-level singletons (`ToolRegistry`, `config`, `active_providers`) are appropriate for the CF Workers execution model.

**To reach 10/10:**
1. **`active_providers` lives in `tools.ts` but is consumed by `handlers.ts` and `providers/index.ts`**: This creates a subtle coupling where `handlers.ts` imports from `tools.ts` just for the `active_providers` set. Move `active_providers` to its own module (e.g., `common/registry.ts` or `server/state.ts`) to decouple provider state from tool registration.
2. **Search operator parsing is only used by 2 of 9 search providers**: `search_operators.ts` is imported by `tavily` and `brave` but not by `exa`, `kagi`, `perplexity`, etc. Either document that operator support is intentionally partial, or wire it into all providers that support query-string operators.

---

### Area 6: TYPE SAFETY & INTERFACES

**Score: 7/10**

**Justification:** TypeScript strict mode is enabled, which is good. The core interfaces (`SearchResult`, `FetchResult`, `BaseSearchParams`) are well-designed and consistently used. The `ProviderError` class with `ErrorType` enum provides good error typing. However, there are several type-safety gaps. The `config` object in `config/env.ts` uses `as string | undefined` casts on object properties (e.g., line 22: `api_key: undefined as string | undefined`) which is a code smell -- these should be properly typed interfaces. The `@ts-expect-error` in `worker.ts` line 175 is documented and justified. Zod schemas in tool definitions match return types, which is positive.

**To reach 10/10:**
1. **`config` object uses inline `as` casts instead of proper typing**: Lines 19-253 of `config/env.ts` define config with `undefined as string | undefined` for every field. Define proper interfaces (e.g., `interface ProviderConfig { api_key: string | undefined; base_url: string; timeout: number; }`) and type the config object against them.
2. **`apply_search_operators` returns `as unknown as SearchParams`**: Line 103 of `search_operators.ts` uses a double cast. This bypasses type checking entirely. Build the `SearchParams` object with proper field assignments instead of casting from `Record<string, unknown>`.
3. **`structuredContent` casts to `Record<string, unknown>`**: Lines 155, 199, 229 of `tools.ts` cast structured result objects via `as Record<string, unknown>` or `as unknown as Record<string, unknown>`. This is forced by the MCP SDK's type for `structuredContent`, but could be addressed by defining a helper function that validates the shape at the type level.
4. **Unified dispatch params use string literal unions but callers cast with `as`**: `web_search_fanout.ts` line 88 casts `p.name as WebSearchProvider` and `fetch_orchestrator.ts` line 138 casts `provider as FetchProviderName`. These runtime strings should be validated rather than asserted.

---

### Area 7: CONFIGURATION & ENVIRONMENT

**Score: 8/10**

**Justification:** The config initialization pattern is sensible for CF Workers -- `initialize_config(env)` populates module-level globals from the Workers env bindings, which are immutable per deploy. The rejected-promise-retry pattern for both DO and REST init (lines 188-197 and 217-229 of `worker.ts`) handles transient init failures gracefully. `validate_config()` logs available and missing providers, making it easy to diagnose misconfiguration. Provider auto-discovery is clean: if an API key exists in env, the provider is active. Timeouts are explicit per-provider in the config object.

**To reach 10/10:**
1. **No runtime validation of env binding types**: `initialize_config` trusts that `env.TAVILY_API_KEY` is a string. If Cloudflare delivers an unexpected type (unlikely but possible with binding misconfiguration), this would silently pass through. Add a lightweight Zod schema or manual type check for critical bindings.
2. **`CACHE` KV binding is typed as required in `Env` (not optional), but `kv_cache` is `let ... | undefined`**: If `CACHE` binding is missing from wrangler.toml, the worker will get a runtime error on any KV access rather than a clean startup failure. Either make `CACHE` optional in `Env` and handle gracefully, or validate its presence in `validate_config()`.
3. **Timeout values are not overridable via env**: All timeouts are hardcoded in `config/env.ts`. For production tuning, it would be useful to allow per-provider timeout overrides via env vars (e.g., `TAVILY_TIMEOUT_MS`).

---

### Area 8: OBSERVABILITY & DEBUGGING

**Score: 8/10**

**Justification:** Structured JSON logging with component tags, operation labels, request IDs, and duration_ms tracking is well-implemented. The `set_request_id` / `current_request_id` pattern provides end-to-end request correlation. Log levels are used consistently: debug for internal state, info for operations, warn for failures, error for critical issues. Provider-specific loggers (e.g., `loggers.search('tavily')`) provide granular component identification. The `sanitize_url` function in `http.ts` redacts sensitive query params before logging. The `sanitize_for_log` function prevents control character injection in log messages.

**To reach 10/10:**
1. **SSE keepalive pump has no logging**: The `inject_sse_keepalive` function in `worker.ts` performs complex stream processing but has zero logging. Add a debug log when keepalive is injected, when cleanup runs, and when the pump completes. This is critical for diagnosing timeout issues.
2. **Fetch waterfall does not log individual step attempts**: `execute_step` in `fetch_orchestrator.ts` delegates to `run_solo`/`run_parallel`/`run_sequential` but doesn't log which waterfall step number is being attempted. Add step index to the log context.
3. **`loggers` factory creates new Logger instances on every call**: `loggers.worker()` returns `new Logger('worker')` each time. This is fine for functionality but wasteful -- consider caching logger instances or using a singleton pattern.
4. **MCP tool invocations are not logged at the tool handler level**: The tool handlers in `tools.ts` catch errors but don't log the start/end of tool invocations with query/url and duration. The orchestrators log these, but having it at the tool layer would provide a single consistent trace point.

---

### Area 9: API DESIGN & PROTOCOL COMPLIANCE

**Score: 8/10**

**Justification:** MCP protocol compliance looks correct -- tools are registered with proper Zod input/output schemas, resources use proper URI templates, and both `structuredContent` and `content` are returned (the latter as a text fallback for older clients). The REST API uses appropriate status codes (400, 401, 413, 502, 503). CORS handling is thorough with proper expose-headers for MCP session management. Input validation checks query length (2000 chars), body size (64KB), URL format. Tool descriptions are detailed and genuinely helpful, with the `answer` tool description including a "do not cancel early" instruction.

**To reach 10/10:**
1. **REST endpoints don't return `Content-Type: application/json` explicitly**: `Response.json()` sets it automatically, but the health check (line 317 of `worker.ts`) manually sets `Content-Type` on a `new Response()` while other paths use `Response.json()`. This inconsistency is cosmetic but worth standardizing.
2. **MCP tool output schema for `web_search` has `snippets` as optional, but `format_web_search_response` always includes it**: When `include_snippets` is false, the `snippets` key is removed via destructuring, but the output schema still declares it as optional. The schema is technically correct but could confuse clients. Consider using a discriminated schema or documenting the behavior.
3. **No `Retry-After` header on 429 responses**: `rest_fetch.ts` line 130 returns 429 for rate limits but doesn't include a `Retry-After` header, which is recommended by RFC 6585. Extract the reset time from `ProviderError.details` and include it.

---

### Area 10: PERFORMANCE & RESOURCE EFFICIENCY

**Score: 8/10**

**Justification:** The codebase is generally performance-conscious. The pre-allocated `SSE_PING` Uint8Array avoids repeated `TextEncoder.encode()` calls on the hot path. The chunk-list buffering in `inject_sse_keepalive` avoids O(n^2) concatenation. `http_core` uses streaming reads with a byte counter rather than unbounded `res.text()`. The KV caching layer prevents redundant API calls for repeated queries. Provider factories are lazy (only instantiated when keys are present). The `flatten()` function in SSE handling optimizes for the common case (single chunk = no copy).

**To reach 10/10:**
1. **`flatten()` is called on every `flush_complete_events()` invocation**: Even when only one chunk exists (the fast path returns `chunks[0]` without copying), the function call overhead occurs on every pump iteration. The `find_event_boundary` scan runs on the full buffer each time even if only new data was appended. Consider tracking the scan position to avoid rescanning already-checked bytes.
2. **`new URL()` is called repeatedly in hot paths**: `normalize_url` in `rrf_ranking.ts`, `matches_breaker` in `fetch_orchestrator.ts`, `rescue_tail_results`, and `sanitize_url` in `http.ts` all construct `new URL()` objects. For the RRF ranking path, which processes potentially hundreds of results, consider caching parsed URLs.
3. **`sentence_merge` in `snippet_selector.ts` has O(n*m) complexity**: The greedy set-cover loop (lines 129-156) iterates over all remaining sentences for each selection. With large snippet counts this is fine, but the nested `jaccard()` dedup loop (lines 116-122) is O(n^2) on sentences. For the expected data volumes (a few dozen snippets) this is negligible.
4. **Each `retry_with_backoff` call in `web_search_fanout` creates a new p-retry wrapper**: This is a very minor allocation overhead but could be avoided by pre-creating retry functions during provider construction.

---

## Part 2: Traditional Code Review

---

### CRITICAL

None found. The codebase has no production-breaking bugs that I could identify.

---

### HIGH

**H1: Fetch providers don't thread abort signals through to HTTP calls**

- **File:** `src/providers/fetch/tavily/index.ts:35`, `src/providers/fetch/firecrawl/index.ts:37`, `src/providers/fetch/cloudflare_browser/index.ts:37`, and all other fetch providers
- **What:** Fetch providers use `AbortSignal.timeout(config.fetch.*.timeout)` directly instead of using `make_signal()` with an external abort signal. The `FetchProvider.fetch_url()` interface doesn't accept an `AbortSignal` parameter at all.
- **Why:** When the answer fanout's global deadline fires and `abort_controller.abort()` is called, the abort signal is threaded to AI search providers (via `BaseSearchParams.signal`) but NOT to the fetch waterfall. Similarly, when the web search fanout has a `timeout_ms` deadline, pending HTTP requests from fetch providers cannot be cancelled. This means providers continue consuming resources after the caller has moved on.
- **Fix:** Add `signal?: AbortSignal` to `FetchProvider.fetch_url()` in `common/types.ts`. Update `try_provider` in `fetch_orchestrator.ts` to compose the external signal with the provider timeout via `make_signal()`. Thread through from `run_fetch_race` down to individual provider HTTP calls.

---

### MEDIUM

**M1: Module-level state is shared across DO instances in the same isolate**

- **File:** `src/config/env.ts` (module-level `config` object), `src/server/tools.ts` (singleton `ToolRegistry`), `src/common/logger.ts` (`current_request_id`)
- **What:** Cloudflare Workers can colocate multiple Durable Object instances in the same isolate. Module-level globals (`config`, `ToolRegistry`, `active_providers`, `current_request_id`) are shared across all DO instances in that isolate.
- **Why:** If two DO instances process requests concurrently, `current_request_id` from one request will overwrite the other's, causing log correlation to be wrong. The `config` and `ToolRegistry` are identical across instances (same env bindings), so this is safe for those. But `current_request_id` is definitively a bug for concurrent DOs.
- **Fix:** Replace `current_request_id` with `AsyncLocalStorage` (available in CF Workers with `nodejs_compat`) to properly scope request IDs per async context. Alternatively, pass request_id explicitly through the call chain.

**M2: `retry_with_backoff` in web search fanout uses 1 retry with 2s min backoff**

- **File:** `src/server/web_search_fanout.ts:87-89`
- **What:** `retry_with_backoff(fn, 1)` means 1 retry (total 2 attempts) with 2-5s randomized backoff. For a web search fanout with 9 parallel providers, this means a failing provider adds 2-5 seconds of latency before its failure is reported.
- **Why:** The answer orchestrator explicitly chose NOT to retry (comment on line 76-77: "the multi-provider fanout IS the redundancy strategy"), which is the right call. But the web search fanout DOES retry once, contradicting this philosophy and adding unnecessary latency. Since both fanouts have the same redundancy strategy (N parallel providers), the retry in web search is inconsistent.
- **Fix:** Either remove the retry from web search fanout (set retries to 0, or just call the function directly), or document why web search benefits from retry while answer does not.

**M3: `kv_cache` is used without await in `set_cached` for web search**

- **File:** `src/server/web_search_fanout.ts:222`
- **What:** `set_cached(cache_key, result)` is fire-and-forget (no `await`). The function itself is async and awaits the KV put, but the caller doesn't await it.
- **Why:** This is intentional (documented as "fire-and-forget") and the KV write error is logged. However, if the Worker's execution context ends before the KV write completes (e.g., for a REST request where `ctx.waitUntil()` is not used), the write may be silently dropped. In the MCP/DO path, DO instances have longer lifetimes so this is less of a concern.
- **Fix:** For the REST path, pass `ctx.waitUntil()` from the Worker fetch handler and use it to wrap fire-and-forget promises. This ensures KV writes complete even after the response is sent.

---

### LOW

**L1: `timing_safe_equal` returns false immediately on length mismatch**

- **File:** `src/common/utils.ts:28`
- **What:** `if (a_buf.byteLength !== b_buf.byteLength) return false` leaks the length of the expected key via timing side-channel.
- **Why:** An attacker could determine the exact length of the API key by timing the response. This is a textbook timing-safe comparison weakness, though practical exploitability over HTTPS through Cloudflare's proxy is very low.
- **Fix:** Pad both buffers to the same length (max of the two) before comparing, or use a constant-time length comparison (hash both, then compare hashes).

**L2: Web search tool description mentions "You.com" but `you` search provider was removed**

- **File:** `src/server/tools.ts:73`
- **What:** The `web_search` tool description says "Tavily, Brave, Kagi, Exa, Firecrawl, Perplexity, SerpAPI, Linkup, You.com" but the `you` provider still exists in the codebase (`providers/search/you/index.ts`). Meanwhile, the git log shows commit `7e226a6` "remove you.com ai search provider" -- this removed the AI response provider but kept the web search provider.
- **Why:** The description is technically correct (you.com IS still a search provider), but could be confusing given the commit history. Just noting for awareness.
- **Fix:** No action needed unless the `you` search provider is also intended to be removed.

**L3: `answer` tool description lists "Claude" as a provider**

- **File:** `src/server/tools.ts:117`
- **What:** The answer tool description says "Claude" is one of the providers, but when used from Claude, this means Claude is querying itself as an answer source.
- **Why:** This is logically valid (Claude via an OpenAI-compatible gateway produces independent answers), but could confuse users who think Claude is citing itself.
- **Fix:** Consider documenting this in the tool description, or allowing the calling model to be excluded from the fanout.

---

### POSITIVE

**P1: SSE keepalive injection is genuinely excellent engineering.** The event-boundary-aware buffering, the `safe_write` serialization lock, the `total_len === 0` guard for keepalive injection, and the pre-allocated `SSE_PING` constant show deep understanding of the SSE spec and CF Workers constraints. This solves a real problem (Claude web's 45s timeout) elegantly.

**P2: The fetch waterfall architecture is well-designed.** The `WaterfallStep` discriminated union (`solo | parallel | sequential`), domain breakers for specialized providers, and the `is_fetch_failure` challenge detection create a robust fetching pipeline that degrades gracefully across 25+ providers.

**P3: Provider registration is clean and extensible.** The `{ name, key, factory }` pattern in unified dispatchers with the `key()` function checking config at runtime means adding a new provider is genuinely just 3 lines of code across 3 files. The comment markers ("ADD ONE LINE HERE") are helpful.

**P4: The `handle_provider_error` utility with stack preservation** (`common/utils.ts:68-95`) wraps unknown errors into typed `ProviderError` instances while preserving the original stack trace. This makes debugging provider failures much easier.

**P5: The `http_core` streaming response size guard** (`common/http.ts:62-84`) uses a streaming byte counter rather than buffering the entire response to check size. This prevents OOM on malicious payloads while still allowing normal responses to stream through.

**P6: Defensive copies after deadline in `execute_tasks`** (answer_orchestrator.ts:220-223). The spread operator creates new arrays before returning, preventing late-arriving promise callbacks from mutating the returned result. This shows awareness of the subtle concurrency issues with JavaScript's cooperative scheduling.

**P7: RRF ranking with tail rescue** (`rrf_ranking.ts:86-106`). The `rescue_tail_results` function prevents high-quality unique-domain results from being dropped just because they fell below the top-N cutoff. The intra-rank calculation is mathematically sound.

**P8: The `make_signal` polyfill** (`common/utils.ts:8-20`) for `AbortSignal.any` is correct and handles cleanup properly -- the timer is cleared when the signal aborts, preventing leaks.
