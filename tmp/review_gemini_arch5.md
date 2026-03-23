Here is the architecture scorecard and traditional code review for the Omnisearch MCP server.

## Part 1: Architecture Scorecard

### Area 1: CONCURRENCY & ASYNC PATTERNS
**Score: 8/10**
**Justification:** Promise orchestration is highly robust with correct use of `Promise.allSettled`, deadlines, and late-arrival array mutation guards. However, the fetch waterfall's parallel execution step leaves losing promises running in the background without cancellation, wasting execution time and network resources.
**To reach 10/10:**
- Add an `AbortSignal` parameter to the `FetchProvider` interface in `types.ts` and propagate it through `UnifiedFetchProvider`.
- In `fetch_orchestrator.ts` (`run_parallel`), create a new `AbortController()`, pass its `.signal` to the parallel `try_provider` calls, and call `controller.abort()` in a `.finally()` block attached to the `Promise.any` winner/loser resolution.

### Area 2: STREAM HANDLING & SSE
**Score: 9/10**
**Justification:** The SSE keepalive injection is ingeniously designed. It correctly buffers fragmented event boundaries across chunks and safely serializes concurrent stream writes. The only flaw is that it eagerly flattens the chunk buffer on *every* read loop iteration, even if no line breaks are present.
**To reach 10/10:**
- In `worker.ts`, modify the `pump` function to only trigger the buffer flush if the newly read chunk contains a line break, preventing O(N²) memory copying on multi-megabyte JSON payloads:
  `if (value.indexOf(10) !== -1 || value.indexOf(13) !== -1) { await flush_complete_events(); }`

### Area 3: ERROR HANDLING & RESILIENCE
**Score: 10/10**
**Justification:** Error handling is exemplary. The code correctly normalizes diverse external errors to `ProviderError`, isolates transient failures using `allSettled`, degrades gracefully when partial providers fail, and catches deep Durable Object initialization errors without crashing the isolate.
**To reach 10/10:** No changes needed.

### Area 4: DATA FLOW & PROVIDER ORCHESTRATION
**Score: 9/10**
**Justification:** The Reciprocal Rank Fusion (RRF) merging, deduplication, and truncation pipelines are exceptionally clever. However, the KV caching strategy will cache results as long as *at least one* provider succeeds, meaning a transient network blip across 8 out of 9 providers will pin a severely degraded result in the cache for 24 hours.
**To reach 10/10:**
- In `web_search_fanout.ts`, only write to the KV cache if `providers_failed.length === 0`, or significantly reduce the cache TTL (e.g., to 5 minutes) when returning a partially degraded result.

### Area 5: CODE ORGANIZATION & MODULARITY
**Score: 8/10**
**Justification:** The unified dispatcher pattern is scalable and the separation of concerns between routing and business logic is clear. However, module-level mutable state (`active_providers`) is defined in `tools.ts` but mutated by `index.ts`, creating an implicit initialization order requirement across modules.
**To reach 10/10:**
- Extract the `active_providers` Set and its getters/setters into a dedicated `provider_registry.ts` file. Both `tools.ts` and `providers/index.ts` should import this new file to decouple the tool schema definitions from the mutable runtime state.

### Area 6: TYPE SAFETY & INTERFACES
**Score: 10/10**
**Justification:** Excellent use of TypeScript primitives. The system safely navigates heterogeneous provider responses with runtime guards, uses discriminated unions elegantly in the waterfall config, and leverages strict `unknown` assertion boundaries rather than falling back to `any`.
**To reach 10/10:** No changes needed.

### Area 7: CONFIGURATION & ENVIRONMENT
**Score: 10/10**
**Justification:** Cloudflare's environment bindings are safely mapped to a static internal config state per isolate. Missing keys are gracefully handled (disabling specific providers rather than crashing), and timeout constants are well-calibrated for the different service limits.
**To reach 10/10:** No changes needed.

### Area 8: OBSERVABILITY & DEBUGGING
**Score: 8/10**
**Justification:** Structured logging and request ID context threading via `AsyncLocalStorage` is beautifully implemented for the REST paths. However, tool calls invoked via the MCP WebSocket protocol bypass the initial `fetch` handler's context, resulting in `request_id: undefined` across all deep provider logs.
**To reach 10/10:**
- In `server/tools.ts`, generate a new UUID inside each `server.registerTool` handler and wrap the entire execution block with `run_with_request_id(request_id, async () => { ... })` so that MCP-driven executions have correlated logs.

### Area 9: API DESIGN & PROTOCOL COMPLIANCE
**Score: 10/10**
**Justification:** The REST API acts as a seamless secondary interface, CORS immutability is handled correctly across stream/JSON responses, and proper HTTP status codes (e.g., `502 Bad Gateway` vs `500 Internal Server Error`) cleanly map to underlying protocol states.
**To reach 10/10:** No changes needed.

### Area 10: PERFORMANCE & RESOURCE EFFICIENCY
**Score: 8/10**
**Justification:** Memory limits are rigorously enforced during HTTP fetching, and execution is generally fast. However, KV cache writes are `await`ed on the hot path directly before returning HTTP/tool responses, artificially delaying the response by 20-50ms.
**To reach 10/10:**
- Use Cloudflare's `ctx.waitUntil()` to execute KV cache writes asynchronously. Because `ctx` is not directly available inside the orchestrators, either expose a `globalThis.waitUntilTasks.push(promise)` array that the main worker flushes, or pass `ctx` down through the function parameters.

---

## Part 2: Traditional Code Review

### HIGH — Should fix (problems under specific conditions)

- **File and line number(s):** `src/server/rest_search.ts` (~line 36) & `src/server/rest_fetch.ts` (~line 33)
- **What:** The request body size guard relies exclusively on the `content-length` header. If a malicious or poorly configured client sends a payload using `Transfer-Encoding: chunked` and omits the `content-length` header, `parseInt` falls back to `0`, bypassing the `content_length > 65536` check entirely. The subsequent `await request.json()` will then buffer the unbounded payload into memory.
- **Why:** This leaves the REST endpoints vulnerable to memory exhaustion / OOM DOS attacks.
- **Fix:** Do not rely on `request.json()` for unbounded streams. Either configure a hard request limit on the Cloudflare dashboard natively, or manually consume `request.body` with a reader and a byte counter, identical to the brilliant implementation you already wrote in `http_core`.

### MEDIUM — Should fix soon (quality, maintainability)

- **File and line number(s):** `src/server/fetch_orchestrator.ts` (~line 279)
- **What:** When a domain breaker succeeds, it returns the result directly. However, it does not push the breaker provider's name into the `attempted` array before calling `build_and_cache`.
- **Why:** If the result hits a domain breaker, the returned `providers_attempted` array in the final JSON schema will be entirely empty, which is confusing for observability and the UI.
- **Fix:** Add `attempted.push(breaker_config.provider);` immediately before calling `run_solo(ctx, breaker_config.provider);`.

### POSITIVE — What was done well (good patterns, smart decisions)

- **Mathematical Elegance:** The `rescue_tail_results` function in `rrf_ranking.ts` mathematically derives the `intra_rank` from the inverted Reciprocal Rank Fusion score. This allows the system to accurately rescue incredibly specific, high-quality results that were pushed to the bottom of the list simply because they were only indexed by a single niche provider. It is a masterful piece of algorithm design.
- **Hybrid Deployment Model:** Bridging a stateless Worker for rapid REST execution alongside a stateful Durable Object instance to host persistent MCP WebSocket sessions is an elite architectural pattern. It solves Claude's brutal 45-second timeout while avoiding unnecessary DO billing for quick HTTP hits.
- **Defensive Networking:** Manually parsing the `fetch` streams in `http_core` with a running `total_bytes` counter to defend against infinite stream responses is a highly professional, military-grade security defense against chunked-encoding denial of service attacks.
