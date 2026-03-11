# Omnisearch MCP

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-1.27-green)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

> **Multi-provider search aggregation with intelligent ranking.**

Omnisearch MCP is a production-ready [Model Context Protocol](https://modelcontextprotocol.io/) server that queries **9+ web search engines** and **6+ AI answer providers** in parallel, deduplicates results using [Reciprocal Rank Fusion](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf), and returns unified, ranked responses with full provenance.

---

## ✨ What makes this different

| Feature | Single Provider | Omnisearch |
|---------|----------------|------------|
| **Resilience** | Single point of failure | 9+ providers in parallel; graceful degradation |
| **Coverage** | One index's blind spots | Cross-engine deduplication finds hidden gems |
| **Quality** | Raw provider results | RRF ranking + snippet intelligence + quality filters |
| **AI Answers** | One model's perspective | Consensus across Perplexity, Kagi, Exa, Brave, Tavily, You.com |
| **Integration** | Custom code per provider | Single MCP tool or REST endpoint |

---

## 🚀 Quick Start

```bash
# 1. Clone and install
git clone https://github.com/yourusername/omnisearch-mcp.git
cd omnisearch-mcp
npm ci

# 2. Configure your API keys (see .env.example)
cp .env.example .env
# Edit .env with your provider keys

# 3. Run locally
npm run dev

# 4. Deploy
npm run deploy
```

Configure your MCP client to point to your deployed endpoint.

---

## 🔧 Configuration

### Required: At least one web search provider

Set any of these environment variables:

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

### Optional: AI Answer providers

For the `answer` tool (consensus across AI search):

| Variable | Provider |
|----------|----------|
| `PERPLEXITY_API_KEY` | Perplexity Sonar |
| `KAGI_API_KEY` | Kagi FastGPT |
| `EXA_API_KEY` | Exa Answer |
| `BRAVE_ANSWER_API_KEY` | Brave Answer |
| `TAVILY_API_KEY` | Tavily Answer |
| `YOU_API_KEY` | You.com Agent |
| `LLM_SEARCH_BASE_URL` | Custom Claude/Gemini/Codex endpoint |

### Optional: REST Authentication

Protect the `/search` REST endpoint:

```bash
OMNISEARCH_API_KEY=your-secret-key-here
```

Then use:
```http
POST /search
Authorization: Bearer your-secret-key-here
Content-Type: application/json

{"query": "latest rust async runtime"}
```

---

## 🛠️ Usage

### As an MCP Tool (Recommended)

Configure your MCP client (Claude Desktop, Cursor, etc.):

```json
{
  "mcpServers": {
    "omnisearch": {
      "url": "https://your-deployment-url/mcp"
    }
  }
}
```

Now your AI assistant has two powerful tools:

#### `web_search` — Deep web coverage

```typescript
// The AI calls this tool with:
{
  "query": "tokio vs async-std performance 2024",
  "timeout_ms": 15000,        // Optional: early return for latency
  "include_snippets": true    // Include page content snippets
}

// Returns:
{
  "query": "tokio vs async-std performance 2024",
  "total_duration_ms": 3420,
  "providers_succeeded": [
    {"provider": "tavily", "duration_ms": 890},
    {"provider": "brave", "duration_ms": 450},
    {"provider": "kagi", "duration_ms": 1200}
  ],
  "providers_failed": [],
  "truncation": {
    "total_before": 47,
    "kept": 15,
    "rescued": 3    // Low-rank but diverse domains added back
  },
  "web_results": [
    {
      "title": "Async Rust: Tokio vs Async-std Benchmarks",
      "url": "https://example.com/benchmarks",
      "snippets": ["Tokio shows 15% better throughput..."],
      "source_providers": ["tavily", "brave"],  // Found by both!
      "score": 0.892
    }
  ]
}
```

#### `answer` — Consensus across AI search

```typescript
// The AI calls:
{
  "query": "What are the main differences between tokio and async-std?"
}

// Returns multiple AI perspectives:
{
  "providers_queried": ["perplexity", "kagi_fastgpt", "exa_answer", "web_search"],
  "providers_succeeded": ["perplexity", "kagi_fastgpt", "exa_answer", "web_search"],
  "answers": [
    {
      "source": "perplexity",
      "answer": "Tokio is the most mature async runtime...",
      "duration_ms": 2100,
      "citations": [
        {"title": "Tokio Documentation", "url": "https://tokio.rs", "snippet": "..."}
      ]
    },
    {
      "source": "kagi_fastgpt", 
      "answer": "While both implement the Future trait...",
      "duration_ms": 920,
      "citations": [...]
    }
  ]
}
```

> **Why multiple answers?** When providers agree, you can be confident. When they disagree, you know the topic has genuine nuance or debate.

### REST API

For non-MCP integrations (OpenWebUI, custom clients):

```bash
curl -X POST https://your-deployment-url/search \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OMNISEARCH_API_KEY" \
  -d '{
    "query": "vector database comparison 2024",
    "count": 10,
    "raw": false
  }'
```

Response:
```json
[
  {
    "link": "https://www.pinecone.io/learn/vector-database/",
    "title": "What is a Vector Database?",
    "snippet": "A vector database is a purpose-built database..."
  }
]
```

Parameters:
- `query` (string, required, max 2000 chars)
- `count` (number, optional) — max results to return
- `raw` (boolean, optional, default false) — skip quality filtering

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Request Handler                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   /health    │  │    /mcp      │  │   /search    │      │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      │
│         │                 │                   │             │
│         └─────────────────┼───────────────────┘             │
│                           ▼                                 │
│              ┌─────────────────────────┐                    │
│              │   Provider Registry     │                    │
│              │  (auto-detects active   │                    │
│              │   providers from env)   │                    │
│              └───────────┬─────────────┘                    │
│                          ▼                                  │
│         ┌────────────────────────────────┐                  │
│         │      Parallel Fanout           │                  │
│  ┌──────┴──────┐  ┌──────┴──────┐  ┌────┴────┐             │
│  │   Tavily    │  │    Brave    │  │  Kagi   │  ... 9 total │
│  └──────┬──────┘  └──────┬──────┘  └────┬────┘             │
│         └─────────────────┼────────────────┘                │
│                           ▼                                 │
│              ┌─────────────────────────┐                    │
│              │   RRF Ranking Engine    │                    │
│              │  - Normalize URLs       │                    │
│              │  - Score by rank position│                   │
│              │  - Rescue diverse tail   │                    │
│              └───────────┬─────────────┘                    │
│                          ▼                                  │
│              ┌─────────────────────────┐                    │
│              │ Snippet Intelligence    │                    │
│              │  - Jaccard dedup        │                    │
│              │  - Query relevance      │                    │
│              │  - Greedy sentence merge │                   │
│              └───────────┬─────────────┘                    │
│                          ▼                                  │
│              ┌─────────────────────────┐                    │
│              │   Quality Filtering     │                    │
│              │  - Min score thresholds │                    │
│              │  - Min snippet length   │                    │
│              │  - Multi-source boost   │                    │
│              └─────────────────────────┘                    │
└─────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

1. **Reciprocal Rank Fusion (RRF)**
   - Formula: `score = Σ 1/(k + rank)` where k=60
   - Pages found by multiple providers rank higher
   - No calibration needed across different scoring schemes

2. **Intelligent Snippet Selection**
   - When multiple providers return the same URL, we don't just pick one snippet
   - Bigram Jaccard similarity detects diversity
   - Diverse snippets are merged with greedy sentence-level set cover
   - Query-relevance scoring ensures topical focus

3. **Tail Rescue**
   - After taking top-N results, we scan the tail
   - Results from novel domains (not in top-N) with good intra-provider rank get rescued
   - Prevents "9 results from SEO farms, 1 from obscure goldmine" scenarios

4. **Failure Isolation**
   - Each provider times out independently
   - Partial results are returned with failure metadata
   - Clients always get something useful, never a total timeout

---

## 📁 Project Structure

```
src/
├── worker.ts                    # Worker entrypoint
├── types/
│   └── env.ts                   # Environment binding types
├── config/
│   └── env.ts                   # Config initialization & validation
├── common/
│   ├── types.ts                 # Core interfaces (SearchResult, ProviderError)
│   ├── http.ts                  # Safe HTTP client with size limits
│   ├── utils.ts                 # Retry logic, error handling
│   ├── search_operators.ts      # Query syntax parsing (site:, filetype:, etc.)
│   ├── rrf_ranking.ts           # Ranking, dedup, truncation, quality filters
│   └── snippet_selector.ts      # Snippet scoring, merging, dedup
├── providers/
│   ├── index.ts                 # Provider initialization orchestration
│   ├── search/                  # Web search adapters
│   │   ├── tavily/
│   │   ├── brave/
│   │   ├── kagi/
│   │   ├── exa/
│   │   ├── firecrawl/
│   │   ├── perplexity/
│   │   ├── serpapi/
│   │   ├── linkup/
│   │   └── you/
│   ├── ai_response/             # AI answer adapters
│   │   ├── perplexity/
│   │   ├── kagi_fastgpt/
│   │   ├── exa_answer/
│   │   ├── brave_answer/
│   │   ├── tavily_answer/
│   │   ├── you_search/
│   │   └── llm_search/          # Claude/Gemini/Codex bridge
│   └── unified/
│       ├── web_search.ts        # Web provider dispatcher
│       └── ai_search.ts         # AI provider dispatcher
└── server/
    ├── tools.ts                 # MCP tool registration
    ├── handlers.ts              # MCP resource handlers
    ├── web_search_fanout.ts     # Web parallelization logic
    ├── answer_orchestrator.ts   # AI parallelization logic
    └── rest_search.ts           # REST endpoint implementation
```

---

## 🔌 Adding a New Provider

The codebase uses a registry pattern. To add a new provider:

1. **Add environment binding** (`src/types/env.ts`):
```typescript
NEWPROVIDER_API_KEY?: string;
```

2. **Add config** (`src/config/env.ts`):
```typescript
newprovider: {
  api_key: undefined as string | undefined,
  base_url: 'https://api.newprovider.com',
  timeout: 30000,
}
```

3. **Implement adapter** (`src/providers/search/newprovider/index.ts`):
```typescript
export class NewproviderSearchProvider implements SearchProvider {
  name = 'newprovider';
  description = '...';
  
  async search(params: BaseSearchParams): Promise<SearchResult[]> {
    // Fetch, transform, return
  }
}

export const registration = {
  key: () => config.search.newprovider.api_key,
};
```

4. **Register in dispatcher** (`src/providers/unified/web_search.ts`):
```typescript
import { NewproviderSearchProvider, registration as newprovider_reg } from '../search/newprovider/index.js';

const PROVIDERS = [
  // ... existing providers
  { name: 'newprovider', ...newprovider_reg, factory: () => new NewproviderSearchProvider() },
] as const;
```

No other changes needed. The registry auto-detects availability from environment variables.

---

## 🧪 Development

```bash
# Type checking
npm run typecheck

# Local dev server
npm run dev

# Deploy to Cloudflare Workers
npm run deploy
```

### Testing locally with curl

```bash
# Health check
curl http://localhost:8787/health

# REST search (no auth in dev unless configured)
curl -X POST http://localhost:8787/search \
  -H "Content-Type: application/json" \
  -d '{"query": "rust memory safety", "count": 5}'
```

---

## 🐛 Troubleshooting

### No providers available

```
Warning: No API keys found. No providers will be available.
```

**Fix:** Set at least one provider API key in Cloudflare Workers secrets:
```bash
npx wrangler secret put TAVILY_API_KEY
```

### MCP connection errors

If your MCP client can't connect:
1. Verify the worker URL is correct
2. Check CORS preflight works: `curl -X OPTIONS https://<worker>/mcp`
3. Ensure the worker is deployed (not just running locally with different URL)

### Slow responses

- The `web_search` tool waits for **all** providers by default (best quality)
- Set `timeout_ms` to return early with partial results
- Consider geographic proximity: Workers run on Cloudflare's edge, but provider APIs may be US-centric

### Rate limiting

Providers have different limits:
- **Brave**: 2000 req/month (free tier)
- **Tavily**: 1000 req/month (free tier)
- **Kagi**: Pay-per-use
- **Exa**: Pay-per-use

The server handles rate limit responses gracefully (marks provider failed, continues with others).

---

## 🙏 Acknowledgements

This project is a **direct fork inspired by and based on** the excellent work of **Scott Spence** and the original [**mcp-omnisearch**](https://github.com/spences10/mcp-omnisearch) project.

The core idea—aggregating multiple search providers behind a unified MCP interface—originates from that project. This fork extends it with:
- Cloudflare Workers edge deployment
- Reciprocal Rank Fusion ranking
- Intelligent snippet merging
- REST API endpoint
- Enhanced provider coverage

Huge thanks to Scott and all contributors to the original project.

---

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.
