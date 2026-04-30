# skip_providers feature — multi-reviewer synthesis

## Overview

- **Feature reviewed**: the `skip_providers` parameter on the URL-fetch waterfall (MCP `fetch` tool input, REST `POST /fetch` body field, internal `run_fetch_race({ skip_providers })`).
- **Source files in scope**: `src/server/fetch_orchestrator.ts`, `src/server/tools.ts`, `src/server/rest_fetch.ts`, `src/providers/unified/fetch.ts`.
- **Sandbox path**: `/home/cjangrist/dev/omnisearch/tmp/2026-04-30-10-37-38_c8c2fa9_o-new-session-zai-glm-5-1/`.
- **Review prompt**: `/home/cjangrist/dev/omnisearch/tmp/skip_providers_review_prompt.txt`.
- **Aggregated JSON**: `/home/cjangrist/dev/omnisearch/tmp/hydra_skip_providers.json`.
- **Reviewers run**: 9 (`claude--opus`, `codex--gpt-5.5`, `gemini--pro`, `goose--glm-5.1`, `kilo--grok-4.20-0309-reasoning`, `kimi--kimi-for-coding`, `ob1--grok-4.2`, `opencode--deepseek-v4-pro`, `qwen--qwen3-max-preview`).
- **Outcomes**: 8 success, 1 timeout (`goose--glm-5.1`).

### Files read per reviewer (every line)

| Reviewer | Files in sandbox | Notes |
|---|---|---|
| `claude--opus` | `response.md`, `logs/stdout.log` | clean run, 17 distinct findings |
| `codex--gpt-5.5` | `response.md`, `01-fetch_orchestrator.ts`, `02-tools.ts`, `03-rest_fetch.ts`, `04-unified_fetch.ts`, `logs/stdout.log`, `logs/stderr.log` | working files are verbatim copies of source — confirmed via diff. 10 findings. |
| `gemini--pro` | `response.md`, `logs/stdout.log`, `logs/stderr.log` | 8 findings |
| `goose--glm-5.1` | `logs/stdout.log` only — **NO** `response.md` written. **TIMEOUT.** | partial: read all 4 files, started analysis, did NOT produce findings. Last todo "Write final response.md with all findings" never checked. No findings recoverable for cross-reference. |
| `kilo--grok-4.20-0309-reasoning` | `response.md`, `01-parser-test.js`, `logs/stdout.log`, `logs/stderr.log` | 10 findings + executable parser tests (12/12 pass against bug-spec) |
| `kimi--kimi-for-coding` | `response.md`, `01-test-parser.py`, `02-test-escaped-quotes.py`, `logs/stdout.log`, `logs/stderr.log` | 16 findings + 2 parser test scripts |
| `ob1--grok-4.2` | `response.md`, `01_findings.md`, `logs/stdout.log`, `logs/stderr.log` | `01_findings.md` is byte-identical to `response.md` (verified via diff). 16 findings. |
| `opencode--deepseek-v4-pro` | `response.md`, `01-parse_skip_providers_tests.js`, `logs/stdout.log`, `logs/stderr.log` | 15 findings + parser test harness |
| `qwen--qwen3-max-preview` | `response.md`, `01-parse-skip-providers-test.ts`, `02-parse-skip-providers-analysis.md`, `03-unknown-providers-analysis.md`, `04-cache-interaction-analysis.md`, `05-target-count-analysis.md`, `06-breaker-bypass-analysis.md`, `07-concurrency-safety-analysis.md`, `08-trace-logging-analysis.md`, `09-schema-consistency-analysis.md`, `10-alternative-results-analysis.md`, `11-error-handling-analysis.md`, `12-type-safety-analysis.md`, `13-comment-code-alignment.md`, `logs/stdout.log` | 8 findings, broken into per-topic working files |

**Goose timeout details**: `task_exit_code__-1.txt` confirms a non-success exit. `logs/stdout.log` (50 KB) shows it `cat -n`'d all four source files in parallel, marked 8 of 9 todos complete, and was about to write `response.md` when the 600s timeout fired. **No partial findings document was produced.** The reviewer is excluded from consensus counts. Effective reviewer count for consensus math: **8**.

## Provider success matrix

Coverage across the four files (✓ = explicitly cited in findings, ▢ = cited only via cross-reference in another file's discussion). Every successful reviewer demonstrably read all four source files.

| Reviewer | `fetch_orchestrator.ts` | `tools.ts` | `rest_fetch.ts` | `unified/fetch.ts` | Findings count |
|---|:-:|:-:|:-:|:-:|:-:|
| claude--opus | ✓ | ✓ | ✓ | ▢ | 17 |
| codex--gpt-5.5 | ✓ | ✓ | ✓ | ▢ | 10 |
| gemini--pro | ✓ | ✓ | ▢ | ▢ | 8 |
| goose--glm-5.1 | ▢ | ▢ | ▢ | ▢ | TIMEOUT |
| kilo--grok-4.20-0309-reasoning | ✓ | ✓ | ✓ | ▢ | 10 |
| kimi--kimi-for-coding | ✓ | ✓ | ✓ | ▢ | 16 |
| ob1--grok-4.2 | ✓ | ✓ | ✓ | ▢ | 16 |
| opencode--deepseek-v4-pro | ✓ | ✓ | ✓ | ▢ | 15 |
| qwen--qwen3-max-preview | ✓ | ✓ | ✓ | ▢ | 8 |

Issue-class coverage (a checkmark = at least one finding in that class):

| Reviewer | Cache pollution | Parser | Validation/typos | target_count | Concurrency | Schema/docs | Empty active | Result-shape | Provider+skip combo |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| claude--opus | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | ✓ |
| codex--gpt-5.5 | ✓ | ✓ | ✓ | ✓ | – | ✓ | ✓ | – | ✓ |
| gemini--pro | ✓ | – | ✓ | ✓ | – | ✓ | ✓ (nit) | – | – |
| kilo--grok-4.20-0309-reasoning | ✓ | ✓ | ✓ | – | ✓ | ✓ | – | – | – |
| kimi--kimi-for-coding | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | ✓ |
| ob1--grok-4.2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (Med) | – |
| opencode--deepseek-v4-pro | ✓ | ✓ | ✓ | – | – | ✓ | ✓ | – | – |
| qwen--qwen3-max-preview | ✓ | ✓ | ✓ | ✓ | – | ✓ | ✓ | – | – |
| **Coverage** | **8/8** | **7/8** | **8/8** | **6/8** | **3/8** | **8/8** | **7/8** | **1/8** | **3/8** |

## Findings — single ranked action list

Ordered by **consensus count DESC**, then **severity DESC**. Severity is the highest assigned by any reviewer for that finding. Provider keys use the `provider--model` form. Line refs are against the current `src/` (verified at the start of this synthesis).

| ID | Severity | Category | Consensus (N/8) | Finding | File:line | Suggested fix | Providers |
|---|---|---|---|---|---|---|---|
| F01 | Critical | correctness | **8/8** | **Cache pollution.** When `skip_providers` is non-empty, KV cache reads are correctly bypassed (line 336) but `build_and_cache` still WRITES the result (line 382, 443). A subsequent unconstrained request hits the cache and gets the skip-shaped result for 36 hours. The skipped provider is permanently bypassed for that URL across all callers. | `src/server/fetch_orchestrator.ts:380-384, 443` | Inside `build_and_cache`, gate the write: `if (!has_skip_providers) await set_fetch_cached(url, race_result);`. Alt: namespace cache key with normalized skip-set hash. | claude--opus (C1), codex--gpt-5.5 (#1), gemini--pro (#1), kilo (Crit-1), kimi (#1), ob1 (Crit-3), opencode (C2), qwen (#1) |
| F02 | High | correctness | **8/8** | **Unknown / typo'd provider names silently accepted.** `parse_skip_providers` returns whatever the caller passed (lowercased) and never validates against `get_active_fetch_providers()`. A typo like `"tavly"` or unknown name like `"all"`, `"skip_providers"` produces a non-empty skip-set: the intended provider is NOT skipped, AND `has_skip_providers` flips true (cache bypass + `target_count=2`). The caller has no way to know. REST endpoint validates `provider` (`rest_fetch.ts:62-68`) but not `skip_providers` — inconsistent. | `src/server/fetch_orchestrator.ts:374-377`; `src/server/rest_fetch.ts:36-40` (no validation); `src/server/tools.ts:200` (no validation) | After parsing, intersect with active names; reject (REST 400) or warn (MCP) on unknown names. Compute `has_skip_providers` from the *intersected* set, not the raw input length. | claude--opus (H1), codex--gpt-5.5 (#3), gemini--pro (#6), kilo (High-1), kimi (#3), ob1 (Med-1), opencode (C1, H3), qwen (#3) |
| F03 | High | correctness/type-safety | **7/8** | **Parser produces garbage entries from non-string inputs.** Both branches use `String(v)` without checking `typeof`. `null`→`"null"`, `undefined`→`"undefined"`, `42`→`"42"`, `{foo:1}`→`"[object object]"`, `Symbol`→throws (caught upstream → empty skip). These survive `filter(Boolean)` as truthy strings, never match a real provider, but flip `has_skip_providers` true (F01/F02 amplification). | `src/server/fetch_orchestrator.ts:308-309, 311` | Array branch: `raw.filter((v): v is string => typeof v === 'string').map(...)`. String branch: `if (typeof raw !== 'string') return [];` before `String(raw)`. | claude--opus (H3), codex--gpt-5.5 (#6), kilo (Med-1), kimi (#4), ob1 (High-3), opencode (C3, M4), qwen (#2 partially) |
| F04 | Critical/High | correctness/docs | **7/8** | **`parse_skip_providers` doesn't actually parse JSON; the comment lies.** The comment says it accepts "JSON array, comma string, bracketed string, quoted variants, single string, null/undefined → string[]" but the implementation is `replace(/^\[|\]$/g, '').replace(/"/g, '').replace(/'/g, '').split(',')` — a regex strip-and-split. This breaks: (a) JSON strings with internal commas (`'["foo,bar","baz"]'` → `['foo','bar','baz']`); (b) escaped quotes (`'["tav\"ily"]'` → `['tav\\ily']`); (c) literal strings `"null"`/`"undefined"` (parsed as provider names instead of `[]`); (d) smart quotes from copy-paste; (e) nested brackets. | `src/server/fetch_orchestrator.ts:303-316` | Add a `try { JSON.parse(str) }` branch when `str.startsWith('[')`; recurse into the array path. Treat `"null"`/`"undefined"` (case-insensitive) as empty. Update the comment to match reality if not fixing the impl. | claude--opus (M1, M2, M3), codex--gpt-5.5 (#5, #8), gemini--pro (#7), kilo (Med-1), kimi (#5, #9, #10), ob1 (Crit-1), opencode (H5, L1, M4), qwen (#2, #6) |
| F05 | High | docs/integration | **7/8** | **MCP Zod schema is `z.string().optional()`; REST accepts `string | array`. Asymmetry breaks LLMs that send native arrays.** An LLM emitting `skip_providers: ["tavily","firecrawl"]` over MCP gets a Zod validation error before `parse_skip_providers` even runs. The REST endpoint accepts the same payload. The contract is split, undocumented, and forces LLMs to wrap arrays in strings. | `src/server/tools.ts:200-201`; `src/server/rest_fetch.ts:36-40` | Update MCP schema: `z.union([z.string(), z.array(z.string())]).optional()` (with `.transform(parse_skip_providers)` if desired). Update `.describe()` to document both formats. | claude--opus (M4), codex--gpt-5.5 (no — qwen counted), gemini--pro (#4), kilo (Med-2), kimi (#8), ob1 (Med-3), opencode (M3), qwen (#4) |
| F06 | High | runtime/correctness | **7/8** | **Empty active set produces misleading "All providers failed. Tried: " error.** When the caller skips every active provider (or every named provider), `active` is empty, every step returns `undefined`, `attempted=[]`. The catch-all `throw` at line 467 reads `"All providers failed for ${url}. Tried: "` (empty) — looks like a server fault rather than a caller error. REST returns 502 for what should be 400. | `src/server/fetch_orchestrator.ts:451-471` | Detect `active.size === 0` before the breaker loop and `throw new ProviderError(ErrorType.INVALID_INPUT, 'No fetch providers available — all candidates were skipped via skip_providers (...)', 'waterfall')`. Maps to REST 400 via the `ErrorType.INVALID_INPUT` branch in `rest_fetch.ts:130`. | claude--opus (H5), codex--gpt-5.5 (#4), gemini--pro (#8), kimi (#6), ob1 (Crit-2), opencode (M1), qwen (#5) |
| F07 | High | correctness | **5/8** | **`run_parallel` only captures the FIRST success; wastes alternatives when `target_count=2`.** `Promise.any` returns winner #1 and orphans the rest. With `skip_providers` set, `target_count=2`. If a parallel step (e.g. `['linkup','cloudflare_browser']`) sees both succeed, only one enters `winners`. The waterfall then continues to the next step, invoking ANOTHER provider just to fill slot #2 — wasted cost when an alternative was already in flight. Same problem in `run_sequential` (gemini #3): returns on first success even when `target_count > 1`. | `src/server/fetch_orchestrator.ts:196-243`, `245-267`, `390` | When `target_count > 1`, replace `Promise.any` with a collector that takes successes up to `target_count - winners.length` (e.g. `Promise.allSettled` + filter). Equivalent fix in `run_sequential`: keep iterating after first success until target met. | claude--opus (L2), codex--gpt-5.5 (#2), gemini--pro (#3, sequential variant), kimi (#2), ob1 (High-2 — broader target_count clamp) |
| F08 | High/Medium | correctness | **5/8** | **`provider` + `skip_providers` combined: skip is silently ignored; REST response misleadingly echoes `skip_providers` as if applied.** When both are set, `run_fetch_race` enters the explicit-provider branch (line 348) and never references `skip_providers`. `rest_fetch.ts:117` still echoes the input list back under `skip_providers` — the response says it skipped providers it ran. No validation against `provider ∈ skip_providers` either. | `src/server/fetch_orchestrator.ts:348-369`; `src/server/rest_fetch.ts:90-117` | In `rest_fetch.ts`, return 400 when (a) `provider` is set together with non-empty `skip_providers`, or at minimum (b) `provider ∈ skip_providers`. Alternatively only echo back the *applied* skip set in the response. | claude--opus (H4), codex--gpt-5.5 (#10), kimi (#14 Low) — note: weaker than the 4-reviewer threshold for "high consensus" but enough to flag. Plus implicit support: opencode (H3 covers REST validation gap), qwen (no explicit). |
| F09 | Medium/High | correctness/runtime | **3/8** | **`target_count` is not clamped to `active.size` when many providers are skipped.** When `skip_providers` leaves only 1 active provider, `target_count` is still 2. After it succeeds, the waterfall keeps iterating ~10 more steps that all return `undefined` via the `ctx.active.has` guard — waste of CPU/trace volume. Worse, the response will only contain 1 winner (no `alternative_results`) despite the dual-fetch contract. | `src/server/fetch_orchestrator.ts:390, 416-425` | `const target_count = Math.min(has_skip_providers ? 2 : 1, active.size);`. Optionally early-exit on `winners.length >= active.size`. | claude--opus (—), kimi (#13 Low), ob1 (High-2), qwen (#5 in target-count analysis) |
| F10 | Medium | concurrency/correctness | **3/8** | **`run_parallel` `resolved` flag races / parallel losers' trace errors leak.** The `resolved` flag (`fetch_orchestrator.ts:208`) gates `ctx.failed.push` but is set AFTER the `Promise.any` await resolves. (a) **Trace integrity (claude L1):** `trace?.record_provider_error` at line 224 is OUTSIDE the `if (!resolved)` guard — losers that reject after the winner returns leave a trace error event for a "failure" not in the public response. (b) **Microtask race (kimi #7):** if a loser rejects synchronously in the same microtask as the winner's resolution, `ctx.failed` can record it before `resolved=true`. (c) **Comment-vs-code (kimi #15 Nit):** comment says "cancel losers" but no cancellation is wired; loser fetches keep running, billing as Workers subrequests (claude L4). | `src/server/fetch_orchestrator.ts:206-243` | Move `record_provider_error` inside `if (!resolved)`. Better: `AbortController` per provider, abort losers when `Promise.any` resolves. Update the misleading comment. | claude--opus (L1, L4), kimi (#7, #15), ob1 (High-1, with stronger framing) |
| F11 | Medium | docs/correctness | **4/8** | **MCP `outputSchema` does not declare `alternative_results`, `providers_attempted`, `providers_failed`.** The fetch tool handler emits `alternative_results` whenever `skip_providers` triggers `target_count=2` and produces ≥2 winners (`tools.ts:224-231`), but the `outputSchema` (lines 203-210) declares only `url/title/content/source_provider/total_duration_ms/metadata`. Strict MCP clients may strip the undeclared field — the LLM never sees the dual-fetch comparison. | `src/server/tools.ts:203-210, 224-231` | Add to outputSchema: `alternative_results: z.array(z.object({...})).optional()` (with the same shape used at 225-231). Optionally also `providers_attempted` / `providers_failed`. | codex--gpt-5.5 (#7), gemini--pro (#5), opencode (H2), kilo (Med-2 partial — schema asymmetry), ob1 (Med-3 partial) |
| F12 | Medium | docs | **4/8** | **`skip_providers` triggers a hidden 2-provider compare (`target_count=2`) — undocumented in tool description and Zod `.describe`.** The MCP tool description tells the LLM the parameter "forces the next provider in the waterfall". The reality is a dual-fetch with `alternative_results` and ~2× cost/latency. Combined with F02/F03, even a typo like `"tavili"` doubles spend on the page. | `src/server/tools.ts:189-201` | Add to description and `.describe`: "Setting this also bypasses the cache and fetches a second alternative for comparison; expect ~2× latency/cost." Or make dual-fetch opt-in via a separate `compare: true` parameter and default `target_count=1`. | claude--opus (H2, M5), opencode (M3 partial), ob1 (Med-3 partial), codex--gpt-5.5 (no explicit) — counted at 3 strong + 1 partial |
| F13 | Medium | runtime | **2/8** | **`has_skip_providers` evaluates input length, not effective skip count.** Computed as `(options?.skip_providers?.length ?? 0) > 0` BEFORE intersecting with the active set. Garbage-only inputs (e.g. `["null","undefined","foobar"]` from a bad LLM) still flip the flag, bypass cache, and force `target_count=2`. (Subsumed by F02 fix but called out as its own bug.) | `src/server/fetch_orchestrator.ts:335` | Compute `has_skip_providers` AFTER intersection: `const real_skip_count = active_initial.size - active.size; const has_skip_providers = real_skip_count > 0;` | opencode (H1), claude--opus (covered under H1), kilo (Med-1 partial) |
| F14 | Medium | runtime | **1/8** | **Breakers and first waterfall stage run sequentially when `target_count=2`; could race in parallel.** When the caller asks for 2 results because the page is "tricky", the code first runs all matching breakers serially, THEN runs the waterfall serially for slot #2. Net latency = breaker time + first-step time. Could be a single `Promise.any` race that collects 2 winners. | `src/server/fetch_orchestrator.ts:390-425` | Launch breakers + first waterfall stage(s) in a parallel collector; stop when `winners.length >= target_count`. | opencode (M2) |
| F15 | Medium | observability | **2/8** | **`logger.info('Waterfall start', ...)` does NOT include `skip_providers`.** The trace `record_decision('waterfall_start', { skipped_providers })` captures it (line 377) but the structured logger one line earlier (line 372) does not. Operators reading Cloudflare Workers logs (rather than R2 traces) cannot see that the request used `skip_providers`. Plus `record_decision` (line 377) records `Array.from(skip_set)` which may contain garbage entries (F02/F03) — pollutes R2 traces. | `src/server/fetch_orchestrator.ts:372, 377` | Add `skip_providers: Array.from(skip_set)` and `target_count` to the `logger.info` call. Filter `skip_set` to active names before recording in trace, or record raw + effective separately. | claude--opus (L3), opencode (L3) |
| F16 | High | correctness | **1/8** (gemini-only) | **`is_fetch_failure` checks content length BEFORE the API_NATIVE_PROVIDERS bypass.** `if (!result.content || result.content.length < 200) return true;` runs unconditionally; the `API_NATIVE_PROVIDERS.has(provider)` bypass is on the next line. A small valid GitHub gist or supadata response (e.g. 50 chars) is flagged as failure and forces fallback. **NOT directly a `skip_providers` bug** — it's a tangential bug gemini surfaced. Real bug, but out-of-scope for this review. | `src/server/fetch_orchestrator.ts:127-134` | Reorder: `if (!result.content) return true; if (provider && API_NATIVE_PROVIDERS.has(provider)) return false; if (result.content.length < 200) return true;`. | gemini--pro (#2) |
| F17 | Critical (per reviewer) | correctness/cache | **1/8** (kilo-only) | **`alternative_results` set AFTER `build_and_cache` runs — cache entry never contains alternatives.** `build_and_cache` calls `set_fetch_cached(url, race_result)` at line 382, which serializes a `race_result` that does NOT yet have `alternative_results`. Lines 444-446 mutate it after the cache write. Cached re-hits never see alternatives. **Largely subsumed by F01 fix** (gating cache writes on `!has_skip_providers` makes this impossible to observe), but real until that ships. | `src/server/fetch_orchestrator.ts:443-446` | Either (a) populate `race_result.alternative_results` BEFORE `set_fetch_cached`, or (b) gate the cache write on `!has_skip_providers` (F01) — which makes the alts moot. | kilo (Crit-2) |
| F18 | Medium | correctness | **1/8** (ob1-only, contested) | **`alternative_results` could include results from breakers/parallel that were "not intended" if `target_count > 1`.** ob1 frames this as a leak; cross-checked: every push into `winners` is gated on `ctx.active.has(provider)` (lines 178, 200/210, 251), and `active` is built from skip-filtered names. **No actual leak path exists** — opencode, qwen, codex, claude, kimi all explicitly verified this and found no leak. **Likely false positive.** | `src/server/fetch_orchestrator.ts:407, 423, 444-446` | None — the `active.has(...)` guards prevent skipped names from entering winners. | ob1 (Med-2) — disputed by codex (No-issues #2), opencode (No-issues), qwen (#10), claude (no finding) |
| F19 | Low | runtime/security | **2/8** | **No length cap on `skip_providers`; large MCP input could allocate aggressively.** REST has a 64 KB body cap but MCP `z.string()` has no max. A multi-MB skip string would force multiple full-string copies (`replace`, `split`) in the parser. Bounded but not free in a Workers environment. | `src/server/tools.ts:200`; `src/server/fetch_orchestrator.ts:311` | `z.string().max(2000)` on the MCP schema; `if (str.length > 4096) return [];` in the parser. | codex--gpt-5.5 (#9), ob1 (Low-3) |
| F20 | Low | type-safety | **3/8** | **Unchecked `as` casts.** (a) `try_provider` does `provider as FetchProviderName` (line 156); CONFIG is not typed against `FetchProviderName`, so a typo in waterfall/breaker config compiles fine and crashes at runtime. (b) `get_fetch_cached` returns `as FetchRaceResult | undefined` (line 30); a corrupted/manually-inserted cache entry yields downstream `undefined` errors. (c) `rest_fetch.ts:37` `body.url as string` is dead-cast; the very next check covers it. | `src/server/fetch_orchestrator.ts:30, 156, 323`; `src/server/rest_fetch.ts:37, 91` | Type CONFIG entries as `FetchProviderName`. Add a runtime shape validator on cache reads (`typeof cached?.provider_used === 'string'`). Drop the dead `as string` cast. | kimi (#11, #12), claude--opus (N1), kilo (Low-1), ob1 (Med-4), opencode (No-issues — explicit) |
| F21 | Low | UX | **2/8** | **No special semantics for `skip_providers: "all"`.** Caller might intuitively expect "all" to skip everything; instead it parses to `["all"]` which matches no provider, triggers F02/F13 (cache bypass + target_count=2 for nothing). | `src/server/fetch_orchestrator.ts:306-316` | Either reject "all" with a clear message, or expand it to `get_active_fetch_providers().map(p => p.name)`. | opencode (L1), qwen (#7) |
| F22 | Low | observability | **1/8** | **No log line when a breaker is skipped because its provider is in skip-set.** When the user skips e.g. `"github"`, the breaker for `github.com` URLs is silently bypassed (correct behavior), but no decision is recorded in the trace — debugging "why didn't the github breaker fire" is harder than it needs to be. | `src/server/fetch_orchestrator.ts:394-413` | Add an `else if (matches_breaker(...))` branch: `trace.record_decision('breaker_skipped', { breaker: name, provider, reason: 'in_skip_set' })`. | qwen (#8) |
| F23 | Nit | semantics | **1/8** | **`ctx.attempted.push(...available)` runs synchronously before any provider promise starts.** Strictly the providers are "intended", not yet "attempted". Cosmetic only — the calls all start within the same microtask. | `src/server/fetch_orchestrator.ts:203` | None required; rename or move push into the `.then`/`.catch` handlers. | claude--opus (N2) |
| F24 | Nit | type-safety | **1/8** | **Redundant `as { sequential: string[] }` cast.** After `'solo' in step` and `'parallel' in step` are both false, TS narrows `step` to `{ sequential: string[] }` automatically. The cast is dead and will silently lie if a 4th `WaterfallStep` variant is added later. | `src/server/fetch_orchestrator.ts:418` | Drop the cast: `step.sequential.join(',')`. | kimi (#16) |
| F25 | Low | observability | **1/8** | **JSON catch in REST swallows skip_providers parse failures.** The body-parse `try { ... } catch { return 400 }` covers JSON failure, but `parse_skip_providers` can fail to handle pathological types (e.g. `Symbol`, `BigInt`) by exception inside `String(raw)`, which the same catch then converts to a generic 400 "Invalid JSON body" — misleading. | `src/server/rest_fetch.ts:36-43` | Either harden `parse_skip_providers` against non-serializable types, or catch parser errors separately and return a more specific 400. | opencode (H4) |

**Note on counts**: only 8 reviewers contribute to consensus (goose timed out without a `response.md`). Where the table says e.g. "5/8" the bug was independently flagged by 5 of the 8 successful reviewers.

## Contradictions / disagreements

1. **Concurrency safety in `run_parallel` is contested.**
   - **Bug-flaggers (3/8)**: `claude--opus` (L1 — trace error leak), `kimi` (#7 — `resolved` flag race), `ob1` (High-1 — race on `attempted`/`failed`).
   - **No-issue declarers (5/8)**: `codex--gpt-5.5` ("No issues found... `failed` mutation happens on the single JavaScript event loop"), `gemini--pro` ("Concurrency in `run_parallel` safely mutates arrays synchronously"), `qwen` ("No concurrency bugs found"), `opencode` ("No issues — JS single-threaded event loop prevents races on array push"), `kilo` (Low-2, but explicitly says "JS single-threaded, resolved guard present" in the No-issues list).
   - **Resolution**: this synthesis sides with the bug-flaggers on F10 specifically because (a) the trace-vs-public response inconsistency is real and easy to verify, (b) the `resolved` flag is set AFTER `await Promise.any(...)` resumes, so a synchronous `.catch()` on a co-resolving rejection CAN run before the `resolved=true` assignment in microtask order. The "JS is single-threaded" defense is correct about CPU atomicity but irrelevant to microtask ordering. **However**, the impact is observability/billing-only, not correctness of the public response payload.

2. **`alternative_results` leakage from skipped providers.**
   - `ob1` flags as Medium ("alternative_results can include results from breakers or parallel that were not intended"). 5 reviewers explicitly verified no leak (codex, opencode, qwen, kimi, claude implicit). Cross-checked against source: every winners-push gates on `ctx.active.has(...)`. **F18 is a false positive.**

3. **Severity of the empty-active-set error (F06).**
   - Reviewers split between High (codex, claude, kimi, opencode), Medium (gemini, qwen), and Critical (ob1 calls it Critical). All agree it's a real correctness/runtime issue. Synthesis ranks it High because it produces wrong status code (502 vs 400) and a misleading message.

4. **Severity of unknown-name silence (F02).**
   - Reviewers split between Critical (opencode, ob1 implicit), High (claude, kimi, kilo, qwen), Medium (codex, gemini), Low (none). All flag it. Synthesis ranks High because it amplifies F01 cache pollution and the `target_count=2` cost.

5. **Severity of cache pollution (F01).**
   - 8/8 unanimous it's a bug. Severity: Critical (claude, kilo, kimi, opencode, qwen), High (codex, gemini, ob1 calls it Critical too). Synthesis: Critical — it persists for 36 hours and affects all downstream callers.

6. **`run_sequential` short-circuit on `target_count=2` (gemini #3).**
   - Only gemini explicitly cites `run_sequential` (the others focus on `run_parallel`). Verified in source: line 258 returns on first success unconditionally. Real bug, distinct from the parallel variant. Folded into F07.

## Solo findings worth noting

| Finding | Reviewer | Real? | Why interesting |
|---|---|---|---|
| F16 — `is_fetch_failure` length check before API_NATIVE bypass | gemini--pro | **Real** | Out-of-scope (it's not a `skip_providers` bug per se), but a real bug. A 50-char gist is flagged blocked. Worth fixing in a follow-up. |
| F17 — `alternative_results` set AFTER `build_and_cache` | kilo | **Real but moot under F01 fix** | Cache stores entry without `alternative_results`. Fix F01 first; if F01 isn't taken, F17 must be fixed too. |
| F22 — Missing breaker-skipped trace decision | qwen | **Real (low value)** | Useful for debugging but not a correctness issue. |
| F23 — `attempted` pre-pushed in parallel | claude | **Cosmetic** | Documentation/naming nit. |
| F24 — Redundant `as` cast on sequential step label | kimi | **Real (style)** | Future-proofing if a 4th variant is added. |
| F25 — JSON catch swallows parser exceptions | opencode | **Edge case** | `Symbol` / `BigInt` / etc. would mostly be rejected by `JSON.parse` upstream; small surface. |
| F14 — Breakers serialize with first waterfall step under `target_count=2` | opencode | **Real** | Genuine latency improvement; nobody else looked at this angle. |

## False positives / things reviewers got wrong

- **F18 — `alternative_results` leakage from skipped providers** (ob1 Med-2): every winners-push is gated by `ctx.active.has(...)`, and `active` is built from skip-filtered names. Verified in lines 178, 200, 251, 396. 5 other reviewers explicitly checked and found no leak. **Reject this finding.**

- **claude--opus C1 quotes the cache TTL as 36h**: correct (`KV_FETCH_TTL_SECONDS = 129_600 = 36 hours`). No error.

- **opencode H4 description ("Symbol triggers JSON.parse rejection → catch → empty skip_providers")**: technically accurate but the framing implies a hidden bug. In practice this path is fine — `JSON.parse` rejects unsupported types, you get a 400 "Invalid JSON body". Minor concern.

- **opencode L2 (`source_provider` vs `provider_used`)**: not a bug. Internal field is `provider_used`, externalized as `source_provider`. Reviewer self-corrected ("no actual bug. Just naming inconsistency"). **Skip.**

- **qwen "No issues found" on type-safety (file 12)**: directly contradicts F20, which is a real cluster of unchecked `as` casts. Qwen got this wrong.

- **codex/gemini/qwen/opencode "No issues found" on concurrency**: see contradiction #1 above. The "JS single-threaded" defense is partially correct but doesn't cover microtask-ordering edge cases. Severity-wise they're right that it's not critical, but flat-out "no issues" is too strong.

- **opencode H4 description says `skip_providers = []` is "silently set" on JSON catch**: actually the catch returns 400, not silently sets []. Misread.

- **claude C1 reproduction step 3 is slightly imprecise** ("tavily is the preferred top-of-waterfall provider and User B never asked to skip it"): correct in spirit. The skip-provider order and the actual cache content depend on what won the race, but the cache pollution conclusion holds.

## Suggested fix order

Ranked by impact, ease, and dependency:

1. **F01 — Gate cache writes on `!has_skip_providers`** (1-line fix, eliminates a 36-hour user-facing correctness bug, also nullifies F17). 8/8 consensus, Critical.
2. **F02 + F03 — Validate `skip_providers` against active names AND filter non-string array elements** (small additions, eliminates silent typo-amplification, fixes garbage cache-bypass cost). Together they also defang F13. 8/8 + 7/8 consensus.
3. **F06 — Detect empty active set, throw `INVALID_INPUT`** (5-line guard before breakers, turns 502-with-empty-message into 400-with-clear-message). 7/8 consensus.
4. **F08 — REST validation: reject `provider` ∈ `skip_providers` and/or `provider` + non-empty `skip_providers` together** (small input-validation addition, removes a confusing silent no-op). 5/8 consensus.
5. **F04 — Replace regex strip with `JSON.parse` first-pass** (fixes parser correctness for nested commas, escaped quotes, smart quotes, and the "null"/"undefined" literals; brings the comment back in line with reality). 7/8 consensus.
6. **F05 — Update MCP Zod schema to `z.union([z.string(), z.array(z.string())]).optional()`** (allows native LLM array inputs over MCP, mirrors REST capability). 7/8 consensus. Pair with F11 outputSchema fix.
7. **F11 — Add `alternative_results` (and ideally `providers_attempted`/`providers_failed`) to MCP outputSchema** (so strict MCP clients don't strip them). 4/8 consensus, low-effort.
8. **F12 — Document the dual-fetch behavior in the tool description and `.describe`** (or make it opt-in). 4/8 consensus, docs-only.
9. **F07 — Make `run_parallel` and `run_sequential` collect up to N successes when `target_count > 1`** (efficiency gain plus removes ghost extra waterfall step). 5/8 consensus, medium-effort.
10. **F09 — `target_count = Math.min(2, active.size)`** (1-line change). 3/8 consensus.
11. **F10 — Move `record_provider_error` inside the `if (!resolved)` guard, fix the misleading "cancel losers" comment** (1-line fix; the `AbortController` upgrade is a larger follow-up). 3/8 consensus.
12. **F13 — Compute `has_skip_providers` from the intersected (effective) skip set** (small follow-up to F02; cleans up cache-bypass amplification). Implicit under F02 fix.
13. **F15 — Add `skip_providers` and `target_count` to the `logger.info('Waterfall start')` line; filter the trace `record_decision` to known names** (observability hygiene). 2/8.
14. **F19 — Add a `.max(2000)` to MCP schema and length-cap inside the parser** (defensive, no functional change). 2/8.
15. **F20 — Tighten `as` casts (CONFIG → `FetchProviderName`, cache shape validator)** (gradual hardening). 3/8.
16. **F21 — Decide and document `"all"` semantics** (1-line: either special-case to expand, or 400 with helpful message). 2/8.
17. **F14 — Race breakers with the first waterfall stage under `target_count=2`** (latency optimization, larger refactor). 1/8.
18. **F25 — Harden REST JSON-error path against parser exceptions** (small). 1/8.
19. **F22 — `breaker_skipped` trace decision when active.has fails** (debugging aid). 1/8.
20. **F23 / F24** — cosmetic; sweep when convenient.
21. **F16** (out-of-scope, gemini-only) — fix in a separate change; reorder `is_fetch_failure` checks so `API_NATIVE_PROVIDERS` bypass runs before the length gate.

**Reject**: F18 (alternative_results leak from skipped providers) — verified false positive.

**Excluded from prioritization**: any finding from goose--glm-5.1 (timeout, no `response.md`).

---

## Closure log (added 2026-04-30, after fixes landed)

All findings F01-F25 are now either landed, subsumed, or formally rejected.

### Landed as their own commit

| ID | Commit | Notes |
|---|---|---|
| F01 | `1683207` | cache pollution gated on `!has_skip_providers` |
| F02 | `c952fac` | `validate_skip_providers` helper, REST 400 / MCP isError on unknown names |
| F03 | `cd53f2e` | non-string array entries dropped, not stringified |
| F04 | `5e7c048` | real `JSON.parse` for bracketed strings + smart-quote handling |
| F05 | `16e8ae7` | MCP `z.union([z.string(), z.array(z.string())])` |
| F06 | `99e1baf` | empty active set → INVALID_INPUT (REST 400) |
| F07 | `cbc4a78` | parallel/sequential collect up to `target_count` winners |
| F08 | `5d5ba95` | reject `provider` + `skip_providers` collision |
| F09 | `b754176` | clamp `target_count` to `active.size` |
| F10 | `c0afc6f` | trace error events gated on `!resolved` |
| F11 | `cfdacaa` | MCP outputSchema declares alternative_results / providers_attempted / providers_failed |
| F12 | `b1db52d` | tool description warns about ~2x cost |
| F15 | `fe497ba` | `logger.info` carries skip_providers + active_count |
| F16 | `726bd6f` | `is_fetch_failure`: API_NATIVE bypass before length check |
| F19 | `948f18a` | input length caps (string ≤2000, array ≤64) |
| F20 | `60c6d59` | `as` casts replaced with shape checks / type narrowing |
| F22 | `051b2aa` | `breaker_skipped` trace decision |
| F24 | `d3a04b6` | dropped redundant `as { sequential: string[] }` cast |

### Subsumed by other fixes — no separate change needed

- **F13** (`has_skip_providers` from input length, not effective count) — landed under **F02** when `effective_skip` (intersected set) became the source of truth for the flag.
- **F17** (`alternative_results` set after `build_and_cache` writes the cache) — moot under **F01**: `build_and_cache` no longer writes the cache when `has_skip_providers` is true, so an "incomplete" cache entry can never be observed.
- **F21** (no special semantics for `skip_providers: "all"`) — covered by **F02**: a literal "all" is rejected with the active-providers list as the error body, which is the documented "reject with clear message" path.
- **F25** (REST JSON catch swallows parser exceptions) — moot under **F03/F04/F19**: the parser no longer throws on `Symbol`/`BigInt`/oversize inputs (returns `[]` early), and array-vs-string discrimination is handled by zod at the MCP boundary.

### Rejected (false positive)

- **F18** (`alternative_results` could include results from skipped providers) — verified by audit. Every push into `winners` is gated on `ctx.active.has(provider)`, and `ctx.active` is built post-skip. No leak path exists.

### Cosmetic / non-actionable

- **F23** (`ctx.attempted.push(...available)` runs synchronously before any provider promise starts — strictly the providers are "intended", not yet "attempted") — synthesis flagged this as a Nit. Renaming the field across the codebase isn't worth it; the semantic distinction is lost on most consumers and the field is correctly described in the MCP outputSchema as "tried during the waterfall, in attempt order" which is true the moment dispatch starts.

### Deferred (not landed; out of scope or larger refactor)

- **F14** (race breakers with the first waterfall stage under `target_count=2`) — latency optimization. Real, but requires restructuring the breaker loop into the same parallel collector used for waterfall stages. Defer until performance becomes a concern; current breaker latency is dominated by the underlying provider, not the dispatch order.

### Test scripts

Each landed fix has a corresponding `tmp/test_fNN_*.py` test that hits the deployed worker, verifies the fix, and runs cumulative regressions for prior fixes. `tmp/` is gitignored; running them requires a live deploy.

### Verified deployed worker version

`71addf59-6748-464e-9973-47ddf80eabed` carries all F01-F24 fixes.

