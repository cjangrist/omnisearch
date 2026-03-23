I'll conduct a comprehensive architecture review of this MCP server. Let me start by exploring the codebase structure and reading all the relevant files.
Now let me run the typecheck to see if there are any existing issues:
No type errors. Now I have a complete picture. Here's my comprehensive review:

---

# Architecture Scorecard & Code Review

## Part 1: Architecture Scorecard

### Area 1: CONCURRENCY & ASYNC PATTERNS — Score: 7/10

**Justification**: The codebase uses appropriate async patterns (Promise.race, allSettled, any) for fanout scenarios. However, AbortController threading is incomplete — while `make_signal()` in `utils.ts:8-11` uses `AbortSignal.any()` for combining signals, this API is not widely supported (only in modern browsers/Node 20+). Cloudflare Workers V8 isolate support is unclear. The global deadline in `answer_orchestrator.ts:174-178` correctly aborts slow providers, but the abort controller isn't passed to all provider tasks uniformly.

**To reach 10/10**:
1. Replace `AbortSignal.any()` with a manual signal composition helper that works in CF Workers V8 isolates
2. Ensure the AbortController's signal is passed to ALL provider tasks consistently (currently `retry_with_backoff` may not propagate the external signal)
3. Add `ctx.waitUntil()` for deadline timers in `answer_orchestrator.ts` to prevent premature isolate termination

---

### Area 2: STREAM HANDLING & SSE — Score: 8/10

**Justification**: The SSE keepalive injection in `worker.ts:62-136` is well-designed with event boundary buffering to prevent corrupting SSE frames. The TransformStream pump pattern correctly handles backpressure. However, the `keepalive` interval closure logic has a subtle race: `setInterval` continues firing after `closed` is set until the next iteration clears it, potentially causing a spurious write attempt after cleanup.

**To reach 10/10**:
1. Add a `writing` flag to prevent keepalive writes while a flush is in progress
2. Use `ctx.waitUntil(pump())` in the worker to ensure the pump completes before isolate termination
3. Handle `writer.ready` to ensure backpressure is respected before injection

---

### Area 3: ERROR HANDLING & RESILIENCE — Score: 8/10

**Justification**: Provider failures are well-isolated via Promise.allSettled/any patterns. The `ProviderError` class provides typed errors (API_ERROR, RATE_LIMIT, etc.). The 502 response for total provider failure in REST endpoints is correct. However, unhandled rejection paths exist: `tools.ts:234-239` catches errors but `format_error()` may throw if the error isn't an `Error` instance. The `catch` in `run_parallel` at `fetch_orchestrator.ts:183` silently swallows AggregateError without logging.

**To reach 10/10**:
1. Add logging for AggregateError in `fetch_orchestrator.ts:183-185`
2. Ensure `format_error()` handles non-Error throws gracefully
3. Add global unhandled rejection handler in worker initialization

---

### Area 4: DATA FLOW & PROVIDER ORCHESTRATION — Score: 9/10

**Justification**: The three-tier architecture (web_search → RRF rank, answer → parallel fanout, fetch → waterfall with breakers) is excellent. The unified dispatcher pattern with auto-discovery is clean and maintainable. Caching in web_search prevents redundant gemini-grounded calls. The domain breaker pattern for YouTube/social media is smart. Minor issue: the 30-second TTL cache could grow unbounded if queries differ slightly (50-entry limit with lazy eviction).

**To reach 10/10**:
1. Add LRU eviction to the query cache with a size limit
2. Consider adding request deduplication for concurrent identical queries (Promise.race with a Map)

---

### Area 5: CODE ORGANIZATION & MODULARITY — Score: 8/10

**Justification**: The codebase is well-organized with clear separation: `server/`, `providers/`, `common/`, `config/`. The unified dispatcher pattern allows adding providers by creating one file. However, the ToolRegistry singleton in `tools.ts:26-56` is accessed via exported module-level getters that create a temporal coupling with `initialize_providers()`. The module-level `active_providers` object in `tools.ts:20-24` is shared mutable state that could cause issues.

**To reach 10/10**:
1. Convert ToolRegistry to a proper DI pattern passed to initialization functions
2. Consider moving `active_providers` into a closure or class to prevent external mutation
3. Add barrel exports for provider directories to reduce deep imports

---

### Area 6: TYPE SAFETY & INTERFACES — Score: 7/10

**Justification**: The codebase uses Zod for tool schemas and has good TypeScript coverage. However, several issues exist:
- `any` usage in `http.ts:88` with `body.message || body.error || body.detail`
- `@ts-expect-error` in `worker.ts:145` is justified but fragile
- Provider implementations often cast with `as unknown` patterns
- The `FetchProvider` interface at `types.ts:35-39` has a method signature mismatch — it declares `fetch_url()` but implementations may have different signatures

**To reach 10/10**:
1. Replace `any` in `http.ts:88` with a proper type guard
2. Add a shared `SafeParse` helper for typed error extraction
3. Fix `FetchProvider` interface to match actual implementation signatures

---

### Area 7: CONFIGURATION & ENVIRONMENT — Score: 8/10

**Justification**: The atomic swap pattern in `providers/index.ts:79-82` prevents transient empty states. Environment validation is comprehensive. However, `config` is a mutable module-level object written by `initialize_config()`. If `initialize_config()` is called multiple times concurrently (unlikely but possible), the writes aren't atomic at the field level.

**To reach 10/10**:
1. Make `config` fields readonly after initialization
2. Add validation that `initialize_config()` isn't called multiple times
3. Consider using `Object.freeze()` on the config after initialization

---

### Area 8: OBSERVABILITY & DEBUGGING — Score: 7/10

**Justification**: Structured logging is comprehensive with `request_id` correlation. The `loggers` factory provides component-specific loggers. Timing instrumentation is captured at the right granularity. However:
- `answer_orchestrator.ts` uses `loggers.aiResponse()` without request context propagation
- `logger.response()` is called in `worker.ts:229,250,257` but not for all responses
- Missing: correlation between MCP tool calls and REST endpoint logs

**To reach 10/10**:
1. Propagate `request_id` from worker through to orchestrators
2. Add structured error context (stack traces, provider details) to all error logs
3. Log MCP tool call start/end with correlation IDs

---

### Area 9: API DESIGN & PROTOCOL COMPLIANCE — Score: 9/10

**Justification**: MCP protocol compliance is excellent with Streamable HTTP transport. REST endpoints (`/search`, `/fetch`) are well-designed with proper status codes. Tool descriptions are detailed and helpful. CORS handling is comprehensive. Minor issues: the `outputSchema` in tools.ts doesn't match actual return types (the handlers return MCP SDK `CallToolResult` format, not the Zod schema format).

**To reach 10/10**:
1. Verify that `outputSchema` actually validates returned content, or remove it if unused
2. Add OpenAPI/Swagger documentation for REST endpoints
3. Consider adding rate limiting headers to REST responses

---

### Area 10: PERFORMANCE & RESOURCE EFFICIENCY — Score: 7/10

**Justification**: The codebase avoids common performance pitfalls. TextEncoder is created once at module level (`SSE_PING`). Buffer merging uses `Uint8Array` efficiently. However:
- `sanitize_for_log()` in `utils.ts:21-22` creates a new string on every call
- The fanout cache uses Map without size limits enforced (lazy eviction only)
- `Date.now()` is called frequently on hot paths (acceptable but could batch)

**To reach 10/10**:
1. Cache sanitized strings with an LRU cache
2. Add hard size limit to fanout_cache with deterministic eviction
3. Consider using `performance.now()` for higher-precision timing

---

## Part 2: Traditional Code Review

### CRITICAL

**None identified** — No production bugs, data loss risks, or outage-causing patterns.

---

### HIGH

1. **`src/common/utils.ts:8-11` — AbortSignal.any() compatibility**
   - **What**: `make_signal()` uses `AbortSignal.any()` which requires browser/Node 20+ support
   - **Why**: Cloudflare Workers V8 isolates may not support this API, causing silent failures
   - **Fix**: Implement manual signal composition:
   ```typescript
   export const make_signal = (timeout_ms: number, external?: AbortSignal): AbortSignal => {
     const controller = new AbortController();
     const timeout = setTimeout(() => controller.abort(), timeout_ms);
     if (external) {
       external.addEventListener('abort', () => {
         clearTimeout(timeout);
         controller.abort();
       }, { once: true });
     }
     return controller.signal;
   };
   ```

2. **`src/worker.ts:98-103` — SSE keepalive race condition**
   - **What**: The `setInterval` continues firing after `closed` is set until the next iteration
   - **Why**: Could cause write attempts to closed writer, though `.catch(cleanup)` handles it
   - **Fix**: Check `!closed` inside the interval callback before `buffer.length === 0` check, and use a write lock

3. **`src/fetch_orchestrator.ts:183-185` — Silent AggregateError swallowing**
   - **What**: `Promise.any` throws AggregateError when all fail, caught silently
   - **Why**: No visibility into why providers failed — debugging becomes difficult
   - **Fix**: Add logging before the catch:
   ```typescript
   try {
     return await Promise.any(promises);
   } catch (aggError) {
     logger.debug('All parallel providers failed', {
       op: 'parallel_fail',
       errors: aggError.errors.map(e => e.message),
     });
     return undefined;
   }
   ```

---

### MEDIUM

4. **`src/tools.ts:20-24` — Mutable module-level shared state**
   - **What**: `active_providers` is a mutable object exposed as module export
   - **Why**: External code could mutate it, causing inconsistent state
   - **Fix**: Freeze the object or make it an opaque getter

5. **`src/providers/index.ts:79-82` — Field-level non-atomic updates**
   - **What**: `active_providers.search`, `.ai_response`, `.fetch` are updated separately
   - **Why**: If code reads between updates, could see inconsistent state
   - **Fix**: Create a new `active_providers` object entirely and swap once

6. **`src/common/utils.ts:21-22` — Repeated regex on hot paths**
   - **What**: `sanitize_for_log()` compiles regex on every call
   - **Why**: Regex compilation is expensive; called on every request
   - **Fix**: Move regex to module level:
   ```typescript
   const CONTROL_CHARS = /[\x00-\x1F\x7F]/g;
   export const sanitize_for_log = (s: string): string =>
     s.replace(CONTROL_CHARS, '').slice(0, 200);
   ```

7. **`src/server/web_search_fanout.ts:17-18` — Cache eviction not enforced**
   - **What**: Fanout cache has size=50 limit but only evicts on write after size exceeded
   - **Why**: Burst of unique queries could bypass eviction
   - **Fix**: Check size on read and evict if over limit

---

### LOW

8. **`src/common/http.ts:22` — SENSITIVE_PARAMS is created on every import**
   - **What**: `SENSITIVE_PARAMS` is a `new Set()` at module level
   - **Why**: Minor memory waste; Sets are cheap but still unnecessary allocation
   - **Fix**: Use `const SENSITIVE_PARAMS = new Set(['api_key', ...]) as const`

9. **`src/worker.ts:145` — @ts-expect-error for version mismatch**
   - **What**: Comment explains the type mismatch between bundled versions
   - **Why**: Fragile — future updates could break silently
   - **Fix**: Add a comment with the specific version numbers and a TODO to remove when aligned

10. **`src/server/handlers.ts:59` — Unnecessary `as string` cast**
    - **What**: `const providerName = provider as string;`
    - **Why**: Template already typed; unnecessary cast
    - **Fix**: Remove the cast or add a type guard

---

### POSITIVE

1. **SSE keepalive injection with event boundary buffering** (`worker.ts:79-95`): The `find_event_boundary()` approach correctly identifies complete SSE events before injecting pings, preventing frame corruption.

2. **Domain breaker pattern** (`fetch_orchestrator.ts:33-48`): Using specialized providers (supadata for YouTube, sociavault for social) before the general waterfall is an excellent optimization.

3. **Atomic provider initialization** (`providers/index.ts:79-82`): The swap pattern prevents concurrent DO instances from seeing empty provider lists.

4. **RRF ranking implementation** (`rrf_ranking.ts`): Clean implementation with quality filters and the `rescue_tail_results()` feature for preserving diverse domain results.

5. **Snippet selector with greedy cover** (`snippet_selector.ts`): Sophisticated NLP-light approach to selecting/merging provider snippets using bigrams and Jaccard similarity.

6. **Tool descriptions** (`tools.ts`): Comprehensive descriptions that help LLM clients make informed routing decisions.

7. **Error type hierarchy** (`types.ts:42-58`): `ProviderError` with typed enum cases enables granular error handling downstream.
