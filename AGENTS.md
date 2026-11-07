# AGENTS.md — repo root

You are at the top of `omnisearch` — a Cloudflare-Workers MCP server that aggregates web search across many providers and delegates URL fetching to the external **omnifetch** service. This file is your map. If you can answer "where do I look for X" from here without grepping, it has done its job.

## Top-level layout

| Path | What's there |
|------|--------------|
| `README.md` | User-facing docs. Update when adding providers, REST endpoints, or env vars. |
| `LICENSE` | MIT. |
| `package.json` | ESM (`"type": "module"`). Deps: `@modelcontextprotocol/sdk ^1.29`, `agents`, `p-retry`, `zod`. Dev: `wrangler`, `typescript ^6.0.3`, `@cloudflare/workers-types`. Scripts: `dev`, `deploy`, `typecheck`. |
| `wrangler.toml` | CF Worker entry (`src/worker.ts`), `nodejs_compat` flag (required for `node:async_hooks`), DO binding `OmnisearchMCP`, KV binding `CACHE`, R2 binding `TRACE_BUCKET`, SQLite-classes migration tag `v1`. |
| `tsconfig.json` | TypeScript 6 config. |
| `.env.example` | Documents env vars. Secrets live in Doppler / `wrangler secret`. May lag the actual `src/types/env.ts` — if a binding works at runtime but isn't in `.env.example`, regenerate from `types/env.ts`. |
| `docs/` | Reserved for postmortems / synthesis docs. Currently holds only `docs/AGENTS.md`. See `docs/AGENTS.md`. |
| `src/` | Implementation. See `src/AGENTS.md`. |
| `tools/` | Offline harnesses (Python). Currently: `grounding_smoke.py`, `grounding_compare.py`, `grounding_lib.py` — before/after comparison runs for the grounded-snippets feature against fixed query corpora. Not deployed; run locally for tuning. |
| `tmp/` | Hydra-review sandboxes, ad-hoc test artifacts. **Ignore — do not edit, do not include in releases.** |
| `.wrangler/` | Local wrangler state. Ignore. |
| `trash/` | Per CLAUDE.md rule: `rm` is forbidden, deletions move here. |

## Provider count cheatsheet

The active provider count from `/health` is `search.size + fetch.size`, populated by `initialize_providers()`. With every key set, the upper bound is **11**:
- **10 search providers**: tavily, brave, kagi, exa, firecrawl, perplexity, serpapi, linkup, you, parallel (parallel uses `PARALLEL_API_KEY`).
- **1 fetch entry** — `omnifetch`, added when `OMNIFETCH_ENDPOINT` is configured. omnisearch no longer has fetch providers; the multi-provider waterfall lives in the external [omnifetch](https://github.com/cjangrist/omnifetch) service.

## Where do I look for X?

**Adding a search provider** → `src/providers/search/<name>/index.ts` for the adapter + one line in `src/providers/unified/web_search.ts`'s `PROVIDERS`. Also wire env in `src/types/env.ts` + `src/config/env.ts`.

**Adding a fetch provider** → fetch providers no longer live in this repo. omnisearch delegates all URL fetching to the external [omnifetch](https://github.com/cjangrist/omnifetch) service via a single REST call (`src/server/omnifetch_client.ts`). Add new waterfall steps / breakers / providers there, not here.

**Routing / REST endpoint behavior** → `src/worker.ts` (top-level handler + SSE keepalive), `src/server/rest_*.ts` (one file per endpoint).

**MCP tool registration** → `src/server/tools.ts`. Tools are registered against an `McpServer` provided by the DO. **Each tool closure must capture its own `get_ctx` getter** (R4F01) — see comment block at top of `tools.ts`. Schemas are Zod.

**Orchestrator behavior** —
- search fanout + RRF + cache + tail rescue + grounded-snippets stage → `src/server/web_search_fanout.ts`
- fetch → `src/server/omnifetch_client.ts` — a single REST `POST ${OMNIFETCH_ENDPOINT}/web_fetch` with body `{url}`. No internal waterfall, breakers, skip_providers, or cache; omnifetch owns all of that.
- grounded snippets (Cerebras) — top-N URLs fetched via omnifetch + summarized after RRF → `src/server/grounded_snippets.ts` + `src/server/grounded_prompts.ts`. Default ON when `CEREBRAS_API_KEY` is set; opt-out per call with `grounded_snippets:false`.

**Caching** — `web_search` has a `is_valid_cached_fanout` validator and binds the `query` inside the cached payload as defense-in-depth. The `fetch` tool does NOT cache in omnisearch (it delegates to omnifetch, which may cache internally). See `README.md` "Caching" section.

**Tracing** → `src/common/r2_trace.ts`. `TraceContext` is the data model; `run_with_trace(ctx, fn)` scopes it via AsyncLocalStorage; `flush_background(final_result)` writes to R2 via the request's `ctx.waitUntil`. The R2 bucket is hive-partitioned by tool/date/hour.

**Logging** → `src/common/logger.ts`. `loggers.<component>()` factory + `run_with_request_id(uuid, fn)` scope. Level threshold: `info` by default, `LOG_LEVEL` overridable via `globalThis.__LOG_LEVEL`.

**HTTP requests** → `src/common/http.ts` `http_json`. Always go through it (not bare `fetch`) so the 5MB size guard, status-code → `ProviderError` mapping, and R2 trace recording all happen automatically.

**Error model** → `src/common/types.ts` `ProviderError(type, message, provider, details?)`. Types: `API_ERROR`, `RATE_LIMIT`, `INVALID_INPUT`, `PROVIDER_ERROR`. Only `PROVIDER_ERROR` is retried by `retry_with_backoff` (transient). Rate limit and bad input never retry.

**Search query operators (site:, filetype:, etc.)** → `src/common/search_operators.ts`. Used by Brave, Kagi, Tavily.

**Snippet ranking + collapse** → `src/common/rrf_ranking.ts` (RRF + dedup + tail rescue + quality filter) + `src/common/snippet_selector.ts` (bigram Jaccard + greedy sentence merge).

**AsyncLocalStorage stub** → `src/types/node-async-hooks.d.ts`. Workerd provides AsyncLocalStorage at runtime when `nodejs_compat` is on; we don't ship full `@types/node`.

**Provider initialization** → `src/providers/index.ts` `initialize_providers()`. Atomic-swap pattern — never exposes an empty `active_providers`.

**Cache leak fix** (cross-prompt) — cached payloads now bind the original `query` / `requested_url` and reject mismatches as defense-in-depth. See validators in each orchestrator.

## Common debugging entry points

- **Cache pollution / cross-prompt leaks** → check `is_valid_cached_fanout` (`web_search_fanout.ts`). (Fetch no longer caches in omnisearch — it delegates to omnifetch.)
- **Empty MCP envelope** → intermittent issue at high concurrency where concurrent long-running calls return empty JSON-RPC envelopes. Workaround: call serially. (Historical postmortem docs were removed; the behavior is documented in `worker.ts`'s SSE keepalive injection.)
- **Provider count drift** → look at `active_providers` in `src/server/tools.ts` (populated by `initialize_providers`). `/health` endpoint reports the live total.
- **Why is provider X not being called?** Check `key()` returns a non-empty trimmed string in the appropriate `unified/*.ts` `PROVIDERS` array.
- **Trace not showing up in R2** → confirm `TRACE_BUCKET` binding exists in `wrangler.toml` and `set_trace_r2_bucket(env.TRACE_BUCKET)` ran (in `initialize_config`). If `_r2_bucket` is undefined, `flush_background` is a no-op.

## Conventions / Invariants (root-level)

- **No emojis in source code or docs.** Commit messages may use a single leading emoji (see `git log`); files do not.
- **ESM-only** (`"type": "module"`). Imports use `.js` suffix even for `.ts` source — TypeScript convention for ESM.
- **AsyncLocalStorage everywhere**: never module-scope per-request state. Anything that varies per request (request_id, ExecutionContext, TraceContext) lives in an ALS store.
- **`hash_key` is async** — always `await` it.
- **Module-level config singleton** (`src/config/env.ts`) populated by `initialize_config(env)` — must be called before any provider access.
- **Tokens cheap, correctness paramount**: prefer reading the full file over inferring from path names. Some providers have non-obvious behavior (provider-specific params, operator translation) that wouldn't be correctly described by their folder name alone.

## Gotchas / History

- **Fetch is delegated, not duplicated.** omnisearch no longer runs a fetch waterfall — there is no `skip_providers`, no `provider`, no `skip_cache` on the `fetch` tool. All URL fetching goes through `src/server/omnifetch_client.ts` → omnifetch `/web_fetch`. The waterfall, breakers, and multi-provider racing live in the [omnifetch](https://github.com/cjangrist/omnifetch) repo.
- **Brave uses `BRAVE_API_KEY`** for web search.
- **The DO is stateful.** Each MCP client session gets its own DO instance. R4F01 (per-closure ctx capture) exists because the `tools.ts` module-level registry is shared across DOs in the same isolate; capturing `() => this.ctx` per registration call keeps each tool callback bound to the DO that registered it.
- **The R2 trace bucket is private and stores unredacted payloads.** Sensitive query params are redacted in *log output* but not in R2 traces — by design, for incident debugging. Do not change without checking with the user.
- **`/researcher` accepts auth as `?api_key=...` query param** for GPT-Researcher compatibility — REST handler converts it to a Bearer header internally before calling the shared `authenticate_rest_request`.

## Related

- `src/AGENTS.md` — implementation overview
- `docs/AGENTS.md` — what's in `docs/`, when to add new docs
