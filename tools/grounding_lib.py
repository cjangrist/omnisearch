"""Shared helpers for the grounded-snippets test scripts.

Uses the `sh` library (https://sh.readthedocs.io/) for all subprocess work.
Functions here are deliberately small and self-contained so the smoke and
compare scripts can be read top-to-bottom without jumping into utilities.

Provides:
    - cloudflare_env()              build env dict with Doppler-sourced CF auth
    - groq_api_key()                fetch the Groq key from Doppler
    - parse_concatenated_json()     decode pretty-printed JSON stream
    - extract_app_logs()            unwrap wrangler log envelopes
    - run_query_with_tail()         core: start tail -> curl -> kill -> parse
    - summarize_aggregate()         pretty-print the grounding_aggregate dict
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from io import StringIO
from typing import Any, Dict, Iterator, List, Optional, Tuple

from sh import doppler, npx, ErrorReturnCode

WORKER_URL_DEFAULT = "https://omnisearch-mcp.cjangrist.workers.dev"


def get_doppler_secret(name: str) -> str:
    """Return a single Doppler secret value, stripped of trailing newline."""
    return str(doppler.secrets.get(name, plain=True)).strip()


def cloudflare_env() -> Dict[str, str]:
    """Build env dict with Cloudflare credentials sourced from Doppler.

    Wrangler refuses to run non-interactively without these.
    """
    env = os.environ.copy()
    env["CLOUDFLARE_EMAIL"] = get_doppler_secret("CLOUDFLARE_EMAIL")
    env["CLOUDFLARE_API_KEY"] = get_doppler_secret("CLOUDFLARE_API_KEY")
    return env


def groq_api_key() -> str:
    return get_doppler_secret("GROQ_API_KEY")


def parse_concatenated_json(text: str) -> List[Any]:
    """Parse a stream of concatenated (possibly pretty-printed) JSON objects.

    Wrangler tail in --format=json emits one JSON document per event, but
    pretty-printed across many lines. Plain line-by-line parsing fails;
    instead use json.JSONDecoder.raw_decode to consume objects sequentially.
    """
    decoder = json.JSONDecoder()
    pos = 0
    out: List[Any] = []
    while pos < len(text):
        while pos < len(text) and text[pos].isspace():
            pos += 1
        if pos >= len(text):
            break
        try:
            obj, end = decoder.raw_decode(text, pos)
            out.append(obj)
            pos = end
        except json.JSONDecodeError:
            pos += 1
    return out


def extract_app_logs(wrangler_event: Dict[str, Any]) -> Iterator[Dict[str, Any]]:
    """Yield each app-level structured log entry inside a wrangler tail event.

    Each wrangler event has a `logs[]` array of console.* invocations.
    Each entry's `message[0]` is a stringified JSON log emitted by
    src/common/logger.ts. Decode and yield those.
    """
    for log_entry in wrangler_event.get("logs", []):
        msgs = log_entry.get("message", [])
        for msg in msgs:
            if not isinstance(msg, str):
                continue
            try:
                yield json.loads(msg)
            except json.JSONDecodeError:
                continue


def filter_by_op(app_logs: List[Dict[str, Any]], op_name: str) -> List[Dict[str, Any]]:
    """Return only the app log entries whose context.op matches op_name."""
    return [lg for lg in app_logs if (lg.get("context") or {}).get("op") == op_name]


@dataclass
class QueryRun:
    query: str
    count: int
    grounded_snippets: Optional[bool]
    http_status: int
    response_body: Any
    wall_time_s: float
    aggregate: Optional[Dict[str, Any]] = None
    phase_logs: List[Dict[str, Any]] = field(default_factory=list)
    fanout_complete: Optional[Dict[str, Any]] = None
    raw_event_count: int = 0


def run_query_with_tail(
    query: str,
    count: int = 5,
    grounded_snippets: Optional[bool] = None,
    worker_url: str = WORKER_URL_DEFAULT,
    pre_tail_secs: float = 3.0,
    post_curl_secs: float = 6.0,
    tail_log_path: Optional[str] = None,
) -> QueryRun:
    """End-to-end smoke run for a single query.

    Sequence:
        1. Start `npx wrangler tail --format json` in background, output to file.
        2. Sleep pre_tail_secs to let the tail connection establish.
        3. POST to /search; capture response + wall time.
        4. Sleep post_curl_secs to let trailing log events arrive.
        5. Kill the tail. Parse the file. Extract our app logs.

    Returns QueryRun with the response, raw aggregate dict (if found), and
    full list of grounding_phase entries (for retry/timeout inspection).
    """
    import urllib.request
    import urllib.error
    import tempfile

    env = cloudflare_env()
    if tail_log_path is None:
        tail_log_path = tempfile.mktemp(prefix="grounding_tail_", suffix=".jsonl")

    with open(tail_log_path, "wb") as tail_out:
        tail_proc = npx(
            "wrangler", "tail", format="json",
            _bg=True,
            _bg_exc=False,
            _out=tail_out,
            _err=tail_out,
            _env=env,
        )
        time.sleep(pre_tail_secs)

        body = {"query": query, "count": count}
        if grounded_snippets is not None:
            body["grounded_snippets"] = grounded_snippets
        body_bytes = json.dumps(body).encode()

        req = urllib.request.Request(
            f"{worker_url}/search",
            data=body_bytes,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        wall_t0 = time.monotonic()
        http_status = 0
        response_body: Any = None
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                http_status = resp.status
                raw = resp.read().decode("utf-8", errors="replace")
                try:
                    response_body = json.loads(raw)
                except json.JSONDecodeError:
                    response_body = raw
        except urllib.error.HTTPError as e:
            http_status = e.code
            response_body = e.read().decode("utf-8", errors="replace")
        wall_time_s = time.monotonic() - wall_t0

        time.sleep(post_curl_secs)

        try:
            tail_proc.terminate()
            tail_proc.wait()
        except (ErrorReturnCode, Exception):
            pass

    with open(tail_log_path, "r", encoding="utf-8", errors="replace") as f:
        tail_text = f.read()

    events = parse_concatenated_json(tail_text)
    all_app_logs: List[Dict[str, Any]] = []
    for ev in events:
        for log in extract_app_logs(ev):
            all_app_logs.append(log)

    aggs = filter_by_op(all_app_logs, "grounding_aggregate")
    aggregate_ctx = aggs[-1].get("context") if aggs else None

    fanout_completes = filter_by_op(all_app_logs, "web_fanout_complete")
    fanout_ctx = fanout_completes[-1].get("context") if fanout_completes else None

    phases = filter_by_op(all_app_logs, "grounding_phase")

    return QueryRun(
        query=query,
        count=count,
        grounded_snippets=grounded_snippets,
        http_status=http_status,
        response_body=response_body,
        wall_time_s=wall_time_s,
        aggregate=aggregate_ctx,
        phase_logs=[p.get("context") or {} for p in phases],
        fanout_complete=fanout_ctx,
        raw_event_count=len(events),
    )


def summarize_aggregate(agg: Dict[str, Any], indent: str = "  ") -> str:
    """One-block textual summary of a grounding_aggregate context dict."""
    if not agg:
        return f"{indent}(no grounding_aggregate found)"

    lines: List[str] = []
    total = agg.get("total_urls", 0)
    grounded = agg.get("grounded_count", 0)
    fallback = agg.get("fallback_count", 0)
    ratio = agg.get("grounded_ratio", 0.0)
    lines.append(f"{indent}grounded:    {grounded}/{total} ({ratio*100:.0f}%)   fallback: {fallback}")
    lines.append(f"{indent}wall:        {agg.get('total_duration_ms', 0):,} ms")
    pcts = agg.get("duration_percentiles") or {}
    lines.append(
        f"{indent}per-url:     p50={pcts.get('p50', 0):,}ms  p95={pcts.get('p95', 0):,}ms  max={pcts.get('max', 0):,}ms",
    )
    lines.append(f"{indent}retried:     {agg.get('retried_count', 0)}    timeouts: {agg.get('timeout_count', 0)}")
    lines.append(f"{indent}concurrency: {agg.get('concurrency')}    deadline: {agg.get('per_url_deadline_ms')} ms")

    outcomes = agg.get("outcomes") or {}
    if outcomes:
        lines.append(f"{indent}outcomes:")
        for k, v in sorted(outcomes.items(), key=lambda kv: -kv[1]):
            lines.append(f"{indent}  {k:50s} {v:3d}")

    wins = agg.get("provider_wins") or {}
    if wins:
        lines.append(f"{indent}provider_wins:")
        for k, v in sorted(wins.items(), key=lambda kv: -kv[1]):
            lines.append(f"{indent}  {k:30s} {v}")

    fails = agg.get("provider_failures") or {}
    if fails:
        top_fails = sorted(fails.items(), key=lambda kv: -kv[1])[:8]
        lines.append(f"{indent}provider_failures (top 8):")
        for k, v in top_fails:
            lines.append(f"{indent}  {k:30s} {v}")

    return "\n".join(lines)


def show_phase_outliers(phases: List[Dict[str, Any]], threshold_ms: int = 10_000) -> str:
    """Surface the slowest pipelines for diagnosis."""
    completes = [p for p in phases if p.get("phase") == "pipeline_complete"]
    slow = sorted(completes, key=lambda p: -(p.get("total_pipeline_ms") or 0))[:5]
    if not slow:
        return ""
    lines = ["  slowest pipelines:"]
    for p in slow:
        ms = p.get("total_pipeline_ms") or 0
        marker = " ⚠" if ms >= threshold_ms else ""
        lines.append(
            f"    [{p.get('pipeline_index'):>2}] {ms:>6}ms {p.get('outcome', '?'):40s} "
            f"host={p.get('host', '?')}{marker}",
        )
    return "\n".join(lines)
