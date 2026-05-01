# AGENTS.md — src/providers/search/serpapi/

## Purpose
SerpAPI search adapter. Uses the `google_light` engine — lighter response shape, faster, cheaper than `google`.

## Vendor

- **Vendor**: SerpAPI (Google results scraper)
- **Endpoint**: `GET https://serpapi.com/search.json?engine=google_light&q=...`
- **Auth**: `api_key=<SERPAPI_API_KEY>` query parameter
- **Env var**: `SERPAPI_API_KEY` (shared with `../../fetch/serpapi/` which uses the `youtube_video_transcript` engine)
- **Returns**: `{ title, url, snippet, source_provider: "serpapi" }[]` from the `organic_results` array.
- **Default limit**: 20.

## Conventions / Invariants

- Implements `SearchProvider`.
- Engine is hard-coded to `google_light`. Do NOT swap to `google` without checking pricing and response-shape compatibility.
- Provider-native `position` becomes the `score` field; the orchestrator's RRF replaces it during ranking.

## Related

- Registered as `serpapi` in `../../unified/web_search.ts`.
- Sister module: `../../fetch/serpapi/` (different engine: YouTube transcripts).
