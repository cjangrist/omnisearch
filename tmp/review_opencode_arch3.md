I'll conduct a comprehensive architecture review of this MCP server. Let me start by exploring the codebase structure and reading all the files in full.
Now I have a complete picture of the codebase. Let me provide the comprehensive architecture review.

---

# Architecture Scorecard: MCP Server on Cloudflare Workers

## Area 1: CONCURRENCY & ASYNC PATTERNS — Score: 7/10

**Justification:** The promise composition is mostly correct with proper deadline handling and `is_done` flags preventing post-deadline mutations. However, AbortSignal is not propagated through the fetch waterfall, leaving providers running even when clients disconnect. The `resolved` flag pattern in `run_parallel` is subtle and could silently misbehave if the timing changes.

**To reach 10/10:**
1. Add `signal?: AbortSignal` parameter to `run_fetch_race()` and propagate it to each provider attempt — when client aborts, cancel in-flight fetch requests immediately instead of waiting for timeout.
2. Add explicit cleanup of `abort_controller` signal listeners in `answer_orchestrator.ts` after the deadline fires (currently the AbortController is created but its signal listeners are never explicitly removed).

---

## Area 2: STREAM HANDLING & SSE — Score: 8/10

**Justification:** The SSE keepalive injection is sophisticated — it buffers chunks, scans for SSE event boundaries (`\n\n`, `\r\n\r\n`, `\r\r`), only injects keepalives when the buffer is empty (no partial events in flight), and uses a write lock to prevent concurrent writer access. However, there are two subtle issues: (1) the interval continues running briefly after `closed` is set but before `clearInterval` executes, and (2) there's no mechanism to detect when the client has disconnected so the stream can be cancelled upstream.

**To reach 10/10:**
1. Track `reader.cancel()` completion and await it in cleanup to prevent the pump from continuing after cancellation.
2. Store the `pump()` promise and `await` it in the response initialization or pass it to the `ExecutionContext.waitUntil()` to ensure proper stream teardown.

---

## Area 3: ERROR HANDLING & RESILIENCE — Score: 8/10

**Justification:** Provider failures are well-isolated — each provider runs in its own promise with individual try/catch. The `p-retry` retry strategy with `shouldRetry` distinguishes transient errors (5xx, network) from permanent ones (auth, rate limit, bad input). Fire-and-forget cache writes prevent caching failures from blocking responses. The `// @ts-ignore` comment in `PerplexityProvider.get_answer()` line 152 on the unreachable `throw` is concerning — it implies a code path that can never execute, making the function return `undefined` instead of the declared `Promise<PerplexityResponse>`.

**To reach 10/10:**
1. Remove the unreachable `// @ts-ignore` on line 152 and the corresponding closing brace — the `handle_provider_error()` call always throws, so the function never returns normally. This is a latent bug if `handle_provider_error` ever stops throwing.
2. Add a circuit breaker pattern for KV cache writes that fails open after N consecutive failures to prevent unbounded error accumulation.

---

## Area 4: DATA FLOW & PROVIDER ORCHESTRATION — Score: 9/10

**Justification:** The pipeline architecture is excellent — clear separation between dispatch (fanout), merge, RRF ranking, and truncation. The atomic swap for `active_providers` prevents concurrent mutation. Domain breakers in the fetch waterfall are a smart pattern. The only significant gap is the lack of a global deadline signal in web search fanout (unlike answer fanout which has 2-minute deadline).

**To reach 10/10:**
1. Add a `deadline_ms` option to `run_web_search_fanout()` similar to `timeout_ms` in `dispatch_to_providers()` — when the deadline fires, snapshot results immediately instead of waiting for `Promise.race`.
2. Document the RRF constant `RRF_K = 60` in a comment — this is a well-known hyperparameter but not obvious to future maintainers.

---

## Area 5: CODE ORGANIZATION & MODULARITY — Score: 7/10

**Justification:** The directory structure is logical with clear separation between `common/`, `config/`, `providers/`, and `server/`. The provider registration pattern (one file per provider + one line in unified dispatcher) is elegant and low-friction for adding new providers. However, there is a **circular dependency**: `tools.ts` imports from `providers/index.ts` which imports from `tools.ts` (for `active_providers`). The atomic swap pattern in `initialize_providers()` is correct but the module-level mutable state (`config`, `kv_cache`, `active_providers`) makes unit testing difficult — you cannot test a provider or orchestrator in isolation without mocking globals.

**To reach 10/10:**
1. Break the circular dependency by moving `active_providers` from `tools.ts` to a new `src/common/provider_registry.ts` module that has no imports from providers or tools.
2. Refactor orchestrators to accept `config` and `kv_cache` as constructor parameters or dependency-injected context objects instead of importing module-level globals directly.

---

## Area 6: TYPE SAFETY & INTERFACES — Score: 6/10

**Justification:** The codebase uses Zod for tool input validation and has good discriminated unions (e.g., `WaterfallStep`). However, there are several type safety issues: (1) `structuredContent` is cast with `as unknown as Record<string, unknown>` in multiple tool handlers — the actual value is a concrete type but the cast bypasses type checking; (2) The `outputSchema` on tool definitions in `tools.ts` doesn't match what the handlers actually return — the schema says `providers_succeeded` is `Array<{ provider, duration_ms }>` but `run_web_search_fanout` returns `providers_succeeded` as `Array<{ provider, duration_ms }>` which is correct, but the `outputSchema` in `register_answer_tool` says `providers_succeeded: z.array(z.string())` which doesn't match the actual `Array<{ provider, error, duration_ms }>` structure; (3) `BaseSearchParams` includes `signal?: AbortSignal` but fetch providers ignore it.

**To reach 10/10:**
1. Remove `as unknown as` casts by defining proper return types and using `satisfies` or type assertions with the correct type.
2. Fix the `outputSchema` mismatch in `register_answer_tool` — `providers_succeeded` should be `z.array(z.string())` OR change the actual return type to match the schema definition.

---

## Area 7: CONFIGURATION & ENVIRONMENT — Score: 8/10

**Justification:** Configuration is centralized in `config/env.ts` with a clear pattern for adding new providers. The `initialize_config()` function populates from `Env` bindings, and `validate_config()` logs availability. The rejected-promise-retry pattern prevents thundering herd on DO cold starts. However, timeout values are hardcoded (e.g., `180_000` for AI providers) and cannot be overridden via environment variables, making it difficult to tune for different deployment environments without code changes.

**To reach 10/10:**
1. Allow timeout overrides via environment variables (e.g., `TAVILY_TIMEOUT_MS`) with sensible defaults.
2. Validate that required config keys (like `api_key` format) have non-empty values at startup — currently a blank string API key passes `validate_config()` but will fail at runtime.

---

## Area 8: OBSERVABILITY & DEBUGGING — Score: 6/10

**Justification:** Structured JSON logging with `component`, `op`, `requestId`, and context fields provides good request correlation. Duration tracking is present on most operations. However, there are significant gaps: (1) No metrics (counters, histograms, gauges) — you cannot answer "what is the p95 latency of the web search fanout?" without adding instrumentation; (2) Provider success/failure rates are not aggregated — no visibility into which providers fail most often; (3) KV cache hit rate is not tracked; (4) The `__LOG_LEVEL` global is clever but not documented; (5) There's no way to enable debug logging in production without redeploying.

**To reach 10/10:**
1. Add Cloudflare Analytics or a custom metrics endpoint that exports aggregated provider success/failure rates, latency percentiles, and cache hit rates.
2. Add a `?debug=true` query parameter or `X-Omnisearch-Debug` header to the REST endpoints that enables debug-level logging dynamically.

---

## Area 9: API DESIGN & PROTOCOL COMPLIANCE — Score: 8/10

**Justification:** REST endpoints follow standard patterns (`POST /search`, `POST /fetch`) with proper status codes (200, 400, 401, 413, 502, 503). MCP tool descriptions are detailed and accurate. CORS headers are present. The `answer` tool description says "up to 2 minutes" which is honest but could be improved with dynamic progress updates. Input validation (query length, body size, URL format) is thorough.

**To reach 10/10:**
1. Add a `/v1/providers` REST endpoint that returns provider availability, latency percentiles, and quota status — this helps clients make routing decisions.
2. Consider returning streaming responses for long-running `answer` fanouts so clients can see progress incrementally instead of waiting 2 minutes for a single response.

---

## Area 10: PERFORMANCE & RESOURCE EFFICIENCY — Score: 8/10

**Justification:** The codebase is efficient in most hot paths — `TextEncoder` is reused as a module-level constant, `subarray()` avoids buffer copies, the chunk buffer in `inject_sse_keepalive` uses a list to avoid O(n²) concatenation. KV caching prevents redundant work. However, there are inefficiencies: (1) `Date.now()` is called many times per request — each provider execution captures its own timing when it could be captured once at the orchestrator level; (2) `flatten()` copies all chunks into a single `Uint8Array` every time `flush_complete_events()` is called even when no boundary is found; (3) The snippet normalization in `collapse_snippets()` builds bigrams and trigrams on every snippet every time even for repeated queries to the same URL.

**To reach 10/10:**
1. Capture timing at the orchestrator level and pass durations to provider callbacks instead of each provider capturing its own `Date.now()`.
2. Add an LRU cache for normalized snippets keyed by URL to avoid re-normalizing the same content on repeated fetches.

---

## Part 2: Traditional Severity-Ranked Code Review

### HIGH

**1. `PerplexityProvider.get_answer()` has unreachable code** — `src/providers/ai_response/perplexity/index.ts:152-158`

```typescript
} catch (error) {
    handle_provider_error(
        error,
        this.name,
        'fetch Perplexity answer',
    );
}
// @ts-ignore
}
```

`handle_provider_error` always throws. The `// @ts-ignore` and closing brace on line 158 are unreachable. If `handle_provider_error` ever changes to not throw (e.g., during a refactor), the function returns `undefined` instead of the declared `Promise<PerplexityResponse>`, causing a runtime crash.

**Fix:** Remove lines 152-158 entirely. `handle_provider_error` replaces the thrown error with a `ProviderError` and throws it — the catch block should simply call it without the `try/catch` wrapper:

```typescript
// Remove the try/catch entirely, let handle_provider_error throw
const data = await http_json<PerplexityAPIResponse>(...);
```

**2. Fetch waterfall doesn't support AbortSignal cancellation** — `src/server/fetch_orchestrator.ts:277-372`

The `run_fetch_race()` function has no `signal` parameter. When a client disconnects, in-flight fetch requests continue running until their individual timeouts fire, wasting resources and bandwidth.

**Fix:** Add `signal?: AbortSignal` to `run_fetch_race()` and wrap each provider call:

```typescript
export const run_fetch_race = async (
    fetch_provider: UnifiedFetchProvider,
    url: string,
    options?: { provider?: FetchProviderName; signal?: AbortSignal },
): Promise<FetchRaceResult> => {
    // ...
    const try_provider = async (...) => {
        const controller = new AbortController();
        const cleanup = () => controller.abort();
        options.signal?.addEventListener('abort', cleanup, { once: true });
        try {
            return await unified.fetch_url(url, provider as FetchProviderName, controller.signal);
        } finally {
            options.signal?.removeEventListener('abort', cleanup);
        }
    };
    // ...
};
```

---

### MEDIUM

**3. Output schema mismatch in `register_answer_tool`** — `src/server/tools.ts:114-135`

The Zod outputSchema declares `providers_succeeded: z.array(z.string())` (an array of strings), but the actual return type from `run_answer_fanout()` is `providers_succeeded: string[]` which is correct. However, `providers_failed` is declared as `z.array(z.object({ provider: z.string(), error: z.string(), duration_ms: z.number() }))` which matches the actual type. The inconsistency is that `providers_succeeded` should probably also include `duration_ms` to be consistent with the web_search tool's output schema.

**Fix:** Either add `duration_ms` to `providers_succeeded` in the output schema and actual return, or clarify in documentation that `providers_succeeded` only returns provider names (for brevity).

**4. `flatten()` is called on every `flush_complete_events()` even when no boundary exists** — `src/worker.ts:115-128`

```typescript
const flush_complete_events = async () => {
    const buf = flatten();  // Always copies all chunks!
```

`flatten()` allocates a new `Uint8Array` and copies all chunks every time, even when no SSE boundary is found in the current buffer. On high-throughput streams with many small chunks, this causes O(n) allocation per chunk.

**Fix:** Only call `flatten()` when `find_event_boundary` returns a valid index:

```typescript
const flush_complete_events = async () => {
    const buf = flatten();
    const boundary = find_event_boundary(buf);
    if (boundary === -1) return;
    // ... process events
};
```

Or better: scan the last chunk directly without flattening when no complete boundary exists.

**5. Retry strategy is not applied consistently** — `src/server/answer_orchestrator.ts:77`

```typescript
// No retry_with_backoff — the multi-provider fanout IS the redundancy strategy.
```

The comment justifies not retrying AI providers because the fanout provides redundancy. This is a valid architectural decision, but `retry_with_backoff` IS used in `web_search_fanout.ts:87` for individual search providers. This inconsistency means a transient Tavily API error on one search query will retry 3 times (adding latency) but a transient Perplexity API error on an answer query will fail immediately without retry. Users may get different behavior depending on which tool they use.

**Fix:** Document this intentional inconsistency in code comments and ensure it's reflected in user-facing documentation (e.g., the answer tool description should mention it doesn't retry).

**6. KV cache key collision potential for long queries** — `src/server/web_search_fanout.ts:19-23`

```typescript
const make_cache_key = (query: string, options?: {...}): string => {
    const base = options?.skip_quality_filter || options?.timeout_ms
        ? `${query}\0sqf=${...}\0t=${...}`
        : query;
    return KV_SEARCH_PREFIX + base;
};
```

Long queries (>500 chars) become cache keys of equal length. If multiple queries share a long prefix, this doesn't cause correctness issues, but it wastes KV storage. More critically, there's no maximum cache key length enforced, and if the KV key exceeds Cloudflare's limits, writes silently fail.

**Fix:** Add a SHA-256 hash of the query for keys when the query exceeds a threshold:

```typescript
const make_cache_key = (query: string, options?: {...}): string => {
    const MAX_RAW_KEY = 200;
    const base = query.length > MAX_RAW_KEY
        ? `${query.slice(0, MAX_RAW_KEY)}:${crypto.randomUUID().slice(0, 8)}`
        : query;
    return KV_SEARCH_PREFIX + base;
};
```

Or use `crypto.subtle.digest('SHA-256', new TextEncoder().encode(query))` to create a fixed-length hash.

---

### LOW

**7. Unused import in `rest_search.ts`** — `src/server/rest_search.ts:9`

`sanitize_for_log` is imported but not used in the file (it's used in `rest_fetch.ts` but not in `rest_search.ts`). TypeScript doesn't flag this because the file still compiles — the import is resolved at bundle time.

**Fix:** Remove the unused import.

**8. `logger.response()` called twice in `handle_rest_fetch()`** — `src/server/rest_fetch.ts:114-116`

```typescript
logger.response('POST', '/fetch', 200, duration, {
    provider_used: result.provider_used,
});
return Response.json({...}); // then response is returned
```

The `logger.response()` is called before constructing the JSON response. This means if `Response.json()` throws (e.g., due to circular references in `result`), the log entry shows success but the response was actually a 500. The logging should happen after a successful response is constructed.

**Fix:** Move `logger.response()` to after `Response.json()` succeeds, or use a try/finally block.

**9. `retry_with_backoff` retries 3 times by default** — `src/common/utils.ts:126`

```typescript
return pRetry(fn, {
    retries: opts.max_retries ?? 3,  // 3 retries = 4 total attempts
```

The `web_search_fanout.ts` passes `1` which means 1 retry = 2 total attempts. But with individual provider timeouts of 10-30 seconds, 3 retries adds 6-9 minutes of potential latency per failing provider. This is probably intentional but not documented.

**Fix:** Add a comment explaining the retry budget per provider and how it interacts with the overall timeout.

**10. `active_providers` exported as mutable object** — `src/server/tools.ts:20-24`

```typescript
export const active_providers = {
    search: new Set<string>(),
    ai_response: new Set<string>(),
    fetch: new Set<string>(),
};
```

The sets are mutated via `active_providers.search = new_search` in `initialize_providers()`. While the atomic swap prevents partial reads, the exported object is mutable and could be accidentally modified by other code. External modules like `handlers.ts` import and read `active_providers` directly.

**Fix:** Export only the three set sizes and provider name arrays instead of the mutable sets, or provide getter functions:

```typescript
export const get_active_providers = () => ({
    search: Array.from(active_providers.search),
    ai_response: Array.from(active_providers.ai_response),
    fetch: Array.from(active_providers.fetch),
});
```

---

### POSITIVE

1. **Atomic swap pattern** in `initialize_providers()` is excellent — avoids transient empty state during concurrent DO instance initialization. This is a sophisticated pattern that prevents real race conditions.

2. **SSE event boundary scanning** (`find_event_boundary`) is implementation of the WHATWG spec that most developers get wrong. Handling `\r\r` (legacy Netscape) in addition to `\n\n` and `\r\n\r\n` is thorough.

3. **Tool descriptions** are honest and helpful — the `answer` tool description explicitly warns users it can take up to 2 minutes. Most MCP tools omit timing expectations, leading to premature cancellations.

4. **The `resolved` flag** in `run_parallel` (`fetch_orchestrator.ts:186-216`) is a correct and subtle solution to the "winner returns, losers' catch handlers race to mutate shared state" problem. This pattern is often implemented incorrectly.

5. **Quality filters** in `apply_quality_filters()` are well-designed — filtering out single-provider results with low RRF scores or short snippets prevents low-quality content from polluting results without hardcoded allowlists.

6. **Domain breaker pattern** for specialized providers (YouTube → supadata, social media → sociavault) is a smart optimization that bypasses the general waterfall for known difficult domains.

7. **The `@ts-expect-error` comment** in `worker.ts:175` is well-documented — it explains WHY the type mismatch exists (SDK version bundling) and why it's safe to suppress.

8. **Timing-safe string comparison** for API key validation (`timing_safe_equal`) prevents timing attacks on the auth check. This is attention to security detail that many projects overlook.
