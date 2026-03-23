// GPT-Researcher compatible endpoint
// GET /researcher?query=...&api_key=...
// Returns [{ url, raw_content }] — search + parallel fetch in one call.
// Compatible with RETRIEVER=custom in GPT-Researcher.

import { loggers } from '../common/logger.js';
import { authenticate_rest_request, sanitize_for_log } from '../common/utils.js';
import { get_web_search_provider } from './tools.js';
import { run_web_search_fanout } from './web_search_fanout.js';
import { OPENWEBUI_API_KEY, OMNISEARCH_API_KEY } from '../config/env.js';

const logger = loggers.rest();

const DEFAULT_MAX_RESULTS = 10;

export async function handle_rest_researcher(
	request: Request,
): Promise<Response> {
	const start_time = Date.now();
	const url = new URL(request.url);

	// Auth — check api_key query param OR Bearer token
	const param_key = url.searchParams.get('api_key');
	if (param_key) {
		request = new Request(request.url, {
			...request,
			headers: new Headers([...request.headers.entries(), ['Authorization', `Bearer ${param_key}`]]),
		});
	}
	const auth_error = authenticate_rest_request(request, OPENWEBUI_API_KEY || OMNISEARCH_API_KEY);
	if (auth_error) return auth_error;

	// Parse query from query params (GET) or body (POST)
	let query: string;
	if (request.method === 'GET') {
		query = url.searchParams.get('query') ?? '';
	} else {
		try {
			const body = await request.json() as { query?: string };
			query = body.query ?? '';
		} catch {
			return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
		}
	}

	if (!query || query.trim().length === 0) {
		return Response.json({ error: 'query is required' }, { status: 400 });
	}
	if (query.length > 2000) {
		return Response.json({ error: 'query too long (max 2000 chars)' }, { status: 400 });
	}
	query = query.trim();

	logger.info('Researcher request', {
		op: 'researcher_request',
		query: sanitize_for_log(query),
	});

	const web_provider = get_web_search_provider();

	if (!web_provider) {
		return Response.json({ error: 'No search providers configured' }, { status: 503 });
	}

	let output: Array<{ href: string; body: string }>;
	try {
		const fanout = await run_web_search_fanout(web_provider, query);
		output = fanout.web_results
			.slice(0, DEFAULT_MAX_RESULTS)
			.map((r) => ({
				href: r.url,
				body: r.snippets?.join('\n') ?? '',
			}))
			.filter((r) => r.body.length > 0);
	} catch (err) {
		logger.error('Researcher search failed', {
			op: 'researcher_search',
			error: err instanceof Error ? err.message : String(err),
		});
		return Response.json({ error: 'Search failed' }, { status: 502 });
	}

	const duration = Date.now() - start_time;
	logger.info('Researcher complete', {
		op: 'researcher_complete',
		query: sanitize_for_log(query),
		result_count: output.length,
		duration_ms: duration,
	});
	logger.response(request.method, '/researcher', 200, duration, { result_count: output.length });

	return Response.json(output);
}
