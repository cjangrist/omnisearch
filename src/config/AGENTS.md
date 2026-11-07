# AGENTS.md — src/config/

Runtime configuration. Populated per-Worker-isolate from Cloudflare Worker env bindings.

## Files

- **`env.ts`** — Single source of truth for runtime config.
  - Exports `config` — a frozen-shape literal with two keys: `search`, `snippet_grounding`. Each search provider has `api_key` + `base_url` + `timeout`; `snippet_grounding.llm` holds the grounding-LLM settings.
  - Exports `OPENWEBUI_API_KEY`, `OMNISEARCH_API_KEY`, `OMNIFETCH_ENDPOINT`, `kv_cache` — top-level singletons set by `initialize_config(env)`. `OMNIFETCH_ENDPOINT` is the base URL of the external omnifetch service (`undefined` when unset/empty); omnisearch POSTs `{url}` to `${OMNIFETCH_ENDPOINT}/web_fetch`.
  - `initialize_config(env)` populates `config.*.api_key` from env bindings, sets `OMNIFETCH_ENDPOINT`, sets the KV cache reference, and calls `set_trace_r2_bucket(env.TRACE_BUCKET)` so removing a binding takes effect on the next isolate boot.
  - `validate_config()` walks the config tree, logs counts of available vs. missing providers (including `snippet_grounding.llm`). Called once per init.

## Snippet grounding (Cerebras) wiring detail

`config.snippet_grounding.llm` is a self-contained block driving the `/search` grounding stage in `src/server/grounded_snippets.ts`. The key is provider-neutral (`llm`); the active provider is Cerebras as of 2026-06-20 (key from `CEREBRAS_API_KEY`, ~3× faster than the prior provider on this workload). Fields and defaults:

- `api_key`     — `env.CEREBRAS_API_KEY`. Default OFF (undefined). When set, the grounding stage runs after RRF for `web_search` / `POST /search`.
- `base_url`    — `https://api.cerebras.ai/v1` (OpenAI-compatible chat-completions endpoint).
- `model`       — `gpt-oss-120b` (Cerebras drops the `openai/` prefix the prior provider required). Chosen over the 20B variant after the 20B emitted degenerate-sampling output (`hhgghghvgegggg`-style mash) under detailed-prompt + 6k-token-context load.
- `timeout`     — `60000` ms (LLM HTTP timeout — separate from `per_url_deadline_ms`).
- `max_content_chars` — `24000` (page body truncation before sending to the LLM).
- `concurrency` — `10` (worker pool width). Makespan is wave-bound, so wider pools cut waves; 20 (one worker/URL) measured ~2× slower per-URL because high fan-out overwhelms fetch + LLM. NB: Cloudflare relaxed the 6-connection cap on 2026-04-09, so >6 no longer gets spuriously cancelled.
- `per_url_deadline_ms` — `7500` (deadline per URL pipeline; aborts the inner fetch + LLM HTTP via `AbortController` on fire). Halved from 15s on 2026-06-21 — cut-off URLs fall back to the aggregated snippet with negligible quality loss.
- `fetch_min_content_chars` — `50` (skip the LLM when the page body is below this).
- `llm_min_snippet_chars` — `1` (treat empty LLM output as the `llm_empty` outcome).

This block lives at the top level of `config` because it isn't a peer of the search providers — it's a separate pipeline plugged into `web_search_fanout`. The wiring in `initialize_config(env)` is a single line: `config.snippet_grounding.llm.api_key = env.CEREBRAS_API_KEY`. No registration in any unified dispatcher; the orchestrator imports `config.snippet_grounding.llm` directly.

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

- **The KV cache and R2 trace bucket bindings come from `env.CACHE` and `env.TRACE_BUCKET`** — these are CF Worker resources defined in `wrangler.toml`, not env vars.

## Related

- `../types/env.ts` — env binding type definitions
- `../providers/index.ts` — `initialize_providers()` is called after `initialize_config`
- `../common/r2_trace.ts` — `set_trace_r2_bucket` is called from here
- `../common/logger.ts` — `loggers.config()` is the channel for init logs
