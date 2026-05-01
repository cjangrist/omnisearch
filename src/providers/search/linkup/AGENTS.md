# AGENTS.md — src/providers/search/linkup/

## Purpose
Linkup search adapter. Returns text-style results with content snippets.

## Vendor

- **Vendor**: Linkup
- **Endpoint**: `POST https://api.linkup.so/v1/search`
- **Auth**: `Authorization: Bearer <LINKUP_API_KEY>`
- **Env var**: `LINKUP_API_KEY` (shared with `../../fetch/linkup/`)
- **Returns**: `{ title, url, snippet, source_provider: "linkup" }[]`
- **Defaults**: `depth=standard`, `outputType=searchResults`, 20 results.

## Conventions / Invariants

- Implements `SearchProvider`.
- Linkup returns results as `[{ type: 'text', name, url, content }]` — `name` becomes title, `content` becomes snippet.

## Related

- Registered as `linkup` in `../../unified/web_search.ts`.
- Sister module: `../../fetch/linkup/`.
