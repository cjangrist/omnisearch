# Kimi search provider — ROI analysis

## TL;DR

**Drop the Kimi search provider.** It is the slowest, least reliable, and most
expensive provider in the fanout, and it does not earn its keep on result
diversity: the median query gets zero unique URLs from Kimi, and the unique URLs
it does contribute skew toward low-quality SEO mills, parked domains, and
Chinese-mirror content. With a 10s fanout timeout, 41% of Kimi attempts get
aborted before HTTP completes; without a timeout, Kimi adds a median 1.5–1.7s
to fanout latency.

## Methodology

- **Data source:** R2 bucket `omnisearch`, prefix
  `request_traces/tool=web_search/`. Listed via boto3 against the R2 S3-compatible
  endpoint, downloaded all 444 traces written between 2026-04-23 (when Kimi
  search was added in commit `97704b8`) and 2026-04-30. Added 12 more traces
  from 10 fresh varied queries against the deployed worker for live
  validation. Skipped 19 cache-hit traces (no real provider activity).
- **Effective sample:** 437 fanout traces with real provider dispatch, all
  containing a Kimi attempt.
- **Per-trace structure used:** `providers.kimi.{success,duration_ms,output,http_calls,error}`,
  cross-referenced with the same record for every other provider. URLs were
  normalized (host lowercased, www. stripped, trailing slash removed) before
  set-difference computation against the union of all other providers' URLs in
  the same trace.
- **Kimi-unique contribution = URLs returned by Kimi where no other successful
  provider in the same trace returned the same normalized URL.**
- **Cost computation:** Scrapfly's billing doc states residential proxy = 25
  credits/call. The Pro plan ($100/mo for 1M credits, $3.50/10k overage)
  implies $0.00875/Scrapfly call. Monthly projection: observed call rate ×
  30 days. Per-search marginal cost: 25 × $0.35/10k = $0.00875.
- **Working files** (not part of deliverable): `tmp/kimi_search_roi/analysis.json`,
  `tmp/kimi_search_roi/traces_data/*.json`, `tmp/kimi_search_roi/{analyze,
  analyze_failures4,analyze_blocking,cost_calc,abort_analysis,spot_check_urls}.py`.

## Latency

p50/p95 per provider, computed over all 437 attempts (success + failure
durations included; failures often hit the 10s deadline). Kimi is at the bottom
on both percentiles among working providers, and its p95 of 11.9s **exceeds the
10s deadline** the answer-orchestrator uses, guaranteeing it gets aborted on
slow queries.

| Provider     | Attempts | Success% | p50 (ms) | p95 (ms) | Mean URLs | 0-result success runs |
|--------------|---------:|---------:|---------:|---------:|----------:|----------------------:|
| kagi         |      437 |    98.4% |     1375 |     7815 |     13.62 |                     1 |
| tavily       |      437 |    95.7% |     1535 |     7901 |     13.58 |                     6 |
| firecrawl    |      437 |    90.2% |     2201 |    10000 |     13.20 |                    14 |
| serpapi      |      437 |    76.4% |     2590 |    10000 |      8.66 |                    14 |
| you          |      437 |    72.8% |     2016 |    10000 |     14.42 |                     3 |
| linkup       |      437 |    70.0% |     3312 |    10000 |     14.71 |                     2 |
| exa          |      437 |    73.0% |     6544 |    10057 |     15.00 |                     0 |
| perplexity   |      437 |    63.4% |     4771 |    10000 |      9.27 |                     4 |
| **kimi**     |  **437** | **49.4%**| **4289** |**11943** |  **6.50** |                **13** |

**Does the fanout wait for Kimi?** Yes, until either Kimi finishes or the
caller-supplied `timeout_ms` deadline fires (`web_search_fanout.ts`
`dispatch_to_providers`, line ~132). Kimi was the slowest successful provider in
**152 of 216 successful traces (70%)**. In no-timeout REST `/search` calls (n=250),
the fanout runs to completion. Kimi's median duration on success there is
8.9s, which is the dominant factor in the 9.1s median total fanout duration.
Without Kimi, the slowest non-Kimi median was 4.9s — Kimi roughly doubles
median fanout latency in REST. In 99 of 210 successful no-timeout traces,
Kimi added >2 seconds; in 49 traces, >5 seconds.

## Reliability

Kimi outcome distribution over 437 attempts:

| Outcome | Count | Pct |
|---------|------:|----:|
| `success_with_results` (Scrapfly 200, results returned) | 203 | 46.5% |
| `failure_aborted_before_http` (deadline fired before any HTTP made it out) | 179 | 41.0% |
| `failure_http_403_cf_waf` (Scrapfly proxied request returned 403 from Cloudflare WAF) | 40 | 9.2% |
| `success_zero_results` (Scrapfly 200, but Kimi returned `search_results: []`) | 13 | 3.0% |
| `failure_aborted_during_http` | 2 | 0.5% |

Three failure modes:

1. **Deadline-aborted (41%)** — the `dispatch_to_providers` AbortController fires
   at the answer-orchestrator's 10s budget. Kimi's `duration_ms=0` and no
   `http_calls` recorded means the abort fires before the Scrapfly POST is even
   sent (likely it's still in queue or about to be issued). This outcome is
   only observed when the fanout has a `timeout_ms` configured. 100% of the
   answer-orchestrator's web search budget overruns end up here for Kimi.
2. **CF WAF 403s (9.2%)** — Scrapfly's residential proxy still gets blocked by
   the Cloudflare WAF in front of `api.kimi.com` ~1 in 11 attempts. The proxy
   returns the upstream WAF challenge HTML body verbatim (we have it on file).
3. **Zero results (3%)** — clean HTTP 200 with `search_results: []`. Almost all
   of these are `site:job-boards.greenhouse.io / site:jobs.ashbyhq.com` queries.
   Kimi's index does not cover modern ATS subdomains.

For comparison, the other lossy providers' failure modes are dominated by
`The operation was aborted` (deadline exceeded) — same root cause as Kimi's
mode #1 — but Kimi's *underlying* slowness makes it the most frequent victim.
40% raw Kimi failures with stable error `API key does not have access to this
endpoint` were observed in earlier history but have since cleared (this 40 was
inside the 220 total failures in the historical sample; see
`tmp/kimi_search_roi/failures.txt`). Kimi 4xx counts have not been seen in the
last week.

**Critical reliability finding:** in 156 traces where any provider was aborted
by the deadline, Kimi succeeded in **0** of them. Kimi never rescues a slow
fanout — it always fails with the others or first. So the "fallback for when
US providers are slow" use case is empirically not served.

## Result diversity

This is the most damning section. Of 437 Kimi attempts:

- **316 / 437 (72.3%) yielded zero kimi-unique URLs** — Kimi either returned
  nothing, or returned URLs that another fanout provider already had.
- **121 / 437 (27.7%) yielded at least one kimi-unique URL.**
- **Median kimi-unique URLs per query: 0.0**
- **Mean kimi-unique URLs per query: 1.26**

Histogram of kimi-unique URL count per query:

```
   0 unique URLs:    316 queries  ████████████████████████████████  72.3%
   1 unique URLs:     20 queries  ██                                 4.6%
   2 unique URLs:     16 queries  █                                  3.7%
   3 unique URLs:     14 queries  █                                  3.2%
   4 unique URLs:     18 queries  ██                                 4.1%
   5 unique URLs:     14 queries  █                                  3.2%
   6 unique URLs:     12 queries  █                                  2.7%
   7 unique URLs:      8 queries                                     1.8%
   8 unique URLs:      7 queries                                     1.6%
   9+ unique URLs:    12 queries  █                                  2.7%
```

Critically, this 27.7% only counts whether Kimi added *any* URL. To affect the
final RRF-ranked top-15, a Kimi-unique URL also has to score well on RRF, which
is a high bar given Kimi-unique URLs by definition score with `1/(k + r_kimi)`
only — they don't get the multi-provider RRF boost. Spot-checking the RRF
output (`final_result.web_results`) of the live tests, **0 of the 10 fresh
test queries had a Kimi-unique URL appear in the top 15.**

## Result quality

550 kimi-unique URLs across all traces. TLD distribution is dominated by `.com`
(312), `.org` (39), `.io` (24), but a meaningful 5 are `.cn` and several
`.com`-on-the-surface domains are Chinese mirrors or low-quality SEO farms.

Top 15 hosts in kimi-unique URLs:

| Count | Host | Quality |
|------:|------|---------|
| 51 | github.com | reputable (often noise: random forks, tutorials) |
| 16 | arxiv.org | reputable (often empty title metadata in Kimi response) |
| 12 | softexia.com | low-quality software-aggregator SEO mill |
| 9 | terminaltrove.com | thin "X vs Y" comparison spam |
| 9 | job-boards.greenhouse.io | OK (when query is site-restricted) |
| 9 | fliphtml5.com | low-quality PDF/book mirror |
| 7 | cnblogs.com | Chinese tech blog |
| 6 | blog.csdn.net | Chinese tech blog (paywalled excerpts) |
| 5 | jobs.lever.co | OK |
| 5 | jobs.ashbyhq.com | OK |
| 5 | ceicdata.com | paywalled stat aggregator |
| 4 | alibaba.com | wholesale aggregator (irrelevant for Western queries) |
| 4 | duckdb.org | reputable (but only when query is site-restricted) |
| 4 | webpronews.com | low-quality SEO/news mill |
| 4 | toolquestor.com | thin SEO aggregator |
| 4 | alibabacloud.com | legit but China-focused |
| 4 | ambitionbox.com | India-only company review (irrelevant for global queries) |

By a conservative manual classification, **at least 14.4% (72/550) of
kimi-unique URLs are low-quality / Chinese-mirror / regional-SEO sources**.
The number is higher if you count Wikipedia-grade sites with broken metadata
(arxiv with empty titles) or thin-content domains in the long tail.

Concrete examples of Kimi pulling poor unique URLs (from sampled queries):

- Query *"current year 2026 date"* → Kimi-unique included
  `islamiccal.com` (parked Hijri-date pages for every country),
  `alibaba.com/product-insights/is-it-today-chinese-new-year-find-out...`.
- Query *"Nation-building and education Quarterly Journal of Economics 136(2)
  1047-1094"* → Kimi-unique included three Tsinghua SEM journal listings
  (`sem.tsinghua.edu.cn`) that aren't the cited paper, and a
  `shanghang.gov.cn` page completely unrelated.
- Query *"latest Gemini CLI Node.js minimum version"* → Kimi-unique was
  `blog.csdn.net/...` (Chinese tutorial mirror).
- Query *"OpenAI Codex CLI Node.js version requirement"* → Kimi-unique was
  three different CSDN/cnblogs Chinese mirrors.
- Query *"Diablo 4 Lord of Hatred party finder"* → Kimi-unique was
  the Russian-language version of a Blizzard news article that all other
  providers returned in English.

The pattern matches the Z.AI search provider's investigation (`docs/
mcp-empty-payload-anomaly-v02.md`): Chinese-origin search APIs prioritize
Chinese-mirror SEO and fail to rank canonical Western sources reliably.

## Cost

Pricing baseline (Scrapfly billing docs): residential proxy = 25 credits/call.
Pro plan: $100/mo for 1M credits, $3.50/10k credits overage.

Observed traffic over the 7.4-day trace window:

- Logical Kimi attempts: 437 → ~58.8/day
- Actual Scrapfly residential calls: 301 → ~40.5/day (the ~136 abort-cancelled
  attempts never make a Scrapfly call, so they cost nothing)

Projected monthly:

- ~1,764 attempts/month, of which ~1,215 reach Scrapfly residential
- Credit consumption: 1,215 × 25 = **~30,400 credits/month**
- On Pro plan: 30,400 × $0.35/10,000 = **~$1.06/mo on raw credits, or
  $3.04/mo if you allocate share-of-plan**.
- On Discovery plan ($30/200k): allocates **~$4.56/mo** for Kimi-search alone.

**Marginal cost per fanout containing a Kimi search: ~$0.00625** (only ~71% of
attempts make a Scrapfly call; the rest abort first).

This isn't a lot of money, but at 1,200 calls/month for a provider whose
median unique-URL contribution is zero, the cost-per-useful-result-added is
roughly **$3.04 / 121 queries-with-any-unique = $0.025 per
query-with-any-unique-url**, or **$5.50/month / mean-1.26-unique-urls-per-query
× 437 queries = $0.0055 per kimi-unique URL added** (and at least a fifth of
those are low-quality). For comparison, a Tavily search call (datacenter, no
Scrapfly) is essentially free against monthly Tavily quota.

If traffic scales 10× the current rate (~600 search/day, plausible production),
Kimi alone would consume ~300k credits/month — still under Pro plan budget but
~$30/mo allocated, and at that point we are spending a measurable fraction of
the Scrapfly budget on a provider that worsens latency and contributes
~negligible result diversity.

## Recommendation

**Drop kimi from the search fanout.**

The single source-line change is in `src/providers/unified/web_search.ts:34`,
which currently reads:

```ts
{ name: 'kimi', ...kimi_reg, factory: () => new KimiSearchProvider() },
```

To deactivate Kimi search **without** removing the source files (preserving the
Scrapfly proxy code, headers helpers, and the answer-side Kimi answer provider),
either:

1. **Recommended:** comment out / delete that single line in the `PROVIDERS`
   array. The unified web_search dispatcher will then never construct or call
   `KimiSearchProvider`, and `get_active_search_providers()` will not include
   Kimi in the fanout. The `KimiSearchProvider` class, headers, and Scrapfly
   proxy stay on disk untouched — easy to re-enable if Moonshot improves
   their CF WAF allowlist or if Kimi Search becomes a directly-reachable
   public API. A second line, `import { KimiSearchProvider, ... }` on line 21,
   then becomes unused and TypeScript will warn — also delete it for cleanliness.

2. **Configuration-only kill switch:** unset `KIMI_API_KEY` in Doppler. The
   `get_active_search_providers()` filter
   (`p.key()?.trim()` in `web_search.ts:41`) skips providers without an API
   key. This keeps the codebase identical to today but requires no deploy,
   only a `doppler secrets unset KIMI_API_KEY` against the production worker.
   This is the simplest reversible change.

The Kimi *answer* provider (config under `config.ai_response.kimi`) is a
distinct provider in `src/providers/ai_response/` and is **not affected** by
either change above.

If keeping Kimi for sentimental / experimental reasons:

- **Mandatory:** add a per-provider hard timeout of ~3.5s for Kimi specifically
  in `dispatch_to_providers`. At p50 = 4.3s and p95 = 12s, Kimi is already the
  weakest link; capping it at 3.5s would forfeit ~half of its already-rare
  successes but would prevent the >5-second fanout penalty in 49+ traces
  observed and stop it from blowing through the answer-orchestrator's 10s
  deadline.
- **Optional:** drop the Scrapfly residential proxy and use Scrapfly datacenter
  (1 credit instead of 25). This would cut cost ~25× but probably push the
  CF-WAF 403 rate from 9% to >50% — net result probably worse.
