// Workers Analytics Engine metrics — the cheap, queryable time-series layer.
//
// Division of labor with R2 traces (src/common/r2_trace.ts):
//   - R2 = full-fidelity per-request forensics (every http_call, every decision,
//     payloads). Right for "open trace X and read everything"; expensive to
//     aggregate (LIST + GET thousands of JSON blobs).
//   - AE = pre-extracted scalars (durations, counts, success bits, provider names,
//     country, cache-hit) that SQL-aggregate in ms. Right for "chart p95 latency /
//     per-provider win-share over time". Lossy by design (adaptive sampling) and
//     payload-free, so it never replaces R2 for incident drill-down.
//
// Cost model: ONE writeDataPoint() call = one billed data point. Packing more
// doubles/blobs into a single call is FREE. So every emit here rides an existing
// orchestration-completion point and crams its metrics into the 20-doubles / 20-blobs
// budget of a single data point — the only cost lever is the number of CALLS.
//
// AE data-point limits (verified 2026-06-21): <=20 doubles, <=20 blobs, exactly 1
// index (<=96 bytes), <=16KB total blob bytes, <=250 data points per invocation.
// writeDataPoint is non-blocking and we additionally swallow any error, so metrics
// can never break or slow the request path. A missing binding (local dev / partial
// config) is a silent no-op.

import { loggers } from './logger.js';

const logger = loggers.worker();

interface AnalyticsDatasets {
	requests?: AnalyticsEngineDataset;
	search?: AnalyticsEngineDataset;
	fetch?: AnalyticsEngineDataset;
}

let _datasets: AnalyticsDatasets = {};

// Set once per request from initialize_config (bindings are immutable within an
// isolate, mirroring set_trace_r2_bucket).
export const set_analytics_datasets = (datasets: AnalyticsDatasets): void => {
	_datasets = datasets;
};

const bool01 = (v: boolean | undefined): number => (v ? 1 : 0);

// AE index cap is 96 bytes; provider/route names are short but clamp defensively.
const idx = (s: string): string => (s.length <= 90 ? s : s.slice(0, 90));

const safe_write = (ds: AnalyticsEngineDataset | undefined, point: AnalyticsEngineDataPoint): void => {
	if (!ds) return;
	try {
		ds.writeDataPoint(point);
	} catch (err) {
		// Metrics must never break the request path.
		logger.debug('AE writeDataPoint failed', {
			op: 'ae_write_error',
			error: err instanceof Error ? err.message : String(err),
		});
	}
};

// ── Dataset A: omni_requests — one row per HTTP request at router exit ─────────
// Index = route, the dominant GROUP BY. Covers REST, /health, 404, dup-id rejects.
// Note: for /mcp the duration is handler-setup time (the tool work streams after
// return) — authoritative per-tool latency lives in the search/fetch datasets.
export interface RequestMetric {
	route: string;        // e.g. mcp:web_search | rest:/search | /health | 404
	transport: string;    // mcp | rest | edge
	tool?: string;        // web_search | fetch | answer | ''
	cf_country?: string;
	error_class?: string; // '' when ok
	duration_ms: number;
	http_status: number;
	cache_hit?: boolean;
	is_mcp?: boolean;
	dup_id_reject?: boolean;
}

export const emit_request_metric = (m: RequestMetric): void => {
	safe_write(_datasets.requests, {
		indexes: [idx(m.route)],
		blobs: [m.route, m.cf_country ?? '', m.transport, m.error_class ?? '', m.tool ?? ''],
		doubles: [m.duration_ms, m.http_status, bool01(m.cache_hit), bool01(m.is_mcp), bool01(m.dup_id_reject)],
	});
};

// ── Dataset B: omni_search — one row per web_search fanout ─────────────────────
// Index = coarse grounded/raw mode (low volume → stays at 100% sampling).
// Per-provider detail + grounding internals ride the doubles[] budget.
export interface SearchMetric {
	mode: string;            // grounded | raw
	top_provider_win?: string;
	outcome_summary?: string;
	total_ms: number;
	dispatch_ms: number;
	providers_succeeded: number;
	providers_failed: number;
	cache_hit?: boolean;
	grounding_makespan_ms?: number;
	grounded_count?: number;
	total_urls?: number;
	grounding_p50?: number;
	grounding_p95?: number;
	grounding_max?: number;
	timeout_count?: number;
	retried_count?: number;
}

export const emit_search_metric = (m: SearchMetric): void => {
	safe_write(_datasets.search, {
		indexes: [idx(`search:${m.mode}`)],
		blobs: [m.mode, m.top_provider_win ?? '', m.outcome_summary ?? ''],
		doubles: [
			m.total_ms, m.dispatch_ms, m.providers_succeeded, m.providers_failed,
			bool01(m.cache_hit),
			m.grounding_makespan_ms ?? 0, m.grounded_count ?? 0, m.total_urls ?? 0,
			m.grounding_p50 ?? 0, m.grounding_p95 ?? 0, m.grounding_max ?? 0,
			m.timeout_count ?? 0, m.retried_count ?? 0,
		],
	});
};

// ── Dataset C: omni_fetch — one row per run_fetch_race ─────────────────────────
// Index = fetch_provider_used (or outcome when none). This is the high-rate stream
// and the field you most want to GROUP BY (per-provider win-share / latency / depth).
// is_grounding_internal separates the ~95% grounding-internal fetches from real
// user /fetch calls (run_fetch_race doesn't set parent_trace_id, so this flag is the
// only clean discriminator).
export interface FetchMetric {
	provider_used: string;       // '' on exhausted/error
	outcome: string;             // resolved | exhausted | cache_hit | explicit | fast_fail | error | no_providers
	breaker?: string;
	host?: string;
	error_class?: string;
	total_ms: number;
	waterfall_depth: number;     // providers_attempted.length
	providers_failed_count: number;
	cache_hit?: boolean;
	content_length?: number;
	skip_providers?: boolean;
	is_grounding_internal?: boolean;
}

export const emit_fetch_metric = (m: FetchMetric): void => {
	safe_write(_datasets.fetch, {
		indexes: [idx(m.provider_used || m.outcome)],
		blobs: [m.provider_used, m.outcome, m.breaker ?? '', m.host ?? '', m.error_class ?? ''],
		doubles: [
			m.total_ms, m.waterfall_depth, m.providers_failed_count,
			bool01(m.cache_hit), m.content_length ?? 0,
			bool01(m.skip_providers), bool01(m.is_grounding_internal),
		],
	});
};
