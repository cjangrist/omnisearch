# AGENTS.md — src/providers/search/brave/

## Purpose
Brave Web Search adapter. Privacy-focused; supports the full search-operator vocabulary (site:, -site:, filetype:/ext:, intitle:, inurl:, inbody:, lang:, loc:, before:, after:, +term, -term, "exact").

## Vendor

- **Vendor**: Brave
- **Endpoint**: `GET https://api.search.brave.com/res/v1/web/search?q=...`
- **Auth**: `X-Subscription-Token: <BRAVE_API_KEY>`
- **Env var**: `BRAVE_API_KEY`
- **Returns**: `{ title, url, snippet, source_provider: "brave" }[]`
- **Default limit**: 20 results.

## Conventions / Invariants

- Implements `SearchProvider`.
- Builds the query through `parse_search_operators` + `apply_search_operators` + `build_query_with_operators` so all operators travel as part of the `q` string (Brave parses them server-side).
- Combines `include_domains` and `exclude_domains` from `BaseSearchParams` with the parsed operators.

## Related

- Registered as `brave` in `../../unified/web_search.ts`.
