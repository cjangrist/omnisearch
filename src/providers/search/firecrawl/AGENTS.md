# AGENTS.md — src/providers/search/firecrawl/

## Purpose
Firecrawl web search adapter. Returns standard web results with title and description.

## Vendor

- **Vendor**: Firecrawl
- **Endpoint**: `POST https://api.firecrawl.dev/v2/search`
- **Auth**: `Authorization: Bearer <FIRECRAWL_API_KEY>`
- **Env var**: `FIRECRAWL_API_KEY` (shared with `../../fetch/firecrawl/`)
- **Returns**: `{ title, url, snippet, source_provider: "firecrawl" }[]`
- **Default limit**: 20 results.

## Conventions / Invariants

- Implements `SearchProvider`.
- Title falls back to `'Source'` when the API omits it.
- Snippets come from the API's `description` field.

## Related

- Registered as `firecrawl` in `../../unified/web_search.ts`.
- Sister module: `../../fetch/firecrawl/`.
