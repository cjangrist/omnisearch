# Omnisearch MCP

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-1.27.1-green)](https://modelcontextprotocol.io/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange?logo=cloudflare)](https://workers.cloudflare.com/)
[![License](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

> **Multi-provider search, AI answers, and universal URL fetching — aggregated, ranked, and cached at the edge.**

Omnisearch MCP is a production-ready [Model Context Protocol](https://modelcontextprotocol.io/) server running on Cloudflare Workers with Durable Objects. It queries **9 web search engines** and **9 AI answer providers** in parallel, fetches content from **any URL** via a **26-provider waterfall**, and returns unified results with global KV caching.

---

## What makes this different

| Feature | Single Provider | Omnisearch |
|---------|----------------|------------|
| **Resilience** | Single point of failure | 40+ providers with automatic failover |
| **Search** | One engine's blind spots | 9 engines in parallel, RRF-ranked, cross-deduplicated |
| **AI Answers** | One model's perspective | Consensus across 9 AI providers with citations |
| **URL Fetching** | Blocked by paywalls, CAPTCHAs | 26-provider waterfall with social media extraction |
| **Performance** | Cold on every call | Global KV cache (36h TTL) — cache hits return in ~80ms |
| **Connectivity** | Timeout on long operations | SSE keepalive with event-boundary buffering |

---

## Three Tools

### `web_search` — 9-engine parallel search with RRF ranking

Fans out to Tavily, Brave, Kagi, Exa, Firecrawl, Perplexity, SerpAPI, Linkup, and You.com simultaneously. Deduplicates by URL, ranks using Reciprocal Rank Fusion, merges snippets with Jaccard-based sentence selection, and rescues high-quality results from underrepresented domains.

### `answer` — Consensus AI answers with citations

Queries up to 9 AI providers in parallel (Perplexity, Kagi FastGPT, Exa, Brave Answer, Tavily, ChatGPT, Claude, Gemini, plus Gemini Grounded with web search context). Returns all answers so you can see where providers agree and where they diverge. 2-minute deadline with AbortController cancellation.

### `fetch` — Universal URL content extraction

26-provider deep waterfall that gets clean content from any URL on the internet — paywalled articles, JavaScript SPAs, social media posts, PDFs. Domain breakers route specialized URLs first (YouTube to Supadata for transcripts, Reddit/LinkedIn/TikTok/Instagram to SociaVault for structured extraction), then walks a tiered waterfall of general-purpose fetchers with parallel racing and challenge-page detection.

---

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/cjangrist/omnisearch.git
cd omnisearch
npm ci

# 2. Set your API keys as Cloudflare secrets
npx wrangler secret put TAVILY_API_KEY
npx wrangler secret put BRAVE_API_KEY
# ... add as many providers as you want

# 3. Deploy
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

---

## Configuration

### Web Search Providers (at least one required)

| Variable | Provider | Best For |
|----------|----------|----------|
| `TAVILY_API_KEY` | [Tavily](https://tavily.com) | Academic/research queries |
| `BRAVE_API_KEY` | [Brave Search](https://brave.com/search/api/) | Privacy-focused, technical |
| `KAGI_API_KEY` | [Kagi](https://kagi.com) | High-quality curated results |
| `EXA_API_KEY` | [Exa](https://exa.ai) | AI-native neural search |
| `SERPAPI_API_KEY` | [SerpAPI](https://serpapi.com) | Google results |
| `LINKUP_API_KEY` | [Linkup](https://linkup.so) | Deep content extraction |
| `FIRECRAWL_API_KEY` | [Firecrawl](https://firecrawl.dev) | Structured web data |
| `YOU_API_KEY` | [You.com](https://you.com) | LLM-optimized snippets |
| `PERPLEXITY_API_KEY` | [Perplexity](https://perplexity.ai) | AI-cited search |

### AI Answer Providers (optional)

| Variable | Provider |
|----------|----------|
| `PERPLEXITY_API_KEY` | Perplexity Sonar |
| `KAGI_API_KEY` | Kagi FastGPT |
| `EXA_API_KEY` | Exa Answer |
| `BRAVE_ANSWER_API_KEY` | Brave Answer |
| `TAVILY_API_KEY` | Tavily Answer |
| `LLM_SEARCH_BASE_URL` + `LLM_SEARCH_API_KEY` | ChatGPT / Claude / Gemini via OpenAI-compatible endpoint |
| `GEMINI_GROUNDED_API_KEY` | Gemini with URL context grounding |

### Fetch Providers (optional, 26 available)

The fetch waterfall includes: Tavily, Firecrawl, Linkup, Cloudflare Browser, Diffbot, Olostep, Scrapfly, Scrapedo, Decodo, Zyte, BrightData, Jina, Spider, You, Scrapeless, ScrapingBee, ScrapeGraphAI, Scrappey, ScrapingAnt, Oxylabs, ScraperAPI, LeadMagic, OpenGraph, Supadata (YouTube transcripts), and SociaVault (social media).

### Social Media Extraction (via SociaVault)

| Platform | Content Returned |
|----------|-----------------|
| Reddit | Full post + all comments |
| Twitter/X | Tweet content + metadata |
| LinkedIn | Post text, author, engagement |
| YouTube | Video info (transcripts via Supadata) |
| Instagram | Post info + media URLs |
| TikTok | Video info + metadata |
| Facebook | Post content |
| Threads | Post content |
| Pinterest | Pin content |

### REST Authentication

```bash
OMNISEARCH_API_KEY=your-secret-key-here
```

---

## REST API

For non-MCP integrations (OpenWebUI, custom clients):

```bash
# Search
curl -X POST https://your-worker.workers.dev/search \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OMNISEARCH_API_KEY" \
  -d '{"query": "vector database comparison", "count": 10}'

# Fetch
curl -X POST https://your-worker.workers.dev/fetch \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OMNISEARCH_API_KEY" \
  -d '{"url": "https://www.linkedin.com/posts/..."}'

# Health
curl https://your-worker.workers.dev/health
# {"status":"ok","name":"omnisearch-mcp","version":"1.0.0","providers":40}
```

---

## Architecture

```
                    ┌─────────────────────────────────────────┐
                    │         Cloudflare Worker               │
                    │                                         │
                    │  /health  /search  /fetch  /mcp         │
                    │     │        │       │       │          │
                    │     │        └───┬───┘       │          │
                    │     │            │           │          │
                    │     │      REST handlers     │          │
                    │     │       (auth, CORS)      │          │
                    │     │            │           │          │
                    │     │            │      Durable Object  │
                    │     │            │       (MCP sessions)  │
                    │     │            │           │          │
                    │     └────────────┴───────────┘          │
                    │                  │                       │
                    │         ┌────────┴────────┐             │
                    │         │  KV Cache (36h) │             │
                    │         └────────┬────────┘             │
                    │                  │ miss                  │
                    │    ┌─────────────┼─────────────┐        │
                    │    ▼             ▼             ▼        │
                    │ Web Search   AI Answer    Fetch Race    │
                    │  Fanout       Fanout      Waterfall     │
                    │ (9 engines)  (9 providers) (26 providers)│
                    │    │             │             │        │
                    │    ▼             ▼             ▼        │
                    │ RRF Rank    Deadline +     Domain       │
                    │ + Snippet   AbortCtrl     Breakers +    │
                    │  Collapse                 Parallel Race │
                    └─────────────────────────────────────────┘
```

### Key Design Decisions

1. **Reciprocal Rank Fusion (RRF)** — `score = Σ 1/(k + rank)` with k=60. Pages found by multiple providers rank higher. No calibration needed across different scoring schemes.

2. **Intelligent Snippet Selection** — When multiple providers return the same URL, snippets are merged using bigram Jaccard similarity to detect diversity, then greedy sentence-level set cover maximizes information density.

3. **Tail Rescue** — After taking top-N results, high-quality results from underrepresented domains are rescued from the tail, preventing SEO-dominated results from drowning out niche but authoritative sources.

4. **SSE Keepalive with Event-Boundary Buffering** — The `answer` tool can take up to 2 minutes. An SSE keepalive mechanism injects `event: ping` between complete SSE events (never mid-event), with a write-lock serializer and WHATWG-compliant boundary detection (`\n\n`, `\r\n\r\n`, `\r\r`).

5. **Global KV Cache** — All three tools cache results in Cloudflare KV with 36-hour TTL and SHA-256 hashed keys. Cache hits return in ~80ms regardless of edge location. Only successful results are cached.

6. **AbortController Cancellation** — When deadlines fire, in-flight provider HTTP requests are cancelled via composed AbortSignals (with polyfill for `AbortSignal.any`). Search providers, AI providers, and the web search fanout all respect cancellation.

7. **Failure Isolation** — Each provider runs in its own promise with individual error handling. One provider's failure never crashes others. Partial results are always returned with failure metadata.

---

## Project Structure

```
src/
├── worker.ts                    # Worker + DO entrypoint, SSE keepalive, routing
├── types/
│   └── env.ts                   # Environment binding types
├── config/
│   └── env.ts                   # Config initialization & validation
├── common/
│   ├── types.ts                 # Core interfaces (SearchResult, FetchResult, ProviderError)
│   ├── http.ts                  # Streaming HTTP client with 5MB size guard
│   ├── utils.ts                 # AbortSignal composition, retry, auth, hashing
│   ├── logger.ts                # Structured JSON logging with AsyncLocalStorage
│   ├── search_operators.ts      # Query syntax parsing (site:, filetype:, etc.)
│   ├── rrf_ranking.ts           # RRF ranking, dedup, truncation, tail rescue
│   └── snippet_selector.ts      # Bigram Jaccard + greedy sentence merge
├── providers/
│   ├── index.ts                 # Provider initialization with atomic swap
│   ├── search/                  # 9 web search adapters
│   ├── ai_response/             # 7 AI answer adapters (+ 3 LLM via OpenAI bridge)
│   ├── fetch/                   # 26 URL fetch adapters
│   └── unified/                 # Dispatchers (web_search, ai_search, fetch)
└── server/
    ├── tools.ts                 # MCP tool registration with Zod schemas
    ├── handlers.ts              # MCP resource handlers (provider status/info)
    ├── web_search_fanout.ts     # Parallel search dispatch + RRF + KV cache
    ├── answer_orchestrator.ts   # AI fanout with deadline + abort + KV cache
    ├── fetch_orchestrator.ts    # Waterfall with breakers + parallel racing + KV cache
    ├── rest_search.ts           # REST /search endpoint
    └── rest_fetch.ts            # REST /fetch endpoint
```

---

## Adding a New Provider

The codebase uses a registry pattern. To add a new search provider:

1. **Add env binding** in `src/types/env.ts`
2. **Add config** in `src/config/env.ts`
3. **Implement adapter** in `src/providers/search/yourprovider/index.ts`
4. **Register** — one line in `src/providers/unified/web_search.ts`

No other changes needed. The registry auto-detects availability from environment variables and only instantiates providers with valid API keys.

---

## Development

```bash
npm run typecheck    # Type checking
npm run dev          # Local dev server (port 8787)
npm run deploy       # Deploy to Cloudflare Workers
```

```bash
# Health check (shows provider count)
curl http://localhost:8787/health

# REST search
curl -X POST http://localhost:8787/search \
  -H "Content-Type: application/json" \
  -d '{"query": "rust memory safety", "count": 5}'

# REST fetch
curl -X POST http://localhost:8787/fetch \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.reddit.com/r/LocalLLaMA/..."}'
```

---

## Acknowledgements

This project is inspired by and based on the work of **Scott Spence** and the original [**mcp-omnisearch**](https://github.com/spences10/mcp-omnisearch) project.

---

## License

MIT License — see [LICENSE](LICENSE) for details.
