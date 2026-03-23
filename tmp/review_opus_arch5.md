# Architecture Scorecard & Code Review: OmniSearch MCP Server (Round 5)

Reviewer: Claude Opus 4.6 (1M context)
Date: 2026-03-22
Codebase state: commit 5ef32b9 (main, clean)

---

## Part 1: Architecture Scorecard

---

### Area 1: CONCURRENCY & ASYNC PATTERNS

**Score: 8/10**

**Justification:** The codebase demonstrates sophisticated understanding of Promise composition. The answer orchestrator correctly uses `Promise.race([Promise.all(tracked), deadline])` with an `is_done` flag and defensive copies to prevent post-deadline mutations. The web search fanout mirrors this pattern with snapshot copies on timeout. The fetch orchestrator's `Promise.any` for parallel racing is well-constructed with a `resolved` flag to suppress loser error logging. AbortSignal composition via `AbortSignal.any()` with a polyfill fallback in `make_signal()` is a strong choice. The `write_lock` pattern in SSE keepalive serializes concurrent writes correctly.

**To reach 10/10:**

1. **Timer leak in `execute_tasks` deadline:** At `answer_orchestrator.ts:183`, `timer_id` is declared with `let` and assigned inside the Promise constructor. The `clearTimeout(timer_id!)` at line 189 uses a non-null assertion, but if `Promise.race` somehow throws before the deadline callback fires, the timer leaks. Wrap the entire `Promise.race` block in a `try/finally` that always clears the timer:
   ```ts
   const timer_id = setTimeout(resolve, GLOBAL_TIMEOUT_MS);
   try { ... } finally { clearTimeout(timer_id); }
   ```
   The same pattern exists at `web_search_fanout.ts:127-133`.

2. **Post-deadline array mutation race in answer_orchestrator:** The `is_done = true` flag at line 190 prevents *new* entries from being pushed, but late-arriving promises that entered the `.then()` callback *before* `is_done` was set can still push concurrently with the spread-copy at lines 223-224. This is benign in practice (worst case: an extra answer appears) but not airtight. Consider collecting results into an immutable structure rather than mutating shared arrays, or snapshot under a check of `is_done` at the moment of push.

3. **No AbortController for fetch waterfall:** `fetch_orchestrator.ts` never creates an AbortController/signal for the waterfall. Individual provider calls use `AbortSignal.timeout()` via their config, but if the MCP client disconnects, there is no mechanism to abort in-flight fetch provider HTTP requests. Thread the MCP tool call's implicit signal through `run_fetch_race`.

4. **`_rest_init` module-level singleton is never reset:** If `initialize_config` succeeds but `validate_config` throws, `_rest_init` is set to `undefined` correctly via the `.catch()`. However, if the *first* REST request initializes successfully but then the Worker isolate is recycled and a *new* env is provided, `_rest_init` (being a resolved promise) silently serves stale config. In practice Cloudflare recycles the entire module on isolate eviction, so this is theoretical — but it means the REST path cannot handle dynamic env changes within an isolate lifetime. Document this assumption or compare `env` reference.

---

### Area 2: STREAM HANDLING & SSE

**Score: 9/10**

**Justification:** The SSE keepalive injection is impressively well-engineered. Event boundary detection handles `\n\n`, `\r\n\r\n`, and `\r\r` per the WHATWG EventSource spec. The chunked buffer design avoids O(n^2) concatenation. The `safe_write` lock correctly serializes keepalive pings and pump writes to prevent concurrent `writer.write()` calls. The keepalive only injects between complete events (`total_len === 0` check), preventing corruption of in-flight SSE events. The `cleanup()` function is idempotent and handles both reader cancellation and writer closure.

**To reach 10/10:**

1. **`flush_complete_events` calls `flatten()` which may re-allocate unnecessarily:** When the buffer contains a single chunk that has multiple events, `flatten()` returns it directly (line 97: `if (chunks.length === 1) return chunks[0]`). But the subsequent `buf.subarray(offset)` creates a view, not a copy. This is correct for the lifetime of that pump iteration. However, if a new chunk arrives and `chunks` is `[remainder]`, the next `flatten()` concatenates `remainder` with the new chunk — this is fine. No bug here, but the `flatten()` + `subarray` pattern could be simplified by tracking an offset into the flat buffer rather than re-slicing.

2. **Client disconnect is not propagated upstream:** When the client disconnects, `readable.cancel()` propagates to the TransformStream, but the `reader.read()` on the *original* response body will continue reading until the upstream (the agents DO transport) finishes or errors. Adding a `readable.pipeTo()` abort signal or monitoring `writable`'s closed state would allow upstream cancellation. In practice this is low-impact because the DO transport closes when the tool call completes, but for very long-running operations it wastes bandwidth.

---

### Area 3: ERROR HANDLING & RESILIENCE

**Score: 9/10**

**Justification:** Error handling is thorough and consistent. The `ProviderError` class with typed `ErrorType` enum enables clean error routing (`RATE_LIMIT` -> 429, `INVALID_INPUT` -> 400, etc.) in REST endpoints. Provider failures are fully isolated — individual provider errors in fanout are caught and logged without affecting other providers. The REST endpoints return 502 when all providers fail (not a misleading 200 with empty results). The `handle_provider_error` utility wraps unknown errors with cause chains. The `http_core` function includes a streaming byte counter to prevent OOM from chunked-encoding responses.

**To reach 10/10:**

1. **Unhandled promise rejection in `pump().catch(cleanup)` (worker.ts:159):** If `cleanup()` itself throws (e.g., `writer.close()` throws synchronously before the `.catch()` is attached), the rejection is swallowed. This is extremely unlikely in practice because `cleanup()` wraps both `reader.cancel()` and `writer.close()` in `.catch(() => {})`, but adding a top-level `.catch(() => {})` on the pump chain would be belt-and-suspenders: `pump().catch(() => {})`.

2. **`http_core` does not re-throw after `handle_rate_limit` on 429:** At `http.ts:113`, the `case 429:` calls `handle_rate_limit(provider)` which throws (it is typed `never`). This is correct. But the `break` statement after it is dead code that could confuse readers. Remove the `break`.

---

### Area 4: DATA FLOW & PROVIDER ORCHESTRATION

**Score: 9/10**

**Justification:** The three-tier orchestration (web search fanout, answer fanout, fetch waterfall) is architecturally clean. Web search: parallel dispatch -> per-provider retry (1 retry) -> URL-normalized RRF merge -> quality filter -> snippet collapse -> truncation with tail rescue. Answer: parallel dispatch -> global 2min deadline -> AbortController cancellation -> defensive copy + sort. Fetch: domain breakers -> tiered waterfall (solo/parallel/sequential steps) -> content validation (min chars + challenge pattern detection). The caching layer (KV with 24h TTL) is well-placed — only caches successful results and uses cache keys that include options affecting output.

**To reach 10/10:**

1. **Web search retry inside answer fanout is inconsistent:** `web_search_fanout.ts:94` uses `retry_with_backoff` with `max_retries: 1`, but `answer_orchestrator.ts:79-83` explicitly avoids retries with a comment explaining why. The web search fanout's retry is justified (it's a shorter operation), but the answer fanout *also* calls `run_web_search_fanout` for gemini-grounded (line 90), meaning that inner web search call *does* retry. This is fine but should be documented as intentional.

2. **Fetch waterfall does not log which step is being attempted:** The waterfall walks steps but only logs the final provider that resolved or the exhaustion. Adding a `logger.debug` at the start of `execute_step` with the step type (`solo: tavily`, `parallel: [linkup, cloudflare_browser]`) would make debugging much easier.

3. **KV cache key collision risk for answer cache:** `answer_orchestrator.ts:237` uses `KV_ANSWER_PREFIX + query` as the cache key. If two different queries differ only in whitespace or casing, they get different cache entries. Consider normalizing the query (lowercase, trim, collapse whitespace) before hashing. Alternatively, the raw query is fine if you accept case-sensitive caching as intentional — but document this.

---

### Area 5: CODE ORGANIZATION & MODULARITY

**Score: 9/10**

**Justification:** The file structure is excellent. Clear separation: `common/` (shared utilities), `config/` (env binding), `providers/` (implementations + unified dispatchers), `server/` (orchestrators + handlers + REST), `types/` (shared types). The provider registration pattern is elegant — each provider exports a `registration` object with a `key()` function, and the unified dispatcher builds a `PROVIDERS` array. No circular dependencies detected. The `ToolRegistry` singleton cleanly separates tool registration from tool execution. Import chains are short and unidirectional.

**To reach 10/10:**

1. **`active_providers` is exported from `tools.ts` but mutated from `providers/index.ts`:** This creates a bidirectional data flow between `server/` and `providers/`. Consider moving `active_providers` to a shared location like `common/state.ts` or `config/state.ts` to make the dependency graph cleaner.

2. **`config` is a mutable module-level object exported from `config/env.ts`:** Every provider file imports and reads from it. This works because Cloudflare Workers modules are singletons within an isolate, but it makes unit testing impossible without mutating the import. Consider a factory pattern that returns a frozen config object, or pass config as a parameter.

3. **Duplicate auth logic in `rest_search.ts` and `rest_fetch.ts`:** Lines 22-38 in both files contain identical Bearer token validation. Extract to a shared `authenticate_request(request)` function in `common/` or `server/`.

---

### Area 6: TYPE SAFETY & INTERFACES

**Score: 8/10**

**Justification:** TypeScript strict mode is enabled. The `SearchResult`, `FetchResult`, and `BaseSearchParams` interfaces are well-designed and consistently used. Provider types are derived from const arrays (`typeof PROVIDERS[number]['name']`), giving literal union types. The `ProviderError` class with `ErrorType` enum is a proper discriminated error hierarchy. Zod schemas in tool definitions match the actual return structures.

**To reach 10/10:**

1. **`as unknown as Record<string, unknown>` cast in tool responses:** At `tools.ts:155` and `tools.ts:199`, `structuredContent` is cast with `as unknown as Record<string, unknown>`. This is unavoidable given MCP SDK's generic return type, but it bypasses type checking on the actual shape. Consider defining a type guard or branded type that validates the shape at the boundary.

2. **`as` casts in several places suppress type narrowing:** `rest_search.ts:57` casts `body.query as string` before checking `typeof query !== 'string'` on line 73. The cast is premature — use optional chaining and type narrowing instead: `const query = body?.query;` then narrow with the existing runtime check.

3. **`config` object uses `undefined as string | undefined` type assertions:** `config/env.ts:22` uses `api_key: undefined as string | undefined`. This is a valid pattern but unusual. A more conventional approach would be to declare the config type as an interface and use `Partial<>` or explicit optional properties, then initialize a const of that type.

4. **Fetch providers don't thread AbortSignal:** The `FetchProvider` interface at `common/types.ts:36` defines `fetch_url(url: string)` with no signal parameter. All 25+ fetch provider implementations use `AbortSignal.timeout()` individually but cannot be externally cancelled. Add `signal?: AbortSignal` to the interface.

5. **`@ts-expect-error` at `worker.ts:175`:** This is well-documented with a clear justification (version mismatch between agents' bundled SDK and the project's SDK). The comment explains both the cause and why it's safe at runtime. No action needed, but pin a TODO to remove it when agents updates its bundled version.

---

### Area 7: CONFIGURATION & ENVIRONMENT

**Score: 8/10**

**Justification:** The config initialization pattern is pragmatic for Cloudflare Workers — module-level mutable state populated per-request via `initialize_config(env)`. The `validate_config()` function logs available and missing providers clearly. Provider auto-discovery is elegant: presence of an API key is the only requirement. The wrangler.toml is correct — DO binding name matches the exported class, `new_sqlite_classes` migration is present, `nodejs_compat` flag enables AsyncLocalStorage.

**To reach 10/10:**

1. **No runtime validation of env binding types:** `initialize_config` blindly assigns `env.TAVILY_API_KEY` etc. without checking if they are strings. If Cloudflare bindings are misconfigured (e.g., a KV namespace bound where a string secret is expected), this would surface as a confusing runtime error deep in a provider call. Add a type guard at the config boundary.

2. **Timeout constants are not overridable:** Every provider has a hardcoded timeout (e.g., `timeout: 30000`). These cannot be overridden via env vars. For production tuning, add optional `*_TIMEOUT` env vars that override the defaults.

3. **`CACHE` KV binding is typed as non-optional in `Env` interface but treated as optional in code:** `types/env.ts:64` declares `CACHE: KVNamespace` (required), but `config/env.ts:14` declares `kv_cache` as `KVNamespace | undefined`. If `CACHE` is truly required, the optional check in every cache function is unnecessary. If it can be absent (e.g., in dev), make it optional in the Env interface.

4. **LLM search provider config initializes with empty strings instead of undefined:** `config/env.ts:94-95` uses `api_key: '' as string` and `base_url: ''`. This means `has_any_ai_provider()` sees `''` as falsy and skips them when no env vars are set — correct behavior. But the empty string default means `validate_api_key` would not throw if `base_url` is set but `api_key` is genuinely empty. The guard at line 282 (`if (env.LLM_SEARCH_BASE_URL && env.LLM_SEARCH_API_KEY)`) prevents this, but the empty string defaults are confusing.

---

### Area 8: OBSERVABILITY & DEBUGGING

**Score: 9/10**

**Justification:** Structured JSON logging with consistent `op` fields enables log filtering. Request IDs are generated per-request and threaded via AsyncLocalStorage, surviving async boundaries. Every major operation is instrumented: provider dispatch, completion, failure, timeout, fanout start/complete, REST request/response with duration_ms, HTTP request/response with sanitized URLs. The logger uses appropriate levels: debug for internal state, info for operations, warn for recoverable failures, error for unrecoverable failures. URL and query sanitization prevents log injection.

**To reach 10/10:**

1. **MCP tool call execution is not logged:** When a tool handler in `tools.ts` is invoked, there is no log entry for "tool X called with params Y". The orchestrators log their own start/complete, but the tool-level entry/exit is missing. Add `logger.info('Tool invoked', { op: 'tool_call', tool: 'web_search', query })` at the start of each handler.

2. **KV cache hit/miss is logged at debug level:** Cache performance is important for understanding cost and latency. Consider promoting cache hits to info level, or at minimum ensuring cache miss (the implicit else when `cached` is undefined) is logged.

3. **SSE keepalive injection has no logging:** The `inject_sse_keepalive` function in `worker.ts` operates silently. Add a debug log when the keepalive interval starts and when cleanup occurs.

---

### Area 9: API DESIGN & PROTOCOL COMPLIANCE

**Score: 9/10**

**Justification:** MCP compliance is solid — Streamable HTTP transport via `McpAgent.serve()`, proper tool schemas with Zod input/output definitions, resource handlers for provider status. The REST API is well-designed: proper status codes (400 for bad input, 401 for auth failure, 413 for oversized body, 502 for upstream failure, 503 for no providers), consistent JSON error shapes. CORS headers are comprehensive and correctly applied. Tool descriptions are detailed and actionable. Input validation checks query length, body size, and URL format.

**To reach 10/10:**

1. **REST `/fetch` returns provider error messages directly to the client:** At `rest_fetch.ts:138`, `error_message` (which comes from `ProviderError.message`) is returned in the JSON response. This could leak internal provider details (API error messages, internal URLs). Sanitize to generic messages for 5xx errors while preserving specifics for 4xx.

2. **REST `/search` does not validate `count` range:** `rest_search.ts:59` does `Math.max(0, body.count ?? 0)`, which means `count: -1` becomes `0` (meaning "return all"). But `count: 999999` is accepted. Add a reasonable upper bound.

3. **CORS preflight skips `/mcp` path but MCP handler has its own CORS:** The comment at `worker.ts:262` explains this, but the agents package's `corsOptions: { origin: '*', headers: '*', exposeHeaders: '*' }` and the worker's `CORS_HEADERS` could diverge. The MCP POST responses are not wrapped with `add_cors_headers` (they go through the agents handler), which is correct, but GET /mcp (SSE) responses from the agents handler might not have the specific headers the worker adds. This is fine in practice since the agents handler's wildcard CORS is more permissive.

---

### Area 10: PERFORMANCE & RESOURCE EFFICIENCY

**Score: 8/10**

**Justification:** The `SSE_PING` Uint8Array is pre-encoded at module level (line 60), avoiding repeated TextEncoder allocations on the hot path. The `text_encoder` in utils.ts is similarly shared. The chunked buffer in SSE keepalive avoids O(n^2) concatenation. The http_core streaming reader with byte counter is more efficient than buffering the entire response. Provider instances are created once during initialization (not per-request). KV caching with 24h TTL prevents redundant provider API calls.

**To reach 10/10:**

1. **`flatten()` is called on every pump iteration even when there is only one chunk:** At `web_search_fanout.ts:flush_complete_events` (actually `worker.ts:116`), `flatten()` is called at the top of the while loop. When there is exactly one chunk and no event boundary is found, this is a no-op (returns `chunks[0]`). But when there IS a boundary, subsequent iterations call `flatten()` again on the remainder, which is already a single chunk. This is not a bug but the call overhead is unnecessary — check `chunks.length === 1` before calling.

2. **`new URL()` is called repeatedly for the same URL in fetch orchestrator:** `matches_breaker` calls `new URL(url)` for each breaker config entry. Since the URL is the same, parse it once and pass the hostname.

3. **`get_active_search_providers()` / `get_active_ai_providers()` / `get_active_fetch_providers()` allocate new arrays on every call:** These are called during initialization and at the start of each fanout. The provider list doesn't change after initialization. Cache the result after `initialize_providers()` runs.

4. **`collapse_snippets` creates a new array with spread for every result:** At `snippet_selector.ts:238`, `results.map(r => ({ ...r, snippets: ... }))` creates a shallow copy of every result object even when `snippets.length <= 1` (the common case). For results with a single snippet, return the original object reference.

---

## Part 2: Traditional Code Review

---

### CRITICAL

No critical issues found.

---

### HIGH

**H1: Fetch providers use `AbortSignal.timeout()` without composing external signals**

- **File:** `src/providers/fetch/tavily/index.ts:36`, `src/providers/fetch/firecrawl/index.ts:42`, `src/providers/fetch/jina/index.ts:35`, and all other fetch providers
- **What:** Every fetch provider creates `AbortSignal.timeout(config.fetch.X.timeout)` but does not compose it with any external signal. The `FetchProvider.fetch_url()` interface does not accept a signal parameter.
- **Why:** If the MCP client disconnects or the REST request is cancelled, in-flight HTTP requests to fetch providers continue running until they complete or timeout (up to 60s for decodo). This wastes Worker CPU time and egress bandwidth, and could contribute to rate limiting on provider APIs.
- **Fix:** Add `signal?: AbortSignal` to `FetchProvider.fetch_url()` in `common/types.ts`. Update all fetch provider implementations to use `make_signal(config.fetch.X.timeout, signal)`. Thread the signal from `run_fetch_race` down through `try_provider` to each provider.

**H2: `run_parallel` in fetch orchestrator does not track loser promise failures after winner resolves**

- **File:** `src/server/fetch_orchestrator.ts:189-204`
- **What:** The `resolved` flag prevents loser `.catch()` from mutating `ctx.failed` after the winner returns. But the loser promises are never awaited or cancelled — they continue running in the background. When they fail, the error is silently swallowed (`if (!resolved) { ... }`). If they *succeed*, the successful result is also silently discarded.
- **Why:** Background HTTP requests consume Worker CPU time. More importantly, if a loser promise throws after the calling function has returned to the MCP tool handler, and there is no `.catch()` on it, it could surface as an unhandled promise rejection in some runtimes.
- **Fix:** The `throw error` on line 203 re-throws after the `resolved` check, so Promise.any does see it. The issue is that after `Promise.any` resolves, the remaining promises' rejections fire with `resolved = true` and the error is re-thrown but caught by the implicit Promise machinery. This is actually fine — `Promise.any` internally catches all rejections. No production bug, but adding `AbortController` cancellation for loser providers would be a meaningful improvement.

---

### MEDIUM

**M1: Duplicate authentication logic in REST handlers**

- **File:** `src/server/rest_search.ts:22-38`, `src/server/rest_fetch.ts:22-37`
- **What:** Identical Bearer token validation code is duplicated across both REST handlers.
- **Why:** Bug risk if one is updated without the other. Violates DRY.
- **Fix:** Extract to `authenticate_rest_request(request: Request): Response | null` in a shared module. Return null on success, or a 401 Response on failure.

**M2: `config` object is deeply mutable with no freeze**

- **File:** `src/config/env.ts:19-253`
- **What:** The entire `config` object is exported as a mutable module-level variable. Any import site could accidentally mutate a provider's `base_url` or `timeout`.
- **Why:** Accidental mutation in one provider's code could affect all other providers sharing the same config subtree.
- **Fix:** After `initialize_config()` completes, call `Object.freeze()` recursively on the config object. Or use a `ReadonlyDeep<typeof config>` type annotation to catch mutations at compile time.

**M3: `search_operators.ts` regex patterns use lookbehinds**

- **File:** `src/common/search_operators.ts:47-48`
- **What:** `force_include` and `exclude_term` patterns use `(?<=^|\s)` lookbehinds.
- **Why:** While V8 (used by CF Workers) supports lookbehinds, they are a relatively recent addition and can be slower than alternatives. The `exclude_term` pattern `(?<=^|\s)-([^\s:]+)` could also match inside URLs or quoted strings. This is a minor correctness issue rather than a performance issue.
- **Fix:** Consider anchoring the match more carefully or using a non-lookbehind approach with word boundary assertions.

**M4: `web_search_fanout` awaits KV cache write synchronously**

- **File:** `src/server/web_search_fanout.ts:236`
- **What:** `await set_cached(cache_key, result)` blocks the response until the KV write completes.
- **Why:** KV writes add latency (typically 10-50ms) to every non-cached search response. The comment in `answer_orchestrator.ts:282` explains why it awaits there (REST path could kill the promise), but the same concern applies here.
- **Fix:** This is intentionally correct for the REST path. In the MCP path (where the DO keeps the isolate alive), the await is unnecessary but harmless. The current approach is the safe choice. No change needed — just noting the tradeoff.

---

### LOW

**L1: `loggers` factory creates new Logger instances on every call**

- **File:** `src/common/logger.ts:201-214`
- **What:** `loggers.worker()`, `loggers.search()`, etc. each call `new Logger(...)`. Several are called at module top-level (e.g., `const logger = loggers.worker()` in `worker.ts`), so this is fine. But `loggers.search(p.name)` at `web_search_fanout.ts:89` is called inside a loop per-provider per-request.
- **Why:** Trivial allocation overhead, but Logger instances are lightweight (just a string field).
- **Fix:** No action needed. Flagging for awareness only.

**L2: `handle_rate_limit` always throws, but `http.ts:113` has a dead `break` after it**

- **File:** `src/common/http.ts:112-113`
- **What:** `handle_rate_limit(provider)` is typed as `never` (it always throws). The `break` on the next line is dead code.
- **Why:** Misleading to readers who might think execution continues.
- **Fix:** Remove the `break` statement.

**L3: `OmnisearchMCP.init()` caches the init promise but the DO class creates a new `McpServer` every time the class is instantiated**

- **File:** `src/worker.ts:178-186`
- **What:** `server` is a class property initialized inline with `new McpServer(...)`. Every time the Durable Object is instantiated, a new McpServer is created. `init()` then registers tools and handlers on it.
- **Why:** This is correct because each DO instance should have its own McpServer. But if CF reuses the same DO JavaScript object across hibernation cycles, the `server` property is re-initialized but `_init_promise` retains the old resolved promise. The `init()` method won't re-register tools because `_init_promise` is already resolved.
- **Fix:** This is actually fine because CF creates a new class instance on each DO activation. The `_init_promise` pattern with error reset is correct. No change needed.

---

### POSITIVE

**P1: SSE keepalive injection is production-grade**
The event-boundary buffering at `worker.ts:62-166` is the standout piece of engineering in this codebase. It correctly handles all three SSE line ending conventions, avoids injecting pings mid-event, serializes concurrent writes with a promise chain, and uses an efficient chunked buffer. This solves a real problem (Claude web's 45s timeout) with minimal overhead.

**P2: Provider registration pattern is exemplary**
The `registration` export + `PROVIDERS` array + `key()` function pattern makes adding a new provider a 3-step process: create the file, add a config entry, add one line to the unified dispatcher. The `key()` function doubles as an availability check, eliminating a separate "is configured" flag.

**P3: RRF ranking with tail rescue is well-designed**
The `rescue_tail_results` function prevents valuable unique-domain results from being discarded during truncation. The `RESCUE_INTRA_RANK_THRESHOLD` of 2 means only results that were top-ranked *within their provider* are rescued, preventing noise from being promoted.

**P4: Snippet collapse is genuinely sophisticated**
The `snippet_selector.ts` implementation goes beyond simple dedup. Bigram Jaccard similarity, sentence-level greedy set-cover, and diversity-threshold-based merge/select is a thoughtful approach to maximizing information density in search results.

**P5: Error hierarchy enables clean HTTP status mapping**
The `ProviderError` + `ErrorType` enum pattern allows the REST endpoints to map errors to appropriate HTTP status codes (429 for rate limit, 400 for invalid input, 502 for upstream failure) without inspecting error message strings.

**P6: HTTP response streaming with byte counter prevents OOM**
The `http_core` function in `common/http.ts` reads responses as a stream with a running byte counter, rejecting payloads over 5MB even when chunked-encoding omits the Content-Length header. This prevents a malicious or buggy provider from OOM-ing the Worker.

**P7: Defensive copies after deadline in orchestrators**
Both `answer_orchestrator.ts:223-224` and `web_search_fanout.ts:151-155` create spread copies of the results arrays after the deadline fires. This prevents late-arriving promise callbacks from mutating the data returned to the caller. The `is_done` flag + defensive copy is a clean pattern.

**P8: `make_signal` polyfill for `AbortSignal.any()`**
The polyfill at `common/utils.ts:12-19` correctly handles runtimes without `AbortSignal.any()` by wiring up listeners and timers with proper cleanup. The `{ once: true }` option prevents listener leaks.
