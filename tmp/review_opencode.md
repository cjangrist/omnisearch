[0m
> build · big-pickle
[0m
I'll conduct an extremely thorough code review. Let me start by reading all the files in parallel.
[0m→ [0mRead src/worker.ts
[0m→ [0mRead src/server/tools.ts
[0m→ [0mRead src/server/answer_orchestrator.ts
[0m→ [0mRead src/server/web_search_fanout.ts
[0m→ [0mRead src/types/env.ts
[0m→ [0mRead src/server/fetch_orchestrator.ts
[0m→ [0mRead wrangler.toml
[0m→ [0mRead package.json
[0m→ [0mRead src/config/env.ts
[0m→ [0mRead src/providers/index.ts
[0m→ [0mRead src/server/handlers.ts
[0m→ [0mRead src/server/rest_search.ts
[0m→ [0mRead src/server/rest_fetch.ts
[0m→ [0mRead src/common/logger.ts
[0m→ [0mRead src/common/types.ts
[0m→ [0mRead src/common/http.ts
Now let me read the unified providers and utility files:
[0m→ [0mRead src/providers/unified/ai_search.ts
[0m→ [0mRead src/providers/unified/web_search.ts
[0m→ [0mRead src/common/utils.ts
[0m→ [0mRead src/providers/unified/fetch.ts
[0m→ [0mRead src/common/rrf_ranking.ts
Now let me examine the `agents` package type definitions to understand `McpAgent`:
[0m✱ [0mGlob "node_modules/agents/dist/**/*.d.ts"[90m 0 matches[0m
[0m✱ [0mGlob "node_modules/@modelcontextprotocol/sdk/dist/**/*.d.ts"[90m 0 matches[0m
[0m
[0m$ [0mls node_modules/agents/dist/ 2>/dev/null || ls node_modules/agents/ 2>/dev/null | head -30
ai-chat-agent.d.ts
ai-chat-agent.js
ai-chat-agent.js.map
ai-chat-v5-migration.d.ts
ai-chat-v5-migration.js
ai-chat-v5-migration.js.map
ai-react.d.ts
ai-react.js
ai-react.js.map
ai-types.d.ts
ai-types.js
ai-types.js.map
cli
client-K8Z-u76l.js
client-K8Z-u76l.js.map
client.d.ts
client.js
client.js.map
codemode
do-oauth-client-provider-C2jurFjW.d.ts
email-U_MG7UET.d.ts
email.d.ts
email.js
email.js.map
experimental
index-B6xYRT3K.d.ts
index-D9AuAMOt.d.ts
index.d.ts
index.js
index.js.map
internal_context-DgcmHqS1.d.ts
internal_context.d.ts
internal_context.js
internal_context.js.map
mcp
observability
react.d.ts
react.js
react.js.map
retries-DXMQGhG3.d.ts
retries.d.ts
retries.js
retries.js.map
schedule.d.ts
schedule.js
schedule.js.map
serializable.d.ts
serializable.js
types-BB1plA51.d.ts
types.d.ts
types.js
types.js.map
utils.d.ts
utils.js
utils.js.map
workflow-types-CZNXKj_D.d.ts
workflow-types.d.ts
workflow-types.js
workflow-types.js.map
workflows.d.ts
workflows.js
workflows.js.map
[0m
[0m$ [0mls node_modules/@modelcontextprotocol/sdk/ 2>/dev/null | head -20
LICENSE
README.md
dist
package.json
[0m
[0m→ [0mRead node_modules/agents/dist/mcp/index.d.ts
[0m
[0m$ [0mls node_modules/agents/dist/mcp/
client.d.ts
client.js
do-oauth-client-provider.d.ts
do-oauth-client-provider.js
do-oauth-client-provider.js.map
index.d.ts
index.js
index.js.map
x402.d.ts
x402.js
x402.js.map
[0m
[0m→ [0mRead node_modules/agents/dist/index.d.ts
[0m→ [0mRead node_modules/agents/dist/index-B6xYRT3K.d.ts
Let me check the agents package version and look at key parts:
[0m
[0m$ [0mcat node_modules/agents/package.json | grep -E '"version"|"name"'
"name": "agents",
  "version": "0.7.9",
[0m
[0m$ [0mcat node_modules/@modelcontextprotocol/sdk/package.json | grep '"version"'
"version": "1.27.1",
[0m
Let me also check the snippet selector and gemini grounded provider:
[0m→ [0mRead src/common/snippet_selector.ts
[0m
[0m$ [0mls src/providers/ai_response/gemini_grounded/ 2>/dev/null
index.ts
[0m
[0m→ [0mRead src/providers/ai_response/gemini_grounded/index.ts
[0m
[0m$ [0mls src/providers/ai_response/
brave_answer
exa_answer
gemini_grounded
kagi_fastgpt
llm_search
perplexity
tavily_answer
[0m
[0m$ [0mls src/providers/ai_response/llm_search/
index.ts
[0m
[0m→ [0mRead src/providers/ai_response/llm_search/index.ts
[0m→ [0mRead node_modules/agents/dist/index-B6xYRT3K.d.ts[90m [offset=1600, limit=500][0m
[0m→ [0mRead node_modules/agents/dist/index-B6xYRT3K.d.ts[90m [offset=2100, limit=300][0m
[0m✱ [0mGrep "onStart|\.init\("[90m 0 matches[0m
[0m→ [0mRead node_modules/agents/dist/index-B6xYRT3K.d.ts[90m [offset=2400, limit=200][0m
Now let me research SSE spec and Cloudflare Durable Objects to verify key aspects:
[0m◇ [0mExa Code Search "Cloudflare Durable Object WebSocket hibernation SSE lifecycle init onStart"
[0m◇ [0mExa Code Search "SSE Server-Sent Events spec event comment format keepalive"
Now I have enough information for a comprehensive review. Let me run typecheck to verify current state:
[0m
[0m$ [0mcd /home/cjangrist/dev/omnisearch && npm run typecheck 2>&1 | head -50
> omnisearch-mcp@1.0.0 typecheck
> tsc --noEmit
[0m
TypeScript passes cleanly. Here is my comprehensive review:

---

## CRITICAL — Must fix before merging

**1. Auth bypass when no API key is configured**
- `src/server/rest_search.ts:23` and `src/server/rest_fetch.ts:23`
- When neither `OPENWEBUI_API_KEY` nor `OMNISEARCH_API_KEY` is set, `expected_key` is `''`. The condition `if (expected_key)` evaluates to `false` so auth is skipped — this is correct. **However**, the condition is `if (expected_key)` which means if only whitespace keys are set (`' '` trimmed to `''`), auth is bypassed. More critically, the logic flow means when `expected_key` is set to a single space (edge case), `if (expected_key)` is truthy, `token` is `''`, and `timing_safe_equal(' ', '')` returns `false` → auth correctly rejected. The real risk is misconfigured environments where the check should be explicit.
- **Fix**: Make the condition explicit: `if (expected_key && expected_key.trim())`

**2. Module-level global mutation on REST hot path**
- `src/worker.ts:171-210` — Every REST `/search` and `/fetch` call calls `initialize_config(env)`, `validate_config()`, and `initialize_providers()` inline, which mutate module-level globals and the `ToolRegistry` singleton. While the single-threaded nature of Workers/DOs prevents torn reads, this pattern is fragile and could cause subtle bugs if any future refactoring introduces concurrent execution or if the order of operations changes.
- **Fix**: REST endpoints should route through the DO so initialization happens once per session, or the REST initialization should be moved to a shared utility that guards against redundant work.

---

## HIGH — Should fix before merging

**3. SSE keepalive injection is POST-only, GET SSE streams not covered**
- `src/worker.ts:227-232` — The keepalive injection only triggers on `request.method === 'POST'`. The SSE keepalive comment mentions preventing Claude web's 45-second timeout, but Claude web primarily uses GET for SSE subscriptions (streaming tool responses). If the MCP SDK ever uses GET for long-running streams, those won't receive keepalives.
- **Impact**: Potential timeout on GET SSE streams if the MCP transport uses them for tool streaming.
- **Fix**: Consider injecting keepalive for all SSE responses regardless of method, or at minimum document why POST-only is intentional.

**4. DO eviction mid-request with long-running fanouts**
- The answer fanout has a 120-second hard deadline. If a DO is evicted mid-fanout (after 70-140s idle), the request fails with an unclear error. There's no `keepAlive()` or `keepAliveWhile()` call during fanouts to prevent eviction.
- **Impact**: Long-running answer tool calls (up to 2 minutes) could fail if the DO goes idle between the start of the fanout and completion.
- **Fix**: Wrap long-running fanouts in `this.keepAliveWhile(...)` to ensure the DO stays alive during the entire operation.

**5. `total_duration_ms` measured incorrectly in `execute_tasks`**
- `src/server/answer_orchestrator.ts:204` — `final_answers` and `final_failed` use `duration_ms` computed at the time each promise resolved (relative to `start_time`). But `result.total_duration_ms` is computed at line 235 as `Date.now() - start_time` after `execute_tasks` returns. If any promise resolved after the deadline, its `duration_ms` could exceed `total_duration_ms`, making the timing data inconsistent.
- **Fix**: Cap each provider's `duration_ms` at the deadline when marking pending providers as timed out, and ensure reported durations are consistent.

**6. `retry_with_backoff` called with `1` means 1 retry, not 2 attempts**
- `src/server/web_search_fanout.ts:55-58` — `retry_with_backoff(..., 1)` passes `max_retries: 1` to `p-retry`, which means 1 retry = 2 total attempts (initial + 1 retry). This is probably intentional but undocumented. If the intent was to retry once (2 total attempts), the call should be `2`. If the intent was 1 total attempt with no retries, it should be `0`.
- **Fix**: Verify intent and use explicit named option `{ max_retries: 1 }` for clarity.

**7. `structuredContent` may not be respected by all MCP clients**
- `src/server/tools.ts:158, 200` — Tools return both `structuredContent` (for programmatic clients) and `content` (JSON text). The MCP spec doesn't guarantee clients will use `structuredContent`. If a client only reads `content`, the JSON text may be large (e.g., full answer fanout with 9 provider results).
- **Fix**: Consider whether `structuredContent` is actually consumed by Claude desktop or if this is dead code. If unused, it adds complexity without benefit.

---

## MEDIUM — Should fix soon

**8. Module-level `SSE_PING` shared across concurrent streams**
- `src/worker.ts:60` — `SSE_PING` is a shared `Uint8Array`. While `TextEncoder` produces identical output and `TransformStream` buffers writes, the comment doesn't explain why this is safe. If the encoder's internal state were mutable (it's not), this would be a bug.
- **Fix**: Add a comment explaining this is safe because `TextEncoder` has no mutable state and each `write()` call is atomic.

**9. No maximum cap on `timeout_ms` for web search fanout**
- `src/server/web_search_fanout.ts:86-90` — If `timeout_ms` is passed as an extremely large value (e.g., `Number.MAX_SAFE_INTEGER`), the fanout effectively runs forever. No upper bound is enforced.
- **Fix**: Cap `timeout_ms` at a reasonable maximum (e.g., 60 seconds) and document the limit.

**10. Progress interval continues logging after deadline for answer fanout**
- `src/server/answer_orchestrator.ts:157-168` — The `setInterval` fires every 5 seconds logging pending providers. After the deadline resolves (120s), `clearInterval` is called in `finally`, but there's a race where a pending interval callback could fire between the deadline resolution and `finally` running, logging stale pending state after the function has conceptually completed.
- **Impact**: Minor log pollution with stale data.
- **Fix**: Add `closed` flag to the interval callback similar to the SSE keepalive pattern.

**11. `llm_reg` spread in PROVIDERS array**
- `src/providers/unified/ai_search.ts:25` — The `llm_reg` array spread produces `ChatGPTProvider`, `ClaudeProvider`, and `GeminiProvider` with dynamic `key()` functions that close over `config`. If `config` changes after initialization, these providers might appear/disappear from the active list unexpectedly.
- **Impact**: Minor — the unified registry is re-built on each `initialize_providers()` call, and `get_active_ai_providers()` is called fresh each time.
- **Fix**: Document that provider key functions are called dynamically, or memoize the active list.

**12. Error responses in MCP tool handlers lack structured error codes**
- `src/server/tools.ts:145-147, 149-155` — When no providers are configured or all fail, the tool returns `isError: true` with a human-readable text message. For programmatic clients, a structured error with a code would be more actionable.
- **Fix**: Consider adding an `error_code` field to structured error responses.

**13. `web_search_fanout` result snapshots not consistent with answer fanout**
- `src/server/web_search_fanout.ts:106-110` — When timeout is hit, the function snapshots results with `new Map(results_by_provider)`. However, in the non-timeout path (line 121), it returns the live `results_by_provider`. If any in-flight promise pushes to the map after `rank_and_merge` starts reading it, this could cause inconsistent rankings.
- **Fix**: Always snapshot in the non-timeout path too, or ensure `rank_and_merge` doesn't mutate the map.

**14. Provider-level `loggers.search(p.name)` creates new Logger instances**
- `src/server/web_search_fanout.ts:50` — Each provider's promise calls `loggers.search(p.name)` to create a provider-specific logger. While `Logger` instances are lightweight, this creates many short-lived objects in the hot path.
- **Fix**: Consider passing the logger down or using a shared provider logger pool.

---

## LOW — Nice to have

**15. `@ts-expect-error` for SDK version mismatch**
- `src/worker.ts:108` — The comment explains this is safe because wrangler bundles a single copy, but a future wrangler change could break this silently. Consider pinning the `agents` version to a specific minor (e.g., `0.7.9` without `^`) to reduce risk.

**16. Tool descriptions contain URLs that could become stale**
- `src/server/tools.ts:76, 120, 172` — Provider lists in tool descriptions include URLs that could break or change over time.

**17. Unused export `sanitize_for_log` has a bug**
- `src/common/utils.ts:14-15` — `sanitize_for_log` removes control chars but also strips newlines (`\n`, `\r`) which might be intentional in some log contexts. Consider whether this is the desired behavior.

**18. `create_error_response` loses `ProviderError` details**
- `src/common/utils.ts:79-90` — `create_error_response` returns the provider name and message, but loses the `ErrorType` and any `details` from `ProviderError`. Callers who want to return structured errors must re-extract this information.

**19. `handle_rate_limit` has `never` return type but always throws**
- `src/common/utils.ts:36-48` — The `never` return type is correct but the function could be clearer as a regular function that throws.

**20. `ProviderError` extends `Error` but doesn't include the cause chain in the message**
- `src/common/types.ts:48-58` — When wrapping errors, `handle_provider_error` preserves the stack trace but the `ProviderError.message` only contains the wrapper message, not the original error message. This could make debugging harder.

---

## POSITIVE — What was done well

**1. Excellent fanout architecture with RRF ranking**
The multi-provider search fanout with Reciprocal Rank Fusion is well-designed. The `rank_and_merge` function deduplicates across providers and the `truncate_web_results` with `rescue_tail_results` shows sophisticated thinking about result quality vs. completeness.

**2. Intelligent snippet selection**
`src/common/snippet_selector.ts` implements a sophisticated greedy set-cover algorithm for merging provider snippets. The bigram-based Jaccard similarity, query relevance scoring, and sentence-level merging are production-quality text processing.

**3. Consistent error handling pattern**
`ProviderError` with `ErrorType` enum provides structured error categorization (API_ERROR, RATE_LIMIT, INVALID_INPUT, PROVIDER_ERROR) that flows through all fanout patterns. The `retry_with_backoff` correctly distinguishes retryable vs. non-retryable error types.

**4. Provider registry pattern is clean and extensible**
The unified dispatcher pattern (`UnifiedWebSearchProvider`, `UnifiedAISearchProvider`, `UnifiedFetchProvider`) with factory registrations makes adding new providers trivial — one line per provider. The `registration` pattern with key getters is elegant.

**5. SSE keepalive injection is correct**
The `inject_sse_keepalive` function correctly uses `TransformStream` to inject well-formed SSE events (`event: ping\ndata: keepalive\n\n`) at 5-second intervals. The `closed` flag + `cleanup()` pattern handles all edge cases including client disconnect.

**6. Security-conscious auth**
Using `crypto.subtle.timingSafeEqual` for Bearer token comparison prevents timing attacks. The auth pattern with dual-key fallback (`OPENWEBUI_API_KEY || OMNISEARCH_API_KEY`) is practical for deployment flexibility.

**7. Durable Object initialization guard is correct**
The `_initialized` flag in `OmnisearchMCP.init()` correctly prevents redundant initialization. The `init()` method orchestrates config, validation, providers, and tool registration in the right order.

**8. Comprehensive logging with structured fields**
All log entries include `op` naming, request IDs, provider names, and timing. The `logger.response()` pattern with automatic status-code-based log levels (error/warn/info) is excellent.

**9. REST endpoints have good input validation**
Size-limited request bodies, JSON parsing guards, URL format validation, and provider name validation in `rest_fetch.ts` show defensive programming. The 65KB body size limit is sensible.

**10. TypeScript passes with zero errors**
The codebase compiles cleanly under `tsc --noEmit`, indicating good type hygiene throughout. The `@ts-expect-error` is documented with a clear rationale.
