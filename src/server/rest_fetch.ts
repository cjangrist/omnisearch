// REST fetch endpoint — delegates to the external omnifetch service.
// POST /fetch  { url: string }
// Returns { url, title, content, source_provider, duration_ms, metadata }
// Compatible with Open WebUI and any REST client.

import { ErrorType, ProviderError } from '../common/types.js';
import { loggers } from '../common/logger.js';
import { authenticate_rest_request, sanitize_for_log } from '../common/utils.js';
import { fetch_url } from './omnifetch_client.js';
import { OPENWEBUI_API_KEY, OMNISEARCH_API_KEY } from '../config/env.js';

const logger = loggers.rest();

export async function handle_rest_fetch(
	request: Request,
): Promise<Response> {
	const start_time = Date.now();

	const auth_error = authenticate_rest_request(request, OPENWEBUI_API_KEY || OMNISEARCH_API_KEY);
	if (auth_error) return auth_error;

	// Reject oversized request bodies
	const content_length = parseInt(request.headers.get('content-length') ?? '0', 10) || 0;
	if (content_length > 65536) {
		return Response.json({ error: 'Request body too large' }, { status: 413 });
	}

	// Parse request body
	let url = '';
	try {
		const body = await request.json() as { url?: unknown };
		if (typeof body.url === 'string') url = body.url;
	} catch {
		return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	if (!url || url.trim().length === 0) {
		return Response.json({ error: 'url is required' }, { status: 400 });
	}
	if (url.length > 2000) {
		return Response.json({ error: 'url too long (max 2000 chars)' }, { status: 400 });
	}
	url = url.trim();

	// Validate URL format
	try {
		new URL(url);
	} catch {
		return Response.json({ error: 'Invalid URL format' }, { status: 400 });
	}

	logger.info('Fetch request received', {
		op: 'fetch_request',
		url: sanitize_for_log(url),
	});

	try {
		const result = await fetch_url(url);

		const duration = Date.now() - start_time;
		logger.info('Fetch completed', {
			op: 'fetch_complete',
			url: sanitize_for_log(url),
			source_provider: result.source_provider,
			duration_ms: result.total_duration_ms,
		});

		logger.response('POST', '/fetch', 200, duration, {
			source_provider: result.source_provider,
		});

		return Response.json({
			url: result.url,
			title: result.title,
			content: result.content,
			source_provider: result.source_provider,
			duration_ms: result.total_duration_ms,
			metadata: result.metadata,
		});
	} catch (err) {
		const error_message = err instanceof Error ? err.message : String(err);
		const status = err instanceof ProviderError && err.type === ErrorType.RATE_LIMIT ? 429
			: err instanceof ProviderError && err.type === ErrorType.INVALID_INPUT ? 400
			: 502;
		logger.error('Fetch failed', {
			op: 'fetch_failed',
			error: error_message,
			status,
		});
		return Response.json({ error: error_message }, { status });
	}
}
