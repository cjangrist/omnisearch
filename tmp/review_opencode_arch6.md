I'll start by exploring the codebase structure and reading all the required files.
Based on my comprehensive review of the codebase, here is the architecture scorecard and traditional code review:

---

# Architecture Scorecard

## Area 1: CONCURRENCY & ASYNC PATTERNS
**Score: 6/10**

**Justification:**
Promise patterns are appropriate (`allSettled` for search fanout, `race` for deadlines, `any` for fetch racing). The `is_done` flag in `answer_orchestrator.ts:128` correctly prevents post-deadline mutations. However, the `make_signal` polyfill has a memory leak — the external signal listener is never removed on timeout (src/common/utils.ts:19-21). Additionally, `setInterval` in `answer_orchestrator.ts:168` continues running until `finally` in line 194, but the promise chain can resolve via `deadline` while providers are still returning — the interval doesn't know about deadline-triggered early termination.

**To reach 10/10:**
1. Fix `make_signal` polyfill to clean up listener: `const timer = setTimeout(() => { external.removeEventListener('abort', on_abort, { once: true }); controller.abort(); }, timeout_ms);`
2. Add explicit deadline awareness to the progress interval in `answer_orchestrator.ts` — track `is_deadline_reached` alongside `is_done`

---

## Area 2: STREAM HANDLING & SSE
**Score: 7/10**

**Justification:**
The SSE keepalive injection (src/worker.ts:62-169) is sophisticated — event boundary buffering with proper \n\n, \r\n\r\n, \r\r handling, write lock serialization, and chunk flattening. The `flatten()` function avoids O(n²) concatenation. However, `pump().catch(cleanup)` at line 162 fires-and-forgets errors silently. The `safe_write` function at line 76-78 also swallows errors in its catch chain.

**To reach 10/10:**
1. Add error logging before cleanup: `pump().catch((err) => { logger.error('SSE pump failed', { error: err }); cleanup(); });`
2. Log `safe_write` rejections before calling cleanup

---

## Area 3: ERROR HANDLING & RESILIENCE
**Score: 8/10**

**Justification:**
Excellent provider isolation — each provider runs in `Promise.allSettled` and failures don't propagate. The `ProviderError` class with `ErrorType` enum enables proper error categorization. REST endpoints return 502 on total failure. However, empty catch blocks silently swallow KV cache errors throughout, and `create_error_response` (src/common/utils.ts:114-125) discards stack traces and `ProviderError.details`.

**To reach 10/10:**
1. Add logging in catch blocks: `} catch (err) { logger.warn('KV cache miss/error', { error: err }); }`
2. Preserve error details in `create_error_response` by including `error.details` when available

---

## Area 4: DATA FLOW & PROVIDER ORCHESTRATION
**Score: 9/10**

**Justification:**
The three orchestrators have clear, well-separated responsibilities with excellent pipeline design. Provider registration uses atomic swap pattern in `providers/index.ts:79-82`. The gemini-grounded nested fanout is documented. The RRF implementation with rescue_tail_results is sophisticated. One concern: `ToolRegistry` in `tools.ts` has no `reset()` call when providers are re-initialized, and `register_tools` at line 250 is called without null checks (though guarded by `if (this.web_search_provider)`).

**To reach 10/10:**
1. Call `registry.reset()` in `providers/index.ts` before each register call, or check if the provider instance changed
2. Add defensive null checks: `if (!this.web_search_provider) { logger.warn('Web search provider not registered'); return; }`

---

## Area 5: CODE ORGANIZATION & MODULARITY
**Score: 8/10**

**Justification:**
Excellent file structure with clear separation: common utilities, server orchestration, provider implementations, and types. The unified dispatcher pattern in `src/providers/unified/*.ts` is elegant — adding a provider requires just one line. No circular dependencies detected. However, module-level mutable globals (`config`, `kv_cache`, `OPENWEBUI_API_KEY`) are concerning for testability. Provider implementations each define local interfaces (e.g., `TavilySearchResponse`, `JinaReaderResponse`) instead of sharing common patterns.

**To reach 10/10:**
1. Consider extracting common response shapes into shared interfaces in `src/common/types.ts`
2. Document the module-level global pattern in a comment explaining the atomic swap guarantee

---

## Area 6: TYPE SAFETY & INTERFACES
**Score: 8/10**

**Justification:**
Strict TypeScript throughout, minimal `any` usage, Zod schemas in tools match return types. `ProviderError` with `ErrorType` is a well-designed tagged union. The two `@ts-expect-error` at lines 178-180 are justified. However, the `FetchProvider` interface at src/common/types.ts:35-39 returns `Promise<FetchResult>` but the actual implementations sometimes return `undefined` (implicitly undefined due to void returns in catch blocks).

**To reach 10/10:**
1. Add explicit `return undefined` or `throw` in provider catch blocks that currently silently swallow errors
2. Verify all catch blocks in providers either throw `ProviderError` or return a valid result

---

## Area 7: CONFIGURATION & ENVIRONMENT
**Score: 8/10**

**Justification:**
Config initialization uses atomic swap pattern correctly. Environment binding validation logs provider availability. The comment at src/config/env.ts:17-18 explains the "add one entry" pattern clearly. Timeout constants (180000ms for AI, 30000ms for search/fetch) are reasonable but hardcoded. The `LLM_SEARCH_BASE_URL` and `LLM_SEARCH_API_KEY` conditional initialization (src/config/env.ts:292-299) correctly requires both keys.

**To reach 10/10:**
1. Extract timeout constants to a constants file or make them overridable via environment variables
2. Add validation that at least one provider is configured before startup (currently startup succeeds with zero providers)

---

## Area 8: OBSERVABILITY & DEBUGGING
**Score: 8/10**

**Justification:**
Comprehensive structured logging throughout with `request_id` via AsyncLocalStorage. Log levels used consistently. `duration_ms` captured at appropriate granularity. Provider-specific loggers via `loggers.search(p.name)` enable tracing. However, `run_web_search_fanout` doesn't log the query at info level (only debug), making it hard to trace in production without log level changes. KV cache hits/misses are logged but not the URL or query hash.

**To reach 10/10:**
1. Log query hash instead of full query in info-level logs for privacy-friendly tracing
2. Add KV cache hit rate metrics: `cache_hits`, `cache_misses` counters in structured logs

---

## Area 9: API DESIGN & PROTOCOL COMPLIANCE
**Score: 8/10**

**Justification:**
MCP protocol compliance is solid with proper `registerTool`, `registerResource` usage, and capability declarations. REST endpoints use appropriate status codes (200, 400, 413, 502, 503). CORS headers comprehensively configured. Tool descriptions are detailed and helpful. However, the `web_search` tool description at src/server/tools.ts:74 is extremely long — consider shortening. The `answer` tool description incorrectly claims "9 providers" which may not match actual count.

**To reach 10/10:**
1. Shorten tool descriptions to ~200 chars, move detailed docs to separate resources
2. Make provider count dynamic: `fans out to ${active_providers.length} providers`
3. Add rate limit response headers (X-RateLimit-Reset) when available from providers

---

## Area 10: PERFORMANCE & RESOURCE EFFICIENCY
**Score: 8/10**

**Justification:**
`SSE_PING` pre-encoded at module level avoids repeated TextEncoder calls. The `flatten()` function writes to a single Uint8Array. Response streaming with byte counting prevents unbounded memory. However, `find_event_boundary` in `worker.ts:101-112` does linear scanning on every chunk, which is acceptable for SSE but could be optimized for very large chunks. The `retry_with_backoff` in web search adds latency even when `max_retries: 1`.

**To reach 10/10:**
1. Consider using `TextEncoder` pooled instances or streaming for very high-throughput scenarios
2. The retry in `web_search_fanout.ts:100-103` with `max_retries: 1` could be disabled for timeout_ms scenarios since partial results are already expected

---

# Traditional Code Review

## CRITICAL — Must fix

**1. Memory leak in `make_signal` polyfill**
- **File:** `src/common/utils.ts:14-21`
- **What:** The external signal listener is never removed, causing memory leaks in long-running workers.
- **Why:** Every call to `make_signal` with an external signal adds a listener that's never cleaned up.
- **Fix:**
```typescript
const controller = new AbortController();
const on_abort = () => {
    clearTimeout(timer);
    controller.abort();
};
external.addEventListener('abort', on_abort, { once: true }); // Use once!
const timer = setTimeout(() => {
    external.removeEventListener('abort', on_abort, { once: true });
    controller.abort();
}, timeout_ms);
```

**2. Silent promise rejection in SSE pump**
- **File:** `src/worker.ts:162`
- **What:** `pump().catch(cleanup)` silently swallows all pump errors.
- **Why:** If the pump throws, operators have no visibility into the failure.
- **Fix:**
```typescript
pump().catch((err) => {
    logger.error('SSE pump failed', { op: 'sse_pump_error', error: err });
    cleanup();
});
```

## HIGH — Should fix

**3. Provider registration without reset**
- **File:** `src/providers/index.ts:26-27`, `src/server/tools.ts:46-56`
- **What:** `initialize_providers()` can be called multiple times (e.g., after config changes), but `ToolRegistry` instance is never reset, so old provider instances may persist.
- **Why:** If a provider key is removed and re-added, the old instance remains registered.
- **Fix:** Call `registry.reset()` before each registration, or add identity checks.

**4. `safe_write` error suppression**
- **File:** `src/worker.ts:76-78`
- **What:** `write_lock = write_lock.then(() => writer.write(chunk)).catch(cleanup)` hides write errors.
- **Why:** Operators cannot distinguish between intentional closure and write failures.
- **Fix:** Log errors before cleanup: `.catch((err) => { logger.warn('SSE write failed', { error: err }); cleanup(); })`

**5. Silent KV cache error swallowing**
- **Files:** `src/server/web_search_fanout.ts:38-40`, `src/server/fetch_orchestrator.ts:38-40`
- **What:** Catch blocks silently proceed without logging cache failures.
- **Why:** Cache errors are invisible — hard to diagnose cache issues in production.
- **Fix:** Add `logger.debug('Cache write failed, proceeding without cache', { error: err });`

## MEDIUM — Should fix soon

**6. Incorrect provider count in tool description**
- **File:** `src/server/tools.ts:74`
- **What:** Description says "Fans out to 9 search engines" but the actual count depends on configured API keys.
- **Why:** Misleading documentation could cause confusion.
- **Fix:** Make dynamic or remove the specific number: `Fans out to all configured search engines in parallel`

**7. `retry_with_backoff` adds latency to timeout_ms scenarios**
- **File:** `src/server/web_search_fanout.ts:100-103`
- **What:** Providers are retried even when `timeout_ms` is set, adding latency that may cause partial results.
- **Why:** With `max_retries: 1`, worst case doubles provider latency.
- **Fix:** Skip retry when `timeout_ms` is set: `{ max_retries: timeout_ms ? 0 : 1, signal: combined_signal }`

**8. ToolRegistry.register_web_search_tool called unconditionally**
- **File:** `src/server/tools.ts:59-61`
- **What:** `if (this.web_search_provider)` guards only the registration, not the tool setup call.
- **Why:** If provider is not registered, `register_web_search_tool` is never called but no warning is logged.
- **Fix:** Add warning log when providers are missing: `logger.warn('No web search provider registered, skipping tool registration');`

## LOW — Nice to have

**9. Unused `reset_registry` export**
- **File:** `src/server/tools.ts:249`
- **What:** `reset_registry` is exported but never called.
- **Why:** Dead code that could confuse future maintainers.
- **Fix:** Either use it (in `initialize_providers`) or remove it.

**10. Zod v4 API usage**
- **File:** `src/server/tools.ts:75-95`
- **What:** Using `.describe()` method which may differ between Zod versions.
- **Why:** The codebase uses Zod v4 (package.json: `"zod": "^4.3.6"`), verify compatibility.
- **Fix:** Verify `.describe()` API is correct for Zod 4.

## POSITIVE — What was done well

1. **RRF ranking with rescue_tail_results** — The `rescue_tail_results` function in `rrf_ranking.ts:86-106` intelligently rescues results that might be cut off by truncation, preventing important content from being lost.

2. **SSE keepalive injection** — The event boundary buffering pattern in `worker.ts:62-169` is production-grade, correctly handling all three SSE delimiter variants and preventing partial event injection.

3. **Snippet collapse with greedy set-cover** — The `snippet_selector.ts` uses a sophisticated algorithm combining Jaccard similarity, bigram/trigram scoring, and sentence-level greedy merge.

4. **Domain breakers pattern** — The `matches_breaker` function in `fetch_orchestrator.ts:123-132` efficiently routes social media and YouTube URLs to specialized providers before the waterfall.

5. **Module-level pre-encoded constants** — `SSE_PING` at `worker.ts:60` is encoded once at module load, avoiding repeated TextEncoder allocations.

6. **Atomic swap in provider initialization** — The pattern in `providers/index.ts:79-82` ensures concurrent requests never see a transient empty state.
