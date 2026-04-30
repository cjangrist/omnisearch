// R2-based request tracing: captures full, unredacted request/response for every
// provider hit, plus orchestrator decision trace. Written as a single pretty-formatted
// JSON file per request to hive-partitioned R2 paths for easy querying.
//
// Path format: request_traces/tool={tool}/date={YYYY-MM-DD}/hour={HH}/trace_id={uuid}.json

import { AsyncLocalStorage } from 'node:async_hooks';
import { loggers } from './logger.js';

const logger = loggers.worker();

// ── AsyncLocalStorage for trace context ──────────────────────────────────────

const trace_store = new AsyncLocalStorage<TraceContext>();

export const get_active_trace = (): TraceContext | undefined => trace_store.getStore();

export const run_with_trace = <R>(ctx: TraceContext, fn: () => R): R =>
	trace_store.run(ctx, fn);

// ── Per-request waitUntil-capable context store ─────────────────────────────
// AsyncLocalStorage keeps the ctx scoped to the originating request. The
// previous module-level singleton was overwritten by every concurrent request,
// so a slow request's `flush_background` attached to a newer request's ctx
// (or, if that newer ctx had already returned, was silently dropped).
//
// Worker-side ctx is `ExecutionContext`; DO-side ctx is `DurableObjectState`.
// Both expose `.waitUntil(promise)` — type the store as the structural minimum
// so MCP tool handlers running inside the DO can scope `this.ctx` here too.

export type WaitUntilCapable = { waitUntil: (promise: Promise<unknown>) => void };

const ctx_store = new AsyncLocalStorage<WaitUntilCapable>();

export const run_with_execution_context = <R>(ctx: WaitUntilCapable, fn: () => R): R =>
	ctx_store.run(ctx, fn);

const get_active_execution_context = (): WaitUntilCapable | undefined =>
	ctx_store.getStore();

// ── R2 bucket reference (set once at startup; constant across requests) ──────

let _r2_bucket: R2Bucket | undefined;

export const set_trace_r2_bucket = (bucket: R2Bucket | undefined) => {
	_r2_bucket = bucket;
};

// ── Types ────────────────────────────────────────────────────────────────────

export interface HttpCallRecord {
	timestamp: string;
	method: string;
	url: string;
	request_headers: Record<string, string>;
	request_body: unknown;
	response_status: number;
	response_headers: Record<string, string>;
	response_body: unknown;
	response_size_bytes: number;
	duration_ms: number;
	error?: string;
}

interface ProviderRecord {
	started_at: string;
	duration_ms: number;
	success: boolean;
	input: unknown;
	output: unknown;
	error?: string;
	http_calls: HttpCallRecord[];
}

interface OrchestratorDecision {
	timestamp: string;
	action: string;
	details: unknown;
}

// ── Trace context ────────────────────────────────────────────────────────────

export class TraceContext {
	readonly trace_id: string;
	readonly tool: string;
	readonly started_at: string;
	parent_trace_id?: string;
	cache_hit = false;
	request_environment: Record<string, unknown> = {};

	private _strategy = '';
	private _active_providers: string[] = [];
	private _providers = new Map<string, ProviderRecord>();
	private _decisions: OrchestratorDecision[] = [];

	constructor(trace_id: string, tool: string) {
		this.trace_id = trace_id;
		this.tool = tool;
		this.started_at = new Date().toISOString();
	}

	set_strategy(strategy: string) {
		this._strategy = strategy;
	}

	set_active_providers(providers: string[]) {
		this._active_providers = [...providers];
	}

	record_decision(action: string, details: unknown) {
		this._decisions.push({
			timestamp: new Date().toISOString(),
			action,
			details,
		});
	}

	record_provider_start(provider: string, input: unknown) {
		if (!this._providers.has(provider)) {
			this._providers.set(provider, {
				started_at: new Date().toISOString(),
				duration_ms: 0,
				success: false,
				input,
				output: null,
				http_calls: [],
			});
		} else {
			const rec = this._providers.get(provider)!;
			rec.input = input;
			rec.started_at = new Date().toISOString();
		}
	}

	record_provider_complete(provider: string, output: unknown, duration_ms: number) {
		const rec = this._providers.get(provider);
		if (rec) {
			rec.output = output;
			rec.success = true;
			rec.duration_ms = duration_ms;
		}
	}

	record_provider_error(provider: string, error: string, duration_ms: number) {
		const rec = this._providers.get(provider);
		if (rec) {
			rec.error = error;
			rec.success = false;
			rec.duration_ms = duration_ms;
		}
	}

	record_http_call(provider: string, call: HttpCallRecord) {
		let rec = this._providers.get(provider);
		if (!rec) {
			rec = {
				started_at: call.timestamp,
				duration_ms: 0,
				success: false,
				input: null,
				output: null,
				http_calls: [],
			};
			this._providers.set(provider, rec);
		}
		rec.http_calls.push(call);
	}

	/** Fire-and-forget R2 write. Uses ctx.waitUntil() when available. */
	flush_background(final_result: unknown) {
		if (!_r2_bucket) return;

		const write_promise = this._write_to_r2(final_result);

		const ctx = get_active_execution_context();
		if (ctx) {
			ctx.waitUntil(write_promise);
		}
	}

	private async _write_to_r2(final_result: unknown): Promise<void> {
		if (!_r2_bucket) return;

		try {
			const completed_at = new Date().toISOString();
			const total_duration_ms = new Date(completed_at).getTime() - new Date(this.started_at).getTime();
			const now = new Date();
			const date_str = now.toISOString().slice(0, 10);
			const hour_str = String(now.getUTCHours()).padStart(2, '0');

			const r2_key = `request_traces/tool=${this.tool}/date=${date_str}/hour=${hour_str}/trace_id=${this.trace_id}.json`;

			const providers_hit = Array.from(this._providers.keys());
			const providers_succeeded = providers_hit.filter((p) => this._providers.get(p)?.success);
			const providers_failed = providers_hit
				.filter((p) => !this._providers.get(p)?.success)
				.map((p) => {
					const r = this._providers.get(p)!;
					return { provider: p, error: r.error ?? 'unknown', duration_ms: r.duration_ms };
				});

			const providers_detail: Record<string, ProviderRecord> = {};
			for (const [name, rec] of this._providers) {
				providers_detail[name] = { ...rec };
			}

			const trace_document = {
				trace_id: this.trace_id,
				tool: this.tool,
				parent_trace_id: this.parent_trace_id ?? null,
				started_at: this.started_at,
				completed_at,
				total_duration_ms,
				cache_hit: this.cache_hit,
				request_environment: this.request_environment,
				orchestrator: {
					strategy: this._strategy,
					active_providers: this._active_providers,
					decisions: this._decisions,
				},
				providers_hit,
				providers_succeeded,
				providers_failed,
				providers: providers_detail,
				final_result,
			};

			await _r2_bucket.put(r2_key, JSON.stringify(trace_document, null, 2), {
				httpMetadata: { contentType: 'application/json' },
			});

			logger.debug('R2 trace written', {
				op: 'r2_trace_flush',
				trace_id: this.trace_id,
				tool: this.tool,
				provider_count: this._providers.size,
				r2_key,
			});
		} catch (err) {
			logger.warn('R2 trace write failed', {
				op: 'r2_trace_flush_error',
				trace_id: this.trace_id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}

// ── Header extraction helpers (used by http.ts and provider trace recording) ─

export const extract_headers_from_init = (headers: HeadersInit | undefined): Record<string, string> => {
	if (!headers) return {};
	if (headers instanceof Headers) {
		const result: Record<string, string> = {};
		headers.forEach((value, key) => {
			result[key] = value;
		});
		return result;
	}
	if (Array.isArray(headers)) {
		return Object.fromEntries(headers);
	}
	return { ...headers } as Record<string, string>;
};

export const extract_response_headers = (headers: Headers): Record<string, string> => {
	const result: Record<string, string> = {};
	headers.forEach((value, key) => {
		result[key] = value;
	});
	return result;
};

export const parse_request_body = (body: BodyInit | null | undefined): unknown => {
	if (!body) return null;
	if (typeof body === 'string') {
		try {
			return JSON.parse(body);
		} catch {
			return body;
		}
	}
	return `[${typeof body}]`;
};
