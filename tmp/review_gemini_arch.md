# Architecture Scorecard & Code Review

Here is the comprehensive architecture review of the Omnisearch MCP Server on Cloudflare Workers.

## Part 1: Architecture Scorecard

### Area 1: CONCURRENCY & ASYNC PATTERNS
**Score: 8/10**
The server elegantly handles complex fanouts using `Promise.allSettled`, `Promise.race`, and `Promise.any` depending on the use case (e.g., answer deadlines vs. fetch racing). However, the Durable Object initialization pattern contains a critical flaw where a rejected initialization promise is permanently cached, breaking the DO instance until the isolate is destroyed.
**To reach 10/10:** In `src/worker.ts`, update `OmnisearchMCP.init()` to clear `_init_promise` if it rejects, allowing the DO to recover on the next request:
```typescript
async init(): Promise<void> {
    if (!this._init_promise) {
        this._init_promise = this._do_init().catch((err) => {
            this._init_promise = undefined;
            throw err;
        });
    }
    return this._init_promise;
}
```

### Area 2: STREAM HANDLING & SSE
**Score: 7/10**
The event boundary buffering for SSE keepalive injection is a very clever workaround for Claude's 45-second timeout while preserving the SSE spec. However, `setInterval` and the `pump()` loop can concurrently invoke `writer.write()`, which can cause queueing issues or unhandled rejections if backpressure builds. Furthermore, appending `Uint8Array`s on every chunk creates unnecessary garbage.
**To reach 10/10:** Introduce a sequential write lock for stream writing in `src/worker.ts`'s `inject_sse_keepalive` function to prevent overlapping writes:
```typescript
let write_lock = Promise.resolve();
const safe_write = (chunk: Uint8Array) => {
    write_lock = write_lock.then(() => writer.write(chunk)).catch(cleanup);
};
// Replace all `writer.write(...)` calls with `safe_write(...)`
```

### Area 3: ERROR HANDLING & RESILIENCE
**Score: 8/10**
Provider isolation is excellent; one provider failing does not crash the fanout. Error propagation is consistent across REST and MCP layers. The usage of `p-retry` targeting only transient `ProviderError` types is smart. However, `Promise.any` in the fetch waterfall leaves "losing" promises running indefinitely in the background.
**To reach 10/10:** Add an `AbortController` to parallel steps in the fetch waterfall. Update the `FetchProvider` interface to accept an `AbortSignal`, pass it through `try_provider`, and call `controller.abort()` as soon as `Promise.any` resolves to cancel the redundant background requests.

### Area 4: DATA FLOW & PROVIDER ORCHESTRATION
**Score: 9/10**
The web search fanout (dispatch → RRF rank → truncate) is exceptionally well modeled. The caching layer deduplicates identical searches, saving time and tokens. The only gap is in `answer_orchestrator.ts`: when the global deadline triggers, providers that resolve *after* the deadline still push data into the local arrays, causing detached memory growth.
**To reach 10/10:** In `src/server/answer_orchestrator.ts`, add a completion flag (`let is_done = false`) set immediately after `Promise.race`. Inside the `tasks.map` handlers, check `if (is_done) return;` before pushing to `answers` or `failed`.

### Area 5: CODE ORGANIZATION & MODULARITY
**Score: 6/10**
The directory structure, unified dispatchers, and tool registries are conceptually clean. However, the codebase heavily relies on mutating module-level global variables (e.g., `export const config` in `src/config/env.ts`) on every single incoming request (`initialize_config(env)`). In Cloudflare Workers, an isolate can process multiple concurrent requests; overwriting globals per request creates severe race conditions if environments differ (like during deployments, differing bindings, or tests).
**To reach 10/10:** Add an initialization flag to `src/config/env.ts` so it only populates the global config once per isolate lifecycle:
```typescript
let is_initialized = false;
export const initialize_config = (env: Env) => {
    if (is_initialized) return;
    is_initialized = true;
    // ... rest of logic
};
```

### Area 6: TYPE SAFETY & INTERFACES
**Score: 9/10**
Interfaces like `BaseSearchParams` and `FetchResult` are strictly defined. Generics are used effectively for the HTTP client. The Zod schemas map accurately to the tool implementations. A few `as unknown as Record<string, unknown>` type casts exist but are localized and safe enough.
**To reach 10/10:** No changes needed. The strictness is appropriate and pragmatic for the scale of the codebase.

### Area 7: CONFIGURATION & ENVIRONMENT
**Score: 9/10**
Environment binding types are clean and well-structured. The auto-discovery array pattern in `unified/*.ts` makes adding new providers frictionless. Missing keys are logged gracefully without failing the entire server.
**To reach 10/10:** No changes needed.

### Area 8: OBSERVABILITY & DEBUGGING
**Score: 9/10**
Structured logging is comprehensive. Key operations log durations, request correlation IDs, and specific provider contexts. Bounding HTTP response bodies to `MAX_RESPONSE_BYTES` and redacting API keys from URLs is excellent defensive programming.
**To reach 10/10:** In `src/common/logger.ts`, the `shouldLog` logic reads an untyped global `globalThis.__LOG_LEVEL`. In `src/worker.ts`, explicitly set `globalThis.__LOG_LEVEL = env.LOG_LEVEL || 'info'` on initialization to make log verbosity officially controllable via the worker environment.

### Area 9: API DESIGN & PROTOCOL COMPLIANCE
**Score: 10/10**
The MCP protocol compliance utilizing the `agents` DO bridge is solid. The dual availability of MCP and REST endpoints (`/search`, `/fetch`) is incredibly useful. Returning `502 Bad Gateway` when all providers fail instead of a misleading `200` with empty results is correct REST design.
**To reach 10/10:** No changes needed.

### Area 10: PERFORMANCE & RESOURCE EFFICIENCY
**Score: 7/10**
Resource efficiency suffers slightly due to the lack of cancellation in the fetch waterfall. In Cloudflare Workers, background tasks count towards CPU time limits and concurrent subrequest limits. Additionally, the string concatenation in the SSE injection layer (`new Uint8Array(buffer.length + value.length)`) causes unneeded memory pressure on long streams.
**To reach 10/10:** Address the cancellation issue from Area 3. For the SSE buffering, consider tracking `buffer_length` and pre-allocating an array for concatenation, or moving to a more efficient sliding window approach if streams exceed standard LLM snippet sizes.

---

## Part 2: Traditional Code Review

### CRITICAL
- **File:** `src/worker.ts`, lines ~106-115 (`init()`)
- **What:** The Durable Object caches rejected initialization promises.
- **Why:** If a DO instance throws an error during `_do_init` (e.g., a momentary KV/Config read failure or transient error), `_init_promise` remains a rejected promise. Every subsequent request hitting this DO will immediately fail until the worker isolate dies.
- **Fix:** Add a `.catch()` that clears the promise to allow for retry on the next request. (See Area 1).

### HIGH
- **File:** `src/config/env.ts` and `src/worker.ts`
- **What:** Global mutable state (`config`) is re-initialized on every single request.
- **Why:** Cloudflare isolates process concurrent requests. Writing to `export const config` inside the `fetch()` handler causes race conditions if requests have slightly different contexts, and adds unnecessary overhead. Environment bindings in Cloudflare are static for the lifetime of the isolate.
- **Fix:** Add `let is_initialized = false;` and return early in `initialize_config` if true. (See Area 5).

### HIGH
- **File:** `src/server/fetch_orchestrator.ts`, lines ~135-155 (`run_parallel`)
- **What:** `Promise.any` is used without an `AbortSignal` for the losing promises.
- **Why:** In parallel steps like `['diffbot', 'olostep']`, if `diffbot` finishes in 500ms and `olostep` is stuck scraping an SPA for 15s, `olostep` will continue running in the CF Worker background. This wastes CPU time and counts against the CF subrequest limits.
- **Fix:** Update the `FetchProvider.fetch_url` interface to accept an optional `AbortSignal`. Instantiate an `AbortController` in `run_parallel`, pass it down, and call `.abort()` immediately after `Promise.any` resolves.

### MEDIUM
- **File:** `src/worker.ts`, lines 78-85
- **What:** Concurrent calls to `writer.write()` in the SSE stream.
- **Why:** `setInterval` can fire exactly while the async `pump()` loop is awaiting `writer.write()`. While some WHATWG stream implementations queue this fine, others throw exceptions when writing while a write is already in progress.
- **Fix:** Wrap all `writer.write` calls in a simple Promise chain lock. (See Area 2).

### MEDIUM
- **File:** `src/server/answer_orchestrator.ts`, lines 122-140
- **What:** Detached execution mutating arrays post-return.
- **Why:** If the global deadline is hit, the function correctly clones and returns the arrays. However, the background promises continue running. When they resolve, they execute `.then()` and push to the local `answers` and `failed` arrays, causing memory growth and logging "Provider completed" out of band.
- **Fix:** Add `let is_done = false;` below `completed_count`. Set it to `true` after the `Promise.race`. Inside `.then()` and `.catch()`, add `if (is_done) return;`.

### POSITIVE
- **File:** `src/common/rrf_ranking.ts` and `src/server/web_search_fanout.ts`
- **What:** The Reciprocal Rank Fusion (RRF) implementation.
- **Why:** Merging results from 9 independent search engines into a single deduplicated, high-quality list is brilliantly implemented. The rescue logic for tail results and the URL normalization ensures highly robust search data.

### POSITIVE
- **File:** `src/common/http.ts`
- **What:** Guarding `content-length` and bounded `.text()` limits.
- **Why:** Checking `MAX_RESPONSE_BYTES` (5MB) before parsing strings protects the V8 isolate from Out-Of-Memory (OOM) crashes, which is a frequent pitfall when scraping raw HTML or PDFs in Serverless environments.
