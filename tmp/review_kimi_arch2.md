Based on my thorough exploration of the codebase, here is my comprehensive review:

---

# Omnisearch MCP — Code Review

## Executive Summary

**Omnisearch MCP** is a production-ready Model Context Protocol (MCP) server that aggregates multiple web search providers (9+) and AI answer providers (6+) with intelligent ranking via Reciprocal Rank Fusion (RRF). It runs on Cloudflare Workers with Durable Objects for stateful MCP sessions.

| Metric | Value |
|--------|-------|
| **Total Lines of Code** | ~3,100 TypeScript |
| **Provider Coverage** | 9 search + 6 AI + 25 fetch providers |
| **Architecture** | Cloudflare Workers + Durable Objects |
| **MCP SDK Version** | 1.27.1 |

---

## Project Structure

```
src/
├── worker.ts                 # Entry point: HTTP routing + MCP DO setup
├── types/env.ts              # Environment binding types (65 lines)
├── config/env.ts             # Config initialization (380 lines)
├── common/
│   ├── types.ts              # Core interfaces (59 lines)
│   ├── http.ts               # Safe HTTP client (148 lines)
│   ├── utils.ts              # Retry, errors, signals (139 lines)
│   ├── logger.ts             # Structured logging (193 lines)
│   ├── rrf_ranking.ts        # RRF algorithm + truncation (150 lines)
│   ├── snippet_selector.ts   # Intelligent snippet merging (244 lines)
│   ├── search_operators.ts   # Query syntax parsing (134 lines)
│   └── html.ts               # HTML/markdown utils (13 lines)
├── providers/
│   ├── index.ts              # Provider initialization orchestrator
│   ├── unified/              # Dispatcher implementations
│   │   ├── web_search.ts     # Web search dispatcher (9 providers)
│   │   ├── ai_search.ts      # AI answer dispatcher (6 providers)
│   │   └── fetch.ts          # Fetch dispatcher (25 providers)
│   ├── search/               # Individual search adapters (9 dirs)
│   ├── ai_response/          # AI answer adapters (6 dirs)
│   └── fetch/                # URL fetch adapters (25 dirs)
└── server/
    ├── tools.ts              # MCP tool registration (252 lines)
    ├── handlers.ts           # MCP resource handlers (98 lines)
    ├── web_search_fanout.ts  # Parallel search dispatch (227 lines)
    ├── answer_orchestrator.ts # AI provider fanout (267 lines)
    ├── fetch_orchestrator.ts # Tiered fetch waterfall (330 lines)
    ├── rest_search.ts        # REST /search endpoint (185 lines)
    └── rest_fetch.ts         # REST /fetch endpoint (140 lines)
```

---

## Strengths

### 1. **Excellent Architecture & Modularity**

| Aspect | Assessment |
|--------|------------|
| **Separation of Concerns** | Clean split between providers, orchestration, and transport layers |
| **Provider Pattern** | Registry-based provider system makes adding new providers trivial |
| **Unified Dispatchers** | `web_search.ts`, `ai_search.ts`, `fetch.ts` provide consistent interfaces |
| **Error Isolation** | Each provider failure is contained; partial results always returned |

### 2. **Sophisticated Ranking & Deduplication**

- **Reciprocal Rank Fusion (RRF)**: `score = Σ 1/(k + rank)` with k=60
- **URL Normalization**: Strips fragments, trailing slashes, lowercases host
- **Snippet Intelligence**: Bigram Jaccard similarity + greedy sentence merging
- **Tail Rescue**: Re-injects diverse domains from tail results

### 3. **Production-Ready Error Handling**

```typescript
// http.ts: Size limits (5MB), sensitive param redaction
// utils.ts: AbortSignal composition, timing-safe comparison
// fetch_orchestrator.ts: Challenge pattern detection (CAPTCHA, Cloudflare)
```

### 4. **Military-Grade Fetch Pipeline**

The fetch orchestrator implements a **tiered waterfall**:
1. **Domain Breakers**: YouTube → Supadata, Social → SociaVault
2. **Parallel Groups**: Race providers, pick longest content
3. **Sequential Fallback**: 12+ providers in order
4. **Failure Detection**: 200 char minimum, challenge patterns

### 5. **Well-Designed Logging**

- Structured JSON logging with correlation IDs
- Per-component loggers (`search:brave`, `fetch:jina`)
- Operation timing built-in

---

## Areas for Improvement

### 1. **Configuration Duplication**

**Issue**: Waterfall config exists in both `config.yaml` AND `fetch_orchestrator.ts`:

```typescript
// fetch_orchestrator.ts (lines 33-77)
const CONFIG = {
  breakers: { /* ... */ },
  waterfall: [ /* ... */ ],
  failure: { /* ... */ }
};
```

**Recommendation**: Parse `config.yaml` at build time or startup to single-source the config.

### 2. **Missing Input Validation on Query Parameters**

**Issue**: `search_operators.ts` uses regex patterns that could be exploited:

```typescript
// Line 35: Negative lookbehind may not work in all JS runtimes
site: /(?<!-)site:([^\s]+)/g,
```

**Risk**: Low (Cloudflare Workers uses modern V8), but inconsistent with explicit parser approach.

### 3. **No Request Size Limits on MCP Tools**

**Issue**: While REST endpoints have body size limits (`65536`), MCP tool inputs aren't bounded:

```typescript
// tools.ts: query string has no explicit max length check
query: z.string().min(1).max(2000)  // This exists, but...
```

Actually, this **is** validated (2000 char max). ✅

### 4. **Potential Race Condition in Fanout Cache**

**Issue**: `web_search_fanout.ts` cache eviction:

```typescript
// Lines 40-42: LRU eviction logic
if (fanout_cache.size >= CACHE_MAX_SIZE) {
  const oldest_key = fanout_cache.keys().next().value;
  if (oldest_key !== undefined) fanout_cache.delete(oldest_key);
}
```

**Assessment**: Safe for single-threaded Workers, but concurrent requests in same isolate could race.

### 5. **Type Safety Gap in Unified Providers**

**Issue**: `UnifiedWebSearchProvider.search()` requires runtime provider validation:

```typescript
// web_search.ts: lines 58-71
const selected = this.providers.get(provider);
if (!selected) {
  throw new ProviderError(/* ... */);
}
```

This should be typed exhaustively at compile time.

---

## Code Quality Score

| Category | Score | Notes |
|----------|-------|-------|
| **Architecture** | 9/10 | Clean separation, registry pattern |
| **Type Safety** | 8/10 | Good TS usage, few `any` escapes |
| **Error Handling** | 9/10 | Comprehensive, graceful degradation |
| **Performance** | 8/10 | Parallelization, caching, timeouts |
| **Documentation** | 8/10 | Good inline comments, README |
| **Testing** | 0/10 | **No tests found** |
| **Security** | 7/10 | API key redaction, timing-safe compare |

### **Overall: 7.7/10** (would be 8.5+ with tests)

---

## Critical Observations

### ✅ **What's Done Well**

1. **SSE Keepalive Injection** (`worker.ts:62-160`): Sophisticated TransformStream implementation for keeping MCP connections alive through Cloudflare's 45s timeout
2. **Provider Registration Pattern**: Adding a new provider requires only 1 line in the unified dispatcher
3. **Search Operator Parsing**: Full support for `site:`, `-site:`, `filetype:`, `intitle:`, etc.
4. **Gemini Grounded Integration**: Novel approach feeding web search results to Gemini's URL context API

### ⚠️ **What Needs Attention**

1. **Test Coverage**: Zero automated tests. Recommend:
   - Unit tests for RRF ranking algorithm
   - Unit tests for snippet selector
   - Integration tests for provider error handling
   - Mock provider tests for waterfall logic

2. **Configuration Sync**: `config.yaml` and `fetch_orchestrator.ts` can drift

3. **Rate Limit Handling**: Some providers have rate limit headers that could be parsed for smarter backoff

4. **Memory Leak Risk**: Fanout cache never clears expired entries except on access

---

## Security Assessment

| Check | Status | Notes |
|-------|--------|-------|
| API Key Logging | ✅ Safe | Redacted in `sanitize_url()` |
| Timing Attacks | ✅ Safe | `timing_safe_equal()` for auth |
| Response Size Limits | ✅ Safe | 5MB limit in HTTP client |
| Content Injection | ⚠️ Medium | Challenge patterns detected, but HTML not sanitized |
| Secret Management | ✅ Safe | Uses Cloudflare secrets, not env |

---

## Recommendations (Priority Order)

1. **Add Unit Tests** (Critical)
   - Start with `rrf_ranking.ts` and `snippet_selector.ts`
   - Mock fetch for provider tests

2. **Sync Config Sources** (High)
   - Build-time YAML → TS generation, or
   - Runtime YAML parsing

3. **Add Provider Health Checks** (Medium)
   - Periodic ping to detect provider outages
   - Circuit breaker pattern for failing providers

4. **Improve Caching** (Medium)
   - TTL-based eviction (not just LRU)
   - Cache hit/miss metrics

5. **Add Metrics Export** (Low)
   - Provider latency histograms
   - Success rate by provider

---

## Conclusion

Omnisearch MCP is a **well-architected, production-ready system** with sophisticated ranking and resilient provider failover. The codebase demonstrates solid software engineering practices with clean separation of concerns, comprehensive error handling, and thoughtful performance optimizations.

The primary gap is **test coverage** — with automated tests, this would be a reference-quality codebase. The architecture scales well for adding new providers, and the RRF + snippet intelligence provides genuine value over single-provider search.

**Verdict**: **Approve with recommendations** — add tests before next major release.
