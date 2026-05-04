#!/usr/bin/env python3
"""Run a single grounded-snippets smoke test.

Spawns `npx wrangler tail` in the background while issuing a /search request
to the deployed feature-branch worker, then parses the captured logs to
surface the grounding_aggregate breakdown plus the slowest pipelines.

Usage:
    python tools/grounding_smoke.py "rust ownership lifetime annotations explained"
    python tools/grounding_smoke.py "vector database 2026" --count 3
    python tools/grounding_smoke.py "openai gpt-5 release" --no-grounding   # opt-out
    python tools/grounding_smoke.py "test query" --tail-log /tmp/tail.json --keep-tail-log

Notes:
    - Requires Doppler CLI logged in to the omnisearch project (auto-pulls
      CLOUDFLARE_EMAIL / CLOUDFLARE_API_KEY).
    - Default worker URL is the deployed feature branch
      (https://omnisearch-mcp.cjangrist.workers.dev). Override with --worker-url.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from textwrap import shorten

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from grounding_lib import (
    WORKER_URL_DEFAULT,
    QueryRun,
    run_query_with_tail,
    show_phase_outliers,
    summarize_aggregate,
)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Single-query grounded-snippets smoke test",
    )
    p.add_argument("query", help="Search query string")
    p.add_argument(
        "--count",
        type=int,
        default=5,
        help="REST count parameter (number of results to return). Default: 5.",
    )
    p.add_argument(
        "--no-grounding",
        action="store_true",
        help="Pass grounded_snippets=false (opt-out path).",
    )
    p.add_argument(
        "--worker-url",
        default=WORKER_URL_DEFAULT,
        help=f"Worker URL. Default: {WORKER_URL_DEFAULT}",
    )
    p.add_argument(
        "--pre-tail-secs",
        type=float,
        default=3.0,
        help="Seconds to wait after starting wrangler tail before sending the query.",
    )
    p.add_argument(
        "--post-curl-secs",
        type=float,
        default=6.0,
        help="Seconds to wait after the response before killing wrangler tail.",
    )
    p.add_argument(
        "--tail-log",
        help="Where to write the wrangler tail output. Defaults to a temp file.",
    )
    p.add_argument(
        "--keep-tail-log",
        action="store_true",
        help="Print the path to the tail log file so it can be inspected after.",
    )
    p.add_argument(
        "--show-snippets",
        action="store_true",
        help="Also print each returned snippet's first 200 chars.",
    )
    return p.parse_args()


def print_header(args: argparse.Namespace) -> None:
    print("=" * 78)
    print(f"GROUNDING SMOKE TEST")
    print(f"  query:           {args.query!r}")
    print(f"  count:           {args.count}")
    grounded_str = "false (opt-out)" if args.no_grounding else "default (true)"
    print(f"  grounded:        {grounded_str}")
    print(f"  worker:          {args.worker_url}")
    print("=" * 78)


def print_snippets(run: QueryRun) -> None:
    if not isinstance(run.response_body, list):
        print("\n  (response is not a list; cannot print snippets)")
        return
    print("\n  returned snippets:")
    for i, item in enumerate(run.response_body):
        link = item.get("link", "?")
        title = shorten(item.get("title", ""), width=70, placeholder="...")
        snippet = item.get("snippet", "") or ""
        snippet_short = shorten(snippet.replace("\n", " "), width=200, placeholder="...")
        print(f"    [{i}] ({len(snippet)} chars) {link}")
        print(f"        {title}")
        print(f"        {snippet_short}")


def print_phase_breakdown(run: QueryRun) -> None:
    if not run.phase_logs:
        print("\n  (no grounding_phase logs captured — was tail running long enough?)")
        return
    completes = [p for p in run.phase_logs if p.get("phase") == "pipeline_complete"]
    starts = [p for p in run.phase_logs if p.get("phase") == "pipeline_start"]
    fetch1s = [p for p in run.phase_logs if p.get("phase") == "fetch_attempt_1"]
    fetch2s = [p for p in run.phase_logs if p.get("phase") == "fetch_attempt_2"]
    groq1s = [p for p in run.phase_logs if p.get("phase") == "groq_attempt_1"]
    groq2s = [p for p in run.phase_logs if p.get("phase") == "groq_attempt_2"]
    print("\n  phase counts:")
    print(f"    pipeline_start:    {len(starts):>3}")
    print(f"    fetch_attempt_1:   {len(fetch1s):>3}")
    print(f"    groq_attempt_1:    {len(groq1s):>3}")
    print(f"    fetch_attempt_2:   {len(fetch2s):>3}   (retry triggered)")
    print(f"    groq_attempt_2:    {len(groq2s):>3}   (retry groq call)")
    print(f"    pipeline_complete: {len(completes):>3}")


def main() -> int:
    args = parse_args()
    print_header(args)

    grounded = None if not args.no_grounding else False

    print(f"\n→ starting wrangler tail (waiting {args.pre_tail_secs}s for connection)...")
    sys.stdout.flush()

    run = run_query_with_tail(
        query=args.query,
        count=args.count,
        grounded_snippets=grounded,
        worker_url=args.worker_url,
        pre_tail_secs=args.pre_tail_secs,
        post_curl_secs=args.post_curl_secs,
        tail_log_path=args.tail_log,
    )

    print(f"\n← HTTP {run.http_status}   wall: {run.wall_time_s:.2f}s")
    print(f"  raw wrangler events captured: {run.raw_event_count}")
    if run.fanout_complete:
        fc = run.fanout_complete
        print(
            f"  fanout: dispatch={fc.get('dispatch_duration_ms')}ms "
            f"total={fc.get('total_duration_ms')}ms "
            f"providers_succeeded={fc.get('providers_succeeded')} "
            f"providers_failed={fc.get('providers_failed')} "
            f"final_count={fc.get('final_result_count')} "
            f"grounded={fc.get('grounded_snippets')}",
        )

    print("\n--- grounding_aggregate ---")
    print(summarize_aggregate(run.aggregate or {}))

    phase_outliers = show_phase_outliers(run.phase_logs)
    if phase_outliers:
        print()
        print(phase_outliers)

    print_phase_breakdown(run)

    if args.show_snippets:
        print_snippets(run)

    if args.keep_tail_log and args.tail_log:
        print(f"\n  tail log retained at: {args.tail_log}")

    print()
    return 0 if run.http_status == 200 else 1


if __name__ == "__main__":
    sys.exit(main())
