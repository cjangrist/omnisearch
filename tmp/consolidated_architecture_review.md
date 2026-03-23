# Consolidated Architecture Scorecard — Omnisearch MCP Server

**Reviewers:** Gemini 3.1 Pro, Codex (GPT-5.4), Kimi K2, OpenCode (GLM-5), Claude Opus 4.6
**Consolidated by:** Claude Opus 4.6 | 2026-03-22

---

## Scorecard Summary

| Area | Gemini | Codex | Kimi | OpenCode | Opus | **Avg** |
|------|--------|-------|------|----------|------|---------|
| 1. Concurrency & Async | 8 | 6 | 7 | 7 | 7 | **7.0** |
| 2. Stream Handling & SSE | 7 | 7 | 8 | 8 | 8 | **7.6** |
| 3. Error Handling & Resilience | 8 | 7 | 8 | 8 | 8 | **7.8** |
| 4. Data Flow & Orchestration | 9 | 6 | 9 | 9 | 9 | **8.4** |
| 5. Code Organization | 6 | 7 | 8 | 8 | 9 | **7.6** |
| 6. Type Safety & Interfaces | 9 | 6 | 8 | 7 | 7 | **7.4** |
| 7. Configuration & Environment | 9 | 5 | 7 | 8 | 8 | **7.4** |
| 8. Observability & Debugging | 9 | 6 | 8 | 7 | 8 | **7.6** |
| 9. API Design & Protocol | 10 | 6 | 8 | 9 | 8 | **8.2** |
| 10. Performance & Efficiency | 7 | 5 | 7 | 7 | 8 | **6.8** |
| **Overall** | **8.2** | **6.1** | **7.8** | **7.8** | **8.0** | **7.6** |

---

## Ranked Improvement Items (by impact, to reach 10/10)

### Priority 1 — Signal threading gap (Areas 1, 10) — Consensus: 5/5

**All 9 search providers and 25+ fetch providers ignore `params.signal`.** The `make_signal()` utility exists but is only used by AI response providers. When the web search fanout's `timeout_ms` fires, or the answer orchestrator's global deadline fires, in-flight HTTP requests continue running until their individual timeouts (10-30s) expire. Fetch waterfall losers also continue in the background.

**Fix:** In every search provider's `search()` method, change `signal: AbortSignal.timeout(...)` to `signal: make_signal(timeout, params.signal)`. In `web_search_fanout.ts`, create an `AbortController` and pass its signal to providers. In `fetch_orchestrator.ts`, abort losing parallel providers after `Promise.any` resolves.

---

### Priority 2 — `_init_promise` caches rejected promises permanently (Area 1) — Consensus: 1/5 (Gemini only, but CRITICAL)

If a DO instance throws during `_do_init()` (e.g., transient config error), `_init_promise` remains a rejected promise. Every subsequent request hitting this DO immediately fails until the isolate dies. **This is a bug introduced in the M1 fix.**

**Fix:**
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

---

### Priority 3 — REST path re-initializes on every request (Areas 1, 5, 7, 10) — Consensus: 4/5

Every `POST /search` and `POST /fetch` request calls `initialize_config(env)` + `validate_config()` + `initialize_providers()`, reconstructing 40+ provider class instances. Env bindings don't change within an isolate's lifetime.

**Fix:** Add a module-level `let _rest_init: Promise<void> | undefined` guard (same pattern as `_init_promise` in the DO class).

---

### Priority 4 — Fanout cache key doesn't include options (Area 4) — Consensus: 2/5

The web search cache is keyed only by `query`. A timed-out partial result or `skip_quality_filter: true` variant can be returned to a later call that expects full results.

**Fix:** Include `skip_quality_filter`, `timeout_ms`, and provider count in the cache key. Only cache results from non-timeboxed runs (all providers completed).

---

### Priority 5 — Fanout cache unbounded growth (Areas 4, 10) — Consensus: 4/5

The 50-entry lazy eviction only removes expired entries. If all 50 are still valid, the cache grows without bound.

**Fix:** Replace lazy eviction with LRU — when at capacity, evict the oldest entry (first key in Map insertion order) regardless of TTL.

---

### Priority 6 — Post-deadline promise mutations (Area 4) — Consensus: 2/5

After the answer orchestrator's deadline fires and `execute_tasks` returns defensive copies, late-arriving `.then()` callbacks still push into the original `answers` and `failed` arrays. Causes detached memory growth and out-of-band logging.

**Fix:** Add `let is_done = false;` set after `Promise.race`. Inside `.then()` and `.catch()` callbacks, add `if (is_done) return;` to prevent post-deadline mutation entirely.

---

### Priority 7 — SSE buffer concatenation is O(n^2) (Areas 2, 10) — Consensus: 3/5

Each `reader.read()` creates `new Uint8Array(buffer.length + value.length)` plus two `.set()` copies. For long SSE streams, total allocation is quadratic.

**Fix:** Accumulate chunks in an array; only concatenate when scanning for `\n\n` boundaries, or scan only the latest chunk + tail of previous buffer.

---

### Priority 8 — SSE writer concurrent write risk (Area 2) — Consensus: 2/5

`setInterval` can fire while the pump loop is awaiting `writer.write()`. While WritableStream queues writes internally, some runtimes throw on concurrent `.write()` calls.

**Fix:** Introduce a sequential write lock (Promise chain) for all `writer.write()` calls.

---

### Priority 9 — Error response shape inconsistency (Areas 3, 9) — Consensus: 2/5

REST endpoints, MCP tool errors, and worker-level errors use different JSON shapes. Some branches expose raw provider messages, others suppress them.

**Fix:** Define one shared error JSON shape and use it everywhere.

---

### Priority 10 — Config mutation is non-atomic at field level (Area 7) — Consensus: 3/5

`initialize_config()` writes ~60 fields individually to the module-level `config` object. Optional fields only update when env vars are truthy — stale values survive.

**Fix:** Build a new config object locally, then swap entirely. Reset optional fields to defaults before populating.

---

### Priority 11 — request_id not propagated to DO / orchestrators (Area 8) — Consensus: 3/5

The `request_id` generated in the Worker fetch handler is logged at the routing level only. MCP tool calls through the DO never receive it.

**Fix:** Use AsyncLocalStorage (available with `nodejs_compat`) for request-scoped context, or thread request_id through orchestrators.

---

### Priority 12 — AbortSignal.any() compatibility risk (Area 1) — Consensus: 2/5

`make_signal()` uses `AbortSignal.any()` which is relatively new. A polyfill would be more defensive.

**Fix:** Add feature detection; fall back to manual composition via AbortController + event listeners if `AbortSignal.any` doesn't exist.

---

### Priority 13 — AggregateError silently swallowed in fetch parallel (Area 3) — Consensus: 2/5

`run_parallel` catches `Promise.any`'s `AggregateError` silently. Individual failures are logged, but the aggregate "all failed" event is invisible.

**Fix:** Add `logger.debug('All parallel providers failed', { providers })` in the catch block.

---

### Priority 14 — Tool descriptions overclaim behavior (Area 9) — Consensus: 2/5

The `fetch` tool description claims "military-grade", "near-100% success rate". The `answer` tool claims "9 providers" regardless of configured keys.

**Fix:** Tone down to factual claims. Make provider counts dynamic from `get_active_*_providers().length`.

---

### Priority 15 — `structuredContent` cast to `Record<string, unknown>` (Area 6) — Consensus: 3/5

Multiple `as unknown as Record<string, unknown>` casts in tools.ts. Zod output schemas don't match MCP SDK `CallToolResult` types.

**Fix:** Define proper output DTOs matching Zod schemas and use `z.infer<typeof schema>`.

---

### Priority 16 — TextEncoder in `timing_safe_equal` (Area 10) — Consensus: 2/5

New `TextEncoder()` created on every call to `timing_safe_equal`.

**Fix:** Move to module scope.

---

### Priority 17 — `sanitize_for_log` regex recompilation (Area 10) — Consensus: 2/5

Regex `/[\x00-\x1F\x7F]/g` compiled on every call.

**Fix:** Move regex to module scope.

---

## Consensus Positive Findings

| Finding | Votes |
|---------|-------|
| SSE keepalive with event-boundary buffering is correct and well-designed | 5/5 |
| RRF ranking with rescue-tail diversity mechanism | 5/5 |
| Provider registration pattern (name/key/factory tuples) is clean and extensible | 5/5 |
| Atomic provider set swap prevents empty-state windows | 5/5 |
| `ProviderError` type hierarchy for error classification | 5/5 |
| Fetch waterfall with domain breakers is well-architected | 4/5 |
| `http_core` centralized HTTP utility with response size guards | 4/5 |
| Clean separation between MCP and REST paths using shared orchestrators | 4/5 |
| Comprehensive structured logging with op/timing fields | 4/5 |
| Defensive copies after deadline in answer orchestrator | 3/5 |
| Tool descriptions detailed enough for LLM routing decisions | 3/5 |
| Snippet selector with greedy cover using bigrams + Jaccard similarity | 2/5 |
