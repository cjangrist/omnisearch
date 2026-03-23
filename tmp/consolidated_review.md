# Consolidated Code Review #3: Omnisearch MCP Server (Full Codebase)

**Reviewers:** Gemini 3.1 Pro, GPT-5.4 (Codex), GLM-5 (OpenCode), Kimi K2, Claude Opus 4.6
**Consolidated by:** Claude Opus 4.6 | 2026-03-22 (round 3)

Findings ranked by real-world impact. "Votes" = independent reviewers flagging the same core issue. Items already fixed in previous rounds are excluded.

---

## CRITICAL

### CR1. SSE keepalive can interleave mid-SSE-event (stream corruption risk)
- **File:** `src/worker.ts:62-99`
- **Votes:** 5/5 (unanimous)
- **Issue:** The keepalive interval writes `event: ping\ndata: keepalive\n\n` while the pump writes upstream chunks. If a chunk boundary falls mid-SSE-event, the ping lands inside an event, corrupting it.
- **Counter:** The agents package's `writeSSEEvent()` writes complete events atomically via a single `writer.write()`. The pump's `await writer.write(value)` and the interval's `writer.write(SSE_PING)` are serialized by the WritableStream's internal queue — they can't truly overlap. The risk is only if the upstream chunks an SSE event across multiple `reader.read()` calls AND the interval fires between those reads.
- **Verdict:** Theoretically possible under edge conditions, practically unlikely with current agents package. Fix would add complexity (SSE framing parser) for a low-probability issue.
- **Fix if doing it:** Buffer incoming bytes, track `\n\n` boundaries, only inject keepalive between complete events.

### CR2. Module-level singleton state shared across DO instances
- **File:** `src/config/env.ts`, `src/server/tools.ts:247`, `src/providers/index.ts`
- **Votes:** 5/5 (unanimous — every reviewer flagged this)
- **Issue:** `config`, `active_providers`, `ToolRegistry`, `OPENWEBUI_API_KEY`, `OMNISEARCH_API_KEY` are module-level globals shared by all DO instances in the same isolate. `initialize_providers()` calls `reset_registry()` which could clear state mid-request.
- **Mitigated by:** `_initialized` guard on each DO instance. Same env bindings per isolate. DOs serialize per-instance.
- **Proper fix:** Instance-scoped state on `OmnisearchMCP` class. Bigger refactor.

### CR3. REST `/search` returns 200 with empty results when all providers fail
- **File:** `src/server/rest_search.ts:138,168`
- **Votes:** 1/5 (Codex — but it's correct)
- **Issue:** REST `/search` endpoint returns `200 []` when every provider fails. The MCP `web_search` tool was already fixed (H4 in round 2) to return `isError: true`, but the REST path was missed.
- **Fix:** Return 502 when `providers_succeeded.length === 0` and there were failures.

---

## HIGH

### H1. Error responses missing CORS headers
- **File:** `src/worker.ts:173,194,235`
- **Votes:** 2/5 (Gemini, Codex)
- **Issue:** JSON error responses from REST init failures and MCP handler catch block bypass `add_cors_headers()`. Browser clients get opaque CORS failures on the paths where they most need error diagnostics.
- **Fix:** Wrap all error `Response.json()` calls with `add_cors_headers()`.

### H2. Fetch orchestrator "parallel" steps use `allSettled` not racing
- **File:** `src/server/fetch_orchestrator.ts:162,282`
- **Votes:** 1/5 (Codex)
- **Issue:** Parallel fetch steps wait for ALL providers via `Promise.allSettled()` before moving to the next step. Latency = slowest provider in the group, even if a good result exists.
- **Fix:** Use `Promise.any()` or first-success loop, abort losers.

### H3. Answer fanout doesn't cancel providers after deadline
- **File:** `src/server/answer_orchestrator.ts:121`
- **Votes:** 3/5 (Codex, Kimi, Opus)
- **Issue:** After `Promise.race` resolves at deadline, provider HTTP requests continue running until their individual timeouts. Wastes quota and CPU.
- **Fix:** Thread `AbortController.signal` through provider calls, abort on deadline.

### H4. `original.body!` non-null assertion
- **File:** `src/worker.ts:65`
- **Votes:** 2/5 (Opus, OpenCode)
- **Issue:** `inject_sse_keepalive` uses `!` on `original.body`. The guard on line 229 checks `response.body` first, but a defensive null check inside the function is safer.
- **Fix:** Add `if (!original.body) return original;` at top.

### H5. Duplicate web search fanout for gemini-grounded
- **File:** `src/server/answer_orchestrator.ts:80-92`
- **Votes:** 2/5 (Opus, prev round)
- **Issue:** gemini-grounded calls `run_web_search_fanout()` inside the answer fanout, doubling search API usage if user already called `web_search`.
- **Fix:** Cache recent search results or accept pre-computed results as parameter.

### H6. Explicit fetch provider path bypasses validation heuristics
- **File:** `src/server/fetch_orchestrator.ts:259,92`
- **Votes:** 1/5 (Codex)
- **Issue:** `/fetch?provider=X` bypasses `try_provider()` and `is_fetch_failure()` checks. Can return challenge pages that the normal waterfall would reject.
- **Fix:** Run explicit providers through same validation path.

---

## MEDIUM

### M1. `_initialized` guard doesn't protect concurrent `init()` calls
- **File:** `src/worker.ts:121-132`
- **Votes:** 1/5 (Opus)
- **Fix:** Use Promise-based guard: `if (!this._initPromise) this._initPromise = this._doInit(); return this._initPromise;`

### M2. `agents@^0.7.9` semver range allows breaking pre-1.0 changes
- **File:** `package.json:14`
- **Votes:** 4/5 (Opus, Codex, OpenCode, Kimi)
- **Fix:** Pin exact: `"agents": "0.7.9"`

### M3. Dual SDK versions + `@ts-expect-error`
- **File:** `src/worker.ts:108`, `package.json`
- **Votes:** 3/5 (Opus, Codex, OpenCode)
- **Fix:** Add `overrides` to pin single SDK version.

### M4. `failure.http_codes` configured but never used in fetch detection
- **File:** `src/server/fetch_orchestrator.ts:67`, `src/config/env.ts`
- **Votes:** 1/5 (Codex)
- **Fix:** Wire into `is_fetch_failure()` or delete.

### M5. `provider-info` resource has hardcoded/fabricated capabilities
- **File:** `src/server/handlers.ts:73`
- **Votes:** 2/5 (Codex, Opus)
- **Fix:** Derive from provider metadata or remove.

### M6. Failed provider timings in `run_parallel()` all use same step-level duration
- **File:** `src/server/fetch_orchestrator.ts:170`
- **Votes:** 1/5 (Codex)
- **Fix:** Timestamp each provider independently.

---

## LOW

### L1. SSE keepalive uses `event: ping` instead of spec-recommended `: comment`
- **File:** `src/worker.ts:60`
- **Votes:** 3/5 (Opus, Codex, Kimi)
- **Note:** We tried `: keepalive\n\n` — Cloudflare's proxy killed the connection because it doesn't recognize SSE comments as traffic. `event: ping\ndata: keepalive\n\n` is the necessary workaround. This is a "won't fix" due to CF infra constraints.

### L2. Optional config fields never reset on re-initialization
- **File:** `src/config/env.ts:278-308`
- **Votes:** 2/5 (Codex, Opus)

### L3. `child()` logger doesn't merge generic parent context
- **File:** `src/common/logger.ts:46`
- **Votes:** 1/5 (Codex)

### L4. Tool descriptions contain URLs that could become stale
- **File:** `src/server/tools.ts`
- **Votes:** 1/5 (OpenCode)

---

## POSITIVE — Consensus praise

| Finding | Votes |
|---------|-------|
| SSE keepalive at Worker wrapper is correct architectural layer | 5/5 |
| Defensive array copies after deadline prevent late-mutation bugs | 5/5 |
| Clean routing: REST explicit, MCP via DO, SSE wrap by content-type | 4/5 |
| Fetch waterfall with domain breakers is well-designed | 4/5 |
| RRF ranking + snippet selection pipeline | 4/5 |
| Consistent structured logging throughout | 4/5 |
| Provider registration pattern is clean and extensible | 3/5 |
| `ProviderError` hierarchy for error classification | 2/5 |
| `timing_safe_equal` for API key comparison | 2/5 |
| REST endpoints with auth, method gating, body-size limits | 2/5 |
| TypeScript compiles cleanly, `@ts-expect-error` documented | 2/5 |
