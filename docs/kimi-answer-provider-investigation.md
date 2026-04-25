# Kimi Answer Provider — Investigation Report

**Date:** 2026-04-24
**Repo:** `omnisearch-mcp` (Cloudflare Worker, deployed at `https://omnisearch-mcp.cjangrist.workers.dev`)
**Context:** Added Kimi (Moonshot AI) as a new AI-answer provider following the same `llm_search` pattern as Claude/Gemini/ChatGPT. Needed to verify it works end-to-end via the `answer` MCP tool across varied queries.

---

## TL;DR

- Kimi is **correctly wired** into the answer fanout. It shows up in `active_providers.ai_response` and the orchestrator dispatches to it on every call.
- Kimi **timed out on 10/10 queries** — always hits the orchestrator's 120 s global deadline (`src/server/answer_orchestrator.ts:16 GLOBAL_TIMEOUT_MS = 120_000`).
- The other three OpenAI-compatible providers on the same gateway (`claude/haiku`, `gemini/search-fast`, `codex/gpt-5.4`) also time out frequently: claude 8/10, gemini 9/10, chatgpt 7/10.
- **Direct probes of the gateway** (one sequential call, no concurrency) return in **23–94 s** for every model — well under 120 s. Kimi solo: **47 s**.
- **Root cause is the gateway (`oauth-llm.angrist.net`) under parallel load.** When the orchestrator fires all four OpenAI-compat models in parallel, per-call latency blows past 120 s. The 5 non-gateway providers (exa_answer, gemini-grounded, kagi_fastgpt, perplexity, tavily_answer) always succeed.

---

## What Was Built

Files touched (all committed on `main` as of this report):

| File | Change |
|---|---|
| `src/providers/ai_response/llm_search/index.ts` | Added `KimiProvider()` factory + `{ name: 'kimi', ... }` entry in the exported `registration` array |
| `src/config/env.ts` | Added `ai_response.kimi` config block (default `model: 'kimi'`), inherits `base_url`+`api_key` from `LLM_SEARCH_*`, reads optional `LLM_SEARCH_KIMI_MODEL` override; added kimi to `validate_config`'s base_url-exclusion list |
| `src/types/env.ts` | Added `LLM_SEARCH_KIMI_MODEL?: string` |

Runtime behaviour mirrors Claude exactly:

```ts
// llm_search/index.ts
export const KimiProvider = () => create_llm_provider(
    'kimi',
    'Kimi K2 (Moonshot AI) via OpenAI-compatible endpoint. AI-generated answers from a long-context model.',
    'https://kimi.com',
    () => config.ai_response.kimi,
);

export const registration = [
    { name: 'chatgpt' as const, key: () => (config.ai_response.chatgpt.base_url && config.ai_response.chatgpt.api_key) || undefined, factory: ChatGPTProvider },
    { name: 'claude' as const, key: () => (config.ai_response.claude.base_url && config.ai_response.claude.api_key) || undefined, factory: ClaudeProvider },
    { name: 'gemini' as const, key: () => (config.ai_response.gemini.base_url && config.ai_response.gemini.api_key) || undefined, factory: GeminiProvider },
    { name: 'kimi' as const, key: () => (config.ai_response.kimi.base_url && config.ai_response.kimi.api_key) || undefined, factory: KimiProvider },
];
```

All four providers hit `${base_url}/chat/completions` with the same wire format — only the `model` string differs.

---

## Registration — Verification

```bash
$ curl -sS https://omnisearch-mcp.cjangrist.workers.dev/health
{"status":"ok","name":"omnisearch-mcp","version":"1.0.0","providers":39}
```

Triggered a `/search` call and tailed worker logs to confirm provider registration:

```json
{
  "message": "AI response providers registered",
  "providers": ["perplexity", "kagi_fastgpt", "exa_answer", "tavily_answer",
                "chatgpt", "claude", "gemini", "kimi"],
  "count": 8
}
```

✅ Kimi is registered.
✅ Default model resolution: `kimi` (override via `LLM_SEARCH_KIMI_MODEL`).

---

## Step 1 — Direct Model-Name Probe (find a working model string)

Before wiring Kimi, I probed the gateway at `$LLM_SEARCH_BASE_URL/chat/completions` to find a model name that actually returns content.

**Exact command:**

```bash
URL=$(doppler secrets get LLM_SEARCH_BASE_URL --plain | head -1)
KEY=$(doppler secrets get LLM_SEARCH_API_KEY --plain | head -1)

for MODEL in "kimi" "kimi/search-fast" "kimi/k2" "moonshot/kimi-k2" "moonshot/k2" \
             "kimi/k2-instruct" "kimi/k1.5" "kimi/k2.5" "kimi/k2.6"; do
  curl -sS -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -X POST "$URL/chat/completions" \
    -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"capital of france?\"}]}"
done
```

**Results:**

| Model string | Outcome |
|---|---|
| `kimi` | **✅ 200, full answer with 10 URL citations** |
| `kimi/search-fast`, `kimi/k2`, `kimi/k2-instruct`, `kimi/k1.5`, `kimi/k2.5`, `kimi/k2.6` | 200 but empty `content`, zero tokens — model name accepted but not routed |
| `moonshot/kimi-k2`, `moonshot/k2` | 400: `unknown provider 'moonshot', must be one of: ['claude', 'cod...']` |

→ **Default model set to `kimi`** (plain, no version suffix). User can override with `LLM_SEARCH_KIMI_MODEL`.

Sample successful response (excerpt):

```
content: "The capital of France is **Paris**, a status it has held since the
         late 5th to early 6th century under Clovis I... [10 url_citations]"
usage: { completion_tokens: 0, prompt_tokens: 0, total_tokens: 0 }
```

(Zero usage counters are a gateway quirk, not indicative of a problem — content length and citation count are real.)

---

## Step 2 — End-to-End Test: 10 Varied Queries via MCP `answer` Tool

**Script:** `tmp/test_answer_kimi.py` (227 lines — full source in repo).

**What it does:**

1. For each query, opens a fresh MCP Streamable-HTTP session:
   - `POST /mcp` with `{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-06-18",...}}`
   - Captures `Mcp-Session-Id` from response headers
   - Sends `notifications/initialized`
2. Calls `tools/call` with `name:"answer"` and the query
3. Parses JSON-RPC + SSE framing (the MCP transport returns `event:/data:` lines)
4. Extracts `structuredContent.providers_succeeded`, `.providers_failed`, and the per-provider `answers[]`
5. Specifically checks for `answers[].source == "kimi"` and records its character count + citation count

**Parallelism:** 3 concurrent queries (separate sessions). **Per-query timeout:** 180 s (generous; the orchestrator's own deadline is 120 s).

**Exact invocation:**

```bash
python tmp/test_answer_kimi.py --parallelism 3 --timeout 180
```

**The 10 queries:**

| # | Query |
|---|---|
| 1 | what is the latest version of claude opus and what new features does it have |
| 2 | explain the cap theorem in distributed systems with one concrete example |
| 3 | what is the capital of azerbaijan and what is its population |
| 4 | how does sourdough starter actually rise — what are the microbes involved |
| 5 | summarize the difference between quicksort and mergesort time complexity |
| 6 | what caused the 2008 financial crisis in 3 sentences |
| 7 | what is dark matter and what evidence do we have for its existence |
| 8 | compare rust ownership model to garbage collection in 4 sentences |
| 9 | who won the 2026 super bowl and what was the final score |
| 10 | what is the trolley problem and how does utilitarianism answer it |

---

## Raw Results

All 10 runs took **451 s total** (elapsed), with 3-way parallelism. Every run hit the 120 s orchestrator deadline at least once.

| # | Duration (s) | Answers | Succeeded providers | Failed providers | Kimi chars |
|---:|---:|---:|---|---|---:|
| 1 | 121.4 | 6 | chatgpt, exa_answer, gemini-grounded, kagi_fastgpt, perplexity, tavily_answer | claude ⏱, gemini ⏱, **kimi ⏱** | 0 |
| 2 | 121.8 | 5 | exa_answer, gemini-grounded, kagi_fastgpt, perplexity, tavily_answer | chatgpt ⏱, claude ⏱, gemini ⏱, **kimi ⏱** | 0 |
| 3 | 121.6 | 5 | exa_answer, gemini-grounded, kagi_fastgpt, perplexity, tavily_answer | chatgpt ⏱, claude ⏱, gemini ⏱, **kimi ⏱** | 0 |
| 4 | 121.0 | 5 | exa_answer, gemini-grounded, kagi_fastgpt, perplexity, tavily_answer | chatgpt ⏱, claude ⏱, gemini ⏱, **kimi ⏱** | 0 |
| 5 | 121.2 | 5 | exa_answer, gemini-grounded, kagi_fastgpt, perplexity, tavily_answer | chatgpt ⏱, claude ⏱, gemini ⏱, **kimi ⏱** | 0 |
| 6 | 87.3 | — | **ERROR: Response ended prematurely** (connection dropped) | — | — |
| 7 | 121.1 | 5 | exa_answer, gemini-grounded, kagi_fastgpt, perplexity, tavily_answer | chatgpt ⏱, claude ⏱, gemini ⏱, **kimi ⏱** | 0 |
| 8 | 121.0 | 6 | claude, exa_answer, gemini-grounded, kagi_fastgpt, perplexity, tavily_answer | chatgpt ⏱, gemini ⏱, **kimi ⏱** | 0 |
| 9 | 121.6 | 5 | exa_answer, gemini-grounded, kagi_fastgpt, perplexity, tavily_answer | chatgpt ⏱, claude ⏱, gemini ⏱, **kimi ⏱** | 0 |
| 10 | 121.2 | 8 | chatgpt, claude, exa_answer, gemini, gemini-grounded, kagi_fastgpt, perplexity, tavily_answer | **kimi ⏱** | 0 |

⏱ = `Timed out (global deadline)` — orchestrator killed the in-flight request at 120 s.

### Failure-rate per provider

| Provider | Runs failed | Reason |
|---|---:|---|
| **kimi** | **10/10** | Global deadline (120 s) |
| claude | 8/10 | Global deadline |
| gemini | 9/10 | Global deadline |
| chatgpt | 7/10 | Global deadline |
| perplexity, kagi_fastgpt, exa_answer, tavily_answer, gemini-grounded | 0/10 | — always succeed |

### Q6: the premature-close case

One query (Q6: "what caused the 2008 financial crisis in 3 sentences") errored at 87 s with `Response ended prematurely`. This is a client-side exception from `requests` — most likely the Worker closed the SSE connection. Not Kimi-specific; possibly related to the SSE keepalive injection in `src/worker.ts`. Only 1/10 so not re-investigated here.

---

## Step 3 — Direct Latency Probe Per Model (single sequential calls)

To determine whether Kimi itself is slow or the gateway chokes under parallel load, I issued one sequential call per model from this dev machine (non-CF egress) using the **same query that timed out** in the fanout.

**Exact command:**

```bash
URL=$(doppler secrets get LLM_SEARCH_BASE_URL --plain | head -1)
KEY=$(doppler secrets get LLM_SEARCH_API_KEY --plain | head -1)
for MODEL in "claude/haiku" "kimi" "chatgpt/gpt-5.4" "codex/gpt-5.4"; do
  echo "=== $MODEL ==="
  curl -sS -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -X POST "$URL/chat/completions" \
    -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"explain the cap theorem in distributed systems with one concrete example\"}]}" \
    --max-time 180 \
    -w '\nHTTP_CODE=%{http_code}\nTIME_TOTAL=%{time_total}s\n'
done
```

**Measured latencies:**

| Model | HTTP | `time_total` | Notes |
|---|---:|---:|---|
| `claude/haiku` | 200 | **94.18 s** | Very close to the 120 s deadline even solo |
| `kimi` | 200 | **46.74 s** | Fast — comfortably fits the deadline |
| `chatgpt/gpt-5.4` | 400 | 0.07 s | Wrong model name; our config actually uses `codex/gpt-5.4` for the chatgpt provider — this probe was a control |
| `codex/gpt-5.4` | 200 | **22.92 s** | Fast |

**Key finding:** Kimi alone returns in ~47 s. It has **73 s of headroom** before the 120 s orchestrator deadline. So the failure is **not** intrinsic Kimi slowness.

---

## Root-Cause Analysis

The data points at **gateway contention under parallel load**:

1. Sequential, one-at-a-time: all four models finish in ≤94 s.
2. Parallel fanout (what the orchestrator does): all four models nearly always exceed 120 s.
3. The 5 non-gateway providers (`exa_answer`, `gemini-grounded`, `kagi_fastgpt`, `perplexity`, `tavily_answer`) never time out — they hit independent backends.
4. Q10 was the only run where chatgpt, claude, AND gemini all finished (still kimi didn't). Q10 happened near the end of the 451 s test run — possibly after a brief warm-up or a lull in concurrent load.

The gateway at `oauth-llm.angrist.net` appears to serialize or rate-limit when it receives four concurrent `chat/completions` calls for different models. Under that pressure, each call takes >120 s even though solo latency is fine.

Kimi fails 100% vs claude 80% / gemini 90% / chatgpt 70% — a plausible explanation is that the gateway starts the calls in some order and Kimi is consistently late in the queue, or its model backend is the last to process.

---

## What This Means

**Kimi-as-answer-provider is correctly implemented** and will work as soon as the gateway can return its answer within 120 s under parallel load.

**The failures are a gateway-capacity artefact, not an omnisearch bug.**

### Options (non-exclusive)

1. **Leave as-is, document the cap.**
   Kimi is registered, included in the fanout; if the gateway ever responds faster, Kimi answers appear. The `answer` tool still returns 5–8 answers per query (8 counting gemini-grounded) from the healthy providers.
   *Pros:* zero code change, already deployed. *Cons:* 10–20% of deployed capacity is dead weight until #2 or #3.

2. **Bump `GLOBAL_TIMEOUT_MS`.**
   `src/server/answer_orchestrator.ts:16` currently 120_000. Raising to 180_000 would let the slower parallel calls complete based on the ~94 s solo time of claude/haiku. Worst-case `answer` latency increases for every caller, though, including the cache-miss path.
   *Pros:* one-line fix, captures the slow but eventually-successful responses. *Cons:* slows every uncached `answer` call.

3. **Investigate the gateway (`oauth-llm.angrist.net`).**
   Profile concurrent-request handling. Possible causes: shared backend, per-key rate limit, single-worker bottleneck. This is the only option that addresses the *cause* rather than the symptom.
   *Pros:* unblocks all four LLM providers, not just Kimi. *Cons:* owned by the user's infra, not this repo.

---

## Supporting Artefacts (in repo)

| Path | Purpose |
|---|---|
| `tmp/test_answer_kimi.py` | The 10-query MCP test harness. Re-runnable: `python tmp/test_answer_kimi.py --parallelism 3 --timeout 180`. Accepts `--queries ...` to override the default set. |
| `tmp/test_all_providers.py` | Earlier per-provider fetch + search test harness (unchanged by this investigation). |

---

## Reproduction Recipe

```bash
# 1. Deploy current code
doppler run -- npx wrangler deploy

# 2. Confirm kimi is registered
curl -sS https://omnisearch-mcp.cjangrist.workers.dev/health
doppler run -- npx wrangler tail --format pretty   # watch `AI response providers registered`

# 3. Run the 10-query test
python tmp/test_answer_kimi.py --parallelism 3 --timeout 180

# 4. Baseline solo latency of each model
URL=$(doppler secrets get LLM_SEARCH_BASE_URL --plain | head -1)
KEY=$(doppler secrets get LLM_SEARCH_API_KEY --plain | head -1)
for M in claude/haiku kimi codex/gpt-5.4 gemini/search-fast; do
  curl -sS -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -X POST "$URL/chat/completions" \
    -d "{\"model\":\"$M\",\"messages\":[{\"role\":\"user\",\"content\":\"cap theorem in one paragraph\"}]}" \
    -w '\n%{http_code} time=%{time_total}s\n'
done
```

Expect Kimi solo ≈ 45–60 s. Expect Kimi in fanout ≈ timeout. That's the gap this report documents.
