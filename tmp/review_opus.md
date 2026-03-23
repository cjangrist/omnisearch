# Code Review: OmniSearch MCP Server on Cloudflare Workers with Durable Objects

---

### CRITICAL — Must fix before merging

**1. Module-level globals shared across DO instances cause cross-session state pollution**

- **File:** `src/config/env.ts:16-250`, `src/server/tools.ts:21-24,247`
- **What:** `config`, `active_providers`, `OPENWEBUI_API_KEY`, `OMNISEARCH_API_KEY`, and the singleton `ToolRegistry` are all module-level globals. Cloudflare documentation explicitly states: "Two different instances of [a DO class] will each have their own separate memory for instance variables, but might share memory for the global variable." Multiple DO instances of `OmnisearchMCP` within the same isolate share these module-level variables.
- **Why it matters:** When `OmnisearchMCP.init()` calls `initialize_config(this.env)`, it writes to the shared `config` object. If two DO instances are co-located in the same isolate (which Cloudflare confirms happens when an account has many instances of the same class), the second `init()` overwrites the first's config. Since all instances share the same `this.env` bindings this is currently benign, but the architecture is fundamentally unsound: if env bindings ever differ per-instance (e.g., multi-tenant routing), this silently corrupts state. More critically, `initialize_providers()` calls `reset_registry()` which clears `active_providers` and the singleton `ToolRegistry` — if this races with a concurrent tool call on another instance in the same isolate, the tool call sees a half-initialized or cleared registry.
- **Fix:** Move all mutable state into instance properties on the `OmnisearchMCP` class. Store `config`, providers, and the tool registry on `this` instead of module-level singletons. Pass them through to tool handlers. Alternatively, use `blockConcurrencyWhile()` in a custom constructor approach, though the `agents` package manages DO construction internally.

**2. Late-arriving promise mutations corrupt answer results after deadline**

- **File:** `src/server/answer_orchestrator.ts:121-155,202-207`
- **What:** The `tracked` promises push into `answers` and `failed` arrays via `.then()` callbacks. After `Promise.race` resolves (deadline hit), the code takes defensive copies with `[...answers]` and `[...failed]`. However, between the `Promise.race` returning and the spread operator executing, additional callbacks can fire and push into the arrays (JavaScript microtask queue drains between each `await`). The defensive copy happens on lines 204-206, but the `clearTimeout` on line 174 and `clearInterval` on line 176 happen first — during which microtasks from completing promises can push more entries.
- **Why it matters:** A provider that completes in the same microtask batch as the deadline timeout will be counted in both `answers` (as a success) and `failed` (as timed out on line 184), because `completed_set` is checked after `Promise.race` returns but before the pending-check loop. The `completed_count < total_count` check on line 180 uses the stale count from before microtask drain. This produces inconsistent results: a provider appearing in both `providers_succeeded` and `providers_failed`.
- **Fix:** After `Promise.race`, immediately snapshot `completed_set` and `completed_count` before any further `await` or synchronous work. Or refactor to use `Promise.allSettled` with `AbortController` to cancel pending work at the deadline rather than racing.

**3. `inject_sse_keepalive` can interleave keepalive bytes mid-SSE-event**

- **File:** `src/worker.ts:62-99`
- **What:** The `pump()` loop reads chunks from the original body and writes them to the transform stream, while the `setInterval` independently writes `SSE_PING` bytes. The original response body is chunked by the runtime — there is no guarantee a single `reader.read()` returns a complete SSE event. A chunk might end mid-event (e.g., after `event: message\ndata: {"jsonrpc"` but before the terminating `\n\n`). If the keepalive interval fires between two such chunks, the ping bytes are injected into the middle of an SSE event.
- **Why it matters:** The client receives a malformed SSE event that fails to parse. For MCP clients this means the JSON-RPC response is corrupted, causing the tool call to fail silently or error. Under normal load with fast responses this is unlikely, but during the 120-second answer fanout with large payloads it becomes increasingly probable.
- **Fix:** Track SSE framing state in the pump. Buffer incoming bytes and only allow keepalive injection at event boundaries (after `\n\n`). One approach: scan each chunk for `\n\n` and set a flag indicating whether the stream is currently mid-event. Only write keepalive when the flag indicates a clean boundary. Alternatively, since the `agents` package uses `event: message\ndata: ...\n\n` framing, buffer until you see the double-newline terminator before allowing interleaved writes.

---

### HIGH — Should fix before merging

**4. SSE keepalive uses named event instead of SSE comment**

- **File:** `src/worker.ts:60`
- **What:** The keepalive is `event: ping\ndata: keepalive\n\n` — a named SSE event. The SSE specification recommends using comment lines (starting with `:`) for keepalive: `:\n\n` or `: keepalive\n\n`. The comment notes "MCP SDK clients silently ignore it (they only process `event: message` or unnamed events)" but this relies on undocumented behavior of specific MCP client implementations.
- **Why it matters:** Named events ARE dispatched by `EventSource` and other SSE client implementations. If any MCP client listens for all event types (not just `message`), it will receive spurious `ping` events that could cause parse errors or unexpected behavior. The SSE spec specifically designates comment lines as the correct mechanism for keepalive because they are guaranteed to be silently ignored by all conforming implementations.
- **Fix:** Change to `const SSE_PING = new TextEncoder().encode(': keepalive\n\n');`. This is guaranteed to be silently consumed by every SSE parser per the specification.

**5. REST endpoints re-initialize providers on every request**

- **File:** `src/worker.ts:173-176,194-197`
- **What:** Both `/search` and `/fetch` REST handlers call `initialize_config(env)`, `validate_config()`, and `initialize_providers()` on every single request. `initialize_providers()` calls `reset_registry()` (clearing all providers and sets), then reconstructs everything from scratch — including instantiating new `UnifiedWebSearchProvider`, `UnifiedAISearchProvider`, and `UnifiedFetchProvider` objects, each of which creates a `Map` of all provider instances.
- **Why it matters:** This is wasteful on every request (constructing ~25+ fetch provider instances, ~9 search provider instances, ~9 AI provider instances). More critically, on concurrent REST requests, one request calling `reset_registry()` while another is mid-fanout will clear the active providers mid-execution. The module-level globals are shared across all concurrent requests in the same Worker isolate.
- **Fix:** Add an initialization guard similar to the DO's `_initialized` flag, or use a module-level `let initialized = false` check. Call `initialize_config` only once per isolate activation. For the concurrency issue, either use a lock/flag or restructure so provider instances are request-scoped (passed through rather than stored globally).

**6. `original.body!` non-null assertion can crash on bodyless responses**

- **File:** `src/worker.ts:65`
- **What:** `const reader = original.body!.getReader()` uses `!` to assert the body is non-null. The guard on line 229 checks `response.body` before calling `inject_sse_keepalive`, but if the `agents` package ever returns a response with `content-type: text/event-stream` but a null body (e.g., an error response), this will throw a TypeError.
- **Why it matters:** An unhandled TypeError in the Worker fetch handler returns a generic 500 error with no context about what happened. The `try/catch` on line 225 would catch it, but the error message would be unhelpful ("Cannot read properties of null").
- **Fix:** Add a null check: `if (!original.body) return original;` at the top of `inject_sse_keepalive`.

**7. `clearTimeout(timer_id!)` uses `!` on potentially unassigned variable**

- **File:** `src/server/answer_orchestrator.ts:171-174`
- **What:** `timer_id` is declared with `let` and assigned inside the `Promise` constructor callback. The `clearTimeout(timer_id!)` on line 174 uses a non-null assertion. While JavaScript's synchronous `Promise` constructor execution guarantees `timer_id` is assigned before `clearTimeout` is reached, this is a subtle reliance on Promise constructor semantics that makes the code fragile.
- **Why it matters:** If the code is ever refactored (e.g., `deadline` becomes an async function), `timer_id` could be undefined when `clearTimeout` is called, leading to a silent no-op (clearTimeout with undefined doesn't throw but doesn't clean up either). The same pattern appears in `src/server/web_search_fanout.ts:88-91`.
- **Fix:** Use `AbortController` + `AbortSignal.timeout()` instead of manual timer management, or restructure to assign `timer_id` before the Promise:
  ```typescript
  const controller = new AbortController();
  const deadline_timer = setTimeout(() => controller.abort(), GLOBAL_TIMEOUT_MS);
  // ... use controller.signal
  clearTimeout(deadline_timer);
  ```

**8. `answer` tool triggers a duplicate web search fanout for gemini-grounded**

- **File:** `src/server/answer_orchestrator.ts:80-92`
- **What:** When `gemini-grounded` is active, `build_tasks` calls `run_web_search_fanout(web_search_ref, query)` inside the gemini-grounded task. This fans out to all 9 search providers again, independently of any `web_search` tool call the client may have already made. The answer tool always triggers this additional search fanout.
- **Why it matters:** If a user calls `web_search` then `answer` (a common pattern), the web search fanout runs twice — once for the web_search tool and once embedded inside the answer tool's gemini-grounded task. This doubles API usage for all 9 search providers and adds significant latency to the gemini-grounded path. With 9 search APIs at various costs, this could meaningfully impact billing.
- **Fix:** Consider caching recent web search results (keyed by query) with a short TTL, or accepting pre-computed web results as an optional parameter to `run_answer_fanout`. Alternatively, if the overhead is acceptable, document this as intentional behavior.

---

### MEDIUM — Should fix soon

**9. `ToolRegistry` is a singleton but `register_tools` is called per-DO-instance**

- **File:** `src/server/tools.ts:247,252`, `src/worker.ts:128`
- **What:** `register_tools(this.server)` is called in `OmnisearchMCP.init()`, which calls `registry.setup_tool_handlers(server)` on the module-level singleton. If two DO instances in the same isolate call `init()`, tools are registered on both `McpServer` instances, but the singleton registry only tracks one set of providers. The `reset_registry()` call in `initialize_providers()` clears the singleton while another DO instance's `McpServer` still holds references to the old (now undefined) providers.
- **Why it matters:** In practice this is mitigated by the `_initialized` guard on each DO instance, but the architecture couples per-instance state (McpServer) to shared singletons, creating a latent bug if initialization order changes.
- **Fix:** Make `ToolRegistry` per-instance rather than a module-level singleton, or pass the registry instance explicitly.

**10. `_initialized` guard does not protect against concurrent `init()` calls**

- **File:** `src/worker.ts:121-132`
- **What:** The `_initialized` flag is checked synchronously, but `init()` is async. If two concurrent requests trigger `init()` before the first completes, both will see `_initialized === false` and proceed with initialization, causing `initialize_providers()` to run twice concurrently (and `reset_registry()` to clear state mid-initialization of the first call).
- **Why it matters:** The `agents` package calls `init()` from `onStart()`, which is called each time the DO activates. If two requests arrive simultaneously at a cold DO, they could race through `init()`. Cloudflare's input gate should serialize these in practice, but relying on undocumented serialization is fragile.
- **Fix:** Use a Promise-based guard:
  ```typescript
  private _initPromise: Promise<void> | null = null;
  async init(): Promise<void> {
    if (!this._initPromise) {
      this._initPromise = this._doInit();
    }
    return this._initPromise;
  }
  ```

**11. `agents@^0.7.9` semver range allows breaking changes**

- **File:** `package.json:14`
- **What:** The `^0.x.y` semver range in npm allows minor version bumps for 0.x packages (e.g., 0.8.0, 0.9.0), which are considered breaking changes per semver spec. The `agents` package is pre-1.0 and actively changing — the `McpAgent` API, `serve()` options, transport types, and CORS handling could all change.
- **Why it matters:** A `npm install` or deploy could pull in 0.8.0 which changes the `serve()` signature, CORS header behavior, or transport internals, breaking the server without any code changes.
- **Fix:** Pin to exact version: `"agents": "0.7.9"` (no caret). Same recommendation for `@modelcontextprotocol/sdk` since the `@ts-expect-error` on line 108 already indicates version sensitivity.

**12. Dual SDK versions with `@ts-expect-error` suppresses real type errors**

- **File:** `src/worker.ts:108-109`
- **What:** The `agents` package bundles `@modelcontextprotocol/sdk@1.26.0` internally while the project depends on `1.27.1`. The `@ts-expect-error` suppresses the resulting type mismatch. If `esbuild` deduplicates to one version at bundle time, this works. But if it doesn't (or if the versions diverge further), runtime errors are possible — two different `McpServer` classes with incompatible internal state.
- **Why it matters:** The `@ts-expect-error` is a blanket suppression that will hide any future type errors on the `server` property, not just the version mismatch. If the `McpServer` constructor API changes in a future SDK version, TypeScript won't catch the breakage.
- **Fix:** Add `overrides` (or `resolutions`) in `package.json` to force a single SDK version:
  ```json
  "overrides": {
    "agents": {
      "@modelcontextprotocol/sdk": "^1.27.1"
    }
  }
  ```
  Then remove the `@ts-expect-error`.

**13. `handle_rate_limit` in `http.ts` falls through instead of throwing**

- **File:** `src/common/http.ts:106-107`
- **What:** The `case 429` in `http_core` calls `handle_rate_limit(provider)` then `break`. Looking at `handle_rate_limit` in `utils.ts:36-48`, it is declared as `(): never` and always throws. So the `break` is dead code and the behavior is correct. However, if `handle_rate_limit` is ever refactored to not throw (e.g., to return a retry-after header value), the `break` would cause the function to fall through to return `{ raw, status: 429 }` — treating a rate-limited response as a success.
- **Why it matters:** The `break` after a `never`-returning call is misleading and fragile.
- **Fix:** Remove the `break` and add `// handle_rate_limit always throws` as a comment, or restructure as `throw` inline: `throw new ProviderError(ErrorType.RATE_LIMIT, ...)`.

**14. CORS headers applied inconsistently between REST and MCP paths**

- **File:** `src/worker.ts:22-27,140-147`
- **What:** REST endpoints use `CORS_HEADERS` (set via `add_cors_headers`), while MCP endpoints use the `agents` package's `corsOptions`. The Worker-level `CORS_HEADERS` expose `mcp-session-id` and `mcp-protocol-version`, while the agents package's CORS with `exposeHeaders: '*'` relies on wildcard behavior that not all browsers support (Safari has historically had issues with `Access-Control-Expose-Headers: *`). Additionally, the OPTIONS handler on line 165 explicitly excludes `/mcp` from CORS preflight, delegating to the agents package — but if the agents package changes its CORS handling, this could break.
- **Why it matters:** Inconsistent CORS behavior between endpoints can cause subtle browser-side failures that are hard to debug. The wildcard `exposeHeaders: '*'` may not work in all browsers.
- **Fix:** Use explicit header lists in `corsOptions` instead of wildcards:
  ```typescript
  corsOptions: {
    origin: '*',
    headers: 'Content-Type, Authorization, mcp-session-id, Last-Event-ID, mcp-protocol-version',
    exposeHeaders: 'mcp-session-id, mcp-protocol-version',
  }
  ```

**15. `providers_failed` optional chaining is inconsistent**

- **File:** `src/server/rest_search.ts:146,163`
- **What:** `result.providers_failed?.length` uses optional chaining, but `FanoutResult.providers_failed` is typed as `Array<...>` (not optional) — it is always an array. The `?.` is unnecessary and suggests the developer was unsure of the type contract.
- **Why it matters:** Minor, but inconsistent optional chaining erodes trust in the type system and can mask real bugs elsewhere.
- **Fix:** Remove the `?.` — just use `result.providers_failed.length` and `result.providers_failed.map(...)`.

---

### LOW — Nice to have

**16. `Date.now()` called redundantly in answer orchestrator**

- **File:** `src/server/answer_orchestrator.ts:112,124,140,181,199,224,234`
- **What:** `Date.now()` is called once per provider completion (lines 124 and 140) and again at lines 181, 199, 234. Each individual provider's `duration_ms` is relative to the fanout start time rather than the provider's own start time (there is no `t0` per-provider). This means `duration_ms` for each provider in `answers` represents "time since fanout started" not "how long this provider took."
- **Why it matters:** The duration semantics are misleading in log output and in the API response. Users would expect `duration_ms` to be the provider's own latency, not elapsed wall-clock time since fanout start.
- **Fix:** Capture a `t0` per tracked promise (similar to how `web_search_fanout.ts:49` does it with `const t0 = Date.now()`) and compute `duration_ms = Date.now() - t0` per provider.

**17. Logger instances created at module level are not request-scoped**

- **File:** `src/common/logger.ts:174-187`, used everywhere
- **What:** Every file creates loggers at module level (e.g., `const logger = loggers.worker()`) which creates a new `Logger` instance. These loggers have no `requestId` set by default. The `setRequestId` method exists but is never called. All log entries across all requests in the same isolate share the same logger instances with no request correlation.
- **Why it matters:** In production, logs from concurrent requests are interleaved with no way to correlate them. The `request_id` generated in `worker.ts:153` is only passed as a context field in the worker's own logs, not propagated to downstream loggers.
- **Fix:** Either pass `request_id` through to all function calls and include it in log context, or use `AsyncLocalStorage` to propagate request context automatically.

**18. `handler.ts` provider-info resource returns hardcoded rate limits**

- **File:** `src/server/handlers.ts:82-86`
- **What:** The `provider-info` resource template returns hardcoded `requests_per_minute: 60, requests_per_day: 1000` for all providers regardless of actual rate limits. The `capabilities` array is hardcoded to `['web_search', 'news_search']` even for fetch-only or AI-only providers.
- **Why it matters:** Misleading information returned to MCP clients. A client might use these rate limits for throttling decisions.
- **Fix:** Either return accurate per-provider rate limits or remove the hardcoded values and return only the provider's actual capabilities and status.

**19. `ResourceTemplate` with `list: undefined` omits the provider-info from resource listing**

- **File:** `src/server/handlers.ts:53`
- **What:** `new ResourceTemplate('omnisearch://search/{provider}/info', { list: undefined })` — the `list` option set to `undefined` means this resource template will not appear in `resources/list` responses. Clients must know the exact URI pattern to discover it.
- **Why it matters:** MCP clients performing resource discovery won't find the provider-info resource, making it effectively undiscoverable.
- **Fix:** Implement the `list` callback to return available providers, or document that this resource is only accessible by explicit URI construction.

**20. Naming inconsistency: `camelCase` vs `snake_case`**

- **File:** Various
- **What:** The codebase mostly uses `snake_case` for functions and variables, but some spots use `camelCase`: `totalProviders` in `providers/index.ts:77`, `providerName`/`isAvailable` in `handlers.ts:59-65`, Logger class methods like `setRequestId`, `startOp`, `providerLog` use camelCase while the rest of the codebase uses snake_case.
- **Why it matters:** Inconsistent naming reduces readability and increases cognitive load when reading across files.
- **Fix:** Standardize on `snake_case` throughout (which is the dominant convention in this codebase).

**21. `zod@^4.3.6` is a major version jump**

- **File:** `package.json:16`
- **What:** Zod v4 is a major version with breaking changes from v3. The `agents` and `@modelcontextprotocol/sdk` packages may depend on Zod v3 internally. If both versions end up in the bundle, schema validation could produce unexpected results when types cross the boundary.
- **Why it matters:** Potential runtime incompatibility if the MCP SDK's internal Zod schemas (v3) are validated against Zod v4 runtime.
- **Fix:** Verify that all dependencies are compatible with Zod v4, or pin to the version the SDK expects.

---

### POSITIVE — What was done well

**P1. SSE keepalive at the Worker wrapper level is architecturally sound**

- **File:** `src/worker.ts:53-99`
- **What:** Injecting keepalive at the Worker level (outside the DO) rather than inside the MCP server or tool handlers is the right layering decision. It keeps the tool code clean, works for all SSE responses uniformly, and correctly targets only POST responses with `text/event-stream` content type.

**P2. Defensive copies after deadline in fanout patterns**

- **File:** `src/server/answer_orchestrator.ts:202-207`, `src/server/web_search_fanout.ts:106-110`
- **What:** Both fanout patterns snapshot results after the deadline to prevent post-deadline mutations from in-flight promises. This shows awareness of the race condition between deadline resolution and promise callbacks. (Though as noted in CRITICAL #2, the window is not fully closed.)

**P3. Fetch waterfall with domain breakers is well-designed**

- **File:** `src/server/fetch_orchestrator.ts`
- **What:** The tiered waterfall architecture (breakers -> solo -> parallel -> sequential) is an excellent pattern. Domain-specific breakers (YouTube -> supadata, social -> sociavault) try specialized providers first, then fall through to the general waterfall. The `pick_best` heuristic (longest content wins) for parallel steps is simple and effective.

**P4. RRF ranking with rescue and quality filtering**

- **File:** `src/common/rrf_ranking.ts`
- **What:** The Reciprocal Rank Fusion implementation is clean and correct. The rescue mechanism for tail results (checking intra-rank threshold and domain diversity) prevents useful results from being discarded. The quality filter requiring either multi-provider corroboration or sufficient snippet length is a good heuristic.

**P5. Intelligent snippet selection/merge**

- **File:** `src/common/snippet_selector.ts`
- **What:** The sentence-level greedy set-cover algorithm for merging diverse snippets is sophisticated and well-implemented. Using Jaccard similarity on bigrams to detect diversity, then merging only when snippets are sufficiently different, maximizes information density without redundancy.

**P6. Consistent error handling with `ProviderError` hierarchy**

- **File:** `src/common/types.ts:41-58`, used throughout
- **What:** The `ProviderError` class with `ErrorType` enum provides consistent error categorization across all providers. The `shouldRetry` logic in `retry_with_backoff` correctly only retries transient errors, never auth or rate limit failures.

**P7. `timing_safe_equal` for API key comparison**

- **File:** `src/common/utils.ts:6-12`
- **What:** Using `crypto.subtle.timingSafeEqual` for Bearer token comparison prevents timing side-channel attacks. The length check before the comparison is also correct (timing-safe compare requires equal-length buffers).

**P8. Provider registration pattern is clean and extensible**

- **File:** `src/providers/unified/web_search.ts`, `src/providers/unified/ai_search.ts`, `src/providers/unified/fetch.ts`
- **What:** The `PROVIDERS` array with `{ name, ...registration, factory }` pattern makes adding a new provider a single-line change. The `key()` function pattern for checking API key availability is elegant and consistent across all three provider categories.

**P9. HTTP utility layer with size guards and URL sanitization**

- **File:** `src/common/http.ts`
- **What:** The `http_core` function provides a solid foundation: response size limits (5MB), sensitive parameter redaction in logs, structured error handling for different HTTP status codes, and consistent timing/logging. The dual-check (content-length header + actual body length) catches cases where servers lie about content length.
