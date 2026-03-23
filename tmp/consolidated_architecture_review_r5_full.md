# Full Prioritized Item List (Round 5) — Omnisearch MCP Server

**Source:** All 5 R5 reviews (Gemini, Codex, Kimi, Cline, Opus) read in full
**Compiled by:** Claude Opus 4.6 | 2026-03-22

---

## CRITICAL / HIGH

### H1. Fetch providers don't accept AbortSignal — 4/5 (Gemini, Codex, Kimi, Opus)
**Files:** `common/types.ts:36`, all 25+ `providers/fetch/*/index.ts`, `fetch_orchestrator.ts`
**What:** `FetchProvider.fetch_url(url)` has no signal parameter. All fetch providers create their own `AbortSignal.timeout()`. When `Promise.any` resolves with a winner, losers keep running. When MCP client disconnects, in-flight fetches continue until individual timeouts (up to 60s).
**Fix:** Add `signal?: AbortSignal` to `FetchProvider` interface. Update all fetch providers to use `make_signal(timeout, signal)`. Thread signal from `run_fetch_race` → `try_provider` → provider.

### H2. HTTP 500 from providers classified as PROVIDER_ERROR instead of API_ERROR — 2/5 (Cline, Opus)
**Files:** `common/http.ts:109-110`
**What:** The `default` branch for status >= 500 throws `ErrorType.PROVIDER_ERROR`. But `shouldRetry` in `retry_with_backoff` only retries `PROVIDER_ERROR`. A 500 from a provider API is a transient server error that *should* be retried. The current classification accidentally makes 500s retryable, but for the wrong semantic reason — it should be `API_ERROR` to distinguish from content-level failures (blocked/empty).
**Actually:** Wait — re-reading `shouldRetry`: it returns `true` for `PROVIDER_ERROR` and `true` for non-ProviderError. So 500s ARE retried currently. Changing to `API_ERROR` would make them NOT retried (only `PROVIDER_ERROR` is retried). **This needs careful thought** — Cline's suggestion would actually break retry for 500s.
**Revised fix:** Keep `PROVIDER_ERROR` for 500s (they should be retried). The semantic naming is slightly off but the behavior is correct. OR rename the retry logic to `error.type !== ErrorType.RATE_LIMIT && error.type !== ErrorType.INVALID_INPUT` for clarity.

### H3. Explicit-provider fetch returns known-bad content as success — 2/5 (Codex, already logged)
**Files:** `fetch_orchestrator.ts:299-305`
**What:** Explicit provider mode logs a warning on `is_fetch_failure()` but still returns the result. Callers get CAPTCHA/challenge pages as successful 200.
**Fix:** Throw `ProviderError` when `is_fetch_failure(result)` is true in explicit mode, or add `quality_warning: true` to the response.

### H4. REST body size guard relies on Content-Length header only — 1/5 (Gemini)
**Files:** `rest_search.ts:41-42`, `rest_fetch.ts:40-41`
**What:** `parseInt(request.headers.get('content-length') ?? '0')` — chunked transfer encoding omits Content-Length, bypassing the 64KB guard. `await request.json()` then buffers unbounded payload.
**Fix:** Stream-read `request.body` with byte counter (like `http_core` does), or use CF dashboard request size limits.

---

## MEDIUM — Correctness / Behavior

### M1. `make_signal` polyfill has dead code — 1/5 (Cline, verified by hand)
**Files:** `common/utils.ts:14-19`
**What:** Already fixed above — removed redundant `controller.signal.addEventListener` and consolidated `clearTimeout` into `on_abort`.
**Status:** ✅ FIXED (uncommitted)

### M2. Domain breaker success doesn't push to `attempted` array — 1/5 (Gemini)
**Files:** `fetch_orchestrator.ts:~338`
**What:** When a domain breaker succeeds, the returned `providers_attempted` array may be missing the breaker provider since `run_solo` handles it but the breaker path calls it after `ctx.attempted.push` happens inside `run_solo`.
**Fix:** Verify `run_solo` pushes to `ctx.attempted` (it does at line 161). Actually this may be a non-issue — need to verify.

### M3. Duplicate auth logic in REST handlers — 2/5 (Opus, Codex)
**Files:** `rest_search.ts:22-38`, `rest_fetch.ts:22-37`
**What:** Identical Bearer token validation code duplicated in both files.
**Fix:** Extract to shared `authenticate_request(request): Response | null` utility.

### M4. `config` object is deeply mutable — no freeze after init — 2/5 (Opus, Kimi)
**Files:** `config/env.ts:16-253`
**What:** Any import site could accidentally mutate `config.search.tavily.base_url` etc.
**Fix:** `Object.freeze()` recursively after `initialize_config()`, or use `ReadonlyDeep<>` type.

### M5. `initialize_config` doesn't reset optional fields before reapplying — 2/5 (Codex, Gemini)
**Files:** `config/env.ts:282-302`
**What:** LLM base_url/api_key/model and BrightData zone are only set when env vars are present. If env vars are removed between deploys, stale values survive in the config object.
**Fix:** Reset conditional fields to defaults at top of `initialize_config()` before applying env overrides.

### M6. KV cache key uses null byte separator — 1/5 (Kimi)
**Files:** `web_search_fanout.ts:23-26`
**What:** Cache key format `query\0sqf=...` uses `\0` which some systems handle poorly.
**Fix:** Use `|` or hash the key with SHA-256.

### M7. Perplexity citations use generic snippet string — 1/5 (Cline)
**Files:** `providers/ai_response/perplexity/index.ts:140-143`
**What:** Citations mapped with `snippet: 'Source citation'` — loses URL value, gets downranked by quality filter.
**Fix:** Use citation URL as snippet, or `snippet: \`Research source: ${citation}\``.

### M8. `config.yaml` referenced in comments but not loaded at runtime — 2/5 (Codex, Cline)
**Files:** `fetch_orchestrator.ts:8`
**What:** Comment says "Config: config.yaml (source of truth)" but the CONFIG object is hardcoded in TypeScript. No YAML is read.
**Fix:** Remove misleading comment, or implement build-time YAML→TS generation.

### M9. `provider-info` resource URI is search-specific but serves all categories — 2/5 (Codex, Opus)
**Files:** `handlers.ts:53`
**What:** `omnisearch://search/{provider}/info` but serves search, AI, and fetch providers.
**Fix:** Rename to `omnisearch://providers/{provider}/info`.

### M10. Web search fanout cache key includes `timeout_ms` — 1/5 (Cline)
**Files:** `web_search_fanout.ts:23-26`
**What:** Same query with different timeout gets different cache entries. A timed-out partial result gets cached separately from a full result.
**Fix:** Remove `timeout_ms` from cache key — timeout affects latency, not result quality. The `providers_succeeded.length > 0` guard already prevents caching total failures.

### M11. REST `/search` returns full result set when `count` omitted; MCP always truncates — 1/5 (Codex)
**Files:** `rest_search.ts:138`, `tools.ts`
**What:** REST returns all merged results when `count` is 0/omitted. MCP `web_search` always applies `truncate_web_results`. Different payload sizes for the same query.
**Fix:** Apply `truncate_web_results()` in REST too, then cap with `count`.

### M12. MCP tool calls via DO bypass AsyncLocalStorage context — 1/5 (Gemini)
**Files:** `server/tools.ts` tool handlers
**What:** `run_with_request_id` wraps the Worker fetch handler, but MCP tool calls arrive through the DO's `McpAgent` which doesn't set up the ALS context. Provider logs from MCP calls have `requestId: undefined`.
**Fix:** Generate UUID and wrap each `server.registerTool` handler body with `run_with_request_id(uuid, async () => { ... })`.

### M13. Fetch orchestrator always caches in explicit provider mode — 1/5 (Cline)
**Files:** `fetch_orchestrator.ts:305`
**What:** Explicit-provider fetch skips cache *read* but the result still goes through `build_result` (not `build_and_cache`), so it's actually NOT cached. **Non-issue on re-reading.**

### M14. `handle_rate_limit` dead `break` statement — 3/5 (Opus, Codex, Cline)
**Files:** `common/http.ts:112-113`
**What:** `handle_rate_limit()` returns `never` (always throws). The `break` after it is dead code.
**Fix:** Remove the `break`.

### M15. HTTP response logged twice for REST paths — 1/5 (Codex)
**Files:** `rest_search.ts:171,179`, `worker.ts:287,311`
**What:** Both the handler and the worker wrapper emit `logger.response()` for the same request.
**Fix:** Keep handler-level logging, remove duplicate from worker wrapper. Or vice versa.

### M16. `provider-status` resource always reports "operational" even when empty — 1/5 (Codex)
**Files:** `handlers.ts:22-43`
**What:** Returns `status: 'operational'` regardless of whether any providers are available.
**Fix:** Check `total > 0` and return `'degraded'` or `'unavailable'` accordingly.

---

## MEDIUM — Performance

### P1. SSE `flatten()` called on every pump iteration — 2/5 (Gemini, Opus)
**Files:** `worker.ts:116`
**What:** `flush_complete_events` calls `flatten()` which merges all chunks, even when no line break is present in the latest chunk.
**Fix:** Only call `flush_complete_events()` if the new chunk contains `\n` or `\r`: `if (value.indexOf(0x0a) !== -1 || value.indexOf(0x0d) !== -1)`.

### P2. `new URL()` called repeatedly for same URL in fetch breaker matching — 1/5 (Opus)
**Files:** `fetch_orchestrator.ts:118-126`
**What:** `matches_breaker` calls `new URL(url)` for each breaker config entry. URL is the same.
**Fix:** Parse once, pass hostname.

### P3. `get_active_*_providers()` allocates new array on every call — 1/5 (Opus)
**Files:** `providers/unified/*.ts`
**What:** Called during initialization and at fanout start. Provider list doesn't change after init.
**Fix:** Cache the result after `initialize_providers()`.

### P4. `normalize_url` in RRF called repeatedly for same URL — 1/5 (Cline)
**Files:** `common/rrf_ranking.ts`
**What:** URL normalization per-result could be called thousands of times.
**Fix:** Memoize with a Map within each `compute_rrf_scores` call.

### P5. `sentence_merge` uses O(n²) splice — 2/5 (Cline, Kimi)
**Files:** `common/snippet_selector.ts`
**What:** `deduped.splice()` in while loop.
**Fix:** Use `Set<number>` for selected indices, filter at end.

### P6. KV writes awaited on hot path — 2/5 (Gemini, Cline)
**Files:** `web_search_fanout.ts:236`, `answer_orchestrator.ts:283`, `fetch_orchestrator.ts`
**What:** `await` on KV `put()` adds 10-50ms to every non-cached response.
**Fix:** Use `ctx.waitUntil()` for MCP path (DO keeps isolate alive). Keep `await` for REST path (required). Requires threading `ctx` or detecting path.

---

## LOW — Code Quality / Nits

### L1. `handle_provider_error` lacks explicit `never` return type annotation — 1/5 (Cline)
**Files:** `common/utils.ts:68`
**What:** Function always throws but return type annotation would help TypeScript catch unreachable code.
**Fix:** Already typed as `never` — verified. Non-issue.

### L2. Dead `break` after `handle_rate_limit` — see M14 above

### L3. You.com provider description overclaims capabilities — 1/5 (Codex)
**Files:** `providers/search/you/index.ts:44,53`
**What:** Description mentions operators, freshness, domain, language targeting. Implementation only sends `query` and `count`.
**Fix:** Narrow description or wire through params.

### L4. `CACHE` KV binding typed as required in Env but treated as optional in code — 1/5 (Opus)
**Files:** `types/env.ts:64`, `config/env.ts:14`
**What:** `Env.CACHE: KVNamespace` (required) but `kv_cache: KVNamespace | undefined`.
**Fix:** Make consistent — either optional in Env or remove `| undefined` from kv_cache.

### L5. Logger factory creates new instances per call — 1/5 (Opus, Kimi)
**Files:** `common/logger.ts:201-214`
**What:** `loggers.search(p.name)` called inside loops creates new Logger per provider per request.
**Fix:** Memoize by component name. Low impact — Logger is lightweight.

### L6. No `count` upper bound validation in REST `/search` — 1/5 (Opus)
**Files:** `rest_search.ts:59`
**What:** `count: 999999` is accepted.
**Fix:** Cap at a reasonable max (e.g., 100).

### L7. `/health` doesn't check provider availability — 2/5 (Cline, Opus)
**Files:** `worker.ts:316-323`
**What:** Always returns `{ status: 'ok' }` even with zero providers configured.
**Fix:** Check `active_providers` and return `'degraded'` if empty.

### L8. SSE keepalive interval could leak if pump throws synchronously — 1/5 (Kimi)
**Files:** `worker.ts:132-159`
**What:** Interval created before pump, if pump throws synchronously before `finally`, interval leaks.
**Fix:** Move interval creation inside pump's try block.

### L9. `eval('require')` in logger.ts for AsyncLocalStorage — 1/5 (Opus)
**Files:** `common/logger.ts:19`
**What:** Uses `eval('require')` to avoid bundler issues. Works but fragile.
**Fix:** Use dynamic `import()` or declare ALS type and import normally with `nodejs_compat`.

### L10. `AbortSignal.any()` used directly in `web_search_fanout.ts` but polyfill in `utils.ts` — 1/5 (Gemini)
**Files:** `web_search_fanout.ts:84`
**What:** `AbortSignal.any([signal, deadline_controller.signal])` used directly instead of going through `make_signal` polyfill.
**Fix:** Use `make_signal` or at minimum feature-check `AbortSignal.any` before calling.

---

## Summary by Consensus

| Consensus | Count | Items |
|-----------|-------|-------|
| 4/5 | 1 | H1 (fetch provider signals) |
| 3/5 | 1 | M14 (dead break) |
| 2/5 | 10 | H2, H3, M3, M4, M5, M8, M9, P1, P5, P6, L7 |
| 1/5 | 16 | Everything else |
