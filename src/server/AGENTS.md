# AGENTS.md — src/server/

Tool and REST orchestration. Three orchestrators (search fanout, AI answer fanout, fetch waterfall), three REST endpoints, and the MCP tool registry.

## Files

- **`tools.ts`** — MCP tool registration. Defines a `ToolRegistry` singleton (module-scoped) holding the three unified providers. `register_tools(server, get_ctx)` wires three tools — `web_search`, `answer`, `fetch` — onto an `McpServer`. Each tool callback closes over the per-DO `get_ctx` getter (R4F01) so trace `flush_background` writes attach to the DO's `waitUntil`. Tool input/output schemas use Zod. Long descriptions in the tool annotation tell agents when to prefer `web_search` over `answer` and how to use `skip_providers` on `fetch`.
- **`handlers.ts`** — MCP resource handlers (provider-status, provider-info). Read-only resources reflecting the active set.
- **`web_search_fanout.ts`** — `run_web_search_fanout(unified, query, options)` parallel-fans-out the query to every active search provider. Calls `rank_and_merge` (RRF + dedup + tail rescue + quality filter) and `collapse_snippets`. KV cache keyed on `hash_key('search:', query [+ '\0sqf=true'])`. Optional `timeout_ms` aborts pending providers at the deadline. Only complete fanouts (no failures, no aborts) are cached.
- **`answer_orchestrator.ts`** — `run_answer_fanout(ai_unified, web_unified, query)` builds one task per active AI provider. If `GEMINI_GROUNDED_API_KEY` is set AND a web search provider exists, an extra `gemini-grounded` task is added: it runs an inline 10-second `web_search_fanout`, then calls `gemini_grounded_search(query, sources, signal)`. Hard global deadline `GLOBAL_TIMEOUT_MS = 295_000` (4m55s); pending providers are aborted via `AbortController`. Logs progress every 5s. Only complete fanouts (zero failed providers) are cached.
- **`fetch_orchestrator.ts`** — `run_fetch_race(unified, url, options)` walks the fetch waterfall. The `CONFIG` literal at the top defines:
  - `breakers`: `github` (github.com, gist.github.com, raw.githubusercontent.com), `youtube` → `supadata`, `social_media` → `sociavault`.
  - `waterfall`: `solo: tavily` → `solo: firecrawl` → `solo: kimi` → `parallel: [linkup, cloudflare_browser]` → `parallel: [diffbot, olostep]` → `parallel: [scrapfly, scrapedo, decodo]` → `solo: zyte` → `solo: brightdata` → `sequential: [jina, spider, you, scrapeless, scrapingbee, scrapegraphai, scrappey, scrapingant, oxylabs, scraperapi, leadmagic, opengraph]`.
  - `failure`: `min_content_chars: 200` and `challenge_patterns` (cf-browser-verification, captcha, just a moment, etc.). API-native providers (`github`, `supadata`) are exempt.
  - Also exports `parse_skip_providers` (string | string[] → string[]) and `validate_skip_providers` (returns `{ unknown }` to be 400'd at the entry layer).
- **`rest_search.ts`** — `POST /search`. Body: `{ query, count?, raw? }`. `count` clamped to 0..100 (0 = all). `raw: true` skips quality filtering. Returns `[{ link, title, snippet }]`. 502 + `{ error, failed_providers }` if all providers failed.
- **`rest_fetch.ts`** — `POST /fetch`. Body: `{ url, provider?, skip_cache?, skip_providers? }`. `provider` and `skip_providers` are mutually exclusive (400 if both). `provider` forces a single fetch provider, bypassing the waterfall. `skip_cache` bypasses cache reads only. `skip_providers` bypasses both cache reads and writes, and triggers a 2-provider compare returning the second under `alternative_results`.
- **`rest_researcher.ts`** — `GET` or `POST /researcher`. Auth via `Authorization: Bearer ...` OR `?api_key=...` query param. Body or query param `query`. Returns up to 10 search snippets shaped as `[{ href, body }]` for GPT-Researcher's `RETRIEVER=custom` integration. **Snippets only — no full-page fetch happens** (the file's older header comment is misleading; the implementation calls only `run_web_search_fanout`).

## Conventions / Invariants

- **All three orchestrators wrap their work in `run_with_trace(ctx, fn)`** so providers can call `get_active_trace()?.record_*` without threading.
- **Failure isolation per provider** — every fanout / waterfall step has its own try/catch. One provider's exception never crashes the rest.
- **Partial fanouts are NOT cached** — the cache validator stores `query` / `requested_url`, but partial fanouts skip the write entirely.
- **Cancellation propagates**: `make_signal(timeout, external)` combines an external signal with the per-provider timeout. The fanout's deadline is one such external signal.
- **`is_done` flag pattern** for late arrivals — once the orchestrator settles, late-arriving promises check `is_done` and skip mutating result arrays. Same pattern in `fetch_orchestrator.run_parallel` via the `resolved` flag, also dropping the loser's failure entry from `ctx.failed` AND the trace so the public response and trace tell the same story.
- **Error model**: throw `ProviderError` from inside provider implementations; orchestrators convert to `providers_failed` entries. REST handlers convert top-level `ProviderError(INVALID_INPUT)` to 400 and others to 502.

## Gotchas / History

- **`config.yaml` is documentation only.** The runtime fetch waterfall is the `CONFIG` literal at the top of `fetch_orchestrator.ts`. The two have drifted (YAML lacks the github breaker and the kimi waterfall step). Edit the TS first, then regenerate the YAML.
- **The `kimi` waterfall step requires both `KIMI_API_KEY` AND `SCRAPFLY_API_KEY`.** If only one is set, kimi is silently skipped at the active-set filter — correct behavior, but the dependency isn't reflected in `config.yaml`.
- **`gemini-grounded` is NOT in the unified AI registry.** `answer_orchestrator.ts` imports `gemini_grounded_search` directly and adds it as an extra task when web_search is also available. Its trace links to the inner `web_search` trace via `parent_trace_id`. Setting `GEMINI_GROUNDED_API_KEY` alone is enough; it does not need a registration line.
- **`/researcher` returns snippets, not full content** despite an older header comment. If you need full extraction, call `/fetch` separately or the MCP `fetch` tool.
- **Multi-winner parallel race**: when `skip_providers` triggers `target_count = 2`, the parallel step settles when 2 winners arrive (not on `Promise.any`). Late losers' rejections are dropped from both `ctx.failed` and the trace.
- **Empty-active-set guard on fetch**: if every active fetch provider is filtered out by `skip_providers`, `run_fetch_race` throws `INVALID_INPUT` (REST → 400) rather than running the waterfall to exhaustion and emitting a misleading 502 with `"Tried: <empty>"`.
- **R4F01 (per-DO ctx capture)** is a tools.ts-specific invariant. The registry is module-scoped (shared across DO instances in the same isolate); each tool closure captures its own `get_ctx` so trace flush_background calls scope to the right DO. See README's "Concurrency model" section.
- **All-failed → 502, not 200** on REST `/search` and `/researcher`. (R3F03)

## Related

- `../common/r2_trace.ts` — `TraceContext` data model
- `../common/utils.ts` — `make_signal`, `hash_key`, `authenticate_rest_request`
- `../providers/unified/*.ts` — the providers these orchestrators dispatch to
- `../../docs/skip_providers_review_synthesis.md` — 9-reviewer synthesis on the fetch skip_providers parameter
- `../../README.md` "Caching" + "Concurrency model" sections
