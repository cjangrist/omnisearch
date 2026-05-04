#!/usr/bin/env python3
"""Run a battery of grounded-snippets queries and tabulate quality.

Spawns wrangler tail once per query (so each query gets its own log capture),
collects the grounding_aggregate context, and prints a summary table plus
overall stats.

Usage:
    python tools/grounding_compare.py                    # default battery
    python tools/grounding_compare.py --queries q1 q2 q3
    python tools/grounding_compare.py --count 10
    python tools/grounding_compare.py --json /tmp/results.json   # also dump
    python tools/grounding_compare.py --concurrency 2    # run queries in parallel

The default battery covers a mix of:
    - technical docs (rust, postgres)
    - vendor comparisons (vector dbs)
    - news / current events
    - long-tail / niche topics
    - social / community sites (likely paywalled or JS-heavy)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from grounding_lib import (
    WORKER_URL_DEFAULT,
    QueryRun,
    run_query_with_tail,
    summarize_aggregate,
)

DEFAULT_QUERIES: List[str] = [
    "rust ownership lifetime annotations explained",
    "best vector database 2026 comparison",
    "postgres lateral join examples performance",
    "openai gpt-5 benchmark scores 2026",
    "kubernetes pod security policy migration to PSA",
]


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Multi-query grounded-snippets comparison",
    )
    p.add_argument(
        "--queries",
        nargs="+",
        default=DEFAULT_QUERIES,
        help=f"Override the default query battery. Default: {len(DEFAULT_QUERIES)} queries.",
    )
    p.add_argument("--count", type=int, default=5, help="REST count per query.")
    p.add_argument(
        "--worker-url",
        default=WORKER_URL_DEFAULT,
        help=f"Worker URL. Default: {WORKER_URL_DEFAULT}",
    )
    p.add_argument(
        "--concurrency",
        type=int,
        default=1,
        help=(
            "Run multiple queries in parallel. KEEP LOW (1-2). Each parallel run "
            "spawns its own wrangler tail. Default: 1 (serial)."
        ),
    )
    p.add_argument(
        "--include-opt-out",
        action="store_true",
        help="Also run each query with grounded_snippets=false for A/B comparison.",
    )
    p.add_argument(
        "--json",
        help="Optional path to write the full per-query results as JSON.",
    )
    p.add_argument(
        "--pre-tail-secs",
        type=float,
        default=3.0,
    )
    p.add_argument(
        "--post-curl-secs",
        type=float,
        default=6.0,
    )
    return p.parse_args()


def dominant_outcome(agg: Optional[Dict[str, Any]]) -> str:
    if not agg:
        return "?"
    outcomes = agg.get("outcomes") or {}
    if not outcomes:
        return "?"
    top = max(outcomes.items(), key=lambda kv: kv[1])
    return f"{top[0]}({top[1]})"


def render_row(idx: int, run: QueryRun, label_extra: str = "") -> str:
    agg = run.aggregate or {}
    grounded = agg.get("grounded_count", 0)
    total = agg.get("total_urls", 0)
    ratio = agg.get("grounded_ratio", 0.0)
    pcts = agg.get("duration_percentiles") or {}
    p95 = pcts.get("p95", 0)
    retried = agg.get("retried_count", 0)
    timeouts = agg.get("timeout_count", 0)
    dom = dominant_outcome(agg)
    label = run.query[:42]
    if label_extra:
        label = f"{label} {label_extra}"
    return (
        f"{idx:2d} {label:50s} {run.http_status:>3} "
        f"{run.wall_time_s:>6.1f}s  "
        f"{grounded:>2}/{total:<2} ({ratio*100:>3.0f}%) "
        f"p95={p95:>6}ms r={retried:<2} t={timeouts:<2}  "
        f"{dom}"
    )


def render_summary_block(label: str, runs: List[QueryRun]) -> str:
    if not runs:
        return ""
    rows = [
        "",
        "=" * 100,
        f" {label.upper()} (n={len(runs)})",
        "=" * 100,
        f"{'#':>2} {'query':50s} {'http':>3} {'wall':>7}  {'grounded':>10} {'p95':>10} {'retry/to':>9}  {'dominant'}",
        "-" * 100,
    ]
    grounded_total = 0
    url_total = 0
    wall_total = 0.0
    p95s: List[int] = []
    retried = 0
    timeouts = 0
    for i, run in enumerate(runs):
        rows.append(render_row(i, run))
        agg = run.aggregate or {}
        grounded_total += agg.get("grounded_count", 0)
        url_total += agg.get("total_urls", 0)
        wall_total += run.wall_time_s
        p95s.append((agg.get("duration_percentiles") or {}).get("p95", 0))
        retried += agg.get("retried_count", 0)
        timeouts += agg.get("timeout_count", 0)
    rows.append("-" * 100)
    overall_ratio = grounded_total / url_total if url_total else 0.0
    avg_wall = wall_total / len(runs) if runs else 0.0
    avg_p95 = sum(p95s) / len(p95s) if p95s else 0.0
    rows.append(
        f"   TOTAL grounded={grounded_total}/{url_total} ({overall_ratio*100:.1f}%)   "
        f"avg_wall={avg_wall:.1f}s   avg_p95={avg_p95:,.0f}ms   "
        f"retried={retried}   timeouts={timeouts}",
    )
    return "\n".join(rows)


def serial_runs(args: argparse.Namespace, queries: List[str], grounded: Optional[bool]) -> List[QueryRun]:
    runs: List[QueryRun] = []
    for i, q in enumerate(queries):
        print(f"[{i+1}/{len(queries)}] running: {q!r}{' (opt-out)' if grounded is False else ''}")
        sys.stdout.flush()
        run = run_query_with_tail(
            query=q,
            count=args.count,
            grounded_snippets=grounded,
            worker_url=args.worker_url,
            pre_tail_secs=args.pre_tail_secs,
            post_curl_secs=args.post_curl_secs,
        )
        runs.append(run)
        agg = run.aggregate or {}
        gr = agg.get("grounded_count", 0)
        tot = agg.get("total_urls", 0)
        print(f"   → http={run.http_status} wall={run.wall_time_s:.1f}s grounded={gr}/{tot}")
    return runs


def parallel_runs(args: argparse.Namespace, queries: List[str], grounded: Optional[bool]) -> List[QueryRun]:
    """Run queries in parallel via thread pool. Each thread spawns its own
    wrangler tail. Use sparingly — multiple tails can interleave on R2.
    """
    print(f"running {len(queries)} queries with concurrency={args.concurrency}")
    sys.stdout.flush()
    results: List[Optional[QueryRun]] = [None] * len(queries)
    with ThreadPoolExecutor(max_workers=args.concurrency) as ex:
        futures = {
            ex.submit(
                run_query_with_tail,
                q,
                args.count,
                grounded,
                args.worker_url,
                args.pre_tail_secs,
                args.post_curl_secs,
            ): idx
            for idx, q in enumerate(queries)
        }
        for fut in as_completed(futures):
            idx = futures[fut]
            try:
                run = fut.result()
            except Exception as e:
                print(f"  query #{idx} ({queries[idx]!r}) FAILED: {e}")
                continue
            results[idx] = run
            agg = run.aggregate or {}
            gr = agg.get("grounded_count", 0)
            tot = agg.get("total_urls", 0)
            print(
                f"  done #{idx} {queries[idx]!r:55s} → http={run.http_status} "
                f"wall={run.wall_time_s:.1f}s grounded={gr}/{tot}",
            )
    return [r for r in results if r is not None]


def serialize_runs(runs: List[QueryRun]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for r in runs:
        out.append({
            "query": r.query,
            "count": r.count,
            "grounded_snippets": r.grounded_snippets,
            "http_status": r.http_status,
            "wall_time_s": r.wall_time_s,
            "aggregate": r.aggregate,
            "fanout_complete": r.fanout_complete,
            "phase_log_count": len(r.phase_logs),
            "raw_event_count": r.raw_event_count,
        })
    return out


def main() -> int:
    args = parse_args()
    queries: List[str] = args.queries

    print("=" * 100)
    print(f"GROUNDING COMPARE — {len(queries)} queries × count={args.count}")
    if args.include_opt_out:
        print("  including opt-out runs (grounded_snippets=false) for A/B")
    print(f"  worker: {args.worker_url}")
    print(f"  concurrency: {args.concurrency}")
    print("=" * 100)

    runner = parallel_runs if args.concurrency > 1 else serial_runs

    grounded_runs = runner(args, queries, None)
    print(render_summary_block("grounded (default)", grounded_runs))

    optout_runs: List[QueryRun] = []
    if args.include_opt_out:
        optout_runs = runner(args, queries, False)
        print(render_summary_block("opt-out (grounded_snippets=false)", optout_runs))

    if args.json:
        payload = {
            "grounded": serialize_runs(grounded_runs),
            "opt_out": serialize_runs(optout_runs),
        }
        with open(args.json, "w") as f:
            json.dump(payload, f, indent=2)
        print(f"\nfull results written to {args.json}")

    print()
    failures = [r for r in grounded_runs if r.http_status != 200]
    return 0 if not failures else 2


if __name__ == "__main__":
    sys.exit(main())
