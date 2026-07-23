# Omnisearch MCP

[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-blue?logo=typescript)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-1.29-green)](https://modelcontextprotocol.io/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange?logo=cloudflare)](https://workers.cloudflare.com/)
[![License](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

> Multi-provider search and universal URL fetching — aggregated, ranked, cached at the edge, and fully traced to R2.

Omnisearch MCP is a production-grade [Model Context Protocol](https://modelcontextprotocol.io/) server running on Cloudflare Workers + Durable Objects. It fans out queries to many search engines in parallel, fetches content from any URL via the standalone **omnifetch** service, returns unified results with global KV caching, and writes every request/response to R2 for incident debugging.

URL fetching is delegated to [omnifetch](https://github.com/cjangrist/omnifetch) — the same multi-provider waterfall, externalized into its own service. omnisearch is a thin client for fetching; it owns the search fanout, RRF ranking, grounded snippets, caching, and tracing.

---

## What makes this different

| Surface | Single Provider | Omnisearch |
|---------|----------------|------------|
| Resilience | Single point of failure | Many search engines in parallel + omnifetch's multi-provider fetch failover |
| Search | One engine's blind spots | Multiple engines in parallel, RRF-ranked, cross-deduplicated |
| Snippets | Engine-supplied (often boilerplate / SEO) | Top-N regenerated from actual page content via Cerebras, query-framed |
| URL Fetching | Blocked by paywalls, CAPTCHAs | Delegated to omnifetch (multi-provider waterfall with social media extraction) |
| Performance | Cold on every call | Global KV cache (36h TTL) — cache hits return in ~80ms |
| Connectivity | Timeout on long operations | SSE keepalive with event-boundary buffering, whitespace-heartbeat tolerant |
| Observability | Opaque | R2-backed request/response tracing, hive-partitioned per tool |

---

## Repo Map

```
omnisearch/
├── README.md                                # this file
├── AGENTS.md                                # repo navigation hub for AI agents
├── LICENSE
├── package.json                             # @modelcontextprotocol/sdk ^1.29, agents, p-retry, zod, wrangler, typescript ^6.0.3
├── wrangler.toml                            # CF Worker config — DO + KV + R2 bindings; nodejs_compat flag
├── tsconfig.json
├── .env.example                             # documented env vars (secrets live in Doppler / wrangler secrets)
├── docs/                                    # postmortems, ROI analyses, multi-reviewer synthesis docs
└── src/
    ├── worker.ts                            # CF Worker fetch entry; OmnisearchMCP DO export; SSE keepalive injection
    ├── common/
    │   ├── html.ts                          # extract_html_title / extract_markdown_title
    │   ├── http.ts                          # http_json / http_text wrappers (5MB size guard, redaction, R2 trace hook)
    │   ├── logger.ts                        # JSON logger with AsyncLocalStorage<request_id>
    │   ├── r2_trace.ts                      # TraceContext + AsyncLocalStorage<WaitUntilCapable> + R2 hive-partitioned writer
    │   ├── rrf_ranking.ts                   # Reciprocal Rank Fusion + URL dedup + tail rescue + quality filter
    │   ├── search_operators.ts              # parses site:/filetype:/intitle:/etc. into structured params
    │   ├── snippet_selector.ts              # bigram Jaccard + greedy sentence merge (collapse_snippets)
    │   ├── types.ts                         # SearchResult, SearchProvider, ProviderError
    │   └── utils.ts                         # AbortSignal.any polyfill, hash_key (SHA-256), retry_with_backoff, REST auth
    ├── config/
    │   └── env.ts                           # config object + initialize_config(env) + validate_config()
    ├── providers/
    │   ├── index.ts                         # initialize_providers() — atomic-swap registries
    │   ├── search/                          # 11 web-search providers — query → ranked SearchResult[]
    │   └── unified/                         # web_search dispatcher — auto-built from registrations
    ├── server/
    │   ├── omnifetch_client.ts              # single REST client → POST ${OMNIFETCH_ENDPOINT}/web_fetch
    │   ├── grounded_prompts.ts              # snippet-writer system prompt + junk + sentinel detectors
    │   ├── grounded_snippets.ts             # post-RRF Cerebras grounding stage — bounded worker pool + per-URL deadline
    │   ├── handlers.ts                      # MCP resource handlers (provider-status / provider-info)
    │   ├── rest_fetch.ts                    # POST /fetch
    │   ├── rest_researcher.ts               # GET|POST /researcher (GPT-Researcher compat)
    │   ├── rest_search.ts                   # POST /search (accepts grounded_snippets opt-out)
    │   ├── tools.ts                         # MCP tool registration; per-DO get_ctx capture (R4F01)
    │   └── web_search_fanout.ts             # parallel search fanout + RRF + dedup + tail rescue + grounded-snippets stage + KV cache
    └── types/
        ├── env.ts                           # CF env binding types (KV, R2, DO, secret env vars)
        └── node-async-hooks.d.ts            # minimal type stub for AsyncLocalStorage in workerd
```

A `tools/` directory at the repo root holds offline harnesses (`grounding_smoke.py`, `grounding_compare.py`, `grounding_lib.py`) for before/after evaluation of the grounded-snippets feature against fixed query corpora. Not deployed.

Each subfolder has its own `AGENTS.md` with a file-by-file breakdown — start at `AGENTS.md` (root) for the navigation hub.

---

## Two Tools

### `web_search` — Parallel-fanout search with RRF ranking + grounded snippets

Fans out the same query to all configured search engines simultaneously. Deduplicates by URL (lowercase host + strip fragment + strip trailing slash), ranks with Reciprocal Rank Fusion (`score = sum 1/(60 + rank)`), collapses multi-provider snippets via bigram Jaccard plus greedy sentence-level set cover, and rescues high-quality results from underrepresented domains in the tail.

After ranking — if `CEREBRAS_API_KEY` is set — a **grounded-snippet stage** kicks in: the top-20 URLs are fetched in parallel (via omnifetch) and Cerebras (`gpt-oss-120b`) writes a query-framed snippet describing what each page actually says. The grounded snippet replaces the engine-supplied one. Each result reports `snippet_source` ∈ `{ aggregated, grounded, fallback }` so callers can see which path produced the snippet. Default ON; set `grounded_snippets:false` per call (or omit `CEREBRAS_API_KEY`) to return raw aggregated provider snippets at minimum latency.

Tool input: `query`, optional `timeout_ms` (omitted = wait for all providers, full dedup), optional `include_snippets` (default `true`), optional `grounded_snippets` (default `true` when `CEREBRAS_API_KEY` is configured).

### `fetch` — Universal URL content extraction (via omnifetch)

Delegates to the external **omnifetch** service: omnisearch POSTs `{"url": url}` to `${OMNIFETCH_ENDPOINT}/web_fetch` and returns the result. omnifetch runs its own multi-provider waterfall (paywalls, JS rendering, Cloudflare, social media, YouTube transcripts, Reddit, etc.) with automatic failover — omnisearch does no fetching itself.

Tool input: `url` (required). Output: `url`, `title`, `content`, `source_provider`, `total_duration_ms`, `metadata`.

---

## Quick Start

```bash
# 1. Install
git clone https://github.com/cjangrist/omnisearch.git
cd omnisearch
npm ci

# 2. Run the omnifetch service (owns all URL fetching)
git clone https://github.com/cjangrist/omnifetch.git ../omnifetch
cd ../omnifetch && docker compose up -d --build && cd -
# verify: curl -s http://127.0.0.1:8000/health

# 3. Set Cloudflare secrets — at minimum one search key
npx wrangler secret put TAVILY_API_KEY
npx wrangler secret put OMNIFETCH_ENDPOINT   # e.g. http://127.0.0.1:8000 (local) or your deployed omnifetch URL
# ... see "Configuration" below for the full list

# 4. Optional: protect REST endpoints behind a Bearer token
npx wrangler secret put OMNISEARCH_API_KEY

# 5. Deploy
npm run deploy
```

Configure your MCP client:

```json
{
  "mcpServers": {
    "omnisearch": {
      "url": "https://your-worker.workers.dev/mcp"
    }
  }
}
```

The public deployment at `https://omnisearch-mcp.example.invalid/mcp` is unauthenticated for MCP — call it directly without an API key.

---

## REST API

### Endpoints

| Path | Method | Purpose | Auth |
|------|--------|---------|------|
| `/health`, `/` | GET | Liveness + active-provider count | none |
| `/search` | POST | Search fanout, returns `[{ link, title, snippet }]`. Body accepts `grounded_snippets:false` to skip the Cerebras grounding stage. | Bearer (if configured) |
| `/fetch` | POST | URL fetch via omnifetch, returns `{ url, title, content, source_provider, duration_ms, metadata }` | Bearer (if configured) |
| `/researcher` | GET or POST | GPT-Researcher compatible — returns `[{ href, body }]` (search snippets, no full fetch) | Bearer or `?api_key=` query param |
| `/mcp` | GET, POST, DELETE | MCP Streamable HTTP transport (delegates to Durable Object) | none (CORS wildcard) |

### Auth

REST endpoints (`/search`, `/fetch`, `/researcher`) are gated by a Bearer token if either `OMNISEARCH_API_KEY` or `OPENWEBUI_API_KEY` is set (the legacy alias is honored — `OPENWEBUI_API_KEY || OMNISEARCH_API_KEY`). If neither is set, REST endpoints are open. Comparison uses `crypto.subtle.timingSafeEqual` to prevent timing attacks. The `/researcher` endpoint also accepts `?api_key=...` as a query parameter for GPT-Researcher compatibility.

### Examples

```bash
# Search
curl -X POST https://your-worker.workers.dev/search \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OMNISEARCH_API_KEY" \
  -d '{"query": "vector database comparison", "count": 10}'

# Fetch (delegated to omnifetch)
curl -X POST https://your-worker.workers.dev/fetch \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OMNISEARCH_API_KEY" \
  -d '{"url": "https://www.linkedin.com/posts/..."}'

# Researcher (compatible with RETRIEVER=custom in GPT-Researcher)
curl "https://your-worker.workers.dev/researcher?query=rust+memory+safety&api_key=$OMNISEARCH_API_KEY"

# Health — actual provider count varies by which keys are configured
curl https://your-worker.workers.dev/health
# {"status":"ok","name":"omnisearch-mcp","version":"1.0.0","providers":12}
```

---

## Configuration

Secrets are managed via `wrangler secret put` (or the Doppler-based workflow described in `.env.example`). `wrangler.toml` only contains bindings — no secret values.

### Web Search providers — `web_search` tool

Set at least one.

| Variable | Provider | Notes |
|----------|----------|-------|
| `TAVILY_API_KEY` | [Tavily](https://tavily.com) | |
| `BRAVE_API_KEY` | [Brave](https://search.brave.com) | Brave Web Search |
| `KAGI_API_KEY` | [Kagi](https://kagi.com) | Kagi web search |
| `EXA_API_KEY` | [Exa](https://exa.ai) | Neural search |
| `SERPAPI_API_KEY` | [SerpAPI](https://serpapi.com) | `google_light` engine |
| `LINKUP_API_KEY` | [Linkup](https://linkup.so) | |
| `FIRECRAWL_API_KEY` | [Firecrawl](https://firecrawl.dev) | |
| `YOU_API_KEY` | [You.com](https://you.com) | |
| `PERPLEXITY_API_KEY` | [Perplexity](https://perplexity.ai) | Sonar web search |
| `KIMI_API_KEY` | [Kimi](https://platform.kimi.com) | Currently disabled by default — routed via Scrapfly residential proxy. Requires `SCRAPFLY_API_KEY` too. |
| `PARALLEL_API_KEY` | [Parallel](https://parallel.ai) | |

### URL fetching — `fetch` tool + web_search grounding

| Variable | Purpose |
|----------|---------|
| `OMNIFETCH_ENDPOINT` | Base URL of the external [omnifetch](https://github.com/cjangrist/omnifetch) service. omnisearch POSTs `{"url": ...}` to `${OMNIFETCH_ENDPOINT}/web_fetch`. Public endpoint (no auth). Defaults to `http://127.0.0.1:8000` (local docker-compose). |
| `SCRAPFLY_API_KEY` | Scrapfly residential-proxy egress for the kimi search provider. |

### Snippet grounding (Cerebras) — `web_search` tool

Optional. When set, the top-20 RRF-ranked URLs are fetched (via omnifetch) and re-summarized in parallel.

| Variable | Purpose |
|----------|---------|
| `CEREBRAS_API_KEY` | Cerebras API key (`gpt-oss-120b`). Defaults baked into `src/config/env.ts`'s `config.snippet_grounding.llm` block. Default ON when key is present; per-call opt-out via `grounded_snippets:false`. |

### REST auth

```bash
OMNISEARCH_API_KEY=your-secret-key-here
# legacy alias (still honored if set; takes precedence when both are set):
# OPENWEBUI_API_KEY=your-secret-key-here
```

---

## Caching

`web_search` caches through Cloudflare KV with a **36-hour TTL** (129,600 seconds) and SHA-256-hashed keys. The `fetch` tool does not cache in omnisearch — it delegates to omnifetch, which may cache internally.

- **Key shape**: `search:<sha256(query+options)>`. SHA-256 keeps every key under KV's 512-byte limit regardless of input length.
- **Search cache binds query**: `make_cache_key(query, options)` adds a `\0sqf=true` suffix when `skip_quality_filter` is set, plus a `\0gnd=true` suffix when grounded snippets are active for the call, so raw / filtered / grounded / non-grounded fanouts don't collide. Defense-in-depth: cached entries also store `query` and are rejected if `cached.query !== query`.
- **Validators** (`is_valid_cached_*`): full structural validation on every read. A legacy or corrupted entry is silently treated as a miss so downstream code can never crash on undefined fields.
- **Partial fanouts are NOT cached**. If any search provider failed or timed out, the write is skipped — locking in a one-provider-short result for 36h would prevent recovery once the upstream comes back.
- **Cache hits return in ~80ms** regardless of edge location.

---

## Concurrency model

Cloudflare Workers is a single isolate handling many concurrent requests. Several invariants flow from that:

- **Per-request request_id**: `run_with_request_id(uuid, fn)` from `common/logger.ts` scopes the ID through `AsyncLocalStorage`. All `loggers.*` instances pull from the store, so log lines never cross-contaminate between concurrent requests.
- **Per-request execution context**: `r2_trace.ts` exposes `run_with_execution_context(ctx, fn)` backed by `AsyncLocalStorage<WaitUntilCapable>`. `flush_background()` reads the active ctx and calls `ctx.waitUntil(write_promise)`, so R2 trace writes always attach to the originating request — not to whatever request happens to be active at flush time.
- **Per-trace context**: `run_with_trace(trace, fn)` similarly scopes a `TraceContext` so providers can call `get_active_trace()?.record_*` without threading the context through every function.
- **Durable Object (`OmnisearchMCP`) ctx scoping (R4F01)**: each MCP tool callback closure captures its own `get_ctx` getter — `register_tools(server, () => this.ctx)` — instead of pulling from a shared field on the registry. Reason: `registry` is module-scoped and shared across DO instances in the same isolate, so a per-DO ctx field on the registry would be overwritten by the most recent registration. Capturing `get_ctx` per-closure keeps every `McpServer`'s handlers bound to the DO that registered them. Without this, MCP-invoked tool R2 traces become detached fire-and-forget promises that the runtime can cancel when the DO finishes its current invocation.
- **Atomic provider registry swap**: `initialize_providers()` builds new Sets locally, then assigns them to `active_providers` in one statement. Concurrent reads never see an empty state.
- **Init memoization**: both the Worker fetch path (`ensure_rest_initialized`) and the DO (`init`) memoize a successful initialization promise, but reset it to `undefined` on rejection so a transient secret-load failure doesn't permanently brick the isolate.
- **Cancellation**: search providers and the fanout accept `AbortSignal` and combine the external signal with deadline signals via `AbortSignal.any` (with a polyfill in `utils.ts/make_signal`).
- **`nodejs_compat` flag**: required in `wrangler.toml` so `node:async_hooks` AsyncLocalStorage is provided by workerd. Without it, request-id and execution-context scoping silently no-op, leading to log cross-contamination and orphaned R2 trace writes.

### SSE keepalive (Claude web 45s timeout workaround)

`/mcp` POST responses are streamed back as SSE. The `agents` package's DO transport doesn't emit keepalives. The Worker injects `event: ping\ndata: keepalive\n\n` every 5s **only between complete events** — the buffer is checked via `buffer_is_only_whitespace()` and pings interleave when the buffer is empty OR contains only SSE whitespace bytes (space / tab / LF / CR), so upstream / proxy whitespace heartbeats can't suppress every keepalive ping forever. When the buffer is whitespace-only it's flushed first — so heartbeats are forwarded to the client AND our pings keep firing on schedule. Partial events containing any non-whitespace byte still gate the ping (no mid-event corruption). Boundary detection is WHATWG-compliant (`\n\n`, `\r\n\r\n`, `\r\r`); chunks are kept as a list and only flattened when scanning, avoiding O(n^2) Uint8Array copies. A write lock (`safe_write`) serializes pump writes against interval pings.

---

## Tracing — R2

Every request to the two tools (and every nested HTTP call inside them — including the omnifetch call) is captured to `TRACE_BUCKET` (R2) as a single pretty-formatted JSON document. Path layout:

```
request_traces/tool={search|fetch|web_search}/date=YYYY-MM-DD/hour=HH/trace_id=<uuid>.json
```

Each document includes:

- `trace_id`, `parent_trace_id`
- `tool`, `started_at`, `completed_at`, `total_duration_ms`, `cache_hit`
- `request_environment` (query/url/options)
- `orchestrator.{strategy, active_providers, decisions[]}` — full decision log (`cache_hit`, `fanout_complete`, `grounding_*`, etc.)
- `providers_hit`, `providers_succeeded`, `providers_failed`
- `providers.<name>.{started_at, duration_ms, success, input, output, error, http_calls[]}` — full HTTP round-trip incl. request headers, request body, response headers, response body, response_size_bytes
- `final_result` — what was returned to the client

Sensitive query params (`api_key`, `key`, `token`, `app_id`, `x-api-key`, `apikey`) are redacted in log output (`http.ts/sanitize_url`) but NOT redacted in the R2 trace payload — the bucket is private and used for incident debugging.

`flush_background()` is fire-and-forget; attached to ctx.waitUntil when an active execution context is available, dropped silently otherwise.

---

## Architecture

```
                    +---------------------------------------------+
                    |            Cloudflare Worker                |
                    |                                             |
                    |  /health  /search  /fetch  /researcher  /mcp|
                    |     |        |       |         |       |   |
                    |     |        +----+--+---------+       |   |
                    |     |             |                    |   |
                    |     |       REST handlers       Durable Object
                    |     |       (Bearer auth,        OmnisearchMCP
                    |     |        CORS, body         (per-session)
                    |     |        size guards)             |   |
                    |     +-------------+------------------+    |
                    |                   |                       |
                    |          +--------+--------+              |
                    |          |  KV Cache (36h) |              |
                    |          +--------+--------+              |
                    |                   | miss                  |
                    |     +-------------+-------------+         |
                    |     v                           v         |
                    |  Web Search                     fetch_url |
                    |   Fanout                          |       |
                    |     |                             |       |
                    |     v                             v       |
                    |  RRF Rank                   omnifetch svc |
                    |  + Snippet                   /web_fetch   |
                    |  Collapse                        |        |
                    |     |                             |       |
                    |     v                             |       |
                    |  Cerebras Ground                 |       |
                    |  (top-N URLs via omnifetch)      |       |
                    |     |                             |       |
                    |     +-------------+---------------+       |
                    |                   v                       |
                    |            R2 Trace Bucket                |
                    |       (hive-partitioned per tool)         |
                    +---------------------------------------------+
```

### Key design decisions

1. **Reciprocal Rank Fusion** — `score = sum 1/(60 + rank)` per provider that returned the URL. No score calibration needed across providers with incompatible ranking schemes. Pages found by multiple engines float to the top.

2. **Snippet collapse** — when 2+ providers return the same URL, snippets are scored on bigram density times query-term relevance times log-length. If the runner-up is meaningfully different (Jaccard < 0.3), greedy sentence-level set cover within a 500-char budget produces a merged snippet. Otherwise the best single snippet is kept.

3. **Tail rescue** — after taking top-N, results from underrepresented domains in the tail are rescued if their per-provider intra-rank is < 2. Prevents SEO-dominated top results from drowning out niche-domain authoritative sources.

4. **Grounded snippets** — engine-supplied snippets are notoriously SEO-padded, off-topic, or boilerplate. After RRF picks the top-20, each URL is fetched via omnifetch (concurrency-capped, per-URL hard deadline) and Cerebras (`gpt-oss-120b`) writes a query-framed snippet from the actual page body. Pre-LLM junk detection (paywall / login-wall / cookie-wall / JS-shell / bot-challenge) and post-LLM sentinel detection (`[no usable content]`, `[navigation only]`, `[page not found]`, `[search results page]`, `[login required]`) fall back transparently to the original aggregated snippet (`snippet_source: 'fallback'`) so a single bad URL never breaks the result set. Failure outcomes are classified into buckets and reported via a single `grounding_aggregate` log line per call.

5. **Multi-provider fanout IS the redundancy strategy** — the search fanout deliberately doesn't retry individual providers (`retry_with_backoff` is NOT used here). Retrying doubles worst-case latency for rare gains; the fanout already has redundancy.

6. **Fetch is delegated, not duplicated** — omnisearch no longer runs a fetch waterfall. All URL fetching goes through the single `omnifetch_client.fetch_url()` → omnifetch `/web_fetch` REST call. The waterfall, its providers, breakers, skip_providers, and multi-winner racing live in the standalone omnifetch service.

7. **Failure isolation** — every search provider runs in its own promise. One provider's exception never crashes the others. Partial results are always returned with `providers_failed` metadata.

8. **All-failed → 502, not 200**: REST `/search` and `/researcher` return 502 with `{ error, failed_providers }` when every provider failed.

---

## Adding a new search provider

The codebase uses a registry pattern:

1. **Add env binding** in `src/types/env.ts`
2. **Add a config entry** in `src/config/env.ts` (`config.search.<name>`) and wire it in `initialize_config(env)`
3. **Implement adapter** in `src/providers/search/<name>/index.ts` exporting:
   - `class <Name>SearchProvider implements SearchProvider`
   - `export const registration = { key: () => config.search.<name>.api_key };`
4. **Register** — one line in `src/providers/unified/web_search.ts`'s `PROVIDERS` array
5. **Add to `.env.example`** for documentation

The registry auto-detects availability from environment variables; only providers with non-empty trimmed keys are instantiated. To add a **fetch provider**, work in the [omnifetch](https://github.com/cjangrist/omnifetch) repo instead — omnisearch no longer has fetch providers.

---

## Development

```bash
npm run typecheck    # tsc --noEmit
npm run dev          # wrangler dev (port 8787)
npm run deploy       # wrangler deploy
```

### Smoke tests (curl-based, no test framework)

There is no in-repo test framework — verification is done via the live REST endpoints and R2 trace inspection. (omnifetch must be running for the `/fetch` and grounded-snippet paths.)

```bash
# Health
curl http://localhost:8787/health

# REST search (no auth required when OMNISEARCH_API_KEY is unset)
curl -X POST http://localhost:8787/search \
  -H "Content-Type: application/json" \
  -d '{"query": "rust memory safety", "count": 5}'

# REST fetch (via omnifetch)
curl -X POST http://localhost:8787/fetch \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.reddit.com/r/LocalLLaMA/..."}'

# /researcher with query-param auth
curl "http://localhost:8787/researcher?query=test&api_key=$OMNISEARCH_API_KEY"
```

R2 traces are queryable via the partition path — list by tool, date, hour for any incident.

### Public deployment

`https://omnisearch-mcp.example.invalid/mcp` is open and unauthenticated; call directly without an API key.

---

## Acknowledgements

This project is inspired by and based on the work of **Scott Spence** and the original [**mcp-omnisearch**](https://github.com/spences10/mcp-omnisearch).

---

## License

MIT — see [LICENSE](LICENSE).
