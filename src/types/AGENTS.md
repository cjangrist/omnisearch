# AGENTS.md — src/types/

TypeScript type definitions specific to the Worker runtime. Two files only.

## Files

- **`env.ts`** — `interface Env` with all Cloudflare Worker bindings. Used by:
  - `worker.ts` `ExportedHandler<Env>` and `class OmnisearchMCP extends McpAgent<Env>`.
  - `config/env.ts` `initialize_config(env: Env)`.
  Members:
  - **Search keys**: `TAVILY_API_KEY`, `BRAVE_API_KEY`, `KAGI_API_KEY`, `EXA_API_KEY`, `SERPAPI_API_KEY`, `LINKUP_API_KEY`, `PARALLEL_API_KEY`, `PERPLEXITY_API_KEY`, `FIRECRAWL_API_KEY`, `YOU_API_KEY`, `KIMI_API_KEY`.
  - **Scrapfly** (kimi search proxy): `SCRAPFLY_API_KEY` — required together with `KIMI_API_KEY` if Kimi search is enabled.
  - **Snippet-grounding key**: `CEREBRAS_API_KEY` — when set, `web_search` / `POST /search` regenerate top-N snippets via Cerebras from actual page content (see `src/server/grounded_snippets.ts`). Default ON when present; opt-out via per-call `grounded_snippets:false`.
  - **omnifetch endpoint**: `OMNIFETCH_ENDPOINT` — base URL of the external omnifetch service (owns all URL fetching). Defaults to `http://127.0.0.1:8000`.
  - **REST auth**: `OPENWEBUI_API_KEY`, `OMNISEARCH_API_KEY`.
  - **CF resources**: `CACHE: KVNamespace`, `TRACE_BUCKET: R2Bucket`, `OmnisearchMCP: DurableObjectNamespace`, `AE_REQUESTS` / `AE_SEARCH` (Analytics Engine datasets).
- **`node-async-hooks.d.ts`** — Minimal type stub for `node:async_hooks AsyncLocalStorage`. Workerd provides AsyncLocalStorage at runtime when `nodejs_compat` is enabled in `wrangler.toml`. We don't ship full `@types/node` — the stub declares only `AsyncLocalStorage<T>` with `getStore()` and `run(store, fn)`, which is what we use.

## Conventions / Invariants

- **Adding a new env binding**: add it here AND in `../config/env.ts initialize_config(env)` AND in `.env.example` (documentation). Three changes per new env var; the registry pattern handles the rest.
- **Comment about KV TTL**: line near the `CACHE` binding declaration comments `(24h TTL)` — this is stale; actual TTL is 36h (`KV_*_TTL_SECONDS = 129_600` in both orchestrators). Worth fixing in a follow-up but not load-bearing.

## Gotchas / History

- **`KIMI_API_KEY` only enables Kimi if `SCRAPFLY_API_KEY` is also set** — the Kimi search adapter routes through Scrapfly residential proxy because `api.kimi.com` blocks Cloudflare-Workers ASN egress. The dependency is enforced at the registration / config layer, not in the env type.
- **Optional fields**: every key field is typed `string | undefined`. `validate_api_key()` (from `common/utils.ts`) throws `ProviderError(API_ERROR)` if missing — providers don't need to do their own null-check.

## Related

- `../config/env.ts` — wires these into `config`
- `../worker.ts` — uses `Env` as the type parameter for the Worker handler and the DO class
- `../common/r2_trace.ts` — `WaitUntilCapable` is the structural type used to scope CF `ExecutionContext` and DO `DurableObjectState` together
