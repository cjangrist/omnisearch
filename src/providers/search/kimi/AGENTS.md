# AGENTS.md — src/providers/search/kimi/

## Purpose
Kimi (Moonshot AI) coding-API search. Backs the SearchWeb tool in Kimi CLI. Routed through Scrapfly residential proxy because `api.kimi.com` blocks Cloudflare-Workers ASN egress (CF WAF + IP reputation + TLS fingerprint).

## Files

- `index.ts` — `KimiSearchProvider` class + dispatcher.
- `headers.ts` — `build_kimi_search_headers(api_key)` — emits the same identity headers Kimi CLI sends so requests look identical on the wire.
- `scrapfly_proxy.ts` — `proxy_post_via_scrapfly(provider_name, target_url, headers, body, timeout)` — wraps the request in a Scrapfly proxied call with residential IP egress.

## Vendor

- **Vendor**: Moonshot AI (Kimi)
- **Endpoint**: `POST https://api.kimi.com/coding/v1/search` (proxied through Scrapfly)
- **Auth**: `Authorization: Bearer <KIMI_API_KEY>` plus Kimi-CLI identity headers
- **Env vars**: `KIMI_API_KEY` AND `SCRAPFLY_API_KEY` (the proxy)
- **Returns**: `{ title, url, snippet, source_provider: "kimi", metadata: { date?, site_name? } }[]`
- **Body**: `{ text_query, limit, enable_page_crawling: false, timeout_seconds: 30 }`

## Conventions / Invariants

- Implements `SearchProvider`.
- `enable_page_crawling: false` is hard-coded — we want snippets, not full crawls.
- HTTP non-2xx from Kimi (post-proxy unwrap) is converted to `ProviderError(PROVIDER_ERROR)` so the search fanout records it as a transient failure.

## Gotchas / History

- **Currently disabled in production** per `docs/kimi-search-roi-analysis.md`: Kimi was the slowest, least reliable, and most expensive search provider with minimal unique-URL contribution. The folder is preserved for re-enable if the upstream improves.
- **Both keys required**. Setting only `KIMI_API_KEY` leaves the provider inactive; setting only `SCRAPFLY_API_KEY` similarly leaves it inactive (the registration's `key()` checks `KIMI_API_KEY`, but the implementation also calls `validate_api_key(config.fetch.scrapfly.api_key, ...)` indirectly through the proxy helper).
- **Outer/inner timeout symmetry**: `timeout_seconds: 30` in the body and `config.search.kimi.timeout = 30000ms` outer. Scrapfly proxy adds latency; the outer can fire while the inner is still processing. Orchestrator handles either outcome.

## Related

- Registered as `kimi` in `../../unified/web_search.ts`.
- Sister module: `../../fetch/kimi/` — Kimi fetch is a separate code path; **fetch is active even when search is disabled**.
- `docs/kimi-search-roi-analysis.md` — why search is dormant.
