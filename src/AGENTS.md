# AGENTS.md — src/

Implementation root. Everything that ships at runtime is here.

## Top-level layout

| Path | What's there |
|------|--------------|
| `worker.ts` | Cloudflare Worker fetch entry; `OmnisearchMCP` Durable Object class; SSE keepalive injection; CORS; routing for `/health`, `/search`, `/fetch`, `/researcher`, `/mcp`. |
| `common/` | Shared infrastructure: types, HTTP, logging, R2 tracing, RRF ranking, snippet selection, query operators, utilities. See `common/AGENTS.md`. |
| `config/` | Runtime config (per-Worker-isolate). Populated from CF env bindings via `initialize_config(env)`. See `config/AGENTS.md`. |
| `providers/` | Provider adapters and unified dispatchers. Three categories: `search/`, `ai_response/`, `fetch/`, plus `unified/` dispatchers and `index.ts` initialization. See `providers/AGENTS.md`. |
| `server/` | Tool/REST orchestration: parallel fanouts (search, answer), waterfall (fetch), MCP tool registration, REST endpoints. See `server/AGENTS.md`. |
| `types/` | Type definitions: CF env bindings + a minimal AsyncLocalStorage stub (workerd provides the runtime, but we don't ship full `@types/node`). See `types/AGENTS.md`. |

## Where do I look for X?

**Worker entry / routing** → `worker.ts`. The default export's `fetch` handler is the only entry point. It:
1. Wraps the request in `run_with_execution_context(ctx, ...)` and `run_with_request_id(uuid, ...)` (both AsyncLocalStorage scoped).
2. Handles CORS preflight.
3. Routes by `request.method` + `url.pathname` to one of the REST handlers or the MCP DO handler.
4. Wraps SSE responses with `inject_sse_keepalive` to inject `event: ping` between complete events every 5s.

**Durable Object class** → `worker.ts` `class OmnisearchMCP extends McpAgent<Env>`. `init()` runs once per DO activation: `initialize_config` → `validate_config` → `initialize_providers` → `register_tools(this.server, () => this.ctx)` → `setup_handlers`. The `() => this.ctx` is critical (R4F01); see "Concurrency model" in README.

**REST endpoint handlers** → `server/rest_search.ts`, `server/rest_fetch.ts`, `server/rest_researcher.ts`. All three call `authenticate_rest_request` first, then delegate to the corresponding orchestrator. The researcher endpoint is unique in accepting auth via `?api_key=...` query param.

**MCP tool registration** → `server/tools.ts`. Three tools: `web_search`, `answer`, `fetch`. Each has Zod-typed `inputSchema` + `outputSchema`, an annotation block, and a closure that calls into the matching orchestrator. Tools wrap their callback in `with_ctx_scope(get_ctx, fn)` so trace flush_background calls inside the tool attach to the DO's `waitUntil`.

**Orchestrators** → `server/web_search_fanout.ts`, `server/answer_orchestrator.ts`, `server/fetch_orchestrator.ts`. See each file's top-of-file comment for the strategy.

**Provider implementations** → `providers/<category>/<name>/index.ts`. Each exports a class implementing `SearchProvider` or `FetchProvider`, and a `registration` object whose `key()` returns the configured API key (or undefined when unset). The unified dispatcher filters PROVIDERS by `key()?.trim()` to build the active set.

**Common utilities** → `common/`. `http.ts` for HTTP requests, `utils.ts` for `make_signal`, `hash_key`, `authenticate_rest_request`, `retry_with_backoff`. `logger.ts` for structured logging. `r2_trace.ts` for tracing.

## Conventions / Invariants

- **AsyncLocalStorage everywhere for per-request state.** Module-scope per-request state is forbidden. Use `run_with_request_id`, `run_with_execution_context`, `run_with_trace`.
- **Always go through `http_json` / `http_text`** instead of bare `fetch`. The wrappers handle: 5MB response-size guard, status-code → `ProviderError` mapping, body parsing, R2 trace recording, sanitized URL logging.
- **Throw `ProviderError`** (`common/types.ts`) — orchestrators catch it and convert to per-provider failure entries. Use `handle_provider_error(error, this.name, "context")` from `common/utils.ts` to handle conversion uniformly.
- **`retry_with_backoff` is opt-in.** Search and answer fanouts deliberately do NOT retry — multi-provider fanout IS the redundancy strategy. Retrying doubles worst-case latency for rare gains.
- **Imports use `.js` suffix** even for `.ts` source — ESM convention.
- **Functions over classes** for stateless work; classes only for the registry / tool registry / provider classes.
- **`nodejs_compat` flag in `wrangler.toml` is required.** Without it, `node:async_hooks` is unavailable and AsyncLocalStorage silently no-ops; per-request scoping breaks.

## Gotchas / History

- **R4F01: per-DO ctx scoping** — every MCP tool closure captures its own `get_ctx`. The `tools.ts` registry is module-scoped (shared across DO instances in the same isolate). A per-DO field on the registry would be overwritten by the most-recent registration. Capturing `() => this.ctx` per closure keeps each tool callback bound to the DO that registered it.
- **Init memoization with rejection retry**: both the Worker REST init path and the DO `init()` memoize the success promise but reset to `undefined` on rejection — a transient secret-load failure doesn't permanently brick the isolate.
- **Atomic provider registry swap**: `initialize_providers()` builds local Sets, then assigns them in one statement. Concurrent reads cannot observe an empty state mid-swap.
- **SSE keepalive write-lock**: pings interleave with pump writes via a write-lock serializer in `worker.ts inject_sse_keepalive`. Boundary detection (`\n\n`, `\r\n\r\n`, `\r\r`) is WHATWG-compliant.

## Related

- Top-level navigation: `../AGENTS.md`
- Per-tool documentation: README's "Three Tools" section
- Concurrency model deep-dive: README's "Concurrency model" section
