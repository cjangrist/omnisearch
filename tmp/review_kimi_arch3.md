# Architecture Scorecard & Code Review: MCP Ser
ver on Cloudflare Workers with Durable Objects

## Executive Summary

This i
s a well-architected MCP (Model Context Protocol) server that aggregates 9+ AI/s
earch providers in parallel. It runs on Cloudflare Workers with Durable Objects 
for stateful sessions, implements sophisticated SSE keepalive mechanisms for lon
g-running operations, and features a 25+ provider fetch waterfall with intellige
nt failover. The codebase demonstrates strong engineering practices with good se
paration of concerns, comprehensive error handling, and thoughtful observability
.

---

## Part 1: Architecture Scorecard

### Area 1: CONCURRENCY & ASYNC
PATTERNS
**Score: 8/10**

**Justification:** The codebase demonstrates solid 
understanding of Promise composition with appropriate use of `Promise.race`, `Pr
omise.all`, and `Promise.allSettled` across the three main fanout patterns (web 
search, answer, fetch). AbortController/signal threading is generally well-imple
mented with `make_signal()` utility providing timeout + external signal composit
ion. The deadline handling in `answer_orchestrator.ts` (lines 178-193) correctly
uses `is_done` flag to prevent late-arriving promises from mutating result array
s after the deadline expires.

**To reach 10/10:**
1. **Add explicit cleanup 
for in-flight fetch aborts:** In `fetch_orchestrator.ts` `run_parallel()`, the l
osing providers' fetches aren't explicitly cancelled when a winner is found. A
dd AbortController per provider and abort losers when `resolved = true`.
2. **U
nify timeout constants:** Timeout values are scattered across `config.env.ts` (e
.g., 180000 for AI, 30000 for fetch). Create a single `TIMEOUTS` constant object
with documented rationale for each value.
3. **Add concurrent request limiting:
** The answer fanout launches up to 9 providers simultaneously with no concurren
cy cap. Add `p-limit` or similar to cap concurrent requests to a configurable li
mit (e.g., 5) to prevent overwhelming upstream APIs.

---

### Area 2: STREA
M HANDLING & SSE
**Score: 7/10**

**Justification:** The SSE keepalive inject
ion in `worker.ts` (lines 62-166) is a sophisticated solution to Claude web's 4
5-second timeout. The event-boundary buffering correctly implements WHATWG SSE s
pec with support for `\
\
`, `\\r\
\\r\
`, and `\\r\\r` delimiters. The writ
e-lock serialization via `safe_write()` prevents concurrent writer access. Howev
er, the TransformStream pump pattern lacks backpressure handling—if the consumer
is slower than the producer, chunks will accumulate in memory.

**To reach 10/
10:**
1. **Add backpressure handling:** In `inject_sse_keepalive()`, check `wri
ter.desiredSize` before writing and pause the pump if the buffer is full:
   ``
`typescript
   if (writer.desiredSize !== null && writer.desiredSize <= 0) {
 
   await writer.ready; // Wait for buffer to drain
   }
   ```
2. **Fix clien
t disconnect detection:** The current implementation doesn't detect when the cl
ient disconnects mid-stream. Add a `reader.closed` catch block that triggers cle
anup and upstream cancellation.
3. **Add SSE event ID support:** For resumabili
ty per SSE spec, inject `id:` fields based on a monotonic counter to enable `Las
t-Event-ID` resume after reconnection.

---

### Area 3: ERROR HANDLING & RE
SILIENCE
**Score: 8/10**

**Justification:** Error handling is comprehensive 
and consistent. The `ProviderError` class with `ErrorType` enum provides structu
red error classification. Provider failures are properly isolated—one provider'
s failure never crashes others. The `handle_provider_error()` utility preserves 
stack traces with "Caused by" chaining. REST endpoints return appropriate status
codes (502 for total provider failure, 429 for rate limits). The intentional lac
k of retry for AI providers (line 76-77 in `answer_orchestrator.ts`) is well-jus
tified.

**To reach 10/10:**
1. **Add circuit breaker pattern:** Currently th
ere's no circuit breaker for consistently failing providers. Add a simple in-me
mory circuit breaker that temporarily skips providers after N consecutive failur
es within a time window.
2. **Unify error serialization:** The REST endpoints (
`rest_search.ts`, `rest_fetch.ts`) manually construct error shapes while MCP too
ls use `create_error_response()`. Create a single `serialize_error()` utility us
ed by both.
3. **Add request ID propagation to errors:** Ensure all error respo
nses include the `request_id` for end-to-end tracing in distributed scenarios.


---

### Area 4: DATA FLOW & PROVIDER ORCHESTRATION
**Score: 9/10**

**Ju
stification:** The three main pipelines (web search fanout, answer fanout, fetch
waterfall) are well-designed with clear separation of concerns. The RRF (Recipro
cal Rank Fusion) ranking implementation is correct with k=60 constant and proper
URL normalization. The fetch waterfall's domain breakers (YouTube→Supadata, soc
ial→Sociavault) provide intelligent specialization. The query cache using KV wit
h 24h TTL prevents redundant gemini-grounded searches within answer fanout. Prov
ider registration pattern via unified dispatchers is clean and extensible.

**
To reach 10/10:**
1. **Add result freshness indicators:** Include `cached_at` t
imestamp in cached responses so clients can understand data age.
2. **Implement
cache invalidation:** Currently there's no way to force-refresh cached results.
Add a `cache: "no-cache"` option to tool parameters and REST endpoints.
3. **Ad
d provider health scoring:** Beyond simple availability, track success rate and 
latency per provider to influence RRF weighting or waterfall ordering dynamicall
y.

---

### Area 5: CODE ORGANIZATION & MODULARITY
**Score: 8/10**

**Ju
stification:** The file structure follows clear domain boundaries (`providers/`,
`server/`, `common/`, `config/`). The unified dispatcher pattern (web_search.ts,
ai_search.ts, fetch.ts) provides clean provider registration. Module-level state
is minimized and properly managed via atomic swaps (`initialize_providers()` lin
es 79-82). No circular dependencies detected. The ToolRegistry singleton is appr
opriately scoped.

**To reach 10/10:**
1. **Break up `env.ts`:** At 384 lines
with 250+ lines of config initialization, this file violates single responsibili
ty. Split into `config/providers/search.ts`, `config/providers/ai.ts`, `config/p
roviders/fetch.ts`, and `config/initialization.ts`.
2. **Add barrel file consis
tency:** Some directories use barrel exports, others don't. Standardize on inde
x.ts barrel files for all provider categories.
3. **Extract magic numbers:** Co
nstants like `RRF_K = 60`, `DEFAULT_TOP_N = 15`, `MERGE_CHAR_BUDGET = 500` are s
cattered. Create a single `src/constants.ts` with documented rationale for each.


---

### Area 6: TYPE SAFETY & INTERFACES
**Score: 7/10**

**Justificat
ion:** TypeScript strict mode is enabled. Core interfaces (`SearchResult`, `Fetc
hResult`, `BaseSearchParams`) are well-designed. The registration pattern with `
typeof PROVIDERS[number]['name']` provides compile-time provider name checking
. Zod schemas in tool definitions generally match return types. However, there a
re several `as` casts that could be eliminated, and the `@ts-expect-error` for M
cpAgent server property (line 175) lacks proper documentation of when it can be 
removed.

**To reach 10/10:**
1. **Remove `as unknown as` casts:** In `tools.
ts` lines 155 and 229, replace `as unknown as Record<string, unknown>` with prop
er `CallToolResult` typing. The MCP SDK's `structuredContent` expects `unknown`
already.
2. **Fix `any` in catch blocks:** Several catch blocks use `error as E
rror` (e.g., `tools.ts` line 103) which is unsafe. Use `unknown` with proper typ
e narrowing:
   ```typescript
   } catch (error) {
     const err = error ins
tanceof Error ? error : new Error(String(error));
     return this.format_error
(err);
   }
   ```
3. **Add stricter provider config types:** The `config` ob
ject uses `as string | undefined` assertions. Use proper optional chaining and `
satisfies` operator for stricter typing.

---

### Area 7: CONFIGURATION & E
NVIRONMENT
**Score: 7/10**

**Justification:** Environment binding validation
is handled via `validate_config()` which logs available/missing providers. The p
rovider auto-discovery via unified dispatchers is elegant. Timeout constants are
documented in config. However, there's no runtime validation of config.yaml aga
inst the TypeScript CONFIG mirror in `fetch_orchestrator.ts`, which creates risk
of drift.

**To reach 10/10:**
1. **Add config.yaml validation at startup:** 
Parse config.yaml and validate it matches the TypeScript CONFIG structure. Throw
if waterfall providers don't exist or if required fields are missing.
2. **Add
runtime config reload:** Currently config is loaded once at startup. Support HMR
-style config reload in dev mode via `wrangler --watch`.
3. **Document all envi
ronment variables:** Create `.env.example` with all 40+ environment variables do
cumented with descriptions and example values (currently only basic ones are in 
the example).

---

### Area 8: OBSERVABILITY & DEBUGGING
**Score: 8/10**


**Justification:** Structured logging with JSON formatting is comprehensive. T
he logger provides component-scoped instances with request ID correlation. Opera
tion tracking via `op` field enables tracing. Duration is captured at appropriat
e granularity (provider-level, fanout-level, request-level). Log levels are used
consistently (debug for verbose, info for milestones, warn for non-fatal, error 
for failures).

**To reach 10/10:**
1. **Add OpenTelemetry tracing:** Current
logs are flat. Add span context for distributed tracing across provider fanouts.

2. **Log cache hit/miss ratios:** Add periodic stats logging for KV cache effe
ctiveness by provider category.
3. **Add structured error codes:** Replace stri
ng error messages with stable error codes (e.g., `SEARCH_FANOUT_TIMEOUT`, `PROVI
DER_RATE_LIMITED`) for programmatic alerting.

---

### Area 9: API DESIGN &
PROTOCOL COMPLIANCE
**Score: 8/10**

**Justification:** MCP protocol complian
ce is good with proper tool/resource registration and Streamable HTTP transport.
REST API design follows RESTful conventions with appropriate status codes. CORS 
headers are comprehensive for the Worker-level routes. Tool descriptions are det
ailed and helpful. Input validation (query length, body size, URL format) is pre
sent.

**To reach 10/10:**
1. **Add MCP protocol version negotiation:** Curre
ntly the server doesn't validate the `mcp-protocol-version` header against supp
orted versions. Add validation per MCP spec.
2. **Implement DELETE for session 
cleanup:** The MCP Streamable HTTP spec supports DELETE for session termination.
Add handler to properly clean up DO resources.
3. **Add rate limiting headers:*
* REST endpoints should return `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-
RateLimit-Reset` headers for client-side throttling.

---

### Area 10: PERF
ORMANCE & RESOURCE EFFICIENCY
**Score: 7/10**

**Justification:** The codebas
e shows awareness of performance: `TextEncoder` is reused at module level (line 
22 in `utils.ts`), chunk-based buffer flattening avoids O(n²) concatenation, and
stream reading has a 5MB size guard. However, there are inefficiencies: `Date.no
w()` is called frequently (sometimes multiple times per provider), and the SSE k
eepalive creates a new `Uint8Array` for every ping (should be cached).

**To r
each 10/10:**
1. **Cache timestamp for batch operations:** In fanout loops, cap
ture `const now = Date.now()` once at iteration start instead of calling per pro
vider.
2. **Pre-encode SSE ping:** The `SSE_PING` constant (line 60) is correct
ly pre-encoded. Verify this is used consistently and add pre-encoded error event
bytes too.
3. **Add response compression:** For MCP responses with large tool r
esults, enable gzip compression via `Content-Encoding: gzip` when client accepts
it.
4. **Optimize RRF ranking:** Current implementation creates multiple interm
ediate Maps and arrays. Use a single-pass approach with object pooling for high-
query-rate scenarios.

---

## Part 2: Traditional Code Review

### CRITIC
AL — Must fix

**None identified.** The codebase is production-ready with no c
ritical bugs that would cause outages or data loss.

---

### HIGH — Should 
fix

**1. Missing AbortSignal propagation in fetch waterfall parallel racing**

- **File:** `src/server/fetch_orchestrator.ts`, lines 175-218
- **What:** Whe
n `Promise.any()` resolves with a winner, the losing providers' HTTP requests c
ontinue in the background, consuming resources.
- **Impact:** Wasted compute an
d potential connection pool exhaustion under high load.
- **Fix:** Create an Ab
ortController per parallel provider and abort all losers when winner resolves:


```typescript
const run_parallel = async (/*...*/): Promise<...> => {
  cons
t abortControllers = new Map<string, AbortController>();
  // ... 
  const pro
mises = available.map((p) => {
    const controller = new AbortController();
 
  abortControllers.set(p, controller);
    // Pass controller.signal to try_pro
vider
  });
  try {
    const winner = await Promise.any(promises);
    reso
lved = true;
    // Abort all losers
    for (const [name, controller] of abor
tControllers) {
      if (name !== winner.provider) controller.abort();
    }\
n    return winner;
  } catch { /*...*/ }
};
```

---

**2. Potential mem
ory leak in SSE keepalive on pump error**
- **File:** `src/worker.ts`, lines 13
9-159
- **What:** If `reader.read()` throws, the `finally` block calls `cleanup
()`, but the interval may have fired a pending `safe_write` that hasn't complet
ed.
- **Impact:** Under high error rates, unresolved write promises could accum
ulate.
- **Fix:** Track in-flight writes and wait for completion in cleanup:
\
n```typescript
let inFlightWrites = 0;
const safe_write = async (chunk: Uint8A
rray): Promise<void> => {
  inFlightWrites++;
  try {
    write_lock = write_
lock.then(() => writer.write(chunk)).catch(cleanup);
    await write_lock;
  }
finally {
    inFlightWrites--;
  }
};
const cleanup = async () => {
  if (
closed) return;
  closed = true;
  clearInterval(keepalive);
  // Wait for in
-flight writes
  while (inFlightWrites > 0) {
    await new Promise(r => setTi
meout(r, 10));
  }
  await reader.cancel().catch(() => {});
  await writer.cl
ose().catch(() => {});
};
```

---

**3. Race condition in KV cache writes
**
- **File:** `src/server/web_search_fanout.ts`, line 222; `src/server/answer_
orchestrator.ts`, line 281
- **What:** Fire-and-forget KV writes (`set_cached()
` without await) can complete out of order, causing stale data to overwrite fres
h data.
- **Impact:** Subsequent requests may get older cached results than ava
ilable.
- **Fix:** Add timestamp-based conditional writes or use a write queue 
per cache key.

---

### MEDIUM — Should fix soon

**4. Inconsistent error
response shapes between REST and MCP**
- **File:** `src/server/rest_search.ts` 
(lines 172-175), `src/server/tools.ts` (lines 234-240)
- **What:** REST returns
`{ error: string }` while MCP returns `{ content: [{ type: 'text', text: strin
g }], isError: true }`.
- **Fix:** Create unified error response formatter in `
common/utils.ts` used by both paths.

---

**5. Missing request signal integ
ration for REST endpoints**
- **File:** `src/server/rest_search.ts`, `src/serve
r/rest_fetch.ts`
- **What:** The REST endpoints don't respect the incoming req
uest's AbortSignal for cancellation.
- **Fix:** Pass `request.signal` through 
to fanout functions.

---

**6. Tool registry lacks provider freshness check
**
- **File:** `src/server/tools.ts`, lines 26-24
- **What:** `active_provider
s` Sets are populated at init but never updated if providers fail permanently du
ring runtime.
- **Fix:** Add periodic health checks that update `active_provide
rs` based on recent success rates.

---

**7. Config drift between config.ya
ml and TypeScript**
- **File:** `src/server/fetch_orchestrator.ts` (lines 52-96
), `config.yaml`
- **What:** The waterfall configuration is duplicated in YAML 
(source of truth) and TypeScript. They're manually kept in sync.
- **Fix:** At
build time, generate TypeScript config from YAML using a simple code generator.\
n
---

### LOW — Nice to have

**8. Date.now() called excessively**
- **Fi
le:** Multiple files
- **What:** `Date.now()` is called multiple times within t
ight loops.
- **Fix:** Cache timestamp at operation start and pass through.


---

**9. Unused imports**
- **File:** Various provider files have unused imp
orts from cleanup.
- **Fix:** Enable `noUnusedLocals` in tsconfig.

---

**
10. Zod schemas could be stricter**
- **File:** `src/server/tools.ts`
- **What
:** Tool input schemas use basic types but could add refinements (e.g., URL vali
dation for `fetch` tool).
- **Fix:** Add `.refine()` validators for semantic va
lidation.

---

### POSITIVE — What was done well

1. **Excellent SSE keep
alive implementation** — The event-boundary buffering with write-lock serializat
ion is a sophisticated solution to a real problem (Claude web timeout).

2. **
Thoughtful provider failure isolation** — Each provider runs in its own promise 
with individual error handling; one failure never crashes the fanout.

3. **Cl
ean unified dispatcher pattern** — The provider registration system via `PROVIDE
RS` arrays with factory functions is elegant and extensible.

4. **Comprehensi
ve structured logging** — JSON-formatted logs with request IDs, operation names,
and durations enable effective observability.

5. **Proper Durable Object life
cycle management** — The init promise pattern with retry on failure (lines 188-2
07 in worker.ts) correctly handles DO hibernation/reactivation.

6. **Intellig
ent snippet selection** — The `snippet_selector.ts` implementation with n-gram d
eduplication and sentence-level merging shows attention to result quality.

7.
**AbortController composition** — The `make_signal()` utility correctly implemen
ts `AbortSignal.any()` with a polyfill for broader compatibility.

---

## S
ummary

This is a **production-ready, well-architected MCP server** that demon
strates sophisticated understanding of Cloudflare Workers, Durable Objects, and 
async patterns. The codebase scores **~7.7/10 overall** with clear paths to 9+ t
hrough the specific improvements outlined above. The most impactful changes woul
d be:

1. Adding circuit breakers and loser-cancellation to the fetch waterfal
l
2. Implementing backpressure in the SSE keepalive stream
3. Creating a confi
g validation/generation pipeline to prevent YAML/TypeScript drift
