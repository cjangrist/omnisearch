# AGENTS.md — src/providers/

Provider adapters for the two tools, plus unified dispatchers and provider-set initialization. Every external API integration lives here.

## Files

- **`index.ts`** — `initialize_providers()` — atomic-swap registry initialization. Builds new `Set<string>`s for `active_providers.search` (from `get_active_search_providers()`) and `active_providers.fetch` (adds the single `'omnifetch'` entry when `OMNIFETCH_ENDPOINT` is configured), then assigns them in one statement. Concurrent reads cannot observe a partially-built state. Constructs the `UnifiedWebSearchProvider` and registers it with the `ToolRegistry` in `../server/tools.ts`. Fetch has no provider registry — it's tracked as the lone `omnifetch` entry.

## Subfolders

- **`search/`** — 10 web-search providers (`tavily`, `brave`, `kagi`, `exa`, `firecrawl`, `perplexity`, `serpapi`, `linkup`, `you`, `parallel`). Each implements `SearchProvider` and exports a `registration` object. See `search/AGENTS.md`.
- **`unified/`** — One dispatcher: `web_search.ts`. It imports every leaf search module's registration, builds a `PROVIDERS` array, and exposes `UnifiedWebSearchProvider` which filters by `key()?.trim()` at construction. See `unified/AGENTS.md`. (URL fetching is delegated to omnifetch — no `fetch/` providers and no `unified/fetch.ts`.)

## Registry pattern

Every provider follows the same shape:

```ts
// providers/search/<name>/index.ts

export class FooProvider implements SearchProvider {
  name = 'foo';
  description = '...';
  async search(params: BaseSearchParams): Promise<SearchResult[]> { ... }
}

export const registration = {
  key: () => config.search.foo.api_key,
};
```

The unified dispatcher then does:

```ts
import { FooProvider, registration as foo_reg } from '../search/foo/index.js';

const PROVIDERS = [
  { name: 'foo', ...foo_reg, factory: () => new FooProvider() },
  // ...
] as const;
```

`key()` returning a non-empty trimmed string means the provider is active and gets instantiated. Returning `undefined` or an empty string means it's silently skipped — the user just hasn't set the env var.

## Conventions / Invariants

- **Each leaf folder is self-contained** — one `index.ts`. No cross-leaf imports.
- **Throw `ProviderError`** from inside the `search` method. Use `handle_provider_error(error, this.name, "context")` from `../common/utils.ts`.
- **Validate the API key at the start** of every method via `validate_api_key(config.search.<name>.api_key, this.name)`. The validator throws if missing.
- **Always go through `http_json`** — never bare `fetch`. The wrapper handles response-size guard, status-code mapping, and trace recording.
- **Use `make_signal(timeout, params.signal)`** for search providers so external aborts (deadlines from the orchestrator) compose with the per-provider timeout.
- **Parse search operators** via `apply_search_operators` / `build_query_with_operators` from `../common/search_operators.ts` if your provider supports them (Brave, Kagi, Tavily do).
- **Don't retry inside the provider.** Multi-provider fanout is the redundancy strategy — retries would multiply worst-case latency. The orchestrator decides retry policy.

## Gotchas / History

_(none currently)_

## Related

- `../server/tools.ts` — registers the `UnifiedWebSearchProvider` against the MCP server
- `../server/web_search_fanout.ts` — orchestrator that dispatches through `UnifiedWebSearchProvider`
- `../config/env.ts` — provider config defaults + key wiring
- `../types/env.ts` — env binding types
