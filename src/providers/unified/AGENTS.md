# AGENTS.md — src/providers/unified/

One dispatcher — `web_search` — that abstracts the registry of leaf search providers behind a single class. Auto-built from each leaf module's `registration` export. (URL fetching is delegated to the external omnifetch service — there is no `fetch.ts` dispatcher and no `UnifiedFetchProvider`.)

## Files

- **`web_search.ts`** — `UnifiedWebSearchProvider`. `PROVIDERS` array imports every leaf in `../search/` (10 entries: `tavily`, `brave`, `kagi`, `exa`, `firecrawl`, `perplexity`, `serpapi`, `linkup`, `you`, `parallel`). Constructor filters by `key()?.trim()` and instantiates only the active ones. `search({ provider, ...params })` dispatches by name, throwing `INVALID_INPUT` on unknown.

## How a leaf provider gets registered

Each unified file has a clearly-marked `// ─── ADD ONE LINE HERE TO REGISTER A NEW PROVIDER ─` block. To add `foo`:

```ts
import { FooSearchProvider, registration as foo_reg } from '../search/foo/index.js';

const PROVIDERS = [
  // ...
  { name: 'foo', ...foo_reg, factory: () => new FooSearchProvider() },
] as const;
```

That's it. `get_active_search_providers()` and `has_any_search_provider()` automatically include `foo` if its `key()` returns a non-empty trimmed string.

## Conventions / Invariants

- **`PROVIDERS` is `as const`** so `WebSearchProvider` is derived as a union literal type. New providers automatically appear in the type.
- **Constructor builds the active map**: `new Map(PROVIDERS.filter(p => p.key()?.trim()).map(p => [p.name, p.factory()]))`. Adding a key at runtime would not retroactively activate the provider — `initialize_config` + `initialize_providers` is the way to refresh.
- **`get_active_search_providers()`** returns `Array<{ name, key }>` — used by `/health` and `initialize_providers` to enumerate the active set.
- **`has_any_search_provider()`** returns boolean — used by `register_tools` to decide whether to register the `web_search` MCP tool at all.
- **Dispatch errors throw `ProviderError(INVALID_INPUT)`** with a list of valid names — the REST/MCP layer surfaces these as 400-equivalent.

## Gotchas / History

- **Active map is built at construction time.** If `initialize_config` runs again (e.g., after a memoized init failure resets), `initialize_providers` will rebuild a new `UnifiedWebSearchProvider` instance with the current active set.

## Related

- `../search/<name>/index.ts` — each leaf exports a class + a `registration` object
- `../index.ts` — `initialize_providers()` constructs this and hands it to `ToolRegistry`
- `../../server/web_search_fanout.ts` — consumes the unified dispatcher
