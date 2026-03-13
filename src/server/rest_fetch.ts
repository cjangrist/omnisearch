// REST fetch endpoint — lightweight alternative to the MCP fetch tool
// POST /fetch  { url: string, provider?: string }
// Returns { url, title, content, source_provider, duration_ms }
// Compatible with Open WebUI and any REST client.

import { ErrorType, ProviderError } from '../common/types.js';
import { loggers } from '../common/logger.js';
import { get_fetch_provider } from './tools.js';
import { run_fetch_race } from './fetch_orchestrator.js';
import { get_active_fetch_providers, type FetchProviderName } from '../providers/unified/fetch.js';
import { OPENWEBUI_API_KEY, OMNISEARCH_API_KEY } from '../config/env.js';

const logger = loggers.rest();

const sanitize_for_log = (s: string): string =>
	s.replace(/[\x00-\x1F\x7F]/g, '').slice(0, 200);

const timing_safe_equal = (a: string, b: string): boolean => {
	const encoder = new TextEncoder();
	const a_buf = encoder.encode(a);
	const b_buf = encoder.encode(b);
	if (a_buf.byteLength !== b_buf.byteLength) return false;
	return crypto.subtle.timingSafeEqual(a_buf, b_buf);
};

export async function handle_rest_fetch(
	request: Request,
): Promise<Response> {
	const start_time = Date.now();

	// Validate Bearer token if OMNISEARCH_API_KEY is set
	const expected_key = (OPENWEBUI_API_KEY || OMNISEARCH_API_KEY || '').trim();
	if (expected_key) {
		const auth = request.headers.get('Authorization') ?? '';
		const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
		if (!token || !timing_safe_equal(token, expected_key)) {
			logger.warn('Authentication failed', {
				op: 'auth',
				has_token: !!token,
				status: 401,
			});
			return Response.json(
				{ error: 'Unauthorized' },
				{ status: 401 },
			);
		}
	}

	// Reject oversized request bodies
	const content_length = parseInt(request.headers.get('content-length') ?? '0', 10) || 0;
	if (content_length > 65536) {
		return Response.json({ error: 'Request body too large' }, { status: 413 });
	}

	// Parse request body
	let url: string;
	let provider: string | undefined;
	try {
		const body = await request.json() as { url?: string; provider?: string };
		url = body.url as string;
		provider = body.provider;
	} catch {
		return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	if (!url || typeof url !== 'string' || url.trim().length === 0) {
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

	// Validate provider if specified
	if (provider) {
		const valid_names = new Set(get_active_fetch_providers().map((p) => p.name));
		if (!valid_names.has(provider)) {
			return Response.json(
				{ error: `Invalid provider: ${provider}. Valid: ${Array.from(valid_names).join(', ')}` },
				{ status: 400 },
			);
		}
	}

	logger.info('Fetch request received', {
		op: 'fetch_request',
		url: sanitize_for_log(url),
		provider: provider ?? 'auto',
	});

	const fetch_provider = get_fetch_provider();
	if (!fetch_provider) {
		logger.error('No fetch providers configured', {
			op: 'provider_check',
			status: 503,
		});
		return Response.json(
			{ error: 'No fetch providers configured' },
			{ status: 503 },
		);
	}

	try {
		const result = await run_fetch_race(fetch_provider, url, {
			provider: provider as FetchProviderName | undefined,
		});

		const duration = Date.now() - start_time;
		logger.info('Fetch completed', {
			op: 'fetch_complete',
			url: sanitize_for_log(url),
			provider_used: result.provider_used,
			duration_ms: result.total_duration_ms,
			providers_failed_count: result.providers_failed.length,
		});

		logger.response('POST', '/fetch', 200, duration, {
			provider_used: result.provider_used,
		});

		return Response.json({
			url: result.result.url,
			title: result.result.title,
			content: result.result.content,
			source_provider: result.provider_used,
			duration_ms: result.total_duration_ms,
			metadata: result.result.metadata,
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
