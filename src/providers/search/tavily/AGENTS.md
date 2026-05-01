# AGENTS.md — src/providers/search/tavily/

## Purpose
Tavily web search adapter. Tavily is academic/research-leaning; supports `topic` (general / news) and `search_depth` (basic / advanced) parameters.

## Vendor

- **Vendor**: Tavily
- **Endpoint**: `POST https://api.tavily.com/search`
- **Auth**: `Authorization: Bearer <TAVILY_API_KEY>`
- **Env var**: `TAVILY_API_KEY` (shared with `ai_response/tavily_answer/` and `fetch/tavily/`)
- **Returns**: `{ title, url, snippet, source_provider: "tavily" }[]`
- **Default limit**: 20 results, `search_depth=basic`, `topic=general`.

## Conventions / Invariants

- Implements `SearchProvider` from `../../../common/types.ts`.
- Uses `apply_search_operators` + `parse_search_operators` to translate `site:`/`-site:` operators into `include_domains` / `exclude_domains` API params.
- `make_signal(config.search.tavily.timeout, params.signal)` composes the per-provider 30s timeout with the orchestrator's external abort.

## Related

- Registered as `tavily` in `../../unified/web_search.ts`.
- Sister modules: `../../ai_response/tavily_answer/`, `../../fetch/tavily/`.
