# Omnisearch MCP

[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-blue?logo=typescript)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-1.29-green)](https://modelcontextprotocol.io/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange?logo=cloudflare)](https://workers.cloudflare.com/)
[![License](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

> Multi-provider search, AI answers, and universal URL fetching — aggregated, ranked, cached at the edge, and fully traced to R2.

Omnisearch MCP is a production-grade [Model Context Protocol](https://modelcontextprotocol.io/) server running on Cloudflare Workers + Durable Objects. It fans out queries to many search engines and AI answer providers in parallel, fetches content from any URL via a deep multi-provider waterfall, returns unified results with global KV caching, and writes every request/response to R2 for incident debugging.

---

## What makes this different

| Surface | Single Provider | Omnisearch |
|---------|----------------|------------|
| Resilience | Single point of failure | Many providers with automatic failover |
| Search | One engine's blind spots | Multiple engines in parallel, RRF-ranked, cross-deduplicated |
| Snippets | Engine-supplied (often boilerplate / SEO) | Top-N regenerated from actual page content via Groq, query-framed |
| AI Answers | One model's perspective | Consensus across multiple AI providers with citations |
| URL Fetching | Blocked by paywalls, CAPTCHAs | Multi-provider waterfall with social media extraction |
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
├── config.yaml                              # documentation copy of the fetch waterfall — runtime mirror is in fetch_orchestrator.ts
├── .env.example                             # documented env vars (secrets live in Doppler / wrangler secrets)
├── docs/                                    # postmortems, ROI analyses, multi-reviewer synthesis docs
│   ├── kimi-search-roi-analysis.md
│   ├── mcp-empty-payload-anomaly.md
│   ├── mcp-empty-payload-anomaly-v02.md
│   └── skip_providers_review_synthesis.md
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
    │   ├── types.ts                         # SearchResult, FetchResult, SearchProvider, FetchProvider, ProviderError
    │   └── utils.ts                         # AbortSignal.any polyfill, hash_key (SHA-256), retry_with_backoff, REST auth
    ├── config/
    │   └── env.ts                           # config object + initialize_config(env) + validate_config()
    ├── providers/
    │   ├── index.ts                         # initialize_providers() — atomic-swap registries
    │   ├── ai_response/                     # AI answer providers (5 named + 4 LLM bridge sub-providers + 1 special gemini-grounded)
    │   ├── fetch/                           # 28 URL fetch providers — markdown/text/structured extraction
    │   ├── search/                          # 11 web-search providers — query → ranked SearchResult[]
    │   └── unified/                         # provider-abstraction dispatchers — auto-built from registrations
    ├── server/
    │   ├── answer_orchestrator.ts           # parallel AI fanout + 295s deadline + AbortController + KV cache + gemini-grounded inline
    │   ├── fetch_orchestrator.ts            # waterfall + domain breakers + parallel multi-winner racing + KV cache + skip_providers
    │   ├── grounded_prompts.ts              # snippet-writer system prompt + junk + sentinel detectors
    │   ├── grounded_snippets.ts             # post-RRF Groq grounding stage — bounded worker pool + per-URL deadline + retry path
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

## Three Tools

### `web_search` — Parallel-fanout search with RRF ranking + grounded snippets

Fans out the same query to all configured search engines simultaneously. Deduplicates by URL (lowercase host + strip fragment + strip trailing slash), ranks with Reciprocal Rank Fusion (`score = sum 1/(60 + rank)`), collapses multi-provider snippets via bigram Jaccard plus greedy sentence-level set cover, and rescues high-quality results from underrepresented domains in the tail.

After ranking — if `GROQ_API_KEY` is set — a **grounded-snippet stage** kicks in: the top-20 URLs are fetched in parallel through the same waterfall the `fetch` tool uses, and Groq (`openai/gpt-oss-120b`) writes a query-framed snippet describing what each page actually says. The grounded snippet replaces the engine-supplied one. Each result reports `snippet_source` ∈ `{ aggregated, grounded, fallback }` so callers can see which path produced the snippet. Default ON; set `grounded_snippets:false` per call (or omit `GROQ_API_KEY`) to return raw aggregated provider snippets at minimum latency.

Tool input: `query`, optional `timeout_ms` (omitted = wait for all providers, full dedup), optional `include_snippets` (default `true`), optional `grounded_snippets` (default `true` when `GROQ_API_KEY` is configured).

### `answer` — Consensus AI answers with citations

Queries every configured AI provider in parallel — each independently searches the web and synthesizes its own answer with citations. When a Gemini-grounded key is configured AND a search provider exists, an extra `gemini-grounded` task feeds web_search_fanout results into Gemini's `url_context` tool. Returns all answers in one response so callers can compare consensus vs. divergence.

Hard global deadline 295 seconds (4 minutes 55 seconds); pending providers are aborted via `AbortController` and reported as `Timed out (global deadline)`. Only complete fanouts (zero failed/timed-out providers) are cached — partial results would otherwise lock a one-provider-short answer in for 36 hours.

Tool input: `query` only.

### `fetch` — Universal URL content extraction

Deep waterfall that resolves clean content from any public URL:

1. **Domain breakers** (in order): GitHub URLs to the `github` provider, YouTube URLs to `supadata` (transcripts), social-media URLs to `sociavault` (Reddit, Twitter/X, LinkedIn, TikTok, Instagram, Facebook, Threads, Pinterest, etc.).
2. **Waterfall** (top-to-bottom, configured in `fetch_orchestrator.ts CONFIG.waterfall` — `config.yaml` is documentation only):
   - solo: tavily, then firecrawl, then kimi
   - parallel: linkup + cloudflare_browser
   - parallel: diffbot + olostep
   - parallel: scrapfly + scrapedo + decodo
   - solo: zyte, then brightdata
   - sequential fallback: jina, spider, you, scrapeless, scrapingbee, scrapegraphai, scrappey, scrapingant, oxylabs, scraperapi, leadmagic, opengraph
3. **Failure detection**: rejects any result with content under 200 chars (except API-native providers `github` and `supadata`) or matching one of the challenge patterns (`captcha`, `just a moment`, `cf-browser-verification`, `access denied`, etc.).

Tool inputs:
- `url` (required)
- `skip_providers` — comma-separated string OR JSON-encoded array OR native string-array. Triggers a **2-provider fanout** (returning the second under `alternative_results` for cross-provider validation), bypasses the cache, and roughly doubles cost+latency. Validated against the active provider set; typos are rejected at the MCP and REST layers, with a defense-in-depth pass at orchestrator entry.

`skip_providers` exists ONLY on the `fetch` tool. The `answer` and `web_search` tools do not accept it.

---

## Quick Start

```bash
# 1. Install
git clone https://github.com/cjangrist/omnisearch.git
cd omnisearch
npm ci

# 2. Set Cloudflare secrets — at minimum one search/answer/fetch key each
npx wrangler secret put TAVILY_API_KEY
npx wrangler secret put FIRECRAWL_API_KEY
# ... see "Configuration" below for the full list

# 3. Optional: protect REST endpoints behind a Bearer token
npx wrangler secret put OMNISEARCH_API_KEY

# 4. Deploy
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

The public deployment at `https://omnisearch-mcp.cjangrist.workers.dev/mcp` is unauthenticated for MCP — call it directly without an API key.

---

## REST API

### Endpoints

| Path | Method | Purpose | Auth |
|------|--------|---------|------|
| `/health`, `/` | GET | Liveness + active-provider count | none |
| `/search` | POST | Search fanout, returns `[{ link, title, snippet }]`. Body accepts `grounded_snippets:false` to skip the Groq grounding stage. | Bearer (if configured) |
| `/fetch` | POST | URL fetch, returns full extraction with `alternative_results` when `skip_providers` set | Bearer (if configured) |
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

# Fetch (with cross-provider validation — bypasses cache, returns 2 results)
curl -X POST https://your-worker.workers.dev/fetch \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OMNISEARCH_API_KEY" \
  -d '{"url": "https://www.linkedin.com/posts/...", "skip_providers": "tavily"}'

# Researcher (compatible with RETRIEVER=custom in GPT-Researcher)
curl "https://your-worker.workers.dev/researcher?query=rust+memory+safety&api_key=$OMNISEARCH_API_KEY"

# Health — actual provider count varies by which keys are configured
curl https://your-worker.workers.dev/health
# {"status":"ok","name":"omnisearch-mcp","version":"1.0.0","providers":47}
```

---

## Configuration

Secrets are managed via `wrangler secret put` (or the Doppler-based workflow described in `.env.example`). `wrangler.toml` only contains bindings — no secret values.

### Web Search providers (10) — `web_search` tool

Set at least one. Several keys are shared with the corresponding answer / fetch provider.

| Variable | Provider | Notes |
|----------|----------|-------|
| `TAVILY_API_KEY` | [Tavily](https://tavily.com) | Shared with `tavily_answer` + tavily fetch |
| `BRAVE_API_KEY` | [Brave](https://search.brave.com) | Brave Web Search (separate key from `BRAVE_ANSWER_API_KEY`) |
| `KAGI_API_KEY` | [Kagi](https://kagi.com) | Shared with `kagi_fastgpt` |
| `EXA_API_KEY` | [Exa](https://exa.ai) | Neural search; shared with `exa_answer` |
| `SERPAPI_API_KEY` | [SerpAPI](https://serpapi.com) | `google_light` engine; key reused for fetch (YouTube transcripts) |
| `LINKUP_API_KEY` | [Linkup](https://linkup.so) | Shared with linkup fetch |
| `FIRECRAWL_API_KEY` | [Firecrawl](https://firecrawl.dev) | Shared with firecrawl fetch |
| `YOU_API_KEY` | [You.com](https://you.com) | Shared with you fetch |
| `PERPLEXITY_API_KEY` | [Perplexity](https://perplexity.ai) | Sonar; shared with `perplexity` answer |
| `KIMI_API_KEY` | [Kimi](https://platform.kimi.com) | Currently disabled by default per ROI analysis — see `docs/kimi-search-roi-analysis.md`. Requires `SCRAPFLY_API_KEY` too. |

### AI Answer providers — `answer` tool

| Variable | Provider |
|----------|----------|
| `PERPLEXITY_API_KEY` | Perplexity Sonar Pro (1024 max_tokens) |
| `KAGI_API_KEY` | Kagi FastGPT (~900ms typical) |
| `EXA_API_KEY` | Exa Answer (livecrawl=fallback) |
| `BRAVE_ANSWER_API_KEY` | Brave Answer (SSE streaming with inline citation tags) |
| `TAVILY_API_KEY` | Tavily Answer (`include_answer=advanced`) |
| `LLM_SEARCH_BASE_URL` + `LLM_SEARCH_API_KEY` | OpenAI-compatible bridge — registers 4 separate provider entries (`chatgpt`, `claude`, `gemini`, `kimi`) sharing the same endpoint. Optional model overrides: `LLM_SEARCH_CHATGPT_MODEL`, `LLM_SEARCH_CLAUDE_MODEL`, `LLM_SEARCH_GEMINI_MODEL`, `LLM_SEARCH_KIMI_MODEL`. |
| `GEMINI_GROUNDED_API_KEY` | Native Gemini API with `url_context` tool — invoked specially: receives `web_search_fanout` results as grounding sources. Optional `GEMINI_GROUNDED_MODEL`. |

### Fetch providers (28) — `fetch` tool

Several keys are shared with search:

| Variable | Provider | Notes |
|----------|----------|-------|
| `TAVILY_API_KEY` | Tavily Extract | shared |
| `FIRECRAWL_API_KEY` | Firecrawl `/v2/scrape` `onlyMainContent` | shared |
| `JINA_API_KEY` | Jina Reader | token-efficient |
| `YOU_API_KEY` | You.com Contents | shared |
| `BRIGHT_DATA_API_KEY` (+ optional `BRIGHT_DATA_ZONE`, default `unblocker`) | Bright Data Web Unlocker | |
| `LINKUP_API_KEY` | Linkup `/v1/fetch` | shared |
| `DIFFBOT_TOKEN` | Diffbot Article API | structured extraction |
| `SOCIAVAULT_API_KEY` | SociaVault | social-media routing |
| `SPIDER_CLOUD_API_TOKEN` | Spider.cloud `/scrape` | |
| `SCRAPFLY_API_KEY` | Scrapfly `/scrape` | also used as residential proxy for Kimi |
| `SCRAPEGRAPHAI_API_KEY` | ScrapeGraphAI `/v1/markdownify` | |
| `SCRAPE_DO_API_TOKEN` | Scrape.do | |
| `SCRAPELESS_API_KEY` | Scrapeless Web Unlocker | JS render |
| `OPENGRAPH_IO_API_KEY` | OpenGraph.io Extract | structured tag extraction |
| `SCRAPINGBEE_API_KEY` | ScrapingBee | |
| `SCRAPERAPI_API_KEY` | ScraperAPI | |
| `ZYTE_API_KEY` | Zyte automatic extraction | |
| `SCRAPINGANT_API_KEY` | ScrapingAnt `/v2/markdown` LLM-ready | |
| `OXYLABS_WEB_SCRAPER_USERNAME` + `OXYLABS_WEB_SCRAPER_PASSWORD` | Oxylabs Realtime | |
| `OLOSTEP_API_KEY` | Olostep | JS rendering + residential by default |
| `DECODO_WEB_SCRAPING_API_KEY` | Decodo (Smartproxy) | base64-encoded `user:pass` |
| `SCRAPPEY_API_KEY` | Scrappey headless browser | returns innerText |
| `LEADMAGIC_API_KEY` | LeadMagic Web2MD | |
| `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_EMAIL` + `CLOUDFLARE_API_KEY` | Cloudflare Browser Rendering | all three required to register |
| `SERPAPI_API_KEY` | SerpAPI YouTube transcript engine | YouTube-only fetch; shared with search |
| `SUPADATA_API_KEY` | Supadata YouTube transcripts | sync/async (HTTP 202 + polling) dual-mode |
| `GITHUB_API_KEY` | GitHub fetcher | LLM-optimized REST + GraphQL multi-resource (issues, PRs, files, gists, releases, commits, repo overview) |
| `KIMI_API_KEY` | Kimi (Moonshot AI) coding-agent fetch | requires `SCRAPFLY_API_KEY` — routed via Scrapfly residential proxy because api.kimi.com WAF blocks Cloudflare-Workers ASN |

### Snippet grounding (Groq) — `web_search` tool

Optional. When set, the top-20 RRF-ranked URLs are fetched and re-summarized in parallel.

| Variable | Purpose |
|----------|---------|
| `GROQ_API_KEY` | Groq API key. Defaults: model `openai/gpt-oss-120b`, base `https://api.groq.com/openai/v1`, concurrency 3, per-URL deadline 15 s, page-body truncation 24 000 chars. Defaults are baked into `src/config/env.ts`'s `config.snippet_grounding.groq` block — no other tunable env vars. Default ON when key is present; per-call opt-out via `grounded_snippets:false`. |

### REST auth

```bash
OMNISEARCH_API_KEY=your-secret-key-here
# legacy alias (still honored if set; takes precedence when both are set):
# OPENWEBUI_API_KEY=your-secret-key-here
```

### Social media extraction (via SociaVault domain breaker)

| Platform | API endpoint | Returns |
|----------|--------------|---------|
| Reddit | `/v1/scrape/reddit/post/comments` | post + all comments |
| Twitter/X | `/v1/scrape/twitter/tweet` | tweet content + metadata |
| YouTube | `/v1/scrape/youtube/video` | video info (transcripts come from Supadata's earlier breaker) |
| Facebook | `/v1/scrape/facebook/post` | post content |
| Instagram | `/v1/scrape/instagram/post-info` | post info + media URLs |
| TikTok | `/v1/scrape/tiktok/video-info` | video info |
| LinkedIn | `/v1/scrape/linkedin/post` | post text + author + engagement |
| Threads | `/v1/scrape/threads/post` | post content |
| Pinterest | `/v1/scrape/pinterest/pin` | pin content |

---

## Caching

All three tools cache through Cloudflare KV with a **36-hour TTL** (129,600 seconds) and SHA-256-hashed keys.

- **Key shape**: `<prefix>:<sha256(value)>` where prefix is `search:`, `answer:`, or `fetch:`. SHA-256 keeps every key under KV's 512-byte limit regardless of input length.
- **Search cache binds query**: `make_cache_key(query, options)` adds a `\0sqf=true` suffix when `skip_quality_filter` is set, plus a `\0gnd=true` suffix when grounded snippets are active for the call, so raw / filtered / grounded / non-grounded fanouts don't collide. Defense-in-depth: cached entries also store `query` and are rejected if `cached.query !== query`.
- **Answer cache binds query**: same query-echo defense.
- **Fetch cache binds requested URL**: cached entries store `requested_url`; the read path requires `cached.requested_url === url`. The MCP tool's `skip_providers` path bypasses the cache entirely and skips the cache write — preserving the multi-provider compare semantic (returning two different providers under `alternative_results` would otherwise pollute the singular cache).
- **Validators** (`is_valid_cached_*` in each orchestrator): full structural validation on every read. A legacy or corrupted entry is silently treated as a miss so downstream code can never crash on undefined fields.
- **Partial fanouts are NOT cached**. If any provider failed or timed out, search and answer skip the write — locking in a one-provider-short result for 36h would prevent recovery once the upstream comes back.
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
- **Cancellation**: search providers, AI providers, and the fanouts all accept `AbortSignal` and combine the external signal with deadline signals via `AbortSignal.any` (with a polyfill in `utils.ts/make_signal`). When the answer fanout's 295s deadline fires, the orchestrator calls `abort_controller.abort()` to cancel in-flight provider HTTP requests; late-arriving promises are guarded with an `is_done` flag so they can't mutate result arrays after the deadline.
- **`nodejs_compat` flag**: required in `wrangler.toml` so `node:async_hooks` AsyncLocalStorage is provided by workerd. Without it, request-id and execution-context scoping silently no-op, leading to log cross-contamination and orphaned R2 trace writes.

### SSE keepalive (Claude web 45s timeout workaround)

`/mcp` POST responses are streamed back as SSE. The `agents` package's DO transport doesn't emit keepalives. The Worker injects `event: ping\ndata: keepalive\n\n` every 5s **only between complete events** — the buffer is checked via `buffer_is_only_whitespace()` and pings interleave when the buffer is empty OR contains only SSE whitespace bytes (space / tab / LF / CR), so upstream / proxy whitespace heartbeats can't suppress every keepalive ping forever. (Pre-2026-05-04 the gate was a bare `total_len === 0` check; a single bare `\n` byte from any intermediate layer accumulated forever, suppressed pings, and let Cloudflare's edge tear the connection down client-side.) When the buffer is whitespace-only it's flushed first — so heartbeats are forwarded to the client AND our pings keep firing on schedule. Partial events containing any non-whitespace byte still gate the ping (no mid-event corruption). Boundary detection is WHATWG-compliant (`\n\n`, `\r\n\r\n`, `\r\r`); chunks are kept as a list and only flattened when scanning, avoiding O(n^2) Uint8Array copies. A write lock (`safe_write`) serializes pump writes against interval pings.

---

## Tracing — R2

Every request to the three tools (and every nested HTTP call inside them) is captured to `TRACE_BUCKET` (R2) as a single pretty-formatted JSON document. Path layout:

```
request_traces/tool={search|answer|fetch|web_search}/date=YYYY-MM-DD/hour=HH/trace_id=<uuid>.json
```

Each document includes:

- `trace_id`, `parent_trace_id` (e.g. answer fanout's gemini-grounded child links to the inner web_search trace)
- `tool`, `started_at`, `completed_at`, `total_duration_ms`, `cache_hit`
- `request_environment` (query/url/options)
- `orchestrator.{strategy, active_providers, decisions[]}` — full decision log (`waterfall_step`, `breaker_match`, `cache_hit`, `fanout_complete`, etc.)
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
                    |     v             v             v         |
                    |  Web Search   AI Answer    Fetch Race     |
                    |   Fanout       Fanout       Waterfall     |
                    |     |             |             |         |
                    |     v             v             v         |
                    |  RRF Rank    Deadline +     Domain        |
                    |  + Snippet   AbortCtrl     Breakers +     |
                    |  Collapse    + Gemini      Multi-Winner   |
                    |     |        Grounded      Parallel Race  |
                    |     v             |             |         |
                    |  Groq Ground      |             |         |
                    |  (top-N URLs)     |             |         |
                    |     |             |             |         |
                    |     +-------------+-------------+         |
                    |                   v                       |
                    |            R2 Trace Bucket                |
                    |       (hive-partitioned per tool)         |
                    +---------------------------------------------+
```

### Key design decisions

1. **Reciprocal Rank Fusion** — `score = sum 1/(60 + rank)` per provider that returned the URL. No score calibration needed across providers with incompatible ranking schemes. Pages found by multiple engines float to the top.

2. **Snippet collapse** — when 2+ providers return the same URL, snippets are scored on bigram density times query-term relevance times log-length. If the runner-up is meaningfully different (Jaccard < 0.3), greedy sentence-level set cover within a 500-char budget produces a merged snippet. Otherwise the best single snippet is kept.

3. **Tail rescue** — after taking top-N, results from underrepresented domains in the tail are rescued if their per-provider intra-rank is < 2. Prevents SEO-dominated top results from drowning out niche-domain authoritative sources.

4. **Grounded snippets** — engine-supplied snippets are notoriously SEO-padded, off-topic, or boilerplate. After RRF picks the top-20, each URL is fetched through the same waterfall the `fetch` tool uses (concurrency-capped to 3, per-URL hard deadline 15 s) and Groq (`openai/gpt-oss-120b`) writes a query-framed snippet from the actual page body. Pre-Groq pattern detection (paywall / login-wall / cookie-wall / JS-shell / bot-challenge) and post-Groq sentinel detection (`[no usable content]`, `[navigation only]`, `[page not found]`, `[search results page]`, `[login required]`) trigger a single retry through the waterfall with `skip_providers={attempt-1 winner}` — the search engines have already vouched for relevance, so a second fetcher is more useful than re-asking the model. Failures fall back transparently to the original aggregated snippet (`snippet_source: 'fallback'`) so a single bad URL never breaks the result set. Failure outcomes are classified into 8 buckets and reported via a single `grounding_aggregate` log line per call (grounded ratio, p50/p95/max latency, provider wins, retry count, timeout count). The model choice (120B over 20B) is deliberate — the 20B emitted degenerate-sampling output under detailed-prompt + 6k-token-context load.

5. **Multi-provider fanout IS the redundancy strategy** — `answer_orchestrator` deliberately doesn't retry individual providers (`retry_with_backoff` is NOT used here). Retrying doubles worst-case latency for rare gains; the fanout already has redundancy.

6. **Multi-winner parallel race in fetch** — when `skip_providers` triggers `target_count = 2`, parallel steps collect successes up to the target rather than `Promise.any`-ing the first. Once settled, late-arriving rejections are dropped from both `ctx.failed` and the trace — the public response and the trace tell the same story.

7. **Empty-active-set guard** — if every active fetch provider was filtered out by `skip_providers`, the orchestrator throws `INVALID_INPUT` (REST → 400) instead of running the waterfall to exhaustion and emitting a misleading 502 with `"Tried: <empty>"`.

8. **Failure isolation** — every provider runs in its own promise. One provider's exception never crashes the others. Partial results are always returned with `providers_failed` metadata.

9. **All-failed → 502, not 200**: REST `/search` and `/researcher` return 502 with `{ error, failed_providers }` when every provider failed.

---

## Adding a new provider

The codebase uses a registry pattern. Adding a search provider:

1. **Add env binding** in `src/types/env.ts`
2. **Add a config entry** in `src/config/env.ts` (`config.search.<name>`) and wire it in `initialize_config(env)`
3. **Implement adapter** in `src/providers/search/<name>/index.ts` exporting:
   - `class <Name>SearchProvider implements SearchProvider`
   - `export const registration = { key: () => config.search.<name>.api_key };`
4. **Register** — one line in `src/providers/unified/web_search.ts`'s `PROVIDERS` array
5. **Add to `.env.example`** for documentation

The registry auto-detects availability from environment variables; only providers with non-empty trimmed keys are instantiated. Same flow for `ai_response/` and `fetch/`. For fetch, also consider whether the new provider needs a slot in `fetch_orchestrator.ts CONFIG.waterfall` (and a parallel update to `config.yaml` if the YAML is meant to stay in sync as documentation).

---

## Development

```bash
npm run typecheck    # tsc --noEmit
npm run dev          # wrangler dev (port 8787)
npm run deploy       # wrangler deploy
```

### Smoke tests (curl-based, no test framework)

There is no in-repo test framework — verification is done via the live REST endpoints, R2 trace inspection, and the multi-reviewer hydra-heads workflow (see `docs/skip_providers_review_synthesis.md` for an example).

```bash
# Health
curl http://localhost:8787/health

# REST search (no auth required when OMNISEARCH_API_KEY is unset)
curl -X POST http://localhost:8787/search \
  -H "Content-Type: application/json" \
  -d '{"query": "rust memory safety", "count": 5}'

# REST fetch
curl -X POST http://localhost:8787/fetch \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.reddit.com/r/LocalLLaMA/..."}'

# REST fetch with cross-provider validation (returns alternative_results)
curl -X POST http://localhost:8787/fetch \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/article", "skip_providers": "tavily,firecrawl"}'

# /researcher with query-param auth
curl "http://localhost:8787/researcher?query=test&api_key=$OMNISEARCH_API_KEY"
```

R2 traces are queryable via the partition path — list by tool, date, hour for any incident.

### Public deployment

`https://omnisearch-mcp.cjangrist.workers.dev/mcp` is open and unauthenticated; call directly without an API key.

### Known issues

- **Empty MCP envelope under high concurrency** — see `docs/mcp-empty-payload-anomaly.md`. Under 3+ concurrent long-running answer calls, ~20% return empty JSON-RPC envelopes. Workaround: serial calls. Not fixed at time of writing.

---

## Acknowledgements

This project is inspired by and based on the work of **Scott Spence** and the original [**mcp-omnisearch**](https://github.com/spences10/mcp-omnisearch).

---

## License

MIT — see [LICENSE](LICENSE).
