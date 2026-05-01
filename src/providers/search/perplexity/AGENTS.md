# AGENTS.md — src/providers/search/perplexity/

## Purpose
Perplexity Sonar search adapter. Uses the chat-completions endpoint with `sonar` (the cheaper/faster model) and structured search results.

## Vendor

- **Vendor**: Perplexity
- **Endpoint**: `POST https://api.perplexity.ai/chat/completions`
- **Auth**: `Authorization: Bearer <PERPLEXITY_API_KEY>`
- **Env var**: `PERPLEXITY_API_KEY` (shared with `../../ai_response/perplexity/` which uses `sonar-pro`)
- **Returns**: `{ title, url, snippet, source_provider: "perplexity" }[]`
- **Model defaults**: `sonar`, temperature 0.1, max_tokens 256, search_context_size `high`.

## Conventions / Invariants

- Implements `SearchProvider`.
- Prefers the API's `search_results` array if present; falls back to `citations[]` URL list when only citations come back.
- Title falls back to `'Source'` if the result row doesn't include one.

## Gotchas

- **Same key, different models**: `PERPLEXITY_API_KEY` powers BOTH this search adapter (sonar) AND `../../ai_response/perplexity/` (sonar-pro). They are different API call patterns; do not collapse.

## Related

- Registered as `perplexity` in `../../unified/web_search.ts`.
- Sister module: `../../ai_response/perplexity/`.
