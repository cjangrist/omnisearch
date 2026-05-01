# AGENTS.md — src/providers/search/you/

## Purpose
You.com web search adapter. LLM-oriented snippets (multiple snippet strings per result).

## Vendor

- **Vendor**: You.com
- **Endpoint**: `GET https://ydc-index.io/v1/search?q=...`
- **Auth**: `X-API-Key: <YOU_API_KEY>`
- **Env var**: `YOU_API_KEY` (shared with `../../fetch/you/`)
- **Returns**: `{ title, url, snippet, source_provider: "you" }[]` — joins multiple `snippets[]` into a single `snippet` field.
- **Default limit**: 20.

## Conventions / Invariants

- Implements `SearchProvider`.
- Multiple snippets per result are joined with `\n\n` for the orchestrator's snippet-collapse step.
- Optional metadata: `page_age`, `authors`, `thumbnail_url` are passed through in `metadata` if present.

## Related

- Registered as `you` in `../../unified/web_search.ts`.
- Sister module: `../../fetch/you/`.
