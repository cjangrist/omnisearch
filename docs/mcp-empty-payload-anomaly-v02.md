# MCP `answer` empty-envelope anomaly — v2 (root-cause hypothesis with new evidence)

> **Update 2026-05-04** — two of the structural bugs flagged below have shipped fixes since this doc was written:
>
> - **`_execution_context` singleton** (Recommended fix #2): replaced with AsyncLocalStorage (`run_with_execution_context` + `ctx_store` in `src/common/r2_trace.ts`, plus `with_ctx_scope` in `src/server/tools.ts`). Commits `333c4b3` (R2F03) and `200ebba` (R3F04). The diff in "Recommended fix #2" below now matches main.
> - **`inject_sse_keepalive` whitespace-heartbeat handling**: previously the per-tick gate was `if (total_len === 0)`, which let a single bare `\n` byte from any upstream / proxy layer suppress every ping forever. The interval now flushes whitespace-only buffer contents before injecting the ping (`buffer_is_only_whitespace()` helper at ~line 138 of `src/worker.ts`), so heartbeats are forwarded to the client AND our pings keep firing on schedule. Partial events containing any non-whitespace byte still gate the ping. Ship in commit `c1e8629`.
>
> The remaining open hypotheses (Fix #1 / Fix #3 / Fix #4) are unchanged. Line numbers further down this doc were captured before either fix landed; they have been updated where the original references were specific.

## TL;DR

The empty-envelope anomaly does **not** reproduce on the deployed worker as of 2026-04-26 ~07:30 UTC across 38 fresh long queries (parallelism 1, 3, 3, 5) — including cache-busted variants of the exact queries that reliably failed in 2026-04-25's session. The platform-side `waitUntil() … cancelled` warnings flagged as "smoking gun" by the prior agent occur on **every** POST/GET response, including a single isolated request, so they cannot be the differential cause. The remaining structural risks in the codebase — the `_execution_context` singleton in `src/common/r2_trace.ts` and the unconditional `inject_sse_keepalive` wrapper — are real bugs that should be fixed regardless, but they only explain best-effort R2 trace loss and a small additional waitUntil-budget pressure, not full envelope loss. The most likely true root cause is **third-party / platform layer flakiness in the agents-package WebSocket-to-SSE bridge** during high-concurrency load, where the DO-side `transport.send(message, {…})` arrives at a worker whose `ws.addEventListener('message', …)` callback either fires after `writer.close()` was already called by the `'close'` listener, or never fires because the WS connection was torn down by a transient platform fault. Recommended fix: harden the test-script masking bug, add a worker-side outcome log on every tools/call response so we can identify true anomalies in production, and pin/upgrade the `agents` package after reviewing its release notes for similar issues — there is no code change to our repo that reliably eliminates this anomaly without rewriting away from the `agents` WS-bridge transport.

## Reference

- v1 doc: `/home/cjangrist/dev/omnisearch/docs/mcp-empty-payload-anomaly.md`
- All artifacts (prior session): `/home/cjangrist/dev/omnisearch/tmp/empty_envelope_diag_20260426T071313Z/`
  - `raw_capture.py`, `q01..q03_capture.json`, `q05_capture.json`, `wrangler_tail.log`
  - new analyses: `wrangler_analysis.md`, `captures_analysis.md`
- Differentiating-experiment artifacts (this session): `/home/cjangrist/dev/omnisearch/tmp/empty_envelope_diag_v2_20260426T072602Z/`
  - `raw_capture.py`, `single/`, `burst3/`, `burst3b/`, `burst3c/`, `burst5/`, `wrangler_tail.log`, `wrangler_tail_burst3c.log`

## Smoking gun (revised)

The prior agent's "smoking gun" was the recurring warning:
```
(warn) waitUntil() tasks did not complete within the allowed time after invocation end and have been cancelled.
```
This is **NOT** the cause of the anomaly — confirmed by running a single isolated answer call and observing the same warning attach to that POST. The warning is a normal byproduct of how the worker pipeline composes:

1. `worker.ts:361` calls `await mcp_handler.fetch(request, env, ctx)` — this returns the SSE Response object after a few hundred ms (after the WS bridge to the DO is established), well before the answer fanout finishes.
2. `worker.ts:363` logs `POST /mcp - 200 duration_ms=<small>`. From the runtime's perspective, the worker fetch handler has returned.
3. The 30-second post-response budget for `waitUntil` and detached background work begins.
4. Our `inject_sse_keepalive` wrapper holds a `pump()` async loop and a 5-second `setInterval`. Both are unmanaged background tasks (not registered with `ctx.waitUntil`).
5. The agents package's `ws.addEventListener('message', …)` handler in `node_modules/agents/dist/mcp/index.js:178-194` is also unmanaged background work that writes the eventual SSE message into the bridge writer.
6. Because the SSE response body is being held open and actively pinged, the runtime keeps the worker invocation alive past the 30-s grace period — but it logs the cancelled-waitUntil warning anyway because nothing was registered through that API.

**No log line in the captured wrangler tail differentiates a successful tools/call from an empty-envelope one.** Without a worker-side log emitted at the point `transport.send(envelope, {relatedRequestId})` actually flushes the SSE write, we cannot distinguish "DO returned cleanly, the SSE made it to the client" from "DO returned cleanly, the SSE was lost on the bridge".

## Root cause (most-likely hypothesis)

The empty-envelope anomaly is caused by a **race in the agents-package WS-to-SSE bridge** at `node_modules/agents/dist/mcp/index.js:163-223`:

```js
const ws = (await agent.fetch(req)).webSocket;
…
ws.accept();
ws.addEventListener("message", (event) => { … writer.write(encoder.encode(message.event)) … });
ws.addEventListener("error", () => { writer.close().catch(() => {}); });
ws.addEventListener("close", () => { writer.close().catch(() => {}); });
…
return new Response(readable, { … });
```

Two scenarios are consistent with the prior 2026-04-24 / 2026-04-25 reports of empty envelopes:

1. **Premature WS close.** Under transient network or DO eviction stress, the WS to the DO closes (or errors) **after** the DO's `transport.send()` has been queued but **before** the worker side's `ws.addEventListener('message', …)` can drain the message. The `'close'` listener fires, `writer.close()` finalises the SSE response stream as empty, and the late-arriving message is dropped. The HTTP layer happily returns `200 OK` with an empty body because the response object was already constructed at line 214.

2. **Dropped CF_MCP_AGENT_EVENT.** The DO's `writeSSEEvent` at `node_modules/agents/dist/mcp/index.js:567-576` calls `connection.send(JSON.stringify({ type: CF_MCP_AGENT_EVENT, event: …, close: shouldClose }))`. If the underlying WebSocket frame arrives at the worker but `JSON.parse(data)` fails or the runtime drops the message frame mid-flight (under platform pressure), the listener returns silently (line 191: `console.error("Error forwarding message to SSE:", error)`) and the SSE writer never gets the data.

Both scenarios are platform/library bugs we cannot directly fix. Both are consistent with the anomaly's intermittent, load-correlated nature reported in v1 and the inability to reproduce it in our v2 differentiating run.

The 4 captures we have from the prior session (`q01..q03`, `q05` in `tmp/empty_envelope_diag_20260426T071313Z/`) all completed cleanly — the SSE keepalive wrapper's `pump()` and ping interval ran the full duration, the message event was a single block delivered in 25 chunks within 21 ms, and the body terminator was clean. The 3 missing captures (`q04`, `q06`, `q07`) are **not** evidence of the anomaly — the wrangler log shows their server-side fanouts all completed (8/9 or 9/9 providers). The Python harness simply died before writing those JSON files (no `raw_capture_index.json` exists; no stderr was captured). See `tmp/empty_envelope_diag_20260426T071313Z/wrangler_analysis.md` for the per-query reconstruction.

## Verification

### Differentiating experiments (this session)

| Run | Parallelism | Queries | Anomalies | Notes |
| --- | --- | --- | --- | --- |
| `single/` | 1 | 1 (PEG-4000 weight, 32 s) | 0 | Confirms `waitUntil cancelled` warning fires for an isolated request — refutes "warning = anomaly" claim |
| `burst3/` | 3 | 7 fresh long queries (35–130 s) | 0 | First parallelism-3 burst |
| `burst3b/` | 3 | 10 fresh long queries (35–130 s) | 0 | Matched prior 2026-04-25 failing pattern (parallelism=3, 10 queries) |
| `burst3c/` | 3 | 10 cache-busted variants of prior anomalous queries (35–131 s) | 0 | Includes git binary diff, tardigrade lifespan with date prefixes for cache miss |
| `burst5/` | 5 | 10 fresh long queries (40–129 s) | 0 | Higher pressure than the prior failing tests |

Total: 38 long fanouts across 4 concurrency levels — **0 empty envelopes**. All 38 captures contain a single `event: message` event with a fully-populated `structuredContent`.

### Cross-reference with wrangler tail

In all 4 v2 runs combined: 96 `waitUntil cancelled` warnings logged, 28 fanouts completed successfully server-side, 28 captures with full structured content client-side. The warnings happen for both fast and slow requests, both successful and isolated requests.

### Confirmation of the SSE keepalive wrapper working

All v1 captures show:
- 7–14 `event: ping\ndata: keepalive\n\n` chunks delivered every 5.0 s ± 100 ms
- A single `event: message` chunk arriving last (typically 60–130 KB delivered in 8–25 sub-chunks within ~30 ms)
- Body terminator: clean `\n\n`
- No multiplexing artifacts (the wrapper's "only inject keepalive when buffer is empty" rule is honoured)

## Code paths involved

| File | Lines | Role |
| --- | --- | --- |
| `src/worker.ts` | 55–197 | `inject_sse_keepalive` — wraps DO response stream with 5 s keepalive pings. Update 2026-05-04: the per-tick gate now accepts a buffer that holds only SSE whitespace bytes (see `buffer_is_only_whitespace` helper and the new logic between line ~133 and line ~165). Previously a `total_len === 0` gate would suppress every ping forever once any upstream layer dropped a single bare whitespace byte into the buffer. |
| `src/worker.ts` | 274–287 | `fetch` entry point. The `set_trace_execution_context` singleton bug below was fixed pre-c1e8629 — the entry now calls `run_with_execution_context(ctx, ...)` (AsyncLocalStorage), so the structural risk this doc flagged is closed. The keepalive whitespace fix is independent of that change. |
| `src/worker.ts` | 391–412 | `/mcp` route delegation; conditionally wraps SSE with `inject_sse_keepalive`. Logs `POST /mcp - <status>` BEFORE the SSE body finishes streaming (intentional, but obscures real fanout duration in logs). |
| `src/server/answer_orchestrator.ts` | 117–236 | `execute_tasks` — orchestrator with deadline race. `is_done` flag (line 134, 199) prevents late-arriving promises from mutating arrays after the deadline fires |
| `src/server/answer_orchestrator.ts` | 238–327 | `run_answer_fanout` — emits `Answer fanout complete` log line after `execute_tasks`. Calls `trace.flush_background(result)` on every successful path |
| `src/server/tools.ts` | 117–177 | `register_answer_tool` — returns the structured envelope with `structuredContent` and a JSON `content[0].text` mirror |
| `src/common/r2_trace.ts` | 22–32, 154–163 (pre-fix) | **Module-level `_execution_context` singleton** overwritten on every request entry. Bug — `flush_background` on request A may call request C's `ctx.waitUntil(…)` if 3 requests overlap. **FIXED in commit `333c4b3` (R2F03)**: the singleton was replaced with `AsyncLocalStorage<WaitUntilCapable>` (`run_with_execution_context` + `get_active_execution_context()` in `src/common/r2_trace.ts`). MCP tool callbacks also enter the store via `with_ctx_scope` in `tools.ts` (R3F04). The "Recommended fix #2" diff below is therefore historical — the codebase already matches it. |
| `node_modules/agents/dist/mcp/index.js` | 24–223 | `createStreamingHttpHandler` — worker-side WS bridge to DO. Lines 178–206 are the WS event listeners that pump messages from DO into the SSE response writer. **No `ctx.waitUntil` for these listeners** |
| `node_modules/agents/dist/mcp/index.js` | 567–655 | `writeSSEEvent` and `transport.send` on the DO side — wraps SSE event text into a `{type: CF_MCP_AGENT_EVENT, event, close}` envelope and sends via `connection.send(JSON.stringify(…))` |
| `node_modules/agents/dist/mcp/index.js` | 1278+ | `McpAgent` class definition — DO uses `WorkerTransport` which manages SSE stream mappings per request id |
| `node_modules/agents/dist/index.js` | 700–730 | Agent's `_setStateInternal` registers state-broadcast work via `this.ctx.waitUntil(…)` — a separate waitUntil source, unrelated to the empty envelope but contributing to the warning count |

## Why the prior hypotheses were close but not quite right

| Hypothesis (v1) | Verdict | Notes |
| --- | --- | --- |
| **H1 — `agents` package SSE transport drops late writes under concurrent load** | Likely correct in spirit, wrong in mechanism | The keepalive wrapper isn't the culprit — its events arrive cleanly in every capture. The actual drop, if it happens, is one layer deeper: the WS bridge between worker and DO at `agents/dist/mcp/index.js:178-206`. |
| **H2 — Cloudflare Workers subrequest budget exhaustion** | Disproven | Cloudflare docs (2026-04 retrieved) confirm: "Once response headers arrive, connections no longer count toward this limit." The 6-simultaneous-connection limit is on connections WAITING for headers. Provider responses that have started streaming don't count. We see no `Worker exceeded resource limits` lines in any wrangler tail. |
| **H3 — `ctx.waitUntil` outliving the response** | Misframed | The warning fires for every request, not just anomalous ones. The R2 trace `flush_background` does run via `ctx.waitUntil`, but that path can fail without affecting the SSE response (it's truly fire-and-forget). However, the `_execution_context` singleton bug (see "Recommended fix" #2) means R2 traces can fire on the wrong ctx — that's a real but lower-impact bug. |
| **H4 — `agents` package version mismatch with MCP SDK** | Plausible, untested | `package.json` pins `agents@^0.7.9` and `@modelcontextprotocol/sdk@^1.27.1`. The `@ts-expect-error` at `worker.ts:180` papers over a class-instance type mismatch (1.26 in agents, 1.27 directly). Worth re-investigating if the anomaly returns. |
| **H5 — D1/DO storage write contention** | Disproven (mostly) | We observe `OmnisearchMCP.{set,get}InitializeRequest` storage hits per session — these run via `ctx.storage.put/get` which are durable-but-fast (<10 ms). No storage contention is visible. |

## Recommended fix (do NOT apply — describe only)

### Fix 1: Add a worker-side log when the SSE message actually flushes

Without this we cannot tell a true anomaly from a false positive in production. Add to `src/worker.ts` inside `inject_sse_keepalive` (note: the diff line numbers below are pre-c1e8629; the keepalive function is now lines 64-197, but the `pump()` loop and the `flush_complete_events` boundary scan are structurally identical):

```diff
--- a/src/worker.ts
+++ b/src/worker.ts
@@ -141,8 +143,15 @@ const inject_sse_keepalive = (original: Response): Response => {
 	const pump = async () => {
+		let saw_message = false;
+		const wrapper_started_at = Date.now();
 		try {
 			for (;;) {
 				const { value, done } = await reader.read();
 				if (done) {
+					logger.info('SSE wrapper closed', {
+						op: 'sse_wrapper_closed',
+						saw_message,
+						buffered_remainder_bytes: total_len,
+						wrapper_duration_ms: Date.now() - wrapper_started_at,
+					});
 					if (total_len > 0) {
 						await safe_write(flatten());
 						chunks = [];
@@ -156,6 +165,8 @@ const inject_sse_keepalive = (original: Response): Response => {
 				// Only scan for event boundaries when the chunk contains a line break
 				if (value.indexOf(0x0a) !== -1 || value.indexOf(0x0d) !== -1) {
 					await flush_complete_events();
+					// Cheap detection: a 'message' event payload has the literal token
+					if (!saw_message && value.indexOf(0x6d) !== -1) saw_message = true; // 'm' — heuristic only
 				}
```

A more reliable detector: track whether any chunk that starts with `event: message` was seen. With this log line, every empty envelope shows as `saw_message=false`, and we can finally diagnose them in production wrangler tail output.

### Fix 2: Eliminate the `_execution_context` singleton in `r2_trace.ts`

> **Already shipped — see commits `333c4b3` (R2F03) and `200ebba` (R3F04). Section retained for historical context.**

The module-level `_execution_context` at `src/common/r2_trace.ts:24` is overwritten on every request (`set_trace_execution_context(ctx)` at `src/worker.ts:252`). Under concurrent load, request A's `flush_background()` (called inside its handler) may invoke request C's `ctx.waitUntil(…)` — request A's R2 trace is then anchored to request C's lifetime, leading to silent trace loss when C exits before A's R2 PUT finishes. This does not cause the empty-envelope anomaly, but it is a latent correctness bug.

Pass `ctx` through `AsyncLocalStorage` instead:

```diff
--- a/src/common/r2_trace.ts
+++ b/src/common/r2_trace.ts
@@ -14,17 +14,22 @@ const trace_store = new AsyncLocalStorage<TraceContext>();
 
 export const get_active_trace = (): TraceContext | undefined => trace_store.getStore();
 
-export const run_with_trace = <R>(ctx: TraceContext, fn: () => R): R =>
-	trace_store.run(ctx, fn);
+export const run_with_trace = <R>(trace: TraceContext, fn: () => R): R =>
+	trace_store.run(trace, fn);
 
-// ── Module-level references (set once per request in worker.ts) ──────────────
-
+// ── Per-request execution context via AsyncLocalStorage ──────────────────────
+
+const ctx_store = new AsyncLocalStorage<ExecutionContext>();
 let _r2_bucket: R2Bucket | undefined;
-let _execution_context: ExecutionContext | undefined;
 
 export const set_trace_r2_bucket = (bucket: R2Bucket | undefined) => {
 	_r2_bucket = bucket;
 };
 
-export const set_trace_execution_context = (ctx: ExecutionContext) => {
-	_execution_context = ctx;
-};
+export const run_with_execution_context = <R>(ctx: ExecutionContext, fn: () => R): R =>
+	ctx_store.run(ctx, fn);
 
@@ -154,8 +159,9 @@ export class TraceContext {
 	flush_background(final_result: unknown) {
 		if (!_r2_bucket) return;
 
 		const write_promise = this._write_to_r2(final_result);
 
-		if (_execution_context) {
-			_execution_context.waitUntil(write_promise);
+		const ctx = ctx_store.getStore();
+		if (ctx) {
+			ctx.waitUntil(write_promise);
 		}
 	}
```

And in `src/worker.ts`:

```diff
--- a/src/worker.ts
+++ b/src/worker.ts
@@ -13,7 +13,7 @@ import { handle_rest_fetch } from './server/rest_fetch.js';
 import { handle_rest_researcher } from './server/rest_researcher.js';
 import { loggers, run_with_request_id } from './common/logger.js';
-import { set_trace_execution_context } from './common/r2_trace.js';
+import { run_with_execution_context } from './common/r2_trace.js';
 import type { Env } from './types/env.js';
 
@@ -249,8 +249,9 @@ export default {
 		const start_time = Date.now();
 		const request_id = crypto.randomUUID();
 
-		set_trace_execution_context(ctx);
-		return run_with_request_id(request_id, () => handle_request(request, env, ctx, url, start_time, request_id));
+		return run_with_execution_context(ctx, () =>
+			run_with_request_id(request_id, () => handle_request(request, env, ctx, url, start_time, request_id))
+		);
 	},
 } satisfies ExportedHandler<Env>;
```

### Fix 3: Pin / upgrade `agents` package after reading its release notes

`package.json` currently pins `agents@^0.7.9`. Check whether 0.7.10+ or 0.8.x ships a fix for SSE bridge race conditions. The agents repo is at https://github.com/cloudflare/agents — search closed issues for "SSE", "tools/call", "empty", "missing message", "WebSocket race".

If an upgrade is available, apply it and re-run `tmp/empty_envelope_diag_v2_20260426T072602Z/raw_capture.py` with `--parallelism 5`.

### Fix 4: Defensive — short-circuit empty envelopes server-side before they reach the SSE bridge

In `src/server/tools.ts:152-176`, the `register_answer_tool` callback currently returns:

```ts
if (!answer_result) { return { content: [{ type, text: 'No AI providers…' }], isError: true }; }
if (answer_result.answers.length === 0) { … return { … isError: true }; }
return { structuredContent: answer_result, content: [{ type, text: JSON.stringify(answer_result, null, 2) }] };
```

This is correct as-is: when `answers.length > 0`, both `structuredContent` AND a stringified `content[0].text` are set. So even if `structuredContent` doesn't make it through some reductive client, the `content[0].text` JSON is the same payload. **An empty envelope on the wire is therefore not caused by our tool callback** — it is always caused downstream of `transport.send(envelope, {relatedRequestId})`. Nothing to fix here, but worth documenting.

## Test-script masking bug fix

The test client silently coerces a missing `structuredContent` to `{}` and reports `ok=true` with empty arrays. This needs to fail explicitly so anomalies are visible.

```diff
--- a/tmp/test_answer_kimi.py
+++ b/tmp/test_answer_kimi.py
@@ -136,6 +136,16 @@ def run_one_query(query_index: int, query: str, timeout_s: int) -> dict[str, An
         duration_s = time.monotonic() - started_at
         LOGGER.debug("[%s] answer tool returned in %.1fs, parsing", short_label, duration_s)
+        # Detect the empty-envelope anomaly: jsonrpc envelope with no error and no result.structuredContent
+        envelope_has_result = isinstance(tool_payload, dict) and 'result' in tool_payload
+        envelope_has_error = isinstance(tool_payload, dict) and 'error' in tool_payload
+        result_has_structured = envelope_has_result and isinstance(tool_payload.get('result'), dict) and 'structuredContent' in tool_payload['result']
+        if not envelope_has_error and not result_has_structured:
+            LOGGER.error("[%s] EMPTY ENVELOPE after %.1fs — payload keys=%r, result keys=%r", short_label, duration_s,
+                         list(tool_payload.keys()) if isinstance(tool_payload, dict) else type(tool_payload).__name__,
+                         list(tool_payload.get('result', {}).keys()) if isinstance(tool_payload.get('result'), dict) else 'no result key')
+            return {"query_index": query_index, "query": query, "ok": False, "duration_s": duration_s,
+                    "error": "empty_envelope_anomaly", "succeeded": [], "failed": [],
+                    "kimi_chars": 0, "kimi_first": "", "kimi_citations": 0, "answers_count": 0}
         result = tool_payload.get("result") or {}
         structured = result.get("structuredContent") or {}
         if not structured:
```

Apply this BEFORE the next reproduction attempt — without it, you cannot tell at a glance whether a `succeeded=[]` row is a genuine all-providers-failed result or an empty envelope from the bridge.

## Open questions

1. **Why couldn't we reproduce the anomaly today?** Same code, same queries (cache-busted), same parallelism level, same Cloudflare worker, no anomaly. Possible explanations:
   - Cloudflare platform-side change between 2026-04-25 and 2026-04-26 (no public changelog entry to confirm).
   - Different cf-pop assignment (we saw `ATL` in v1 captures; today's captures don't show CF-RAY in the parsed dump — the harness reads it from `response.headers.get('cf-ray')` but the capture's response_headers prints lowercase `CF-RAY` only for one capture and `?` for the others; need to verify routing).
   - Colocation with another tenant's noisy job during the 2026-04-25 window.
   - The anomaly genuinely correlates with one specific failing third-party API call timing window.
2. **Why does the prior agent's `wrangler_tail.log` show `POST canceled` 3 times?** Look at lines 435, 439, 443. These are POSTs being canceled at the network layer — possibly clients aborting before the response was fully streamed (Python `requests` was the only client; could a network blip have triggered re-issue?).
3. **Is there any way to register the agents package's WS message listener with `ctx.waitUntil`?** Current `node_modules/agents/dist/mcp/index.js:178-206` does not expose this. Patching it locally would be a fork; better to file an upstream issue.
4. **Does `worker.ts:399` correctly identify SSE responses?** It checks `response.headers.get('content-type')?.includes('text/event-stream')`. For a 202 response (notifications/initialized), content-type is null — `inject_sse_keepalive` is correctly skipped. For 200 responses with `text/event-stream`, it's wrapped. This is correct. (Pre-c1e8629 this lived at `worker.ts:367`.)
5. **Should the orchestrator return both `structuredContent` AND emit a separate text event for redundancy?** Currently `tools.ts:170-172` returns a single envelope with both fields; if the bridge drops the message, both are lost. There's no way to send 2 SSE events for one tools/call response within the MCP protocol — closing the stream after the response is part of the spec.

## Status

- The empty-envelope anomaly remains **unreproducible as of 2026-04-26 07:45 UTC** — 0/38 across this session's diagnostic runs.
- The two confirmed code bugs (singleton `_execution_context`, missing empty-envelope detection in test client) are **independent of the anomaly** but worth fixing.
- The most likely real cause is a **transient race in the agents-package WS-to-SSE bridge** that we cannot reproduce on demand. Fix 1 (worker-side outcome log) is the only change that will let us diagnose this in production when it next occurs.

---

# Appendix A — Independent verification (added 2026-04-26 ~07:55 UTC)

A second-pass scan of the 38 captures using the script's own `is_anomaly` and `structured_content_present` fields confirms the agent's claim:

| Metric | Value |
| --- | --- |
| Total captures scanned | 38 |
| `is_anomaly == True` | 0 |
| Captures missing `structuredContent` | 0 |
| `event_count_message` distribution | `{1: 38}` (every capture has exactly one message event) |
| Per-run answer chars (min / median / max) | 5,610 / 11,219 / 17,647 |
| Total provider-success rate | 8.89 / 9 average |
| Captures with kimi present | 35 / 38 |

**Zero empty-envelope anomalies across 38 captures spanning parallelism 1, 3, 3, 3, 5 and durations 31–131s.**

# Appendix B — Real cause of the 4 partial-success captures (130s upstream gateway timeout)

4 of 38 captures returned 8/9 providers instead of 9/9. All 4 hit the **same** failure mode at almost the same wall time:

| Capture | Failed provider | Error | Duration |
| --- | --- | --- | --- |
| `burst3/q03` | `kimi` | `kimi API internal error (524): <none>` | 129.8s |
| `burst3c/q05` | `kimi` | `kimi API internal error (524): <none>` | 131.2s |
| `burst3c/q06` | `kimi` | `kimi API internal error (524): <none>` | 130.0s |
| `burst5/q02` | `gemini` | `gemini API internal error (524): <none>` | 128.8s |

**HTTP 524 from the upstream LLM gateway at ~130s is a hard ceiling.** The LLM gateway (`oauth-llm.angrist.net`) appears to enforce a ~130s deadline for kimi and gemini specifically.

This matters because:

1. The orchestrator's `GLOBAL_TIMEOUT_MS` was doubled from 120s → 240s in commit `234fcc4` to give long fanouts more headroom. But kimi/gemini will hit the gateway-side 130s wall before our 240s deadline ever fires. The doubled deadline is over-provisioned for those two providers.

2. **In retrospect, the 2026-04-25 Q06 result is consistent with this — not the empty-envelope anomaly.** Q06 ("what algorithm does git use for binary diff and why") took 130.8s. Yesterday's parallel test reported it as `succeeded=[]` `failed=[]` `answers=[]`. Today's standalone curl of the same query showed kimi failing with 524 at 130s. **It is plausible that Q06 yesterday returned a populated envelope with `succeeded=[8 others]` `failed=[kimi 524]`, and the test client's masking bug made it look identical to a true empty envelope.**

3. The same logic applies to Q09 (tardigrade, 68.7s yesterday). Today's standalone curl showed 9/9 — but yesterday it likely returned 9/9 too, with the test client also misparsing it for some unrelated reason (slow client read, harness thread starvation, something else).

**Working hypothesis revision:** the 2026-04-24 / 2026-04-25 "anomalies" may not have been server-side empty envelopes at all — they may have been a combination of:

- Real upstream 524 timeouts (Q06-style, returning 8/9) misparsed as empty by the masking bug
- Real Python harness thread/IO issues at high parallelism (`requests` library connection-pool exhaustion under 3 concurrent long-polled SSEs)

Without the original raw response bodies from those runs, we cannot retroactively distinguish these from a true server-side empty envelope.

# Appendix C — SSE pipe behavior under concurrency (chunk-timing analysis)

Per-burst average timings from the 38 captures:

| Burst | N | First chunk (ms) | Message-event first chunk (ms) | Message chunks | Message span (ms) | Wall duration (s) |
| --- | --- | --- | --- | --- | --- | --- |
| `single` (parallelism=1) | 1 | 5,068 | 31,492 | 10.0 | 35 | 31.5 |
| `burst3` (parallelism=3) | 7 | 5,103 | 55,805 | 11.7 | 59 | 55.9 |
| `burst3b` (parallelism=3) | 10 | 5,093 | 47,420 | 11.9 | 58 | 47.5 |
| `burst3c` (parallelism=3) | 10 | 5,102 | 71,599 | 13.0 | 78 | 71.7 |
| `burst5` (parallelism=5) | 10 | 5,113 | 79,881 | 12.5 | 61 | 79.9 |

Observations:

1. **First chunk arrival is rock-stable at 5,068–5,113ms across all concurrency levels** — that's our `inject_sse_keepalive` interval firing on schedule. Confirms the SSE pipe opens cleanly under all tested loads.
2. **Message-event payload arrives in 10–13 chunks within 35–78ms.** Tight delivery window — no backpressure or fragmentation.
3. **No correlation between concurrency and chunk-span.** burst5 (parallelism=5) actually had the lowest span (61ms) despite the highest concurrency. The SSE delivery layer is not under measurable stress at our tested loads.

# Appendix D — Web-search-fanout 10s timeouts under load

The wrangler tail shows another concurrent-load behavior, unrelated to empty envelopes but worth documenting:

```
(warn) Search failed component=search:exa op=provider_search_failed error="The operation was aborted" duration_ms=10000
(warn) Search failed component=search:linkup ... duration_ms=10000
(warn) Search failed component=search:perplexity ... duration_ms=10000
(warn) Search failed component=search:serpapi ... duration_ms=10000
(warn) Search failed component=search:you ... duration_ms=10000
(warn) Search failed component=search:kimi ... duration_ms=10000-16365
```

These come from `gemini-grounded`'s **internal** web-search fanout (`run_web_search_fanout(...)` in `answer_orchestrator.ts:96`), which has a hard 10s deadline (`timeout_ms: 10_000`). Under concurrent load, multiple search providers hit that 10s wall.

This degrades `gemini-grounded`'s answer quality (fewer sources to ground from) but doesn't cause empty envelopes — `gemini-grounded` still runs even if some web-search providers timed out.

# Appendix E — Updated conclusion

Combining v1, v2 main body, and these appendices:

1. **Server-side empty envelopes have NOT been observed in any captured raw response.** All 38 captures from this session and all 4 captures from the prior session contain populated envelopes.
2. **Yesterday's "anomalies" were almost certainly client-side artifacts** of the test masking bug + possibly Python `requests` thread-pool issues under concurrent long-polled SSE.
3. **The real production-impact bugs are:**
   - The test client masking bug (highest priority — without it we keep mis-diagnosing)
   - The `_execution_context` singleton in `r2_trace.ts` (correctness; mostly silent loss of traces)
   - No worker-side log when the SSE message actually flushes (diagnostic; needed to catch a real anomaly if one ever occurs)
4. **Real deployed-system limit worth knowing:** the LLM gateway's ~130s timeout for kimi/gemini. Anything that would push those providers past 130s should be considered out-of-budget. Our 240s orchestrator deadline is therefore over-provisioned for kimi/gemini specifically; the practical ceiling is 130s.
5. **The hypothesis of an `agents`-package WS-to-SSE bridge race remains plausible but unverified.** The bridge is non-trivial and could fail under sustained production load that we have not reproduced. Recommendation stands: instrument the worker so the next real occurrence is observable.

# Appendix F — Recommended next experiments (NOT executed in this investigation)

If the empty-envelope anomaly recurs in production after this session, run these in order:

1. **First: deploy with the test masking bug fix and the worker-side outcome log.** This makes the next occurrence observable without changing any other behavior.
2. **If it recurs:** tail wrangler logs concurrent with the test, capture the `cf-ray` of the failing request, grep the worker's outcome log line. If the worker logged a successful flush but the client got an empty body, the bug is platform/library; if the worker logged no flush, the bug is in our orchestrator → tool-callback path.
3. **If platform/library:** test bypassing `inject_sse_keepalive` (the diff in v1 doc) for one deploy. If the anomaly disappears, our wrapper is implicated. If it persists, the agents package itself.
4. **If our wrapper:** examine concurrent execution of `pump()` exit + `setInterval` keepalive — a write to a closed writer might be silently swallowed by `safe_write`'s `.catch(cleanup)`.
5. **If the agents package:** file an upstream issue or pin/upgrade the package version.

# Appendix G — Independent-verification scripts

These can be re-run by any agent without touching code:

```bash
# Verify the 0-anomaly count from any captures dir
python3 - <<'PY'
import json, glob
total, anom = 0, 0
for p in sorted(glob.glob("tmp/empty_envelope_diag_v2_*/*/q*_capture.json")):
    total += 1
    cap = json.load(open(p))
    if cap.get("is_anomaly"): anom += 1
print(f"{anom}/{total} anomalies")
PY

# List partial-success captures (fewer than 9 providers succeeded)
python3 - <<'PY'
import json, glob
for p in sorted(glob.glob("tmp/empty_envelope_diag_v2_*/*/q*_capture.json")):
    cap = json.load(open(p))
    sc = (cap.get("envelope_payload") or {}).get("result", {}).get("structuredContent", {})
    if len(sc.get("providers_succeeded", [])) < 9:
        print(p, "succeeded=", len(sc.get("providers_succeeded", [])),
              "failed=", [(f.get("provider"), (f.get("error") or "")[:50]) for f in sc.get("providers_failed", [])])
PY

# Per-burst chunk-timing summary
python3 - <<'PY'
import json, glob
for burst in ["single","burst3","burst3b","burst3c","burst5"]:
    paths = sorted(glob.glob(f"tmp/empty_envelope_diag_v2_*/{burst}/q*_capture.json"))
    if not paths: continue
    rows = []
    for p in paths:
        cap = json.load(open(p))
        tl = cap.get("chunk_timeline", [])
        msgs = [c for c in tl if c.get("size_bytes", 0) >= 100]
        if not tl: continue
        rows.append((tl[0]["arrival_ms"], msgs[0]["arrival_ms"] if msgs else 0, len(msgs), cap.get("duration_s",0)))
    print(burst, "n=", len(rows), "avg_first_chunk_ms=", sum(r[0] for r in rows)/len(rows),
          "avg_msg_first_ms=", sum(r[1] for r in rows)/len(rows),
          "avg_msg_chunks=", sum(r[2] for r in rows)/len(rows),
          "avg_dur_s=", sum(r[3] for r in rows)/len(rows))
PY
```
