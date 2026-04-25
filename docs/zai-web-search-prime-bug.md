# `web_search_prime` MCP returns `"[]"` for every query (Coding Max plan)

Related to (but not fixed by) #36.

## Setup

- Plan: **GLM Coding Max-Yearly** ($360, valid through 2027-02-16)
- Quota dashboard: 4,000 web_search calls included
- PAYG balance: ~$3 (added during diagnosis to rule out the 1113 path entirely)
- Two API keys tried, same result on both
- Tested from a Linux box (US, residential) and from Cloudflare Workers, same result on both

## What's broken

`tools/call` against `web_search_prime` always returns:

```json
{ "content": [{ "type": "text", "text": "\"[]\"" }], "isError": false }
```

Tested 12 combinations, all empty:

- queries: English, Chinese, Spanish, technical, news, weather
- `location`: `cn`, `us`, omitted
- `content_size`: `medium`, `high`, omitted
- `search_recency_filter`: `noLimit`, `oneWeek`, omitted
- queries under and over the 70-char recommendation

The MCP envelope is well-formed, no error is surfaced. `search_intent` (when visible via REST) is populated correctly — the query is parsed and rewritten — only `search_result` comes back empty.

## What works on the same key

- `POST /api/coding/paas/v4/chat/completions` (`glm-4.6`) → 200, real response
- `POST /api/paas/v4/web_search` with `search_engine: "search-pro"` → 200, **5–10 real results**, ~1.5s
- `POST /api/paas/v4/web_search` with `search_engine: "search_std"` → 200, **5–10 real results**

## What's broken on the same key

- `POST /api/paas/v4/web_search` with `search_engine: "search-prime"` → 200, `search_result: []`
- `POST /api/paas/v4/web_search` with `search_engine: "search_pro_bing"` → 200, `search_result: []`
- `POST /api/paas/v4/web_search` with `search_engine: "search_pro_jina"` → 200, `search_result: []`
- `POST /api/mcp/web_search_prime/mcp` (any tool/call) → 200, `"[]"`

The pattern: every surface routing through `search-prime` (and `search_pro_bing` / `search_pro_jina`) returns empty. `search-pro` and `search_std` work fine.

## Reproduction

### REST — broken vs working side by side

```bash
# BROKEN: search-prime → empty
curl -sS -X POST https://api.z.ai/api/paas/v4/web_search \
  -H "Authorization: Bearer $ZAI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"search_engine":"search-prime","search_query":"Cloudflare Workers documentation","count":3}'
# {"created":...,"search_intent":[{"intent":"SEARCH_ALWAYS","keywords":"...","query":"..."}],"search_result":[]}

# WORKING: search-pro → 10 results
curl -sS -X POST https://api.z.ai/api/paas/v4/web_search \
  -H "Authorization: Bearer $ZAI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"search_engine":"search-pro","search_query":"Cloudflare Workers documentation","count":3}'
# {"created":...,"search_result":[{"title":"Overview · Cloudflare Workers docs","link":"https://developers.cloudflare.com/workers/",...}, ...]}
```

### MCP — canonical inspector client

```bash
npx @modelcontextprotocol/inspector --cli https://api.z.ai/api/mcp/web_search_prime/mcp \
  --transport http \
  --header "Authorization: Bearer $ZAI_KEY" \
  --method tools/call --tool-name web_search_prime \
  --tool-arg "search_query=Cloudflare Workers documentation"
```

Output:

```json
{ "content": [{ "type": "text", "text": "\"[]\"" }], "isError": false }
```

Same with the official MCP config from [docs.z.ai/devpack/mcp/search-mcp-server](https://docs.z.ai/devpack/mcp/search-mcp-server) wired into Claude Code.

## A useful side observation

The sibling MCP endpoint `/api/mcp/web_search/mcp` (which exposes `webSearchPro` / `webSearchStd` / `webSearchSogou` / `webSearchQuark`) does not silently swallow errors — when there's no PAYG balance, those tools return:

```json
{ "content": [{ "type": "text", "text": "MCP error 429: 余额不足或无可用资源包,请充值。" }], "isError": true }
```

Whereas `web_search_prime` returns the same empty `"[]"` regardless of balance. So beyond the routing issue, the `_prime` server is also masking real errors as success — that's how this bug looks identical to the billing-routing one in #36 even after PAYG is funded.

## Likely root cause

The `search-prime` engine in the underlying search backend is returning empty result sets — independent of billing, query, region, or client. The MCP `web_search_prime` server wraps it 1:1, so MCP looks broken too. `search-pro` / `search_std` route through a different backend path and are unaffected.

## Workaround

Use the REST endpoint with `search_engine: "search-pro"` directly. ~1.5s, 10 results per call, debits PAYG balance even though the docs say Coding Plan should cover it (separate issue, see #36 — billing routing for web_search ignores plan quota).

## Ask

1. Either fix `search-prime` to return real results, or remove it from the docs and from the MCP server's tool list.
2. Make `web_search_prime` (and the underlying engine) surface errors through MCP instead of returning `isError: false` with an empty payload — silent failure is the worst failure mode for an MCP tool.
3. If `search-prime` is intended to be a paid premium tier on top of `search-pro`, document that explicitly and return a clear "not enabled for this plan" error instead of empty.
