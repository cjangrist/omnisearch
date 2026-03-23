# Consolidated Architecture Scorecard (Round 6) — Omnisearch MCP Server

**Reviewers:** Gemini 3.1 Pro, Kimi K2, OpenCode (GLM-5), Kilo Code, Claude Opus 4.6
**Note:** Codex couldn't read repo (sandbox issue), Cline timed out. 5 of 7 completed.
**Consolidated by:** Claude Opus 4.6 | 2026-03-22

---

## Scorecard: Full History R1 → R6

| Area | Gemini | Kimi | OpenCode | Kilo | Opus | **R6 Avg** | **R5** | **R4** | **R1** |
|------|--------|------|----------|------|------|------------|--------|--------|--------|
| 1. Concurrency & Async | 7 | 8 | 6 | 8 | 8 | **7.4** | 7.4 | 8.0 | 7.0 |
| 2. Stream Handling & SSE | 10 | 7 | 7 | 9 | 8 | **8.2** | 8.2 | 8.4 | 7.6 |
| 3. Error Handling | 9 | 8 | 8 | 8 | 9 | **8.4** | 8.2 | 7.8 | 7.8 |
| 4. Data Flow & Orchestration | 9 | 9 | 9 | 9 | 9 | **9.0** | 8.6 | 8.2 | 8.4 |
| 5. Code Organization | 9 | 8 | 8 | 9 | 9 | **8.6** | 8.4 | 8.6 | 7.6 |
| 6. Type Safety | 10 | 7 | 8 | 7 | 7 | **7.8** | 7.8 | 8.0 | 7.4 |
| 7. Configuration | 8 | 8 | 8 | 8 | 8 | **8.0** | 8.4 | 7.8 | 7.4 |
| 8. Observability | 5 | 9 | 8 | 8 | 8 | **7.6** | 8.0 | 8.4 | 7.6 |
| 9. API Design | 10 | 8 | 8 | 8 | 8 | **8.4** | 8.4 | 8.2 | 8.2 |
| 10. Performance | 9 | 8 | 8 | 8 | 8 | **8.2** | 7.4 | 7.8 | 6.8 |
| **Overall** | **8.6** | **8.0** | **7.8** | **8.2** | **8.2** | **8.2** | 8.1 | 8.1 | 7.6 |

---

## Progress Across 6 Rounds

| Round | Overall | Delta | Key Changes |
|-------|---------|-------|-------------|
| **R1** | **7.6** | — | Baseline |
| **R2** | **7.9** | +0.3 | Init guard, write lock, signal threading, CORS |
| **R3** | **7.8** | -0.1 | AsyncLocalStorage regression |
| **R4** | **8.1** | +0.3 | ALS fix, KV await, timeout abort, per-provider timing |
| **R5** | **8.1** | 0 | Cache guard, p-retry signal, MCP logging |
| **R6** | **8.2** | +0.1 | Batch cleanup (10 items), auth dedup, config reset, explicit fetch, MCP tracing |

**Total improvement: 7.6 → 8.2 (+0.6 over 6 rounds)**

---

## New Findings This Round

### Gemini CRITICAL: `eval('require')` for AsyncLocalStorage may be blocked by CF Workers
**Files:** `common/logger.ts:19`
**What:** `eval('require')('node:async_hooks')` — CF Workers may block `eval` or `require` at runtime even with `nodejs_compat`.
**Fix:** Use static `import { AsyncLocalStorage } from 'node:async_hooks'` with a declared type.
**Note:** This needs verification — our deploy works fine, so either CF Workers allows it or the fallback gracefully degrades. Worth testing.

### Kilo HIGH: KV cache keys can exceed 512-byte limit
**Files:** `web_search_fanout.ts`, `answer_orchestrator.ts`, `fetch_orchestrator.ts`
**What:** Long queries (up to 2000 chars) + prefix could exceed KV's 512-byte key limit.
**Fix:** Hash the query portion of the key with SHA-256.

### Data Flow hit 9.0 (highest any area has scored across all rounds)
First area to break 9.0 average — all 5 reviewers gave it 9/10.

---

## Consensus Positive Findings (Round 6)

| Finding | Votes |
|---------|-------|
| SSE keepalive with event-boundary buffering | 5/5 |
| Provider registration pattern | 5/5 |
| Error isolation across fanouts | 5/5 |
| RRF ranking + snippet selector | 5/5 |
| Fetch waterfall with domain breakers | 5/5 |
| Atomic provider swap | 4/5 |
| Streaming response size guard | 4/5 |
| AsyncLocalStorage for request correlation | 3/5 |
| KV caching with 24h TTL | 3/5 |
| `make_signal` polyfill | 3/5 |
