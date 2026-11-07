# Architecture & Logic — omnisearch MCP

> What omnisearch actually does, why it's shaped this way, and what we *hope* it
> achieves. Written for the engineer who just opened the repo and wants the mental
> model without grepping for an hour.

---

## TL;DR

omnisearch is a **Cloudflare Workers + Durable Objects** server that speaks the
**Model Context Protocol (MCP)**. It does exactly two things for an LLM agent:

1. **`web_search`** — fan one query out to ~10 search engines in parallel,
   dedup + RRF-rank the results, then regenerate the top snippets from the real
   page content (grounding).
2. **`fetch`** — fetch any URL's content as markdown. omnisearch does **none** of
   the fetching itself; it makes a single REST call to the external
   [`omnifetch`](https://github.com/cjangrist/omnifetch) service, which owns the
   multi-provider waterfall.

That's it. Everything else is caching, tracing, and the plumbing to make those
two calls fast, observable, and safe under concurrency.

---

## The two data flows

### `web_search` — `src/server/web_search_fanout.ts`

```
query
  │
  ▼
KV cache lookup (key = sha256(query + opts)) ──hit──► return cached (~80ms)
  │ miss
  ▼
dispatch_to_providers ── parallel ──► 10 search engines (each its own promise)
  │                          │
  │                          └─ per-provider timeout via AbortSignal; retry-once
  │                             on transient (PROVIDER_ERROR) failures only
  ▼
rank_and_merge (src/common/rrf_ranking.ts)
  │  • URL dedup (lowercase host, strip fragment/trailing slash)
  │  • Reciprocal Rank Fusion: score = Σ 1/(60 + rank) per engine that returned it
  │  • Snippet collapse across providers (bigram Jaccard + greedy sentence cover)
  │  • Tail rescue (underrepresented domains with high intra-rank)
  │  • Quality filter (min score, min snippet density)
  ▼
grounded snippets (src/server/grounded_snippets.ts) — only if CEREBRAS_API_KEY set
  │  • take top-20 URLs
  │  • bounded worker pool fetches each via omnifetch (concurrency 10, per-URL 7.5s deadline)
  │  • Cerebras gpt-oss-120b writes a query-grounded snippet from the real page body
  │  • pre-LLM junk detection (paywall/login/JS-shell) → fall back to aggregated snippet
  │  • result.snippet_source ∈ {aggregated, grounded, fallback}
  ▼
KV cache write (only if the fanout was complete: 0 failures, 0 transient grounding blips)
  │
  ▼
return FanoutResult { web_results, providers_succeeded, providers_failed, ... }
```

**Why RRF?** Each engine ranks differently and incompatibly. RRF needs no score
calibration — a URL found by 3 independent engines floats to the top regardless
of how each scored it. Pages multiple engines agree on are almost always the
right answer.

**Why grounded snippets?** Engine-supplied snippets are SEO-padded boilerplate.
Regenerating them from the actual page body (framed by the query) gives the LLM
real evidence it can treat as ground truth without fetching the page itself.

### `fetch` — `src/server/omnifetch_client.ts`

```
url
  │
  ▼
POST ${OMNIFETCH_ENDPOINT}/web_fetch  {"url": url}      (public, no auth)
  │
  ▼
omnifetch runs the waterfall (its concern, not ours) ──► {title, content, ...}
  │
  ▼
return { url, title, content, source_provider, total_duration_ms, metadata }
```

omnisearch is deliberately a **thin client** for fetching. The waterfall, the 28
scraping providers, domain breakers, social-media specialists, skip_providers —
all of that lives in the standalone omnifetch service. omnisearch assumes
omnifetch works and stays out of the way.

---

## The substrate (everything that isn't a tool)

| Concern | Where | Logic |
|---|---|---|
| **Entry / routing** | `src/worker.ts` | One `fetch` handler routes `/health`, `/search`, `/fetch`, `/researcher`, `/mcp`. MCP POSTs delegate to the `OmnisearchMCP` Durable Object. |
| **Per-request scoping** | `src/common/logger.ts`, `r2_trace.ts` | Three `AsyncLocalStorage` stores: `request_id`, `TraceContext`, `ExecutionContext`. No module-level per-request state — concurrent requests in the same isolate never cross-contaminate logs/traces/`waitUntil`. |
| **Durable Object** | `OmnisearchMCP` (worker.ts) | One DO instance per MCP client session. `init()` runs once: config → validate → providers → register tools → handlers. Each tool closure captures `() => this.ctx` (R4F01) so R2 trace writes attach to the right DO's `waitUntil`. |
| **HTTP** | `src/common/http.ts` | One wrapper `http_json` — 5MB size guard, status→ProviderError mapping, R2 trace recording, sensitive-param redaction in logs. Never bare `fetch`. |
| **Caching** | KV (`CACHE` binding) | 36h TTL. Only `web_search` caches (key binds the query as defense-in-depth). `fetch` does not cache in omnisearch — omnifetch may cache internally. Partial/transient fanouts are never cached. |
| **Tracing** | `src/common/r2_trace.ts` → `TRACE_BUCKET` | Every tool call + every nested HTTP round-trip written to R2 as one JSON doc, hive-partitioned `tool=…/date=…/hour=…/trace_id=….json`. Unredacted (private bucket, for incident debugging). `flush_background` is fire-and-forget via `ctx.waitUntil`. |
| **Metrics** | `src/common/metrics.ts` → Analytics Engine | Cheap pre-extracted scalars (latencies, counts, cache-hit) that SQL-aggregate fast. Two datasets: `omni_requests` (per-HTTP-request) and `omni_search` (per-fanout). |
| **SSE keepalive** | `worker.ts inject_sse_keepalive` | MCP POST responses stream as SSE; we inject `event: ping` every 5s **between** complete events so Cloudflare's edge / Claude-web's 45s idle timeout can't tear down long calls. |
| **Config** | `src/config/env.ts` | One `config` singleton populated per-isolate by `initialize_config(env)`. Memoized, resets on rejection. |

---

## Provider model

Search providers live in `src/providers/search/<name>/index.ts` (10 of them:
tavily, brave, kagi, exa, firecrawl, perplexity, serpapi, linkup, you, parallel).
Each exports a `registration = { key: () => config.search.<name>.api_key }`. The
unified dispatcher (`src/providers/unified/web_search.ts`) builds a `PROVIDERS`
array, filters by `key()?.trim()` at construction → only configured providers are
active. **There are no fetch providers** — fetching is omnifetch's job.

---

## The hopes (what we're betting on)

- **Fan-out beats single-engine.** No one search engine has full coverage; asking
  all of them and fusing ranks surfaces results any single engine misses, and the
  consensus rank is more trustworthy than any one engine's opinion.
- **Grounded snippets pay for themselves.** They cost a fetch + an LLM call per
  top URL, but they let the consuming agent answer from the snippet alone —
  usually avoiding a follow-up `fetch`. The bet is that fewer downstream fetches
  + better-grounded answers > the grounding latency. (Mitigation: bounded
  concurrency, tight per-URL deadlines, transparent fallback to aggregated
  snippets when grounding fails.)
- **Externalizing fetch to omnifetch.** omnisearch stays small and focused
  (search + ranking + grounding); the scraping complexity (28 providers,
  breakers, bot-evasion) lives in a service that can be operated/scaled/reasoned
  about independently. The bet is that one good fetch service > N inlined
  fetchers, and that the network hop to omnifetch is negligible next to the
  waterfall latency it was already paying.
- **Edge caching makes repeat queries ~free.** A 36h KV TTL means common queries
  return in ~80ms from the edge. The bet is that query distribution is
  heavy-tailed (a few queries dominate) so the hit rate is high; the
  completeness-gate prevents poisoning the cache with partial results.
- **Observability over guessing.** Every request is fully traced to R2 and
  metric-sampled to Analytics Engine. The bet is that when something breaks
  (and it will), we can open one trace and see the entire decision path rather
  than theorize.

---

## What omnisearch deliberately does NOT do

- No AI answer synthesis (the `answer` tool was removed — that's the consuming
  LLM's job, using `web_search` + `fetch` as evidence).
- No internal fetch waterfall (lives in omnifetch).
- No retry storms — multi-provider fanout *is* the redundancy; individual
  providers retry at most once on transient errors.
- No cross-request in-memory state (everything per-request goes through ALS).
