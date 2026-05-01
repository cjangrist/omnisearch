# AGENTS.md — src/config/

Runtime configuration. Populated per-Worker-isolate from Cloudflare Worker env bindings.

## Files

- **`env.ts`** — Single source of truth for runtime config.
  - Exports `config` — a frozen-shape literal with three keys: `search`, `ai_response`, `fetch`. Each provider has `api_key` (or `username`/`password`/`account_id`) + `base_url` + `timeout` (and provider-specific extras like `model`, `zone`).
  - Exports `OPENWEBUI_API_KEY`, `OMNISEARCH_API_KEY`, `kv_cache` — top-level singletons set by `initialize_config(env)`.
  - `initialize_config(env)` populates `config.*.api_key` from env bindings, sets the KV cache reference, calls `set_trace_r2_bucket(env.TRACE_BUCKET)`, and resets conditional fields (LLM bridge URLs, BrightData zone) so removing a binding takes effect on the next isolate boot.
  - `validate_config()` walks the config tree, logs counts of available vs. missing providers. Called once per init.

## LLM bridge wiring detail

The OpenAI-compatible LLM bridge (chatgpt / claude / gemini / kimi) requires BOTH `LLM_SEARCH_BASE_URL` AND `LLM_SEARCH_API_KEY`. Without a key, requests fail auth every time, so the wiring deliberately gates on both. Each LLM has an optional model override env var (`LLM_SEARCH_CHATGPT_MODEL`, etc.) — when unset, defaults are `codex/gpt-5.4`, `claude/haiku`, `gemini/search-fast`, `kimi`.

## Gemini-grounded wiring detail

`config.ai_response.gemini_grounded.api_key = env.GEMINI_GROUNDED_API_KEY`. Optional `GEMINI_GROUNDED_MODEL` override; default `gemini-3.1-flash-lite-preview`. This provider is NOT registered in `unified/ai_search.ts PROVIDERS` — it's invoked directly from `answer_orchestrator.ts`. Setting the key alone is enough; no other registration step.

## Conventions / Invariants

- **`initialize_config` must be called before any provider is constructed.** The Worker fetch path (`ensure_rest_initialized`) and the DO `init()` both do this.
- **Init is memoized but resets on rejection.** A transient secret-load failure doesn't permanently brick the isolate.
- **Conditional fields are reset to defaults each init**, then re-applied. This prevents stale values from surviving when env vars are removed between deploys.
- **Adding a provider** requires:
  1. New env field in `../types/env.ts`.
  2. New entry in `config.<category>.<name>` here, with `api_key`, `base_url`, `timeout`.
  3. New line in `initialize_config(env)` to wire the env value into the config.
  4. Provider implementation + registration in `../providers/<category>/<name>/`.
  5. One line in the unified dispatcher (`../providers/unified/<category>.ts`).

## Gotchas / History

- **`config.fetch.brightdata.zone` defaults to `'unblocker'`** but can be overridden by `BRIGHT_DATA_ZONE`. The reset-then-re-apply pattern in `initialize_config` ensures removing the env var snaps back to default on the next deploy.
- **`OXYLABS` uses username + password**, not a single API key. Validation in `validate_config` looks at `cfg.api_key ?? cfg.username ?? cfg.account_id` so all three auth styles are supported.
- **`CLOUDFLARE_BROWSER` requires THREE env vars** (`CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_EMAIL` + `CLOUDFLARE_API_KEY`). Validation looks at `account_id` to gate registration; the provider impl validates all three at request time.
- **The KV cache and R2 trace bucket bindings come from `env.CACHE` and `env.TRACE_BUCKET`** — these are CF Worker resources defined in `wrangler.toml`, not env vars.

## Related

- `../types/env.ts` — env binding type definitions
- `../providers/index.ts` — `initialize_providers()` is called after `initialize_config`
- `../common/r2_trace.ts` — `set_trace_r2_bucket` is called from here
- `../common/logger.ts` — `loggers.config()` is the channel for init logs
