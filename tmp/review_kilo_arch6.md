# Architecture Scorecard & Code Review: OmniSearch MCP Server

**Reviewer:** Claude Opus 4.6 (Kilo mode)
**Date:** 2026-03-22
**Codebase:** omnisearch-mcp v1.0.0
**Files reviewed:** All 60+ TypeScript source files, wrangler.toml, package.json

---

## Part 1: Architecture Scorecard

---

### Area 1: CONCURRENCY & ASYNC PATTERNS

**Score: 8/10**

**Justification:** The codebase demonstrates strong understanding of Promise composition. `answer_orchestrator.ts` correctly uses `Promise.race` between `Promise.all(tracked)` and a deadline timer, with proper `clearTimeout` cleanup and `is_done` flag to prevent post-deadline array mutations. `web_search_fanout.ts` uses `Promise.allSettled` for the no-timeout path and `Promise.race` with deadline + `AbortController` abort for the timeout path. The `inject_sse_keepalive` uses a `write_lock` chain to serialize concurrent writes. The `make_signal` utility correctly composes external abort signals with per-provider timeouts using `AbortSignal.any` with a manual polyfill fallback.

**To reach 10/10:**

1. **`answer_orchestrator.ts` lines 130-166 — post-deadline array mutation race:** The `is_done` flag is set *after* `await winner` returns, but the `.then()`/`.catch()` handlers on `tracked` check `if (is_done) return`. Between `Promise.race` resolving with `'deadline'` and `is_done = true` executing, a provider promise could resolve and push into `answers`/`failed` arrays. The defensive copy on line 223 mitigates this, but the comment on line 221 acknowledges the race exists. Fix: use `AtomicFlag` pattern — set `is_done = true` *before* the `clearTimeout`, or restructure so `tracked` promises write into a `Map` keyed by provider name and the final result is built from a snapshot of that map after the race.

2. **`web_search_fanout.ts` lines 93-129 — fire-and-forget provider promises on timeout path:** When `timeout_ms` fires, `deadline_controller.abort()` is called, but the provider promises from `provider_promises` are never awaited to completion. They continue running in the background (pushing into `providers_succeeded`/`providers_failed`) even after the snapshot on lines 157-161 is taken. This is correct for the return value, but the abandoned promises may log warnings or throw unhandled rejections after the function returns. Fix: wrap each provider promise's `.catch()` to swallow errors post-deadline, or use `ctx.waitUntil()` if available.

3. **`fetch_orchestrator.ts` `run_parallel` lines 189-209 — `resolved` flag race:** The `resolved` flag prevents losers from pushing into `ctx.failed` after the winner returns, but there's a micro-task gap between `Promise.any` resolving and `resolved = true` on line 209. A loser `.catch()` could fire in that gap. Impact is minor (an extra entry in `ctx.failed`), but fix: use `let resolved = { value: false }` and set it inside the `.then()` of the winner before returning.

4. **`make_signal` polyfill in `utils.ts` lines 14-21 — timer leak on success:** When the external signal is provided and `AbortSignal.any` is unavailable, the polyfill creates a `setTimeout(on_abort, timeout_ms)`. If the request completes before the timer, the timer is never cleared. On Workers this is harmless (isolate dies), but for correctness: return a composite `{ signal, cleanup }` or use `AbortSignal.timeout()` as one of the sources and let the controller be GC'd.

---

### Area 2: STREAM HANDLING & SSE

**Score: 9/10**

**Justification:** The SSE keepalive injection in `worker.ts` is well-engineered. The event-boundary buffering (`find_event_boundary`) correctly handles `\n\n`, `\r\r`, and `\r\n\r\n` per the WHATWG EventSource spec. The `safe_write` function serializes writes through a promise chain, preventing concurrent `writer.write()` calls. The keepalive only fires when `total_len === 0` (no partial event buffered), preventing injection mid-event. The `cleanup` function is idempotent via the `closed` flag and properly cancels both reader and writer.

**To reach 10/10:**

1. **`worker.ts` line 77 — `safe_write` error swallowing:** `write_lock = write_lock.then(() => writer.write(chunk)).catch(cleanup)`. If `writer.write()` throws (e.g., client disconnected), `cleanup` is called but the error is silently swallowed. The caller of `safe_write` (e.g., `flush_complete_events`) gets a resolved promise, not a rejected one. This means the pump loop continues reading from the upstream body even after the client disconnects. Fix: after `cleanup()`, re-throw the error or set a flag that the pump checks.

2. **`worker.ts` line 162 — `pump().catch(cleanup)` — unhandled rejection gap:** If `pump()` throws synchronously (unlikely but possible if `reader.read()` throws on first call), the `.catch(cleanup)` handles it. But if the error occurs between `for(;;)` iterations and `cleanup` has already been called, the `reader.cancel().catch(() => {})` silently succeeds. This is fine, but the pattern could be tightened by having `pump` check `if (closed) break` at the top of each iteration.

---

### Area 3: ERROR HANDLING & RESILIENCE

**Score: 8/10**

**Justification:** Provider failure isolation is excellent — each provider runs in its own `try/catch` with errors captured into structured `failed` arrays rather than propagating. The `ProviderError` class with `ErrorType` discriminant enables precise error handling (e.g., `rest_fetch.ts` maps `RATE_LIMIT` to 429, `INVALID_INPUT` to 400). The `handle_provider_error` utility wraps unknown errors with stack preservation. All REST endpoints have catch-all handlers in `worker.ts`. The `http_core` function in `http.ts` has comprehensive status code handling, response size guards, and streaming byte-count protection against OOM.

**To reach 10/10:**

1. **`worker.ts` line 320 — health check swallows init errors silently:** `try { await ensure_rest_initialized(env); } catch { /* best effort */ }`. If initialization fails, the health endpoint reports `degraded` status (0 providers) but doesn't include the error reason. Fix: catch the error and include it in the response: `{ status: 'degraded', error: err.message }`.

2. **`http.ts` line 113 — missing `break` after `case 429`:** `handle_rate_limit(provider)` returns `never`, so control never falls through, but the missing `break` is a readability concern and a lint trap. Add `break` or restructure as `if/else`.

3. **`rest_search.ts` line 119 — information leakage in 502 response:** When a `ProviderError` is thrown, the response uses the generic `'Search provider error'` message, which is correct. But on line 157, when all providers fail, `failed_providers` names are exposed in the response body. This is arguably useful for debugging but inconsistent with the generic message on line 119. Decide on a policy: either always expose provider names (useful) or never (safer).

4. **Fetch providers (e.g., `tavily/index.ts`, `firecrawl/index.ts`) — no AbortSignal threading:** Search providers thread the `signal` from `BaseSearchParams` through `make_signal()`, but fetch providers use `AbortSignal.timeout(config.fetch.*.timeout)` directly, ignoring any external signal. This means the fetch waterfall cannot cancel in-flight provider requests when a winner is found. Fix: add `signal?: AbortSignal` to `FetchProvider.fetch_url()` and thread it through.

---

### Area 4: DATA FLOW & PROVIDER ORCHESTRATION

**Score: 9/10**

**Justification:** The three orchestration patterns are well-differentiated: web search uses parallel fanout + RRF merge + quality filter, answer uses parallel fanout + deadline race + abort, fetch uses domain breaker + tiered waterfall with solo/parallel/sequential steps. The RRF implementation in `rrf_ranking.ts` is textbook correct (k=60 constant, proper rank-based contribution). The snippet selector (`snippet_selector.ts`) uses Jaccard similarity with bigram/trigram scoring and sentence-level greedy set-cover for merging — sophisticated and well-implemented. KV caching with 24h TTL across all three paths prevents redundant API calls.

**To reach 10/10:**

1. **`answer_orchestrator.ts` lines 86-98 — gemini-grounded double-fetches web search:** When `web_search_ref` is available, the answer fanout runs `run_web_search_fanout(web_search_ref, query, { timeout_ms: 10_000 })` for gemini-grounded. This triggers a *second* full web search fanout (which may hit KV cache if the user ran `web_search` first, but not if `answer` is called directly). The 10s timeout means it gets partial results. This is intentional but could be optimized: if the answer tool eventually uses web search results, pre-fetch once and share. Current design is acceptable since KV cache deduplicates.

2. **`fetch_orchestrator.ts` — breaker runs before waterfall but doesn't skip the breaker provider in the waterfall:** If `supadata` is the breaker for YouTube and it fails, the waterfall still includes `supadata` if it appears in any waterfall step (it doesn't currently, but the design doesn't enforce this). Document this invariant or add a `Set` of attempted-breaker-providers to skip in the waterfall.

3. **`web_search_fanout.ts` — cache key doesn't include `limit`:** The `make_cache_key` function excludes `limit` from the cache key. If a request with `limit=5` is cached, a subsequent request with `limit=20` gets the 5-result cache. The `per_provider_limit` controls how many results each provider returns, affecting RRF ranking. Fix: include `limit` in the cache key if it differs from the default.

---

### Area 5: CODE ORGANIZATION & MODULARITY

**Score: 9/10**

**Justification:** The file structure is clean and well-layered: `common/` for shared utilities, `config/` for environment, `providers/` for implementations with `unified/` dispatchers, `server/` for orchestration and handlers, `types/` for interfaces. The provider registration pattern (export `registration` object with `key()` function + class, add one line in unified dispatcher) is developer-friendly. No circular dependencies detected — the dependency graph flows `worker → server → providers → common/config`, with `config` and `common` being leaf dependencies. Module-level state (`config`, `active_providers`, `ToolRegistry`, `kv_cache`) is initialized via explicit `initialize_*` calls, not import side-effects.

**To reach 10/10:**

1. **Singleton ToolRegistry pattern could be simplified:** `tools.ts` exports a class instance (`registry`) with module-level wrapper functions (`register_tools`, `get_web_search_provider`, etc.). The class provides no benefit over plain module state since it's never subclassed or tested with mocks. Simplify to plain module-level variables and functions, eliminating the class indirection.

2. **`config/env.ts` — mixing module-level mutable exports with object mutation:** `OPENWEBUI_API_KEY`, `OMNISEARCH_API_KEY`, and `kv_cache` are exported as `let` bindings (re-assignable), while `config` is a mutable object whose nested properties are mutated. This mixed pattern is correct but could confuse maintainers. Consider making `config` the single source of truth for all values, including auth keys and KV namespace.

---

### Area 6: TYPE SAFETY & INTERFACES

**Score: 7/10**

**Justification:** The core interfaces (`SearchResult`, `FetchResult`, `BaseSearchParams`) are well-designed and consistently used. The `ProviderError` class with `ErrorType` enum provides good discriminated error handling. Zod schemas in tool definitions match the return types. However, there are several type safety gaps.

**To reach 10/10:**

1. **`@ts-expect-error` on `worker.ts` line 178 — SDK version mismatch:** The `McpServer` instantiation requires a `@ts-expect-error` due to `agents` bundling SDK 1.26.0 while the project uses 1.27.1. This is documented and justified, but the fix is to pin both to the same version via `overrides` in `package.json` (the `overrides` field exists but is empty).

2. **`config/env.ts` — `as string | undefined` type assertions everywhere:** Lines like `api_key: undefined as string | undefined` are used to type the initial value of every config field. This works but is fragile — the object literal's type is inferred from these assertions rather than from an explicit interface. Define a `ProviderConfig` interface and type the `config` object against it.

3. **`tools.ts` lines 156, 199 — `as unknown as Record<string, unknown>` casts:** The `structuredContent` fields use unsafe casts. The `AnswerResult` and fetch response types are known at compile time — define them as `Record<string, unknown>`-compatible or use a type assertion function that validates at runtime.

4. **`search_operators.ts` line 103 — `as unknown as SearchParams` double cast:** The `apply_search_operators` function builds `params` as `Record<string, unknown>` then casts it. Use a builder pattern or type-narrow progressively instead.

5. **`validate_config` in `config/env.ts` lines 357-368 — `as` casts in validation:** Multiple `as { api_key?: string }` casts are used to access config fields generically. Type the config object with a union or mapped type so these casts are unnecessary.

6. **Fetch providers don't accept `signal` parameter:** The `FetchProvider` interface defines `fetch_url(url: string)` with no signal parameter. This means fetch providers can't be cancelled. Add `signal?: AbortSignal` to the interface.

---

### Area 7: CONFIGURATION & ENVIRONMENT

**Score: 8/10**

**Justification:** The config initialization pattern is well-thought-out: `initialize_config(env)` copies Workers env bindings into module-level `config` object, `validate_config()` logs availability, and `initialize_providers()` uses atomic swap on `active_providers` sets. The rejected-promise-retry pattern (`_rest_init` and `_init_promise`) ensures transient failures are retried. The `wrangler.toml` correctly declares DO bindings, SQLite migration, KV namespace, and `nodejs_compat` flag.

**To reach 10/10:**

1. **`config/env.ts` lines 282-288 — reset-before-reapply for LLM providers:** The comment says "prevents stale values from surviving when env vars are removed between deploys." This is correct but only applied to `chatgpt`, `claude`, `gemini`, and `brightdata.zone`. Other providers with conditional logic (e.g., `gemini_grounded.model` on line 313) don't get reset. If `GEMINI_GROUNDED_MODEL` is set on one deploy and removed on the next, the old model name persists. Fix: reset all model/optional fields to defaults before applying env vars.

2. **Timeout constants are not overridable via env vars:** All timeouts (30s for fetch, 180s for AI, 120s global deadline, 5s keepalive, 10s gemini-grounded web search) are hardcoded constants. For operational flexibility, allow key timeouts to be overridden via env vars like `GLOBAL_TIMEOUT_MS`, `KEEPALIVE_INTERVAL_MS`.

3. **`wrangler.toml` — missing `[vars]` section:** There's no way to set non-secret config like `LOG_LEVEL` or custom timeouts without adding them to the Env type and worker secrets. Add a `[vars]` section for non-sensitive configuration.

---

### Area 8: OBSERVABILITY & DEBUGGING

**Score: 8/10**

**Justification:** Structured JSON logging is comprehensive. Every operation logs `op` field for filtering, `duration_ms` for latency tracking, and `request_id` (via AsyncLocalStorage) for request correlation. The `loggers` factory creates component-scoped loggers. Provider operations log start/complete/fail with result counts and error messages. HTTP requests log method, sanitized URL, status, and response size.

**To reach 10/10:**

1. **AsyncLocalStorage initialization in `logger.ts` lines 13-24 — fragile runtime detection:** The ALS initialization checks for `globalThis.process` and uses `eval('require')` to load `node:async_hooks`. This is a hack for the CF Workers bundler. On newer `nodejs_compat` versions, `import { AsyncLocalStorage } from 'node:async_hooks'` works directly. The fallback (no ALS) means request IDs aren't correlated in logs on runtimes where ALS isn't available. Fix: use a top-level `import` with the `nodejs_compat` flag, which is already enabled.

2. **Missing logging in fetch orchestrator waterfall:** `fetch_orchestrator.ts` logs `waterfall_start` and `waterfall_done`/`waterfall_exhausted` but doesn't log individual step transitions. When debugging why a fetch took 30s, you can't see which waterfall steps were tried. Fix: add a `step_start`/`step_complete` log in `execute_step`.

3. **`logger.ts` — no log sampling or rate limiting:** In production with high traffic, every HTTP request generates 3+ log entries (request, provider calls, response). CF Workers charges per log line on the Workers Logs product. Consider adding sampling for debug-level logs or a request-level sampling flag.

4. **Missing `request_id` in REST search/fetch response headers:** The `request_id` is generated in `worker.ts` but never returned to the client. Adding `X-Request-ID` to responses would help clients correlate issues with server logs.

---

### Area 9: API DESIGN & PROTOCOL COMPLIANCE

**Score: 8/10**

**Justification:** MCP compliance is solid — the server declares `tools` and `resources` capabilities, registers tools with Zod input/output schemas, and uses the `agents` package's Streamable HTTP transport with correct DO bindings. REST API design is clean with proper status codes (400, 401, 413, 429, 502, 503). CORS headers are comprehensive with explicit `Expose-Headers` for MCP-specific headers. Tool descriptions are detailed and actionable.

**To reach 10/10:**

1. **REST `/search` — `count: 0` means "return all results":** On line 43 of `rest_search.ts`, `count = Math.min(100, Math.max(0, body.count ?? 0))`. When `count` is 0 (the default), `result.web_results` is returned unsliced (line 122: `count > 0 ? ... : result.web_results`). This is unintuitive — `count=0` should either be invalid or explicitly documented as "all results." Consider defaulting to a reasonable number (e.g., 10) when omitted.

2. **`/mcp` POST responses lack CORS headers:** On line 343 of `worker.ts`, MCP POST responses are returned directly (or through `inject_sse_keepalive`) without `add_cors_headers`. The `agents` package's `corsOptions` handles CORS for the initial connection, but the keepalive-wrapped response inherits the original response's headers, which may not include all custom CORS headers. This could cause issues with browser-based MCP clients. Fix: apply `add_cors_headers` to the MCP response as well.

3. **Tool output schemas don't match error responses:** When all providers fail, the web_search and answer tools return `{ content: [...], isError: true }` instead of the declared `outputSchema`. This is per MCP spec (error responses use `content` array), but the `outputSchema` only describes the success case. Document this in the tool description or add an `error` variant to the schema.

---

### Area 10: PERFORMANCE & RESOURCE EFFICIENCY

**Score: 8/10**

**Justification:** The `SSE_PING` `Uint8Array` is pre-encoded at module load (line 60), avoiding repeated `TextEncoder` allocations. The `text_encoder` in `utils.ts` is similarly reused. The chunked list pattern in `inject_sse_keepalive` (line 71: `let chunks: Uint8Array[] = []`) avoids O(n^2) concatenation. The `http_core` function streams responses with a byte counter instead of buffering the entire response. KV caching prevents redundant API calls across requests.

**To reach 10/10:**

1. **`rrf_ranking.ts` `compute_rrf_scores` — O(n*m) snippet deduplication:** Line 72 uses `existing.snippets.includes(result.snippet)` for dedup, which is O(n) per check. With 9 providers x 20 results, this is ~180 iterations per URL, which is fine at current scale. But if results grow, switch to a `Set` for snippets.

2. **`snippet_selector.ts` `sentence_merge` — O(n^2 * m) greedy set-cover:** The greedy loop (lines 129-156) iterates over all deduped sentences for each selected sentence, computing new bigram counts. With typical snippet counts (2-3 per URL, ~5 sentences each), this is negligible. But the algorithm is O(n^2 * m) where n=sentences and m=bigrams. Not a problem at current scale.

3. **`inject_sse_keepalive` `flatten()` — unnecessary re-flattening:** `flush_complete_events` calls `flatten()` which may have already flattened chunks into a single array. The subsequent `buf.subarray(offset)` creates a view, but the `while` loop calls `find_event_boundary(buf.subarray(offset))` repeatedly, creating new views on each iteration. Use index tracking instead of subarray views.

4. **Provider constructors are called eagerly during `initialize_providers`:** Each `UnifiedWebSearchProvider`, `UnifiedAISearchProvider`, and `UnifiedFetchProvider` constructor instantiates all active providers (lines 55-57 of each unified dispatcher). With 25+ fetch providers, this creates 25+ class instances even though most requests only use 1-2. Consider lazy instantiation — create the provider only when it's first used in the waterfall.

---

## Part 2: Traditional Code Review

---

### CRITICAL — Must fix

*No critical issues found. The codebase handles provider failures gracefully, has proper error boundaries, and no data loss paths.*

---

### HIGH — Should fix

**H1: Fetch providers ignore AbortSignal — cannot cancel in-flight requests**
- **File:** `src/common/types.ts` line 36, all `src/providers/fetch/*/index.ts`
- **What:** `FetchProvider.fetch_url(url: string)` takes no signal parameter. Fetch providers use `AbortSignal.timeout(config.fetch.*.timeout)` which is not cancellable by the waterfall orchestrator. When `Promise.any` picks a winner in `run_parallel`, the losing providers continue running until their individual timeouts expire.
- **Why:** Wastes API credits on losing providers. On a YouTube URL, `supadata` (breaker) might succeed in 2s, but `tavily` (first waterfall step) continues for 30s.
- **Fix:** Add `signal?: AbortSignal` to `FetchProvider.fetch_url()`. In each provider, use `make_signal(config.fetch.*.timeout, signal)`. In `run_parallel` and the waterfall, create an `AbortController` and pass its signal to all providers, aborting losers when a winner is found.

**H2: `answer_orchestrator.ts` — KV cache key is the raw query string, unbounded**
- **File:** `src/server/answer_orchestrator.ts` line 237, `src/server/web_search_fanout.ts` line 21
- **What:** KV cache keys are `answer:<query>` and `search:<query>` where `<query>` can be up to 2000 chars. KV keys have a 512-byte limit.
- **Why:** Queries longer than ~500 characters will fail the KV `put()` call, which is caught and logged as a warning. But the `get()` call on line 237 will also fail silently (caught on line 242), meaning long queries are never cached.
- **Fix:** Hash the query with SHA-256 for cache keys: `KV_ANSWER_PREFIX + await crypto.subtle.digest('SHA-256', new TextEncoder().encode(query))` converted to hex.

---

### MEDIUM — Should fix soon

**M1: `worker.ts` — REST routes don't log response status/duration**
- **File:** `src/worker.ts` lines 271-311
- **What:** The REST `/search` and `/fetch` handlers log `request_start` but don't call `logger.response()` with status code and duration. The health check (line 318) and MCP handler (line 338) do.
- **Why:** Operational blindspot — you can't track REST endpoint latency or error rates from logs alone.
- **Fix:** Add `logger.response('POST', '/search', response.status, Date.now() - start_time, { request_id })` after each REST handler returns.

**M2: `web_search_fanout.ts` — `retry_with_backoff` with `max_retries: 1` doubles latency**
- **File:** `src/server/web_search_fanout.ts` line 100-103
- **What:** Each search provider is wrapped in `retry_with_backoff` with `max_retries: 1` and `min_timeout_ms: 2000`. If a provider fails on the first attempt, it waits 2-5s and retries once.
- **Why:** The answer orchestrator comment (line 77) explicitly states "No retry — the multi-provider fanout IS the redundancy strategy." But web search fanout retries anyway, adding 2-5s latency per failing provider. With 9 providers, if 3 fail, the total wait increases by 6-15s.
- **Fix:** Either remove retries from web search fanout (rely on multi-provider redundancy like the answer orchestrator does) or reduce `min_timeout_ms` to 500ms.

**M3: `config/env.ts` — `initialize_config` is not idempotent for provider objects**
- **File:** `src/config/env.ts` line 256
- **What:** `initialize_config` is called both by the DO's `init()` and by `ensure_rest_initialized()`. In the DO path, it's guarded by `_init_promise`. In the REST path, it's guarded by `_rest_init`. But if both paths run in the same isolate, `initialize_config` mutates the shared `config` object. This is safe because env bindings are immutable within an isolate, but the `UnifiedWebSearchProvider` constructor (called in `initialize_providers`) creates new instances of all provider classes each time.
- **Why:** The DO's `init()` and the REST path's `ensure_rest_initialized()` both call `initialize_providers()`, which calls `new UnifiedWebSearchProvider()` etc. If the lazy-init promise resolves for both paths, duplicate provider instances are created. This wastes memory but doesn't cause bugs because `active_providers` is atomically swapped.
- **Fix:** Add a module-level `_providers_initialized` flag to prevent double-initialization, or share the init promise between DO and REST paths.

**M4: `tools.ts` — `crypto.randomUUID()` per tool call creates a new request context**
- **File:** `src/server/tools.ts` lines 97, 138, 187
- **What:** Each MCP tool handler wraps its logic in `run_with_request_id(crypto.randomUUID(), ...)`. This generates a new request ID that's unrelated to the MCP session or the original HTTP request ID generated in `worker.ts`.
- **Why:** Logs from tool calls can't be correlated with the incoming HTTP request. If a client makes a POST to `/mcp` that triggers a `web_search` tool call, the HTTP request has one `request_id` and the tool call has a different one.
- **Fix:** Pass the original `request_id` through the MCP session context, or use the MCP `sessionId` as the correlation key.

---

### LOW — Nice to have

**L1: `rrf_ranking.ts` — `normalize_url` doesn't strip `www.` prefix**
- **File:** `src/common/rrf_ranking.ts` line 14
- **What:** URL normalization strips fragments and trailing slashes but doesn't normalize `www.` subdomains. `https://www.example.com/page` and `https://example.com/page` would be treated as different URLs in RRF scoring.
- **Why:** Some providers return URLs with `www.` and others without, leading to the same page being scored separately instead of having their RRF scores combined.
- **Fix:** Add `u.hostname = u.hostname.replace(/^www\./, '')` to `normalize_url`.

**L2: `snippet_selector.ts` — `split_sentences` regex doesn't handle abbreviations**
- **File:** `src/common/snippet_selector.ts` line 87
- **What:** The regex `(?<=[.!?])\s+(?=[A-Z])` splits on periods followed by uppercase, which incorrectly splits on abbreviations like "U.S. Department" or "Dr. Smith".
- **Why:** Could produce truncated sentences in merged snippets, reducing quality.
- **Fix:** Add common abbreviation exceptions or use a more sophisticated sentence boundary detector.

**L3: `logger.ts` — `loggers` factory creates new Logger instances on every call**
- **File:** `src/common/logger.ts` lines 201-214
- **What:** `loggers.search()`, `loggers.worker()`, etc. are called at module load time (e.g., `const logger = loggers.search()` at the top of `web_search_fanout.ts`). Each call creates a new `Logger` instance. Since these are module-scoped, they're only created once per module, but the factory pattern suggests they could be called repeatedly.
- **Why:** Minor — no real performance impact since Logger instances are lightweight.
- **Fix:** Cache instances in a `Map<string, Logger>` inside the `loggers` object.

**L4: `search_operators.ts` — regex patterns are re-compiled on every call**
- **File:** `src/common/search_operators.ts` line 33
- **What:** `OPERATOR_PATTERNS` uses regex literals with the `/g` flag. Since they're module-level constants, they're compiled once. But `/g` regexes have mutable `lastIndex` state. If `parse_search_operators` is called concurrently (possible in Workers), the shared regex state could cause incorrect matching.
- **Why:** Workers processes concurrent requests in the same isolate. Two concurrent calls to `parse_search_operators` could interfere via shared `lastIndex`.
- **Fix:** Create new regex instances inside `parse_search_operators`, or use `String.matchAll()` which creates a fresh iterator.

---

### POSITIVE — What was done well

**P1: SSE keepalive with event-boundary buffering (worker.ts lines 53-169)**
This is the standout engineering in the codebase. The implementation correctly handles all three SSE line-ending variants, only injects keepalives between complete events (preventing mid-event corruption), uses a write-lock to prevent concurrent writer access, and cleans up all resources on disconnect. The named `event: ping` ensures MCP SDK clients silently ignore it.

**P2: Provider registration pattern (unified dispatchers)**
The `PROVIDERS` array + `registration` export + `key()` function pattern is elegant. Adding a new provider requires: 1) create the provider file, 2) add one line to the unified dispatcher, 3) add the env var. No factory registry, no runtime reflection, no config files to update. The `key()` function provides lazy API key checking.

**P3: Atomic provider swap (providers/index.ts)**
Building new sets locally and swapping them atomically into `active_providers` prevents a transient empty-state window during reinitialization. This is a subtle concern (CF Workers can share isolates between DOs) handled correctly.

**P4: RRF ranking with quality filtering and rescue (rrf_ranking.ts)**
The RRF implementation goes beyond basic rank fusion — it includes quality filtering (minimum score, minimum snippet length for single-provider results) and a rescue mechanism that promotes tail results if they're from unique domains and ranked highly within their source provider. This prevents good results from being dropped just because only one provider found them.

**P5: Fetch waterfall architecture (fetch_orchestrator.ts)**
The tiered waterfall with domain breakers, solo/parallel/sequential step types, and content validation (challenge pattern detection, minimum content length) is well-designed. The separation of config (waterfall order, breaker domains) from logic (step executors) makes it easy to reorder providers or add new tiers without code changes.

**P6: AbortSignal composition (utils.ts make_signal)**
Properly composes external abort signals with per-provider timeouts, with a polyfill for runtimes without `AbortSignal.any`. This ensures that both the global deadline and per-provider timeouts are respected.

**P7: HTTP response size guard (http.ts)**
The streaming byte-counter pattern (lines 62-84) protects against OOM from malicious or oversized responses, even when `Content-Length` is missing or lies. This is production-grade defensive coding.

**P8: Error type hierarchy (common/types.ts)**
`ProviderError` with `ErrorType` enum enables precise error routing: rate limits become 429s, invalid input becomes 400s, provider errors become 502s. The `handle_provider_error` utility preserves stack traces via `Caused by:` chaining.
