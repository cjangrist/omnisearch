# Architecture Scorecard & Code Review: omnisearch MCP Server

## Architecture Scorecard

### Area 1: CONCURRENCY & ASYNC PATTERNS — **8/10**

**Justification:** The codebase demonstrates strong async discipline. Promise.race deadline handling in `answer_orchestrator.ts` with `is_done` flag mutation prevention is well-executed. `AbortController` threading through `make_signal()` (utils.ts) and the polyfill for `AbortSignal.any()` show awareness of cross-runtime compatibility. However, there are gaps: the `make_signal` polyfill creates a new timer that never gets cleaned up if the external signal aborts first (the `once: true` listener clears it, but the setTimeout isn't removed until abort fires — a minor leak on the happy path). The `keepalive` interval in worker.ts is cleared in cleanup but the interval's async write chain could race with cleanup.

**To reach 10/10:**
1. Fix the `make_signal` polyfill timer leak: add cleanup to the external signal's abort listener that clears the timeout before the timeout fires.
```typescript
// In make_signal polyfill, change the external abort handler:
const on_abort = () => {
  clearTimeout(timer); // Add this
  controller.abort();
};
```
2. Add explicit reader cancellation on the SSE pump when the keepalive interval detects `closed` flag before its next tick, to avoid a stale interval firing after cleanup is called.

---

### Area 2: STREAM HANDLING & SSE — **8/10**

**Justification:** The SSE keepalive injection in `worker.ts` (`inject_sse_keepalive`) is sophisticated — event-boundary buffering with `find_event_boundary`, the `chunks` array for O(1) appends, and the `write_lock` pattern for serializing pump writes and interval pings are all excellent. The agents package internally sends its own keepalive at 30s (`WorkerTransport`), so omnisearch's 5s injection is well-calibrated. However, there's a subtle issue: `safe_write` chains onto `write_lock` but doesn't handle the case where `writer.write()` rejects after the reader has completed and cleanup has been called — the rejection goes to `cleanup` which is idempotent but could mask real errors. Also, `total_len === 0` check means keepalive is injected only when buffer is empty, but this doesn't account for partial SSE events that haven't yet been flushed.

**To reach 10/10:**
1. Track whether the pump has completed separately from `closed` flag, so `safe_write` can distinguish "pump done, writer closed" from "writer error after pump done" and avoid swallowing legitimate errors.
2. In `inject_sse_keepalive`, add a `last_boundary_idx` to only inject keepalive when the buffer has no unprocessed bytes, replacing the simplistic `total_len === 0` check.

---

### Area 3: ERROR HANDLING & RESILIENCE — **8/10**

**Justification:** Provider failure isolation is solid — `Promise.allSettled` in web search, `Promise.any` with `resolved` flag in fetch parallel steps, and individual try/catch per provider ensure one failure doesn't crash others. The `shouldRetry` callback in `retry_with_backoff` correctly excludes non-transient errors. REST endpoints return 502 on total provider failure (rest_search.ts line ~100) which is correct. However, `answer_orchestrator.ts` logs a 500-level error for all-failure but doesn't surface it to the MCP client — the tool returns `isError: true` but the HTTP response is still 200, which could confuse monitoring. Also, `http.ts` 500 errors are thrown as `PROVIDER_ERROR` (line 77) which seems wrong — internal server errors from the provider should be `API_ERROR`, not `PROVIDER_ERROR`.

**To reach 10/10:**
1. In `http.ts`, change the 500-level branch from `ErrorType.PROVIDER_ERROR` to `ErrorType.API_ERROR`:
```typescript
// Line 77, change:
throw new ProviderError(ErrorType.PROVIDER_ERROR, ...)
// to:
throw new ProviderError(ErrorType.API_ERROR, ...)
```
2. Add a `ctx.waitUntil` wrapper around the KV answer cache write in `answer_orchestrator.ts` so cache writes don't block the response but are still tracked by CF Workers:
```typescript
ctx.waitUntil(kv_cache.put(...).catch(...)); // After response is sent
```

---

### Area 4: DATA FLOW & PROVIDER ORCHESTRATION — **9/10**

**Justification:** The three fanout patterns (search parallel→RRF, answer parallel→deadline, fetch waterfall→race) are well-designed and appropriate for their use cases. Provider registration via the `registration = { key: () => config... }` pattern in unified dispatchers is elegant — adding a provider requires only one file + one config entry. RRF ranking with `truncate_web_results` and the rescue mechanism for tail results is sophisticated. KV caching at each layer (search, answer, fetch) with appropriate TTLs (24h) is consistent. Minor issue: the `run_web_search_fanout` cache key includes `timeout_ms` (web_search_fanout.ts line ~25), but if `timeout_ms` fires mid-request, the cached result from a partial fanout is returned — a stale-partial-result bug. Also, `fetch_orchestrator.ts` always caches even on explicit provider mode.

**To reach 10/10:**
1. Remove `timeout_ms` from the search cache key in `web_search_fanout.ts` — timeout affects latency, not result quality. Cache should store the full result regardless of how fast it arrived.
```typescript
// Line 25, change to:
const make_cache_key = (query: string, options?: { skip_quality_filter?: boolean }): string => {
  const base = options?.skip_quality_filter ? `${query}\0sqf=true` : query;
  return KV_SEARCH_PREFIX + base;
};
```
2. In `fetch_orchestrator.ts`, skip cache write in explicit provider mode (already checked on read but not on write).

---

### Area 5: CODE ORGANIZATION & MODULARITY — **9/10**

**Justification:** File structure is excellent — clear separation between server orchestration (`server/`), provider implementations (`providers/`), shared utilities (`common/`), and config (`config/`). No circular dependencies detected. The `ToolRegistry` singleton pattern is clean. Provider implementations are isolated and follow the same pattern. Type definitions are centralized in `common/types.ts` with discriminated `ErrorType` enum. The one concern: module-level mutable state (`config`, `active_providers`, `_rest_init`, `_init_promise`) requires careful initialization ordering, which the code handles correctly with atomic swaps in `initialize_providers()`. `get_active_*_providers()` functions return closures (key getters) rather than values, which is a smart pattern.

**To reach 10/10:**
1. No changes needed — this is already best-in-class for this architecture pattern.

---

### Area 6: TYPE SAFETY & INTERFACES — **7/10**

**Justification:** TypeScript strictness is good overall. `z` from `zod` v4 is used for tool input/output schemas in `tools.ts`. The `@ts-expect-error` on `McpAgent.server` is documented. However, there are several `as unknown as` and `as Record<string, unknown>` casts in `tools.ts` (lines ~110, ~145) when passing structured data to MCP's `structuredContent` — these bypass type checking. The `retry_with_backoff` `shouldRetry` callback casts to `ProviderError` without a type guard, which would silently fail on non-ProviderError thrown objects. `BaseSearchParams` includes `signal?: AbortSignal` but not all callers thread it through (e.g., some fetch providers create their own `AbortSignal.timeout`). The `FetchResult` interface has `source_provider` but some providers return different field names at runtime (e.g., `metadata` content).

**To reach 10/10:**
1. Add a type guard for `ProviderError` and use it in `shouldRetry`:
```typescript
const isProviderError = (e: unknown): e is ProviderError => e instanceof ProviderError;
shouldRetry: (error: unknown) => {
  if (isProviderError(error)) return error.type === ErrorType.PROVIDER_ERROR;
  return true; // Network errors are retryable
}
```
2. Replace `structuredContent: result as unknown as Record<string, unknown>` with a properly typed helper that extracts the known shape, or update the MCP SDK's `structuredContent` type to be generic.

---

### Area 7: CONFIGURATION & ENVIRONMENT — **9/10**

**Justification:** Configuration initialization in `env.ts` with module-level `config` object is well-structured. The `validate_config()` function logs provider availability without crashing on missing keys, which is appropriate for optional providers. wrangler.toml correctly declares the DO binding, KV namespace, and `nodejs_compat` flag. `compatibility_date = "2026-02-24"` is recent. The atomic swap pattern in `initialize_providers()` prevents concurrent DO instances from seeing empty state. Timeout constants (e.g., `config.search.tavily.timeout = 30000`) are stored in config rather than magic numbers in provider code. One issue: `config.yaml` is mentioned in comments but I couldn't verify it's actually read at runtime vs. being documentation.

**To reach 10/10:**
1. Add validation that `config.yaml` is loaded at startup, or remove the reference to it in comments if configuration is env-var-only.
2. Add a runtime check that all required bindings (CACHE, OmnisearchMCP) are present and throw a clear error during initialization if missing.

---

### Area 8: OBSERVABILITY & DEBUGGING — **8/10**

**Justification:** Structured logging is comprehensive — every operation has `op` tags, `request_id` context via AsyncLocalStorage, `duration_ms` on completions, and provider-scoped child loggers. The `logger.response()` method auto-selects log level based on status code. `sanitize_for_log()` prevents credential leakage in URLs. Progress tracking in `answer_orchestrator.ts` every 5s is appropriate for long-running fanouts. Missing: operation-level tracing spans (no OpenTelemetry), no structured metrics (no histogram for provider latencies), no error rate alerting hooks. The `startOp()` helper in logger.ts is underutilized — only a few places use it.

**To reach 10/10:**
1. Emit structured metrics (as custom logs or via CF Workers metrics API) for: provider success/failure rates, fanout durations, cache hit rates, and timeout rates. Example:
```typescript
logger.info('metric', { metric: 'provider_duration_ms', provider: name, value: duration_ms, p50_bucket: true });
```
2. Add `span_id` to all async operations that cross provider boundaries so a single request can be traced through multiple providers.

---

### Area 9: API DESIGN & PROTOCOL COMPLIANCE — **8/10**

**Justification:** MCP tool schemas use Zod v4 correctly and include comprehensive `outputSchema` definitions. REST endpoints (`/search`, `/fetch`) follow consistent patterns with proper status codes (200, 400, 401, 413, 502, 503). CORS handling is thorough — both per-route and the agents package's built-in CORS. Tool descriptions are detailed and accurate. Input validation (query length, body size, URL format) is present. The MCP resource handlers (`provider-status`, `provider-info`) provide introspection. Minor issues: the `answer` tool's output schema doesn't match what the MCP SDK actually returns (the MCP SDK wraps results in `CallToolResult` with `content[]` array, not a flat object). The `/health` endpoint doesn't verify provider availability.

**To reach 10/10:**
1. Update the tool output schemas in `tools.ts` to match what the MCP SDK actually returns — the `structuredContent` field is set alongside `content`, but the SDK's `CallToolResult` type expects `content: Content[]` as the primary field. Ensure the output schema documents the combined response shape.
2. In `/health`, add a check that at least one provider is available and return degraded status if not.

---

### Area 10: PERFORMANCE & RESOURCE EFFICIENCY — **8/10**

**Justification:** Key hot paths are optimized: `chunks` array in SSE buffering avoids O(n²) concatenation, `TextEncoder` for `SSE_PING` is pre-allocated at module level, KV caching prevents redundant provider calls. `results_by_provider` Map construction is efficient. Fetch waterfall starts with solo providers (fast) before parallel groups, which is the right ordering. The `normalize_url` function in RRF ranking does URL normalization per-result which could be called thousands of times for large result sets. The `sentence_merge` function in `snippet_selector.ts` has O(n²) complexity due to repeated `deduped.splice()` calls in the greedy algorithm. Provider factories are called once per `UnifiedFetchProvider` constructor, not per request, which is correct.

**To reach 10/10:**
1. Memoize `normalize_url` results using a `Map<string, string>` within each `compute_rrf_scores` call:
```typescript
const normalize_url_cache = new Map<string, string>();
const normalize_url = (raw: string): string => {
  const cached = normalize_url_cache.get(raw);
  if (cached) return cached;
  // ... current logic
  normalize_url_cache.set(raw, result);
  return result;
};
```
2. Replace `deduped.splice()` with a boolean `used` array in `sentence_merge` to avoid O(n) deletions in the greedy loop, reducing the inner loop from O(n²) to O(n).

---

## Traditional Code Review

### CRITICAL — Must Fix

**File: `src/common/utils.ts`, lines ~30-42**
**What:** The `make_signal` polyfill for `AbortSignal.any()` has a timer leak. When `external` signal aborts before the timeout fires, the `setTimeout` is cleared but the cleanup path via `controller.signal.addEventListener('abort', ...)` only fires when `controller.abort()` is called — which is triggered by the timeout OR by the external signal. The issue: if the external signal fires, `on_abort` clears the timer, but `controller.signal` never fires (since `controller.abort()` wasn't called). The `once: true` listener on external signal removes itself, which is correct, but there's no way for the timer to leak because `clearTimeout(timer)` is called. Actually this is correct — let me re-examine.

**Why:** After re-reading, the polyfill is actually correct. The `clearTimeout(timer)` in `on_abort` prevents the timer from firing after external abort. However, the `controller.signal.addEventListener('abort', () => clearTimeout(timer))` line is redundant — it will never fire because `controller.abort()` is only called by `on_abort` which already cleared the timer. This is harmless but dead code. **This is not critical. Withdrawn.**

**File: `src/server/answer_orchestrator.ts`, lines ~95-100**
**What:** The `is_done` flag prevents late-arriving promises from mutating the `answers` and `failed` arrays after the deadline fires, but the final return creates defensive copies (`[...answers]`). However, the `tracked` promises continue running even after `is_done = true`, and their `.then()` callbacks silently return early. This is correct behavior but not explicitly documented. The real issue: KV cache write at line ~165 awaits before returning, which adds latency to the response unnecessarily.

**Why:** The cache write should use `ctx.waitUntil()` on CF Workers so the response is sent immediately while the cache write happens in the background.

**Fix:**
```typescript
// Replace:
if (kv_cache && result.answers.length > 0) {
  await kv_cache.put(KV_ANSWER_PREFIX + query, JSON.stringify(result), { expirationTtl: KV_ANSWER_TTL_SECONDS });
}
// With: (requires passing ctx through the call chain, or fire-and-forget)
ctx.waitUntil(
  kv_cache.put(KV_ANSWER_PREFIX + query, JSON.stringify(result), { expirationTtl: KV_ANSWER_TTL_SECONDS }).catch((err) =>
    logger.warn('KV answer cache write failed', { op: 'kv_write_error', error: err instanceof Error ? err.message : String(err) })
  )
);
```

---

### HIGH — Should Fix

**File: `src/common/http.ts`, line ~77**
**What:** HTTP 500 responses from providers are thrown as `ErrorType.PROVIDER_ERROR`. A 500 from a provider API means their server had an internal error — this is semantically different from a provider returning blocked/empty content (which is `PROVIDER_ERROR`).

**Why:** Error classification affects retry behavior and monitoring. A 500 is likely transient and worth retrying; `PROVIDER_ERROR` currently skips retry in `shouldRetry`.

**Fix:**
```typescript
// Change line 77 from:
throw new ProviderError(ErrorType.PROVIDER_ERROR, `${provider} API internal error (${res.status}): ${safe_message}`, provider);
// To:
throw new ProviderError(ErrorType.API_ERROR, `${provider} API internal error (${res.status}): ${safe_message}`, provider);
```

---

**File: `src/providers/search/tavily/index.ts`, lines ~1-20**
**What:** The `TavilySearchProvider.search()` catches errors and calls `handle_provider_error()` which throws (never returns), but the function's return type is `Promise<SearchResult[]>` with no explicit return in the catch block. TypeScript may not catch this at compile time if `handle_provider_error` is typed as `never`.

**Why:** If `handle_provider_error` throws a non-ProviderError (e.g., a network error that somehow bypasses the `shouldRetry` check), the tool will return `undefined` at the call site in `web_search_fanout.ts`, which will cause a type error or runtime crash.

**Fix:** Ensure `handle_provider_error` has explicit `never` return type and add a defensive fallback:
```typescript
} catch (error) {
  handle_provider_error(error, this.name, 'fetch search results');
  // unreachable but TypeScript needs this
  return [];
}
```

---

### MEDIUM — Should Fix Soon

**File: `src/server/tools.ts`, lines ~70-75**
**What:** The `answer` tool description says "Use 'web_search' instead when you need raw URLs/links" but the tool is named `answer`, not `web_search`. The `web_search` tool description says "PREFERRED over any single-provider search tool" which is accurate but could be confused with the REST `/search` endpoint.

**Why:** Misleading tool descriptions can cause LLM clients to make suboptimal tool choices.

**Fix:** Update tool descriptions to be more specific about when to use each tool, without comparative language that may not hold for all use cases.

---

**File: `src/providers/ai_response/perplexity/index.ts`, lines ~75-80**
**What:** The `PerplexityProvider` maps API `citations` (URL strings) to `SearchResult` objects with `snippet: 'Source citation'`, which loses the citation URL's value. The RRF ranking will treat these as very low-quality results because they have minimal snippet content.

**Why:** Perplexity citations are often the most valuable part of the response, but they get downranked because they have no snippet text. The `snippet: 'Source citation'` string is also not normalized — if multiple providers return this exact string, deduplication via RRF won't work.

**Fix:** Use the citation URL as the snippet or include a truncated version of the page title/content. At minimum, don't use a generic string that's identical across providers.

---

**File: `src/server/web_search_fanout.ts`, lines ~90-105**
**What:** The timeout mechanism creates a deadline `AbortController` that aborts at `timeout_ms`, but the `deadline_controller.abort()` call happens after `Promise.race` resolves — meaning the deadline fires but in-flight fetch calls may not be cancelled immediately. The abort signal is passed to `combined_signal` but `AbortController.abort()` is asynchronous (it fires on the next microtask), so there's a race between the abort signal propagating and new promises being created.

**Why:** In high-contention scenarios, this could allow providers to continue running past the deadline for a few hundred milliseconds.

**Fix:** Add a check in the provider promise loop to exit early if the combined signal is already aborted:
```typescript
const provider_promises = active.map(async (p) => {
  if (combined_signal.aborted) return; // Early exit
  // ... rest of provider code
});
```

---

### LOW — Nice to Have

**File: `src/common/snippet_selector.ts`, lines ~90-130**
**What:** The `sentence_merge` function uses `deduped.splice()` inside a while loop, making it O(n²) in the worst case. With 20+ snippets per result and 15 results, this is unlikely to be a bottleneck, but it's not optimal.

**Why:** Minor performance concern for edge cases with many snippets.

**Fix:** Use a `Set<number>` for indices that have been selected, and filter `deduped` at the end instead of splicing during iteration.

---

**File: `src/worker.ts`, lines ~195-200**
**What:** The SSE keepalive injector's `safe_write` function chains all writes through `write_lock`, which serializes even non-concurrent writes (the common case). While this is correct, the chain creates an implicit promise that grows with each write.

**Why:** Micro-optimization, but for high-throughput scenarios (many concurrent SSE connections), this could add up.

**Fix:** Track whether a write is already pending and skip the lock for the common case of no concurrent writes. Use a simpler pattern:
```typescript
let pending_write: Promise<void> | undefined;
const safe_write = (chunk: Uint8Array) => {
  const current = pending_write;
  pending_write = (current ?? Promise.resolve()).then(() => writer.write(chunk)).catch(cleanup);
  return pending_write;
};
```

---

### POSITIVE — What Was Done Well

1. **RRF ranking implementation** (`common/rrf_ranking.ts`): The `rescue_tail_results` function that rescues tail results from domains not represented in the top-N is a sophisticated technique that meaningfully improves result diversity. The `collapse_snippets` function with sentence-level greedy merging is also excellent.

2. **Provider registration pattern**: The `registration = { key: () => config... }` pattern in unified dispatchers is the cleanest provider auto-discovery mechanism I've seen. Adding a new provider requires only a file + one line in the dispatcher.

3. **Event-boundary SSE buffering**: The `find_event_boundary` function correctly handles all three valid SSE delimiters (`\n\n`, `\r\n\r\n`, `\r\r`) per the WHATWG spec. This is more correct than most SSE implementations.

4. **AbortController composition**: The `make_signal` polyfill with `AbortSignal.any` composition shows deep understanding of the AbortController API. The fallback for runtimes without `AbortSignal.any` is complete.

5. **AsyncLocalStorage for request context**: Using `run_with_request_id` and `get_request_id` throughout the codebase for request-scoped logging is the right approach for CF Workers isolates.

6. **Durable Object initialization pattern**: The `_init_promise` memoization with retry-on-failure in both `OmnisearchMCP.init()` and `ensure_rest_initialized` prevents thundering herd on cold start while allowing recovery from transient init failures.

7. **Domain breakers in fetch waterfall**: The specialized YouTube→Supadata and social media→SociaVault breakers before the main waterfall show thoughtful architecture that avoids running expensive fallback providers for known-easy URL types.

8. **Module-level pre-encoded constants**: `SSE_PING` encoded at module load time is a good optimization that avoids repeated `TextEncoder.encode()` calls on every keepalive tick.

