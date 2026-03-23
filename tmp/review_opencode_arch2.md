I'll conduct a comprehensive review of this MCP server codebase. Let me start by exploring the structure and reading all the relevant files.
Now let me read some provider implementations and external packages to understand the patterns:
Now I have a comprehensive understanding of the codebase. Let me compile the architecture scorecard and traditional code review.

---

# Architecture Scorecard

## Area 1: CONCURRENCY & ASYNC PATTERNS — **7/10**

**Justification:** The codebase demonstrates solid async patterns with `Promise.race` for deadline enforcement, `Promise.any` for parallel racing, and `Promise.allSettled` for graceful degradation. The `make_signal` utility is excellent — it correctly composes external and timeout abort signals. However, there are subtle race condition risks in the progress interval lifecycle, and the atomic swap pattern for module-level globals is fragile on CF Workers where isolate lifecycle is non-deterministic.

**To reach 10/10:**
1. In `answer_orchestrator.ts:163-174`, capture `tracked.length` into a local variable before the `setInterval` fires, and check `is_done` inside the interval callback to prevent logging after cleanup.
2. In `web_search_fanout.ts:121-145`, the `pending` filter after deadline race should snapshot both `results_by_provider` and arrays BEFORE returning to prevent any concurrent mutation from the finally block.
3. Add explicit cleanup ordering documentation: the `cleanup()` function in `inject_sse_keepalive` should explicitly document that `reader.cancel()` must be called before `writer.close()` to prevent dangling promises.

---

## Area 2: STREAM HANDLING & SSE — **8/10**

**Justification:** The SSE keepalive injection with event-boundary buffering is sophisticated and correct. The write lock prevents concurrent writer access. The TransformStream pump properly handles backpressure through the reader loop. The `total_len === 0` guard correctly prevents injecting keepalive during partial events.

**To reach 10/10:**
1. In `worker.ts:126-131`, the keepalive interval's `total_len === 0` check should be `chunks.length === 0` — currently it skips pings when a partial read has accumulated bytes but no complete event exists yet, which could leave a dead connection for 5s if the upstream chunks never arrive.
2. In `worker.ts:60`, `SSE_PING` uses `\n\n` but per WHATWG SSE spec, the final terminator should be `\r\n\r\n` after the data field. Change to `new TextEncoder().encode('event: ping\r\ndata: keepalive\r\n\r\n')` for spec compliance.
3. In `worker.ts:84-86`, `reader.cancel()` and `writer.close()` in `cleanup()` should be swapped — close the writer first to prevent writes to a cancelled stream.

---

## Area 3: ERROR HANDLING & RESILIENCE — **8/10**

**Justification:** Provider failures are tightly isolated — each runs in its own promise that catches errors and records them. The `retry_with_backoff` utility has well-reasoned retry semantics (only retries `PROVIDER_ERROR`, not auth/rate-limit). Graceful degradation is implemented: partial results are returned even when some providers fail. The REST endpoints return appropriate status codes (502 on total failure, 429 on rate limit).

**To reach 10/10:**
1. In `fetch_orchestrator.ts:317-329`, the waterfall exhaustion error lacks structured context (which steps were tried, error messages from each provider). Add `providers_failed` array to the thrown `ProviderError` details.
2. In `rest_search.ts:168-176`, the 502 response when all providers fail doesn't include the `Content-Type: application/json` header explicitly — use `Response.json()` which sets it automatically.
3. In `common/utils.ts:130-137`, the `shouldRetry` function in `retry_with_backoff` catches all errors but doesn't distinguish between network timeouts (retriable) and client errors like 400 Bad Request (not retriable). Add explicit handling for `fetch` TypeErrors.

---

## Area 4: DATA FLOW & PROVIDER ORCHESTRATION — **9/10**

**Justification:** The three fanout pipelines (web search, answer, fetch) are well-separated and each follows a clear logical flow. The RRF ranking with rescue tail is a sophisticated and well-implemented deduplication strategy. The query cache in `web_search_fanout.ts` is a smart optimization. Provider registration is elegant — adding a new provider requires only adding one line to the unified dispatcher.

**To reach 10/10:**
1. In `web_search_fanout.ts:17-26`, the cache key generation includes `timeout_ms: 0` when unset, meaning two calls with no timeout and one with `timeout_ms: undefined` would have different cache keys. Normalize to only include `timeout_ms` when it differs from the default.
2. In `fetch_orchestrator.ts:33-77`, the `CONFIG` object mirrors `config.yaml` but is hardcoded. Changes to one require updating the other. Add a runtime validation that `CONFIG.waterfall` providers are all in `get_active_fetch_providers()`.

---

## Area 5: CODE ORGANIZATION & MODULARITY — **8/10**

**Justification:** The codebase is exceptionally well-organized with clear separation between common utilities, config, providers, and server. The unified dispatcher pattern is elegant. No circular dependencies are evident. Import hygiene is good — each module imports only what it needs.

**To reach 10/10:**
1. The `ToolRegistry` singleton in `tools.ts` is populated by side effects from `providers/index.ts`. This hidden ordering dependency means `reset_registry()` won't work correctly if called between `initialize_config` and `register_tools`. Add an explicit initialization order check.
2. In `providers/unified/ai_search.ts:25`, `...llm_reg` spreads an array of registrations, but `llm_search` doesn't follow the same pattern as other providers (it supports multiple sub-providers). This special case is not documented — add a comment explaining why.

---

## Area 6: TYPE SAFETY & INTERFACES — **7/10**

**Justification:** TypeScript strict mode is enabled and the codebase is generally well-typed. The `BaseSearchParams` interface with `signal?: AbortSignal` is forward-thinking. Discriminated unions are used in `fetch_orchestrator.ts` (`WaterfallStep`). However, there are `any` casts and `as unknown as` patterns that reduce type safety.

**To reach 10/10:**
1. In `tools.ts:155`, `structuredContent: answer_result as unknown as Record<string, unknown>` — the double cast indicates the `AnswerResult` type doesn't match MCP SDK's expected `structuredContent` type. Define a proper MCP-compatible interface.
2. In `common/utils.ts:130`, `shouldRetry: (error: unknown) =>` — this should be `(error: unknown) => error is Error` with a type predicate, then the `instanceof ProviderError` check on line 131 would be type-safe.
3. In `fetch_orchestrator.ts:67-76`, the `failure.challenge_patterns` array is string-based but should be `RegExp[]` for efficiency — the current `.some()` with `.includes()` on a 12-element array is fine but RegExp patterns are more expressive for complex patterns like `[Chrome](https://www.google.com/chrome/)`.

---

## Area 7: CONFIGURATION & ENVIRONMENT — **7/10**

**Justification:** The config is centralized in `config/env.ts` with per-provider timeouts and base URLs. Validation logs available/missing keys. The pattern of writing to module-level globals is a deliberate choice that works on CF Workers where each isolate handles one request at a time.

**To reach 10/10:**
1. In `config/env.ts:16-250`, the `config` object uses inline type annotations (`as string`) in some places but not others (e.g., `brightdata.zone`). Normalize to explicit type annotations.
2. In `config/env.ts:278-294`, the LLM search config (chatgpt/claude/gemini) requires BOTH `LLM_SEARCH_BASE_URL` AND `LLM_SEARCH_API_KEY`. The conditional only sets base_url when both exist, but could fail silently if one is missing. Add explicit validation that both are required together.
3. In `wrangler.toml`, add a comment explaining why `[[migrations]]` is needed (SQLite class for stateful MCP connections) and what happens if this is omitted.

---

## Area 8: OBSERVABILITY & DEBUGGING — **7/10**

**Justification:** Structured logging is comprehensive with `request_id`, `op`, `duration_ms`, and provider-specific loggers. Log levels are used consistently (debug for verbose info, info for key operations, warn/error for failures). The `logger.response()` helper creates audit-trail style logs.

**To reach 10/10:**
1. Missing logs: `web_search_fanout.ts:170-177` doesn't log when no search providers are available before returning empty results. A client getting zero results without a logged warning would be hard to debug.
2. In `tools.ts:244`, the `ToolRegistry` singleton is instantiated at module load. If `register_tools()` is called multiple times (e.g., during DO re-initialization), it registers duplicate tools. Add a guard to prevent double-registration.
3. In `answer_orchestrator.ts:81-93`, the `gemini-grounded` task logs aren't provider-specific (uses generic logger). Thread the provider name through the task builder to enable per-provider timing.

---

## Area 9: API DESIGN & PROTOCOL COMPLIANCE — **8/10**

**Justification:** The MCP tool schemas are well-designed with accurate descriptions. The REST API follows REST conventions with appropriate HTTP methods and status codes. Input validation covers query length, body size, URL format. CORS headers are comprehensive.

**To reach 10/10:**
1. In `tools.ts:81-94`, the `outputSchema` for `web_search` describes the internal `FanoutResult` structure, but the actual return value is MCP-formatted `content` and `structuredContent`. Update `outputSchema` to match the actual return type (including the MCP wrapper).
2. In `tools.ts:169-173`, the fetch tool description says "ALWAYS USE THIS instead of your built-in URL fetcher" which is misleading — the tool doesn't handle all cases and may not be appropriate for all clients. Tone down the absolute language.
3. In `handlers.ts:22-43`, the `provider-status` resource returns a static JSON blob. Consider making it a `ResourceTemplate` that can accept query parameters for filtering (e.g., only active providers).

---

## Area 10: PERFORMANCE & RESOURCE EFFICIENCY — **8/10**

**Justification:** `TextEncoder` is instantiated once at module level. The chunk-based buffer in `inject_sse_keepalive` avoids O(n²) concatenation. The query cache with LRU eviction prevents unbounded growth. The SSE wrapper is only applied to SSE responses.

**To reach 10/10:**
1. In `web_search_fanout.ts:17-19`, the `fanout_cache` uses `Map.keys().next().value` for LRU eviction which is O(n). Use an `Array` with push/shift or a `LinkedList`-like structure for O(1) eviction.
2. In `providers/unified/web_search.ts:54-55`, the `UnifiedWebSearchProvider` constructor instantiates ALL provider classes eagerly. If a provider has expensive initialization (e.g., loading WASM), this could delay startup. Consider lazy instantiation.
3. In `common/rrf_ranking.ts:91-105`, `rescue_tail_results` creates a new `URL` object for every result in the loop. Move the hostname extraction outside the filter and use a pre-computed Set.

---

# Traditional Code Review

## CRITICAL — Must fix

### 1. `worker.ts:304-313` — SSE keepalive applied to non-SSE responses
```typescript
if (
  request.method === 'POST'
  && response.body
  && response.headers.get('content-type')?.includes('text/event-stream')
) {
  return inject_sse_keepalive(response);
}
```
**What:** The keepalive injection is applied to POST responses, but SSE is a GET-only protocol. POST SSE streams are non-standard and may break MCP protocol compliance.
**Why:** POST SSE is not defined in the WHATWG SSE spec. If the agents package ever returns a POST SSE response, it would be incorrectly transformed.
**Fix:** Change to `request.method === 'GET' &&`.

---

### 2. `answer_orchestrator.ts:186-188` — AbortController fires after deadline
```typescript
if (result === 'deadline' && abort_controller) {
  abort_controller.abort();
}
```
**What:** `abort_controller.abort()` is called AFTER `is_done = true`, meaning providers that have already resolved will continue to run until they naturally complete. The AbortSignal is meant to cancel in-flight requests, not clean up completed ones.
**Why:** This could cause providers to make unnecessary API calls that still count against rate limits. The abort should fire as soon as the deadline is known, not after.
**Fix:** Move `abort_controller.abort()` to fire immediately when the deadline promise resolves, and let `is_done = true` come after.

---

## HIGH — Should fix

### 3. `tools.ts:222-226` — Missing structuredContent on error path
```typescript
if (result.providers_succeeded.length === 0) {
  return {
    content: [{ type: 'text' as const, text: `All ${result.providers_failed.length} providers failed...` }],
    isError: true,
  };
}
```
**What:** Error returns omit `structuredContent`, while success returns include it. MCP clients using `structuredContent` for programmatic access will get `undefined`.
**Why:** Inconsistent return shape breaks programmatic clients that check for `structuredContent`.
**Fix:** Add `structuredContent: { error: '...', ...result }` to error returns.

---

### 4. `web_search_fanout.ts:144` — Race condition on deadline
```typescript
return {
  results_by_provider: new Map(results_by_provider),
  ...
};
```
**What:** A `Map` is returned that contains the state at deadline time, but the `provider_promises` array still has in-flight promises that may push to `results_by_provider` concurrently.
**Why:** If `results_by_provider` is mutated after the Map is created, the returned snapshot could contain inconsistencies (providers appearing in the Map that weren't completed).
**Fix:** Ensure all writes to `results_by_provider` happen before the Map snapshot, or use a mutex.

---

### 5. `common/utils.ts:10-11` — AbortSignal.any polyfill assumes modern runtime
```typescript
if (typeof AbortSignal.any === 'function') {
  return AbortSignal.any([external, AbortSignal.timeout(timeout_ms)]);
}
```
**What:** `AbortSignal.any()` is not available in all runtimes that this code might run on (including older Node.js and some CF Workers configurations).
**Why:** The polyfill below is correct but the runtime check may pass incorrectly if `AbortSignal.any` exists but is non-standard.
**Fix:** Check for a known implementation detail of the standard `AbortSignal.any`, or always use the polyfill for safety.

---

## MEDIUM — Should fix soon

### 6. `fetch_orchestrator.ts:69-75` — Hardcoded challenge patterns
```typescript
challenge_patterns: [
  'cf-browser-verification', 'challenge-platform', 'captcha',
  ...
]
```
**What:** These patterns are lowercase but `CONFIG.failure.challenge_patterns.some()` uses `.includes(p.toLowerCase())` on the content. If a provider returns uppercase patterns, they won't match.
**Why:** False negatives in challenge detection could return blocked content as valid.
**Fix:** Pre-lowercase the patterns array at module load time, or use a `Set<string>` for O(1) lookup with lowercase values.

---

### 7. `common/http.ts:106` — Rate limit throws without returning
```typescript
case 429:
  handle_rate_limit(provider);
  break; // unreachable
```
**What:** `handle_rate_limit` throws, so the `break` is dead code.
**Why:** Misleading code structure.
**Fix:** Remove the `break` statement or add `// unreachable` comment.

---

### 8. `providers/ai_response/llm_search/index.ts` — Import side effects
```typescript
// Verify the factory creates providers for all three LLM types
const llmRegistrations = (llm_reg as unknown as typeof PROVIDERS).length;
if (llmRegistrations !== 3) {
  throw new Error(`Expected 3 LLM registrations, got ${llmRegistrations}`);
}
```
**What:** The validation is done via import side effects at module load time. If the file is ever tree-shaken or imported lazily, the validation won't run.
**Why:** Fragile pattern that could silently break.
**Fix:** Move the validation to `initialize_providers()` in `providers/index.ts` where other initialization happens.

---

## LOW — Nice to have

### 9. `config/env.ts:341-379` — validate_config logs but doesn't throw
```typescript
if (available.length === 0) {
  logger.warn('No API keys found - no providers will be available');
}
```
**What:** `validate_config()` logs a warning when no keys are configured but doesn't throw. This means the server starts and all requests fail.
**Why:** Silent startup with no providers is a hard failure mode that would be better surfaced as an error.
**Fix:** Throw an error in `validate_config()` if no providers of any category are available, allowing the Worker to fail fast.

---

### 10. `worker.ts:236-248` — Timing measurement before await
```typescript
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const start_time = Date.now();
    const request_id = crypto.randomUUID();
```
**What:** `crypto.randomUUID()` is called before any async work. On CF Workers, `crypto.randomUUID()` may have subtle initialization costs.
**Why:** Micro-optimization — not worth changing unless profiling shows it matters.
**Fix:** Move after the first `await` if timing is critical.

---

## POSITIVE — What was done well

### 1. RRF Implementation (`rrf_ranking.ts`)
The Reciprocal Rank Fusion with tail rescue is sophisticated and well-implemented. The `normalize_url` function handles edge cases (trailing slashes, fragments). The quality filter with single-provider snippet length threshold is a smart heuristic.

### 2. Event Boundary Buffering (`worker.ts`)
The SSE keepalive injection with `find_event_boundary()` is the correct approach. Most implementations just inject pings unconditionally, which can corrupt in-flight events. This implementation is spec-compliant and robust.

### 3. Atomic Swap Pattern (`providers/index.ts`)
Building new state locally and swapping atomically is the correct pattern for module-level globals on CF Workers. This prevents concurrent requests from seeing empty intermediate states.

### 4. Provider Registration Pattern
The unified dispatcher pattern with `registration = { key: () => config... }` and factory functions is elegant. Adding a new provider requires one line. The `has_any_*` and `get_active_*` functions make it easy to check availability.

### 5. Error Classification (`types.ts`)
The `ErrorType` enum with `ProviderError` class provides structured error handling. The distinction between `API_ERROR`, `RATE_LIMIT`, `INVALID_INPUT`, and `PROVIDER_ERROR` enables granular retry decisions.

### 6. Fetch Waterfall Configuration
The tiered waterfall with domain breakers, parallel groups, and sequential fallbacks is well-designed. The `CONFIG` object is readable and maintainable.

### 7. Snippet Selection (`snippet_selector.ts`)
The bigram Jaccard similarity + greedy sentence-level set cover is a novel approach to intelligent snippet merging. The `DIVERSITY_THRESHOLD` of 0.3 prevents merging semantically different snippets.

### 8. Retry Strategy
The decision not to retry individual providers (because the fanout IS the redundancy) is the right call. The `retry_with_backoff` utility is well-designed for fetch providers where it's needed.

### 9. MCP Tool Descriptions
The tool descriptions are detailed and include guidance on when to use each tool. The warning about the answer tool taking up to 2 minutes is especially valuable.

### 10. DO Init Pattern (`worker.ts:182-201`)
The `_init_promise` caching with retry-on-failure is correct for DO initialization. The pattern of resetting `_init_promise = undefined` on error enables subsequent retries.
