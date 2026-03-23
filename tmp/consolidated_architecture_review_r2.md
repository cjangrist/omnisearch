# Consolidated Architecture Scorecard (Round 2) — Omnisearch MCP Server

**Reviewers:** Gemini 3.1 Pro, Codex (GPT-5.4), Kimi K2, OpenCode (GLM-5), Claude Opus 4.6
**Consolidated by:** Claude Opus 4.6 | 2026-03-22

---

## Scorecard Comparison: Round 1 → Round 2

| Area | Gemini | Codex | Kimi | OpenCode | Opus | **R2 Avg** | **R1 Avg** | **Δ** |
|------|--------|-------|------|----------|------|------------|------------|-------|
| 1. Concurrency & Async | 8 | 7 | 7* | 7 | 8 | **7.4** | 7.0 | **+0.4** |
| 2. Stream Handling & SSE | 7 | 7 | 8* | 8 | 8 | **7.6** | 7.6 | **0** |
| 3. Error Handling & Resilience | 9 | 7 | 9 | 8 | 9 | **8.4** | 7.8 | **+0.6** |
| 4. Data Flow & Orchestration | 9 | 7 | 9* | 9 | 9 | **8.6** | 8.4 | **+0.2** |
| 5. Code Organization | 10 | 7 | 9* | 8 | 9 | **8.6** | 7.6 | **+1.0** |
| 6. Type Safety & Interfaces | 9 | 6 | 8 | 7 | 7 | **7.4** | 7.4 | **0** |
| 7. Configuration & Environment | 10 | 6 | 7* | 7 | 8 | **7.6** | 7.4 | **+0.2** |
| 8. Observability & Debugging | 10 | 7 | 8* | 7 | 8 | **8.0** | 7.6 | **+0.4** |
| 9. API Design & Protocol | 9 | 7 | 8* | 8 | 8 | **8.0** | 8.2 | **-0.2** |
| 10. Performance & Efficiency | 7 | 6 | 8 | 8 | 8 | **7.4** | 6.8 | **+0.6** |
| **Overall** | **8.8** | **6.7** | **8.1** | **7.7** | **8.2** | **7.9** | **7.6** | **+0.3** |

*Kimi used a condensed 7-category format. Scores marked * are inferred from their category mapping.*

---

## Score Movement Summary

- **Biggest gain:** Code Organization +1.0 (REST init dedup, atomic provider swap, write lock all recognized)
- **Other gains:** Error Handling +0.6, Performance +0.6, Observability +0.4, Concurrency +0.4
- **Flat:** Stream Handling, Type Safety (same gaps remain: `as unknown as` casts, CRLF in SSE)
- **Slight dip:** API Design -0.2 (tool descriptions still overclaim — was flagged but not fixed)

---

## Remaining Improvement Items (ranked by consensus)

### 1. Gemini-grounded inner web search ignores AbortSignal — 3/5
**Files:** `answer_orchestrator.ts:84-88`
**What:** The `gemini-grounded` task calls `run_web_search_fanout(web_search_ref, query)` without passing `signal`. After the 120s deadline fires and aborts, the inner web search (9 provider HTTP requests) continues running.
**Fix:** Change to `run_web_search_fanout(web_search_ref, query, { signal })`.

### 2. Fetch parallel losers never cancelled — 3/5
**Files:** `fetch_orchestrator.ts:167-179`
**What:** `Promise.any` returns the first success but losing providers keep running, consuming CPU and subrequests.
**Fix:** Create a per-step `AbortController`, thread its signal into `try_provider`, and `abort()` when `Promise.any` resolves.

### 3. `http_core` buffers full response before size guard — 2/5
**Files:** `common/http.ts:45-55`
**What:** `await res.text()` reads the entire response body. A chunked-encoding response can bypass the content-length check and OOM the worker.
**Fix:** Use a streaming reader with byte counter, abort when exceeding `MAX_RESPONSE_BYTES`.

### 4. REST handler unhandled throws lack CORS — 2/5
**Files:** `worker.ts:268,286`
**What:** `handle_rest_search(request)` and `handle_rest_fetch(request)` are awaited without try/catch. An unexpected throw would return a response without CORS headers.
**Fix:** Wrap each in try/catch returning `add_cors_headers(Response.json({ error: 'Internal server error' }, { status: 500 }))`.

### 5. Cache eviction is FIFO, not LRU — 3/5
**Files:** `web_search_fanout.ts:38-45`
**What:** Cache hits don't promote entries. Eviction deletes oldest by insertion order.
**Fix:** On cache hit, delete and re-insert: `fanout_cache.delete(key); fanout_cache.set(key, entry);`

### 6. `as unknown as Record<string, unknown>` casts — 4/5
**Files:** `tools.ts:155,198,229`
**What:** Loses type safety for `structuredContent`.
**Fix:** Use typed helpers with `z.infer` or accept the SDK's limitation with documented casts.

### 7. Unified providers instantiate all classes eagerly — 2/5
**Files:** `providers/unified/web_search.ts:55`, `ai_search.ts:49`, `fetch.ts:84`
**What:** Constructor creates instances for all 25+ registered providers, even those without API keys.
**Fix:** Filter by active key before instantiation.

### 8. Health/404 missing CORS headers — 2/5
**Files:** `worker.ts:293,325`
**Fix:** Wrap health and 404 responses with `add_cors_headers()`.

### 9. request_id not threaded to downstream logs — 3/5
**Fix:** Use AsyncLocalStorage or pass through call chain.

### 10. SSE boundary detector only handles `\n\n` — 2/5
**What:** SSE spec also allows `\r\n\r\n` and `\r\r` as boundaries.
**Fix:** Extend boundary detection to handle all three.

---

## Consensus Positive Findings (Round 2)

| Finding | Votes |
|---------|-------|
| SSE keepalive with event-boundary buffering + write lock | 5/5 |
| RRF ranking with rescue-tail diversity | 5/5 |
| Provider registration pattern (name/key/factory) | 5/5 |
| Atomic provider swap prevents empty-state windows | 5/5 |
| `ProviderError` type hierarchy + error classification | 5/5 |
| Three distinct orchestration patterns matching semantics | 4/5 |
| `_init_promise` retry-on-failure for DO startup | 4/5 |
| `is_done` flag + defensive copies after deadline | 4/5 |
| Domain breakers in fetch waterfall (YouTube, social) | 4/5 |
| `http_core` centralized HTTP with size guards + URL sanitization | 3/5 |
| `make_signal` with AbortSignal.any polyfill | 3/5 |
| Structured logging with `op`/`duration_ms`/`request_id` | 3/5 |
| Snippet selector with bigram Jaccard + greedy set-cover | 3/5 |
| `outputSchema` + `structuredContent` in MCP tools | 2/5 |

---

## Zero Tests Flagged

Both Kimi and OpenCode independently flagged **zero test coverage** as a critical gap. While the architecture review prompt excluded this, it's worth noting as the single most impactful improvement for code confidence.
