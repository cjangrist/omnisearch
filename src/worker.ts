// Cloudflare Workers entry point — stateful McpAgent (Durable Object) mode.
// Each client session gets its own DO instance; GET /mcp holds a live SSE stream
// that receives progress notifications every 5s during long-running answer fanouts,
// preventing Claude web's 45-second timeout from killing the connection.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import { initialize_config, validate_config } from './config/env.js';
import { initialize_providers } from './providers/index.js';
import { register_tools, active_providers } from './server/tools.js';
import { setup_handlers } from './server/handlers.js';
import { handle_rest_search } from './server/rest_search.js';
import { handle_rest_fetch } from './server/rest_fetch.js';
import { handle_rest_researcher } from './server/rest_researcher.js';
import { loggers, run_with_request_id } from './common/logger.js';
import { set_trace_execution_context } from './common/r2_trace.js';
import type { Env } from './types/env.js';

const logger = loggers.worker();

const SERVER_NAME = 'omnisearch-mcp';
const SERVER_VERSION = '1.0.0';

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization, mcp-session-id, Last-Event-ID, mcp-protocol-version',
	'Access-Control-Expose-Headers': 'mcp-session-id, mcp-protocol-version',
} as const;

const handle_cors_preflight = (): Response =>
	new Response(null, { status: 204, headers: CORS_HEADERS });

const add_cors_headers = (response: Response): Response => {
	// If headers are immutable (common for streaming/SSE responses), clone first
	try {
		for (const [key, value] of Object.entries(CORS_HEADERS)) {
			response.headers.set(key, value);
		}
		return response;
	} catch {
		// Headers immutable — wrap in a new Response
		const headers = new Headers(response.headers);
		for (const [key, value] of Object.entries(CORS_HEADERS)) {
			headers.set(key, value);
		}
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}
};

// ── SSE keepalive injection ──────────────────────────────────────────────────
// The agents package's DO transport (WebSocket→SSE bridge) does NOT send keepalive
// on POST SSE responses. We inject named SSE events every 5s to keep the connection
// alive through Cloudflare's proxy. Using `event: ping` ensures MCP SDK clients
// silently ignore it (they only process `event: message` or unnamed events).

const SSE_KEEPALIVE_INTERVAL_MS = 5_000;
const SSE_PING = new TextEncoder().encode('event: ping\ndata: keepalive\n\n');

const inject_sse_keepalive = (original: Response): Response => {
	if (!original.body) return original;

	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();
	const reader = original.body.getReader();
	let closed = false;

	// Buffer as a list of chunks — avoids O(n^2) Uint8Array concatenation on every read.
	let chunks: Uint8Array[] = [];
	let total_len = 0;

	// Write lock — serializes pump writes and interval pings to prevent concurrent writer access.
	let write_lock = Promise.resolve();
	const safe_write = (chunk: Uint8Array): Promise<void> => {
		write_lock = write_lock.then(() => writer.write(chunk)).catch(cleanup);
		return write_lock;
	};

	const cleanup = () => {
		if (closed) return;
		closed = true;
		clearInterval(keepalive);
		reader.cancel().catch(() => {});
		writer.close().catch(() => {});
	};

	// Flatten chunks into a single Uint8Array (only when needed for boundary scanning)
	const flatten = (): Uint8Array => {
		if (chunks.length === 0) return new Uint8Array(0);
		if (chunks.length === 1) return chunks[0];
		const flat = new Uint8Array(total_len);
		let offset = 0;
		for (const c of chunks) { flat.set(c, offset); offset += c.length; }
		chunks = [flat];
		return flat;
	};

	// Find the first SSE event boundary: \n\n, \r\n\r\n, or \r\r per WHATWG spec
	const find_event_boundary = (buf: Uint8Array): number => {
		for (let i = 0; i < buf.length - 1; i++) {
			// \n\n
			if (buf[i] === 0x0a && buf[i + 1] === 0x0a) return i + 2;
			// \r\r (with optional \n after each \r for \r\n\r\n)
			if (buf[i] === 0x0d) {
				if (buf[i + 1] === 0x0d) return i + 2; // \r\r
				if (buf[i + 1] === 0x0a && i + 3 < buf.length && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) return i + 4; // \r\n\r\n
			}
		}
		return -1;
	};

	// Flush all complete SSE events from the buffer to the writer
	const flush_complete_events = async () => {
		const buf = flatten();
		let boundary: number;
		let offset = 0;
		while ((boundary = find_event_boundary(buf.subarray(offset))) !== -1) {
			const abs = offset + boundary;
			await safe_write(buf.subarray(offset, abs));
			offset = abs;
		}
		if (offset > 0) {
			const remainder = buf.subarray(offset);
			chunks = remainder.length > 0 ? [remainder] : [];
			total_len = remainder.length;
		}
	};

	// Only inject keepalive between complete events (buffer empty = no partial event in flight)
	const keepalive = setInterval(() => {
		if (closed) return;
		if (total_len === 0) {
			safe_write(SSE_PING);
		}
	}, SSE_KEEPALIVE_INTERVAL_MS);

	const pump = async () => {
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) {
					if (total_len > 0) {
						await safe_write(flatten());
						chunks = [];
						total_len = 0;
					}
					break;
				}
				chunks.push(value);
				total_len += value.length;
				// Only scan for event boundaries when the chunk contains a line break
				if (value.indexOf(0x0a) !== -1 || value.indexOf(0x0d) !== -1) {
					await flush_complete_events();
				}
			}
		} finally {
			cleanup();
		}
	};
	pump().catch(cleanup);

	return new Response(readable, {
		status: original.status,
		statusText: original.statusText,
		headers: original.headers,
	});
};

// ── Stateful MCP Agent (Durable Object) ──────────────────────────────────────
// Each client session gets its own DO instance. init() runs once per DO activation.
// this.env is inherited from Agent<Env> and holds all Cloudflare secret bindings.
// Named export is required — wrangler resolves the DO class by matching this name
// against the class_name in wrangler.toml [[durable_objects.bindings]].

export class OmnisearchMCP extends McpAgent<Env> {
	server = new McpServer(
		{ name: SERVER_NAME, version: SERVER_VERSION },
		{
			capabilities: {
				tools: { listChanged: true },
				resources: { listChanged: true },
			},
		},
	);

	private _init_promise: Promise<void> | undefined;

	async init(): Promise<void> {
		if (!this._init_promise) {
			this._init_promise = this._do_init().catch((err) => {
				this._init_promise = undefined; // allow retry on next request
				throw err;
			});
		}
		return this._init_promise;
	}

	private async _do_init(): Promise<void> {
		initialize_config(this.env);
		validate_config();
		initialize_providers();
		register_tools(this.server);
		setup_handlers(this.server);
		logger.info('OmnisearchMCP agent initialized', { op: 'agent_init' });
	}
}

// ── Wrapper fetch handler for REST routes + MCP delegation ───────────────────
// McpAgent.serve("/mcp") returns a fetch handler that routes /mcp to the DO.
// We intercept /search, /fetch, /health before delegating to it.
// mcp_handler is created at module load time (stores class ref + path only; no DOs spun up).

// REST path initialization — env bindings are immutable within an isolate's lifetime,
// so we only need to initialize once. Uses the same rejected-promise-retry pattern as the DO.
let _rest_init: Promise<void> | undefined;
const ensure_rest_initialized = (env: Env): Promise<void> => {
	if (!_rest_init) {
		_rest_init = (async () => {
			initialize_config(env);
			validate_config();
			initialize_providers();
		})().catch((err) => {
			_rest_init = undefined;
			throw err;
		});
	}
	return _rest_init;
};

const mcp_handler = OmnisearchMCP.serve('/mcp', {
	binding: 'OmnisearchMCP',
	corsOptions: {
		origin: '*',
		headers: '*',
		exposeHeaders: '*',
	},
});

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const start_time = Date.now();
		const request_id = crypto.randomUUID();

		set_trace_execution_context(ctx);
		return run_with_request_id(request_id, () => handle_request(request, env, ctx, url, start_time, request_id));
	},
} satisfies ExportedHandler<Env>;

async function handle_request(request: Request, env: Env, ctx: ExecutionContext, url: URL, start_time: number, request_id: string): Promise<Response> {
		logger.info('Incoming request', {
			op: 'request_start',
			request_id,
			method: request.method,
			path: url.pathname,
			cf_ray: request.headers.get('cf-ray') ?? 'unknown',
			cf_ipcountry: request.headers.get('cf-ipcountry') ?? 'unknown',
		});

		// CORS preflight — let /mcp use the agents package's wildcard CORS
		if (request.method === 'OPTIONS' && url.pathname !== '/mcp') {
			logger.debug('Handling CORS preflight', { op: 'cors', request_id });
			return handle_cors_preflight();
		}

		// REST /search endpoint
		if (request.method === 'POST' && url.pathname === '/search') {
			logger.info('Handling REST search request', { op: 'rest_search', request_id });
			try {
				await ensure_rest_initialized(env);
			} catch (err) {
				logger.error('Provider initialization failed', {
					op: 'provider_init', request_id,
					error: err instanceof Error ? err.message : String(err),
				});
				return add_cors_headers(Response.json({ error: 'Internal server error' }, { status: 500 }));
			}
			let response: Response;
			try {
				response = await handle_rest_search(request);
			} catch (err) {
				logger.error('REST search handler error', { op: 'rest_search', request_id, error: err instanceof Error ? err.message : String(err) });
				return add_cors_headers(Response.json({ error: 'Internal server error' }, { status: 500 }));
			}
			return add_cors_headers(response);
		}

		// REST /fetch endpoint
		if (request.method === 'POST' && url.pathname === '/fetch') {
			logger.info('Handling REST fetch request', { op: 'rest_fetch', request_id });
			try {
				await ensure_rest_initialized(env);
			} catch (err) {
				logger.error('Provider initialization failed', {
					op: 'provider_init', request_id,
					error: err instanceof Error ? err.message : String(err),
				});
				return add_cors_headers(Response.json({ error: 'Internal server error' }, { status: 500 }));
			}
			let fetch_response: Response;
			try {
				fetch_response = await handle_rest_fetch(request);
			} catch (err) {
				logger.error('REST fetch handler error', { op: 'rest_fetch', request_id, error: err instanceof Error ? err.message : String(err) });
				return add_cors_headers(Response.json({ error: 'Internal server error' }, { status: 500 }));
			}
			return add_cors_headers(fetch_response);
		}

		// GPT-Researcher compatible endpoint (GET or POST)
		if (url.pathname === '/researcher') {
			logger.info('Handling researcher request', { op: 'rest_researcher', request_id });
			try {
				await ensure_rest_initialized(env);
			} catch (err) {
				logger.error('Provider initialization failed', {
					op: 'provider_init', request_id,
					error: err instanceof Error ? err.message : String(err),
				});
				return add_cors_headers(Response.json({ error: 'Internal server error' }, { status: 500 }));
			}
			let response: Response;
			try {
				response = await handle_rest_researcher(request);
			} catch (err) {
				logger.error('Researcher handler error', { op: 'rest_researcher', request_id, error: err instanceof Error ? err.message : String(err) });
				return add_cors_headers(Response.json({ error: 'Internal server error' }, { status: 500 }));
			}
			return add_cors_headers(response);
		}

		// Health check
		if (url.pathname === '/' || url.pathname === '/health') {
			logger.debug('Health check request', { op: 'health_check', request_id });
			const duration = Date.now() - start_time;
			logger.response(request.method, url.pathname, 200, duration, { request_id });
			// Try to init so we can report provider availability
			try { await ensure_rest_initialized(env); } catch { /* best effort */ }
			const total = active_providers.search.size + active_providers.ai_response.size + active_providers.fetch.size;
			return add_cors_headers(new Response(
				JSON.stringify({
					status: total > 0 ? 'ok' : 'degraded',
					name: SERVER_NAME,
					version: SERVER_VERSION,
					providers: total,
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			));
		}

		// MCP: delegate to the McpAgent DO handler.
		if (url.pathname === '/mcp') {
			try {
				const response = await mcp_handler.fetch(request, env, ctx);
				const duration = Date.now() - start_time;
				logger.response(request.method, url.pathname, response.status, duration, { request_id });
				if (
					request.method === 'POST'
					&& response.body
					&& response.headers.get('content-type')?.includes('text/event-stream')
				) {
					return inject_sse_keepalive(response);
				}
				return response;
			} catch (err) {
				logger.error('MCP handler error', {
					op: 'mcp_handler',
					request_id,
					error: err instanceof Error ? err.message : String(err),
				});
				return add_cors_headers(Response.json({ error: 'MCP processing error' }, { status: 500 }));
			}
		}

		// 404
		logger.warn('Route not found', { op: 'not_found', request_id, path: url.pathname });
		return add_cors_headers(Response.json({ error: 'Not found' }, { status: 404 }));
}
