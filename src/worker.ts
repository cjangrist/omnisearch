// Cloudflare Workers entry point for the MCP Omnisearch server

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
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

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const start_time = Date.now();
		const request_id = crypto.randomUUID();

		// Log incoming request
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

		// Initialize config from Workers env bindings (per-request)
		try {
			initialize_config(env);
		} catch (err) {
			logger.error('Config initialization failed', {
				op: 'config_init',
				request_id,
				error: err instanceof Error ? err.message : String(err),
			});
			return Response.json({ error: 'Internal server error' }, { status: 500 });
		}

		// REST /search endpoint (before MCP)
		if (request.method === 'POST' && url.pathname === '/search') {
			logger.info('Handling REST search request', {
				op: 'rest_search',
				request_id,
			});

			try {
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
			logger.response(request.method, url.pathname, response.status, duration, {
				request_id,
			});

			return add_cors_headers(response);
		}

		// REST /fetch endpoint
		if (request.method === 'POST' && url.pathname === '/fetch') {
			logger.info('Handling REST fetch request', {
				op: 'rest_fetch',
				request_id,
			});

			try {
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
			logger.response(request.method, url.pathname, response.status, duration, {
				request_id,
			});

			return add_cors_headers(response);
		}

		// MCP endpoint
		if (url.pathname === '/mcp') {
			logger.info('Handling MCP request', {
				op: 'mcp_request',
				request_id,
				method: request.method,
			});

			try {
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

			// Per-request server factory (MCP SDK 1.26.0+ security requirement)
			const server = new McpServer(
				{ name: SERVER_NAME, version: SERVER_VERSION },
				{
					capabilities: {
						tools: { listChanged: true },
						resources: { listChanged: true },
					},
				},
			);

			register_tools(server);
			setup_handlers(server);

			const transport = new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: undefined, // stateless
			});

			try {
				await server.connect(transport);
				const response = await transport.handleRequest(request);

				const duration = Date.now() - start_time;
				logger.response(request.method, url.pathname, response.status, duration, {
					request_id,
				});

				return add_cors_headers(response);
			} catch (err) {
				logger.error('MCP handling failed', {
					op: 'mcp_handler',
					request_id,
					error: err instanceof Error ? err.message : String(err),
				});
				return Response.json({ error: 'MCP processing error' }, { status: 500 });
			}
		}

		// Health check
		if (url.pathname === '/' || url.pathname === '/health') {
			logger.debug('Health check request', {
				op: 'health_check',
				request_id,
			});

			const response = new Response(
				JSON.stringify({
					status: 'ok',
					name: SERVER_NAME,
					version: SERVER_VERSION,
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			);

			const duration = Date.now() - start_time;
			logger.response(request.method, url.pathname, 200, duration, {
				request_id,
			});

			return response;
		}

		// 404 Not Found
		logger.warn('Route not found', {
			op: 'not_found',
			request_id,
			method: request.method,
			path: url.pathname,
		});

		const duration = Date.now() - start_time;
		logger.response(request.method, url.pathname, 404, duration, {
			request_id,
		});

		return new Response('Not found', { status: 404 });
	},
};
