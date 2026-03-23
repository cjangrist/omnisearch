# Consolidated Architecture Scorecard (Round 4) — Omnisearch MCP Server

**Reviewers:** Gemini 3.1 Pro, Codex (GPT-5.4), Kimi K2, OpenCode (GLM-5), Claude Opus 4.6
**Consolidated by:** Claude Opus 4.6 | 2026-03-22

---

## Scorecard: R1 → R2 → R3 → R4

| Area | Gemini | Codex | Kimi | OpenCode | Opus | **R4 Avg** | **R3** | **R2** | **R1** |
|------|--------|-------|------|----------|------|------------|--------|--------|--------|
| 1. Concurrency & Async | 9 | 6 | 8 | 9 | 8 | **8.0** | 7.4 | 7.4 | 7.0 |
| 2. Stream Handling & SSE | 9 | 7 | 9 | 8 | 9 | **8.4** | 8.2 | 7.6 | 7.6 |
| 3. Error Handling | 8 | 6 | 8 | 9 | 8 | **7.8** | 8.2 | 8.4 | 7.8 |
| 4. Data Flow & Orchestration | 8 | 6 | 9 | 9 | 9 | **8.2** | 8.6 | 8.6 | 8.4 |
| 5. Code Organization | 10 | 7 | 8 | 9 | 9 | **8.6** | 8.2 | 8.6 | 7.6 |
| 6. Type Safety | 10 | 6 | 8 | 8 | 8 | **8.0** | 7.4 | 7.4 | 7.4 |
| 7. Configuration | 10 | 5 | 7 | 9 | 8 | **7.8** | 7.6 | 7.6 | 7.4 |
| 8. Observability | 10 | 6 | 9 | 8 | 9 | **8.4** | 6.8 | 8.0 | 7.6 |
| 9. API Design | 10 | 6 | 8 | 8 | 9 | **8.2** | 8.2 | 8.0 | 8.2 |
| 10. Performance | 9 | 6 | 8 | 8 | 8 | **7.8** | 7.4 | 7.4 | 6.8 |
| **Overall** | **9.3** | **6.1** | **8.2** | **8.5** | **8.5** | **8.1** | **7.8** | **7.9** | **7.6** |

---

## Progress Across 4 Rounds

| Round | Overall Avg | Delta | Key Changes |
|-------|-------------|-------|-------------|
| **R1** | **7.6** | — | Baseline |
| **R2** | **7.9** | +0.3 | Init guard, post-deadline fix, write lock, signal threading, CORS |
| **R3** | **7.8** | -0.1 | SSE +0.6, but observability -1.2 from request_id regression |
| **R4** | **8.1** | +0.3 | AsyncLocalStorage fix (+1.6 observability), KV await, timeout abort, per-provider timing |

**Total improvement: 7.6 → 8.1 (+0.5 over 4 rounds)**

---

## R4 Score Movement vs R3

- **Biggest gains:** Observability +1.6 (AsyncLocalStorage fix recovered the R3 regression), Concurrency +0.6, Type Safety +0.6
- **Slight dips:** Error Handling -0.4, Data Flow -0.4 (new concerns: caching failure states for 24h, config.yaml drift)
- **8 of 10 areas now at 7.8+**, up from 6 in R3

---

## Remaining Items (diminishing returns territory)

Most remaining findings are now LOW consensus (1-2/5) or architectural preferences rather than bugs:

1. **Fetch providers don't accept AbortSignal** (2/5) — requires interface change across 25+ providers
2. **KV cache stores failure/partial results for 24h** (1/5 Codex) — could add `providers_succeeded.length > 0` guard
3. **config.yaml vs TypeScript CONFIG drift** (2/5) — build-time validation or single-source
4. **`retry_with_backoff` doesn't pass signal to p-retry** (1/5) — p-retry v7 supports `signal` option
5. **SSE buffer has no hard size limit** (2/5) — add 5MB cap on chunks array
6. **`handle_provider_error` wraps DNS failures as API_ERROR** (1/5 Gemini) — should be PROVIDER_ERROR for retryability
7. **MCP path not duration-logged** (1/5 Codex) — add `logger.response()` for MCP requests

---

## Consensus Positive Findings (Round 4)

| Finding | Votes |
|---------|-------|
| SSE keepalive with event-boundary buffering + write lock | 5/5 |
| Provider registration pattern (name/key/factory) | 5/5 |
| Error isolation — one provider never crashes fanout | 5/5 |
| Atomic provider swap prevents empty-state windows | 5/5 |
| RRF ranking + snippet selector quality | 4/5 |
| Streaming response size guard in http_core | 4/5 |
| Post-deadline mutation prevention (is_done + defensive copies) | 4/5 |
| Fetch waterfall with domain breakers | 4/5 |
| AsyncLocalStorage for request correlation | 3/5 |
| `make_signal` with AbortSignal.any polyfill | 3/5 |
| KV caching with 24h TTL across all tools | 3/5 |
| Per-provider timing with `started_at` | 2/5 |

---

## Reviewer Calibration Notes

Codex remains ~2 points below the mean (6.1 vs 8.5 avg of others). Its scores have been essentially flat across all 4 rounds (6.1 → 6.7 → 6.6 → 6.1) despite significant improvements recognized by the other 4 reviewers. Excluding Codex, the 4-reviewer average is **8.6/10**.
