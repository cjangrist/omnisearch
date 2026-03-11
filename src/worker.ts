// Cloudflare Workers entry point for the MCP Omnisearch server

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { initialize_config, validate_config } from './config/env.js';
import { initialize_providers } from './providers/index.js';
import { register_tools } from './server/tools.js';
import { setup_handlers } from './server/handlers.js';
import { handle_rest_search } from './server/rest_search.js';
import type { Env } from './types/env.js';

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
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// CORS preflight
		if (request.method === 'OPTIONS') {
			return handle_cors_preflight();
		}

		// Initialize config from Workers env bindings (per-request)
		initialize_config(env);

		// REST /search endpoint (before MCP)
		if (request.method === 'POST' && url.pathname === '/search') {
			validate_config();
			initialize_providers();
			return add_cors_headers(await handle_rest_search(request));
		}

		// MCP endpoint
		if (url.pathname === '/mcp') {
			validate_config();
			initialize_providers();

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
			await server.connect(transport);
			const response = await transport.handleRequest(request);
			return add_cors_headers(response);
		}

		// Health check
		if (url.pathname === '/' || url.pathname === '/health') {
			return new Response(JSON.stringify({ status: 'ok', name: SERVER_NAME, version: SERVER_VERSION }), {
				headers: { 'Content-Type': 'application/json' },
			});
		}

		return new Response('Not found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;
