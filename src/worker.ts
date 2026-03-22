// Cloudflare Workers entry point — stateful McpAgent (Durable Object) mode.
// Each client session gets its own DO instance; GET /mcp holds a live SSE stream
// that receives progress notifications every 5s during long-running answer fanouts,
// preventing Claude web's 45-second timeout from killing the connection.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import { initialize_config, validate_config } from './config/env.js';
import { initialize_providers } from './providers/index.js';
import { register_tools } from './server/tools.js';
import { setup_handlers } from './server/handlers.js';
import { handle_rest_search } from './server/rest_search.js';
import { handle_rest_fetch } from './server/rest_fetch.js';
import { loggers } from './common/logger.js';
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
// pings on POST SSE responses. We inject `event: ping` every 5s to prevent proxies
// and MCP clients (Claude web, Claude Code) from killing the stream during long tool calls.

const SSE_KEEPALIVE_INTERVAL_MS = 5_000;
const SSE_PING = new TextEncoder().encode('event: ping\ndata: \n\n');

const inject_sse_keepalive = (original: Response): Response => {
	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();

	const keepalive = setInterval(() => {
		writer.write(SSE_PING).catch(() => clearInterval(keepalive));
	}, SSE_KEEPALIVE_INTERVAL_MS);

	const pump = async () => {
		const reader = original.body!.getReader();
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				await writer.write(value);
			}
		} finally {
			clearInterval(keepalive);
			await writer.close().catch(() => {});
		}
	};
	pump().catch(() => {
		clearInterval(keepalive);
		writer.close().catch(() => {});
	});

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
	// @ts-expect-error: agents bundles @modelcontextprotocol/sdk@1.26.0 while we use 1.27.1.
	// TypeScript flags the private property mismatch as a type error, but at runtime
	// wrangler (esbuild) bundles a single copy so the types are structurally identical.
	server = new McpServer(
		{ name: SERVER_NAME, version: SERVER_VERSION },
		{
			capabilities: {
				tools: { listChanged: true },
				resources: { listChanged: true },
			},
		},
	);

	async init(): Promise<void> {
		// Runs once per DO activation (per session). All subsequent tool calls within
		// the same session reuse the already-initialized providers and config.
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

const mcp_handler = OmnisearchMCP.serve('/mcp', { binding: 'OmnisearchMCP' });

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const start_time = Date.now();
		const request_id = crypto.randomUUID();

		logger.info('Incoming request', {
			op: 'request_start',
			request_id,
			method: request.method,
			path: url.pathname,
			cf_ray: request.headers.get('cf-ray') ?? 'unknown',
			cf_ipcountry: request.headers.get('cf-ipcountry') ?? 'unknown',
		});

		// CORS preflight
		if (request.method === 'OPTIONS') {
			logger.debug('Handling CORS preflight', { op: 'cors', request_id });
			return handle_cors_preflight();
		}

		// REST /search endpoint
		if (request.method === 'POST' && url.pathname === '/search') {
			logger.info('Handling REST search request', { op: 'rest_search', request_id });
			try {
				initialize_config(env);
				validate_config();
				initialize_providers();
			} catch (err) {
				logger.error('Provider initialization failed', {
					op: 'provider_init',
					request_id,
					error: err instanceof Error ? err.message : String(err),
				});
				return Response.json({ error: 'Internal server error' }, { status: 500 });
			}
			const response = await handle_rest_search(request);
			const duration = Date.now() - start_time;
			logger.response(request.method, url.pathname, response.status, duration, { request_id });
			return add_cors_headers(response);
		}

		// REST /fetch endpoint
		if (request.method === 'POST' && url.pathname === '/fetch') {
			logger.info('Handling REST fetch request', { op: 'rest_fetch', request_id });
			try {
				initialize_config(env);
				validate_config();
				initialize_providers();
			} catch (err) {
				logger.error('Provider initialization failed', {
					op: 'provider_init',
					request_id,
					error: err instanceof Error ? err.message : String(err),
				});
				return Response.json({ error: 'Internal server error' }, { status: 500 });
			}
			const response = await handle_rest_fetch(request);
			const duration = Date.now() - start_time;
			logger.response(request.method, url.pathname, response.status, duration, { request_id });
			return add_cors_headers(response);
		}

		// Health check
		if (url.pathname === '/' || url.pathname === '/health') {
			logger.debug('Health check request', { op: 'health_check', request_id });
			const duration = Date.now() - start_time;
			logger.response(request.method, url.pathname, 200, duration, { request_id });
			return new Response(
				JSON.stringify({ status: 'ok', name: SERVER_NAME, version: SERVER_VERSION }),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			);
		}

		// MCP: delegate to the McpAgent DO handler.
		// The agents package's DO transport (WebSocket bridge) does NOT include keepalive
		// pings on POST SSE streams — only the stateless WorkerTransport does. We wrap
		// POST /mcp SSE responses with 5-second pings to prevent Claude web's 45s timeout
		// from killing long-running tool calls (answer fanout takes 20–120s).
		const response = await mcp_handler.fetch(request, env, ctx);
		if (
			request.method === 'POST'
			&& response.body
			&& response.headers.get('content-type')?.includes('text/event-stream')
		) {
			return inject_sse_keepalive(response);
		}
		return response;
	},
} satisfies ExportedHandler<Env>;
