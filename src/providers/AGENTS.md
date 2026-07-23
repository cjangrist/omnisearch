# AGENTS.md — src/providers/

Provider adapters for the two tools, plus unified dispatchers and provider-set initialization. Every external API integration lives here.

## Files

- **`index.ts`** — `initialize_providers()` — atomic-swap registry initialization. Builds new `Set<string>`s for `active_providers.search`, `active_providers.fetch` from each unified module's `get_active_*_providers()`, then assigns them in one statement. Concurrent reads cannot observe a partially-built state. Also constructs the two `Unified*Provider` instances and registers them with the `ToolRegistry` in `../server/tools.ts`.

## Subfolders

- **`search/`** — 11 web-search providers (`tavily`, `brave`, `kagi`, `exa`, `firecrawl`, `perplexity`, `serpapi`, `linkup`, `you`, `kimi`, `parallel`). Each implements `SearchProvider` and exports a `registration` object. See `search/AGENTS.md`.
- **`fetch/`** — 28 URL fetch providers. See `fetch/AGENTS.md` for the full list. Most are general-purpose markdown-extractors; three are specialists (github, supadata, sociavault) and run as domain breakers in the waterfall.
- **`unified/`** — Two dispatchers: `web_search.ts`, `fetch.ts`. Each imports every leaf module's registration, builds a `PROVIDERS` array, and exposes a `Unified<Category>Provider` class that filters by `key()?.trim()` at construction. See `unified/AGENTS.md`.

## Registry pattern

Every provider follows the same shape:

```ts
// providers/<category>/<name>/index.ts

export class FooProvider implements SearchProvider {  // or FetchProvider
  name = 'foo';
  description = '...';
  async search(params: BaseSearchParams): Promise<SearchResult[]> { ... }
  // or async fetch_url(url: string): Promise<FetchResult> { ... }
}

export const registration = {
  key: () => config.<category>.foo.api_key,
};
```

The unified dispatcher then does:

```ts
import { FooProvider, registration as foo_reg } from '../<category>/foo/index.js';

const PROVIDERS = [
  { name: 'foo', ...foo_reg, factory: () => new FooProvider() },
  // ...
] as const;
```

`key()` returning a non-empty trimmed string means the provider is active and gets instantiated. Returning `undefined` or an empty string means it's silently skipped — the user just hasn't set the env var.

## Conventions / Invariants

- **Each leaf folder is self-contained** — one `index.ts` (with rare multi-file exceptions: `github`, `kimi` search). No cross-leaf imports.
- **Throw `ProviderError`** from inside the `search`/`fetch_url` method. Use `handle_provider_error(error, this.name, "context")` from `../common/utils.ts`.
- **Validate the API key at the start** of every method via `validate_api_key(config.<category>.<name>.api_key, this.name)`. The validator throws if missing.
- **Always go through `http_json` / `http_text`** — never bare `fetch`. The wrappers handle response-size guard, status-code mapping, and trace recording.
- **Use `make_signal(timeout, params.signal)`** for search providers so external aborts (deadlines from the orchestrator) compose with the per-provider timeout.
- **Parse search operators** via `apply_search_operators` / `build_query_with_operators` from `../common/search_operators.ts` if your provider supports them (Brave, Kagi, Tavily do).
- **Don't retry inside the provider.** Multi-provider fanout is the redundancy strategy — retries would multiply worst-case latency. The orchestrator decides retry policy.

## Gotchas / History

- **`fetch/github` is the largest leaf folder** (11 files): URL parser → resource-type dispatcher → 17 resource handlers + GraphQL fast-path for repo overview. Domain-breaker provider, exempt from the orchestrator's 200-char failure check. See `fetch/github/AGENTS.md`.
- **`search/kimi` is registered but currently unused** in production (no key set) per the ROI analysis in `docs/kimi-search-roi-analysis.md`. The folder is preserved for re-enablement if the upstream improves. `fetch/kimi` (different code path) is still active.

## Related

- `../server/tools.ts` — registers the two `Unified*Provider` instances against the MCP server
- `../server/web_search_fanout.ts`, `../server/fetch_orchestrator.ts` — orchestrators that dispatch through `Unified*`
- `../config/env.ts` — provider config defaults + key wiring
- `../types/env.ts` — env binding types
