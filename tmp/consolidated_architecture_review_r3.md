# Consolidated Architecture Scorecard (Round 3) — Omnisearch MCP Server

**Reviewers:** Gemini 3.1 Pro, Codex (GPT-5.4), Kimi K2, OpenCode (GLM-5), Claude Opus 4.6
**Consolidated by:** Claude Opus 4.6 | 2026-03-22

---

## Scorecard Comparison: R1 → R2 → R3

| Area | Gemini | Codex | Kimi | OpenCode | Opus | **R3 Avg** | **R2 Avg** | **R1 Avg** | **Δ R2→R3** |
|------|--------|-------|------|----------|------|------------|------------|------------|-------------|
| 1. Concurrency & Async | 8 | 6 | 8 | 7 | 8 | **7.4** | 7.4 | 7.0 | **0** |
| 2. Stream Handling & SSE | 9 | 8 | 7 | 8 | 9 | **8.2** | 7.6 | 7.6 | **+0.6** |
| 3. Error Handling & Resilience | 10 | 7 | 8 | 8 | 8 | **8.2** | 8.4 | 7.8 | **-0.2** |
| 4. Data Flow & Orchestration | 9 | 7 | 9 | 9 | 9 | **8.6** | 8.6 | 8.4 | **0** |
| 5. Code Organization | 10 | 7 | 8 | 7 | 9 | **8.2** | 8.6 | 7.6 | **-0.4** |
| 6. Type Safety & Interfaces | 10 | 7 | 7 | 6 | 7 | **7.4** | 7.4 | 7.4 | **0** |
| 7. Configuration & Environment | 10 | 5 | 7 | 8 | 8 | **7.6** | 7.6 | 7.4 | **0** |
| 8. Observability & Debugging | 6 | 6 | 8 | 6 | 8 | **6.8** | 8.0 | 7.6 | **-1.2** |
| 9. API Design & Protocol | 10 | 7 | 8 | 8 | 8 | **8.2** | 8.0 | 8.2 | **+0.2** |
| 10. Performance & Efficiency | 8 | 6 | 7 | 8 | 8 | **7.4** | 7.4 | 6.8 | **0** |
| **Overall** | **9.0** | **6.6** | **7.7** | **7.5** | **8.2** | **7.8** | **7.9** | **7.6** | **-0.1** |

---

## Score Movement Summary

- **Biggest gain:** Stream Handling +0.6 (WHATWG boundary detection, write lock recognized)
- **New regression:** Observability -1.2 (module-level `current_request_id` flagged as CRITICAL by Gemini + Codex)
- **Stable:** Concurrency, Data Flow, Type Safety, Config, Performance all unchanged
- **Overall 7.8** — flat vs R2's 7.9 (the request_id regression offset the SSE gain)

---

## Remaining Actionable Items (ranked by consensus)

### 1. CRITICAL: Module-level `current_request_id` causes log cross-contamination — 3/5
**Files:** `common/logger.ts`, `worker.ts`
**What:** CF Workers process concurrent HTTP requests in the same isolate. The module-scoped `let current_request_id` is overwritten by each request. If Request A pauses on `await fetch()` and Request B starts, all subsequent logs for Request A carry Request B's ID.
**Fix:** Replace with `AsyncLocalStorage` from `node:async_hooks` (available via `nodejs_compat`). Wrap the Worker fetch handler in `als.run(request_id, () => ...)`.

### 2. HIGH: Unawaited KV cache writes silently fail on REST path — 3/5
**Files:** `web_search_fanout.ts:222`, `answer_orchestrator.ts:281`, `fetch_orchestrator.ts`
**What:** Fire-and-forget `kv_cache.put()` calls. On REST paths, CF Workers kill unresolved promises after the Response is sent. Cache writes may silently drop.
**Fix:** `await` the cache writes, or use `ctx.waitUntil()` to keep the promise alive. The ~10ms KV write latency is negligible vs provider calls.

### 3. Web search fanout doesn't abort providers on timeout — 3/5
**Files:** `web_search_fanout.ts:118-143`
**What:** When `timeout_ms` fires and partial results are returned, in-flight provider HTTP requests continue running.
**Fix:** Create an internal `AbortController`, pass signal to providers, abort on deadline.

### 4. Gemini-grounded blocks on full web search with no internal timeout — 2/5
**Files:** `answer_orchestrator.ts:87`
**What:** The inner `run_web_search_fanout` call has no `timeout_ms`, waiting for all 9 providers before starting Gemini generation.
**Fix:** Pass `timeout_ms: 10000` so gemini-grounded gets partial URLs quickly.

### 5. `retry_with_backoff` doesn't respect AbortSignal — 1/5
**Files:** `common/utils.ts`, `web_search_fanout.ts:89`
**What:** p-retry v7 supports a `signal` option, but it's not passed through.
**Fix:** Pass `signal` to p-retry options so retries abort on cancellation.

### 6. `safe_write` swallows stream errors — 2/5
**Files:** `worker.ts:73`
**What:** The `.catch(cleanup)` in `safe_write` resolves the promise chain successfully, tricking downstream into thinking the write succeeded.
**Fix:** Re-throw after cleanup so flush_complete_events stops iterating.

### 7. Provider duration_ms is time-since-fanout-start, not per-provider — 2/5
**Files:** `answer_orchestrator.ts:126,142`
**What:** Each provider's `duration_ms` is `Date.now() - start_time` where start_time is the fanout start. This measures wall-clock since fanout, not individual latency.
**Fix:** Capture `t0` per task in `build_tasks()`.

### 8. http.ts logs `raw.length` (chars) not byte count — 1/5
**Files:** `common/http.ts:128`
**What:** The streaming reader tracks bytes but the log uses `raw.length` (character count).
**Fix:** Pass and log the tracked byte count.

---

## Consensus Positive Findings (Round 3)

| Finding | Votes |
|---------|-------|
| SSE keepalive with event-boundary buffering + write lock | 5/5 |
| Provider registration pattern (name/key/factory) | 5/5 |
| Error boundary isolation — one provider never crashes fanout | 5/5 |
| RRF ranking + snippet selector quality | 4/5 |
| `_init_promise` retry-on-failure for DO startup | 4/5 |
| Post-deadline mutation prevention (`is_done` + defensive copies) | 4/5 |
| Fetch waterfall with domain breakers | 4/5 |
| `make_signal` with AbortSignal.any polyfill | 3/5 |
| CORS immutable-response wrapping pattern | 2/5 |
| `http_core` streaming size guard | 2/5 |

---

## Progress Across 3 Rounds

| Round | Overall Avg | Key Improvements |
|-------|-------------|-----------------|
| **R1** | **7.6** | Baseline |
| **R2** | **7.9** | +0.3 (init guard, post-deadline fix, buffer perf, write lock, signal threading, CORS, request_id) |
| **R3** | **7.8** | -0.1 (SSE +0.6 offset by observability -1.2 from request_id regression) |

The request_id module-level variable (introduced in R2 to fix item #9) was flagged as worse than the original problem by 3/5 reviewers. Fixing it with AsyncLocalStorage should recover +1.0 on observability, pushing overall to ~8.0+.
