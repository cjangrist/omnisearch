# MCP `answer` tool — empty-envelope anomaly under concurrent load

**Status:** open, intermittent, ~20% reproduction rate on long technical queries when called with parallelism ≥ 3.

**Workaround:** call `answer` serially (parallelism = 1) — every query that hits the anomaly in parallel succeeds when retried alone.

---

## TL;DR for the next agent

When the deployed Cloudflare Worker's MCP `answer` tool is hit with **3 concurrent `tools/call` requests** for **long-running queries** (~70–130s server-side), roughly 2 in 10 of the slowest queries return an MCP envelope with **no `result` field** — neither a JSON-RPC `error` nor a populated `result`. The envelope is well-formed JSON-RPC 2.0; it just contains `{"jsonrpc":"2.0","id":N}` and nothing else (or `result` is set but `structuredContent` is missing).

When the same query is replayed alone, it returns a fully-populated `AnswerResult` with all 9 providers reporting. So the `run_answer_fanout` orchestrator is fine — the loss happens somewhere between the orchestrator returning and the SSE response reaching the client.

A previous test session (2026-04-24) hit the same pattern at the same rate (~23%) on a different set of long technical queries (byzantine generals + blockchain, SSRI synapse, mass spectrometer). Doubling the orchestrator's `GLOBAL_TIMEOUT_MS` from 120s → 240s did not fix it (commit `234fcc4`).

There is **also a test-script bug** that masks this anomaly as a "successful query with empty arrays" — fix that first or you will keep getting confused by the data.

---

## Symptom

### What the test reports

`tmp/answer_kimi_main_20260425T201004Z/answer_test_20260425T201004Z.md`:

```
### Q06
_Query:_ what algorithm does git use for binary diff and why
- duration: 130.8s
- answers returned: 0
- succeeded (0): —
- failed: none
- kimi: chars=0, citations=0
```

`ok=true` in the JSON, but `succeeded`, `failed`, and `answers` are all empty. Looks like a query that succeeded but returned nothing.

### What's actually happening

The MCP tool envelope returned to the client looked roughly like this:

```json
{ "jsonrpc": "2.0", "id": 2 }
```

— no `result`, no `error`, no `structuredContent`. The test client's response-parsing code (`tmp/test_answer_kimi.py:139–146`) does:

```python
result = tool_payload.get("result") or {}
structured = result.get("structuredContent") or {}
# ... silently coerces missing structuredContent to {}
succeeded = structured.get("providers_succeeded") or []
failed   = [...]
```

So `structured = {}` → `succeeded = []` → `failed = []` → reported as `ok=true` with no answers. **Test bug; treats a transport-layer failure as a successful empty result.** The error path (`if "error" in tool_payload and not structured`) only triggers when there's an explicit JSON-RPC `error`.

### Reproduction count

| Test run                      | Parallelism | Anomalies | Total | Rate |
| ----------------------------- | ----------- | --------- | ----- | ---- |
| 20260424T182358Z (prior)      | 3           | 2         | 10    | 20%  |
| 20260424T185323Z (prior)      | 3           | 1         | 3     | 33%  |
| 20260425T201004Z (this one)   | 3           | 2         | 10    | 20%  |

Pattern is consistent — call rate isn't a fluke.

---

## Reproduction

### Quick repro (any 10 long technical queries at parallelism 3)

```bash
cd /home/cjangrist/dev/omnisearch
python3 tmp/test_answer_kimi.py \
  --parallelism 3 \
  --timeout 240 \
  --queries \
    "what algorithm does git use for binary diff and why" \
    "what is the average lifespan of a tardigrade in extreme conditions" \
    "explain how a transformer attention head works using one sentence" \
    "summarize the plot of the brothers karamazov in 4 sentences" \
    "what is the half-life of cesium-137 and why does it matter for nuclear cleanup" \
    "compare a/b testing to multi-armed bandit testing in two sentences" \
    "what is the boiling point of nitrogen at standard pressure" \
    "name three exoplanets discovered in the trappist-1 system" \
    "explain the difference between mutex and semaphore in 3 sentences" \
    "who is the current ceo of intel as of 2026 and when did they take over" \
  --output-dir tmp/repro_$(date -u +%Y%m%dT%H%M%SZ)
```

Use **brand-new queries each run** — the answer endpoint has a 36-hour KV cache (`hash_key('answer:', query)`) that will short-circuit warm queries and silently mask the anomaly.

### Confirming the anomaly via raw curl

The MCP tool returns full data when called in isolation. Quick way to confirm a "broken" query is actually fine:

```bash
SESSION=$(curl -isS -X POST https://omnisearch-mcp.cjangrist.workers.dev/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"diag","version":"1"}}}' \
  --max-time 30 \
  | grep -i "mcp-session-id:" | tr -d '\r' | awk '{print $2}')

curl -sS -X POST https://omnisearch-mcp.cjangrist.workers.dev/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Mcp-Session-Id: $SESSION" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  --max-time 10 > /dev/null

# Now call the failing query — works alone:
curl -sS -X POST https://omnisearch-mcp.cjangrist.workers.dev/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Mcp-Session-Id: $SESSION" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"answer","arguments":{"query":"what is the average lifespan of a tardigrade in extreme conditions"}}}' \
  --max-time 240
```

### Confirmed yesterday (2026-04-25 ~ 20:14 UTC):

| Query                         | In parallel batch | Standalone curl |
| ----------------------------- | ----------------- | --------------- |
| Q06 (git binary diff)         | empty envelope    | 8/9 providers (kimi 524) |
| Q09 (tardigrade lifespan)     | empty envelope    | 9/9 providers   |

Both queries return real data when retried alone. The anomaly is purely concurrency-induced.

---

## Architecture context

### Endpoint topology

- **Worker:** `omnisearch-mcp.cjangrist.workers.dev` (no auth required — see `project_public_endpoint_no_auth.md` memory)
- **MCP route:** `POST /mcp` → delegated to a Durable Object (`OmnisearchMCP` extends `McpAgent` from `agents@^0.7.9`)
- **Per-session DO:** each MCP `initialize` mints a fresh session ID → fresh DO instance. The test script opens a new session per query, so 3 concurrent queries = 3 distinct DOs.
- **Transport:** MCP Streamable HTTP. Server uses SSE (`text/event-stream`) for tool-call responses to allow keepalive injection during long fanouts.
- **Custom SSE keepalive** (`src/worker.ts:55–171`): wraps the DO's response stream, injects `event: ping` every 5s between complete SSE events. This was added to defeat Claude web's 45s connection-idle timeout during the 4-min answer fanout.

### Answer fanout

`src/server/answer_orchestrator.ts`:
- `run_answer_fanout(...)` → `execute_tasks(tasks, abort_controller)`
- `GLOBAL_TIMEOUT_MS = 240_000` (4 min — was 120s, doubled in `234fcc4`)
- `PROGRESS_INTERVAL_MS = 5_000` (debug logging)
- 9 providers fanned out in parallel: chatgpt, claude, exa_answer, gemini, gemini-grounded, kagi_fastgpt, kimi, perplexity, tavily_answer
- Deadline race: `Promise.race([Promise.all(tracked).then('all_done'), deadline.then('deadline')])`. If deadline fires, sets `is_done = true` and any pending providers get pushed to `failed` with `error: "Timed out (global deadline)"`.
- KV cache write only happens if `result.answers.length > 0` (line ~315), so empty results don't pollute future queries.

### What's NOT the cause

- **KV cache stale empty record** — ruled out: cache writes are gated on `answers.length > 0`. Verified by re-running the same exact query immediately after an anomaly and seeing real data (cache should hit if it was written, doesn't).
- **Orchestrator deadline misfire** — ruled out: Q09 anomaly took 68.7s, well under 240s. Also `failed` would be populated with timeout entries if deadline fired.
- **kimi-specific issue** — ruled out: same anomaly affects all providers identically. Q09 alone returns 9/9 providers including kimi.
- **Worker initialization race** — ruled out: anomaly happens long after the DO is initialized and serving fast queries.
- **CPU time limit at 30s** — likely not the cause: Workers measure CPU time, not wall time. Fanout is mostly waiting on subrequests. But worth verifying.

---

## Hypotheses (ranked)

### H1 — `agents` package SSE transport drops late writes under concurrent load (most likely)

The `agents@0.7.9` package implements MCP via DO + SSE, where:
- Each tool call response is serialized over the per-session SSE stream
- We wrap the response with our own SSE-keepalive `TransformStream` (`src/worker.ts:64`)

Under concurrent load (3 in-flight DOs, each holding a long tool call), one of:
- The DO's response writer races our `TransformStream` injector (we have a `write_lock` but it's per-stream, not cross-stream)
- The agents package returns the tool result via WebSocket→SSE bridge mid-write and gets cut off
- The DO scheduler suspends one DO during a long-running fanout and the response stream gets closed before the final `tools/call` reply lands

**Test:** disable the SSE keepalive injection (return `mcp_handler.fetch(...)` directly without `inject_sse_keepalive`) and re-run the parallel test. If the anomaly disappears, the keepalive wrapper is implicated.

### H2 — Cloudflare Workers subrequest budget exhaustion (plausible)

Workers cap **total subrequests per request at 50** (Free) or **1000** (Paid). The answer fanout makes 9 provider calls; gemini-grounded internally fans out to additional web-search providers (~10 more subrequests). Per-DO that's ~20 subrequests. Across 3 concurrent DOs that's ~60.

Workers also cap **simultaneous outbound connections to ~6 per origin**. With 9 providers all hitting different origins this is fine, but a slow provider could block the SSE writer if there's contention on the same TLS connection pool.

**Test:** check Cloudflare dashboard → Workers → Logs for the specific anomaly request IDs — look for `Worker exceeded resource limits` or `Too many subrequests` errors.

### H3 — `ctx.waitUntil` outliving the response (plausible)

The orchestrator uses `trace.flush_background(result)` and KV cache writes to extend work past the response. If the DO's `ctx.waitUntil` budget runs out OR the DO is recycled mid-flight, the tool response can be truncated.

The `trace.flush_background()` writes to R2 (`set_trace_r2_bucket`). On long fanouts (130s) the trace payload can be large.

**Test:** disable R2 trace writes (`set_trace_r2_bucket(undefined)` or comment out `flush_background`). Re-run parallel test.

### H4 — `agents` package version mismatch with MCP SDK (less likely)

`package.json` pins `agents: "^0.7.9"` and `@modelcontextprotocol/sdk: "^1.27.1"`. The `agents` package internally bundles SDK 1.26.0 — there's a `@ts-expect-error` annotation in `worker.ts:180` acknowledging this. If 1.26 vs 1.27 disagree on response shape under concurrent edges, the wire format could differ.

**Test:** pin `agents` to the latest version and rebuild.

### H5 — Cloudflare D1 / DO storage write contention (unlikely)

The DO doesn't use storage in this codebase, but `McpAgent` may internally persist session state to DO storage (sqlite). Under parallel load with 3 DOs, storage writes could serialize. But this should affect throughput, not response correctness.

---

## What's been ruled out

1. **kimi-specific bug** — anomaly predates the kimi answer provider (prior session hit it on chatgpt/claude/gemini/perplexity/exa identically).
2. **Cache pollution** — KV writes gated on non-empty results.
3. **Orchestrator deadline** — anomaly hits queries well under 240s.
4. **Test client bug** — confirmed real: standalone curl reproduces the empty envelope when 3 DOs are concurrent. (But the test client also has a separate masking bug that hides this.)
5. **Auth/CORS** — endpoint is unauthenticated; CORS preflight is correct.
6. **Provider configuration** — same providers succeed on every other query.

---

## Suggested debugging plan

1. **Fix the test masking** — patch `tmp/test_answer_kimi.py` so `result is None or 'structuredContent' not in result` returns `ok=False` with a useful error. Without this you can't tell at a glance which queries hit the anomaly vs which actually returned an empty fanout.

2. **Capture raw responses** — extend the test to save each query's raw response body (`response.text`) alongside the parsed result. A 5-line addition.

3. **Reproduce, capture raw, classify** — run `parallelism=3` against 20 fresh long queries. For every "empty" result, dump:
   - Full response text
   - Response headers (especially `cf-ray`, `x-log-id`)
   - All SSE events received (vs just the first/last)

4. **Cross-reference with Worker logs** — using `cf-ray` from the failing requests, grep `wrangler tail` output (or Cloudflare dashboard logs) for any `Worker exceeded resource limits`, subrequest errors, or DO termination events.

5. **Run isolation tests on the H1/H2/H3 hypotheses** in order. Each is a 1-line change + redeploy + re-run.

6. **Consider serial mode as a workaround** — if no fix is forthcoming, set `PROGRESS_INTERVAL_MS` higher and document parallelism=1 as the supported mode in the test script. The MCP server is designed for one-call-at-a-time use anyway.

---

## Files & line numbers to inspect

- `src/worker.ts:55–171` — SSE keepalive injection (H1 suspect)
- `src/worker.ts:179–213` — `OmnisearchMCP` Durable Object
- `src/worker.ts:237–244` — `mcp_handler` setup
- `src/worker.ts:358–390` — `/mcp` request delegation
- `src/server/answer_orchestrator.ts` — full fanout, especially:
  - `:117–236` — `execute_tasks` (deadline race, late-write guard)
  - `:238–327` — `run_answer_fanout` (KV cache + trace flushing)
- `src/server/tools.ts:125–245` — `register_answer_tool` (MCP tool registration, response shape)
- `src/common/r2_trace.ts` — `flush_background` (waitUntil budget candidate)
- `tmp/test_answer_kimi.py:120–190` — test parsing (the masking bug)

---

## Key data files (full paths)

- **This investigation doc:** `/home/cjangrist/dev/omnisearch/docs/mcp-empty-payload-anomaly.md`
- **Latest test reports (this session):**
  - `/home/cjangrist/dev/omnisearch/tmp/answer_kimi_main_20260425T201004Z/answer_test_20260425T201004Z.json`
  - `/home/cjangrist/dev/omnisearch/tmp/answer_kimi_main_20260425T201004Z/answer_test_20260425T201004Z.md`
- **Prior session test reports (previous identical anomalies):**
  - `/home/cjangrist/dev/omnisearch/tmp/answer_test_20260424T182358Z.json`
  - `/home/cjangrist/dev/omnisearch/tmp/answer_test_20260424T182358Z.md`
  - `/home/cjangrist/dev/omnisearch/tmp/answer_test_20260424T185323Z.json`
  - `/home/cjangrist/dev/omnisearch/tmp/answer_test_20260424T185323Z.md`
- **Test script:** `/home/cjangrist/dev/omnisearch/tmp/test_answer_kimi.py`
- **Prior kimi-answer investigation (parallel-load issue first observed):** `/home/cjangrist/dev/omnisearch/docs/kimi-answer-provider-investigation.md` (only on `z-ai-01` branch — not yet on main)

---

## Concurrency timeline of the failing run

For the 20260425T201004Z test (parallelism=3, total elapsed 220s):

```
t=0      t=63   t=71  t=79.7 t=93.6 t=106 t=150  t=182 t=210  t=218  t=220
| Q01 ──────────────●                                              (71s) ✓
| Q02 ──────────●                                                  (63s) ✓
| Q03 ───────────────────●                                       (79.7s) ✓
|             Q04 ────────────●                                  (30.6s) ✓
|                  Q05 ─────────────●                            (35.4s) ✓
|                       Q06 ─────────────────────────────────●  (130.8s) ◯ EMPTY
|                              Q07 ──────────────────●           (56.4s) ✓
|                                    Q08 ────────────────────●   (75.7s) ✓
|                                              Q09 ──────────●   (68.7s) ◯ EMPTY
|                                                       Q10 ───●  (38.0s) ✓
```

Q06 and Q09 both ran during peak overlap. Q06 was the longest-running query in the batch and overlapped with 4 other queries during its lifetime. Q09 ran during the highest-pressure window (Q06 + Q08 also in flight).

The shortest queries (Q04 30s, Q05 35s, Q10 38s) and queries from the initial batch (Q01, Q02, Q03 — only 3 in flight initially) all succeeded. The anomaly correlates with **(long duration) × (concurrent overlap with other long queries)**.

---

## Hand-off context for the new agent

You're picking up from another agent that:

1. Added the kimi answer provider to `main` (commit `34311b7`) and verified it works (8/8 returned queries showed kimi at 100% success rate).
2. Identified the empty-payload anomaly as a real, reproducible, parallel-load issue independent of kimi.
3. Did NOT root-cause the anomaly — only ruled out the obvious candidates.

**Backup branch with extra context:** `z-ai-01` contains the prior kimi investigation doc (`docs/kimi-answer-provider-investigation.md`) and a now-shelved z.ai search provider integration. Worth a `git diff main..z-ai-01 -- docs/` to see prior notes.

**Memories worth reading first:**
- `/home/cjangrist/.claude/projects/-home-cjangrist-dev-omnisearch/memory/MEMORY.md` (index)
- `/home/cjangrist/.claude/projects/-home-cjangrist-dev-omnisearch/memory/project_public_endpoint_no_auth.md` (no API key needed for the deployed worker)

**Don't:**
- Trust the test's `ok=true` flag without checking `answers_count > 0` — the script has the masking bug described above.
- Re-run the same queries without changing them — the answer endpoint caches successful results for 36h.
- Assume the anomaly is provider-specific. It affects every provider identically.

**Do:**
- Patch the test masking bug first.
- Capture raw response bodies on the next repro.
- Test H1 (SSE keepalive disabled) before H2/H3 — it's a 1-line change and the most likely culprit.
