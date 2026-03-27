// REST fetch endpoint — lightweight alternative to the MCP fetch tool
// POST /fetch  { url: string, provider?: string }
// Returns { url, title, content, source_provider, duration_ms }
// Compatible with Open WebUI and any REST client.

import { ErrorType, ProviderError } from '../common/types.js';
import { loggers } from '../common/logger.js';
import { authenticate_rest_request, sanitize_for_log } from '../common/utils.js';
import { get_fetch_provider } from './tools.js';
import { run_fetch_race, run_fetch_waterfall_collect } from './fetch_orchestrator.js';
import { get_active_fetch_providers, type FetchProviderName } from '../providers/unified/fetch.js';
import { OPENWEBUI_API_KEY, OMNISEARCH_API_KEY } from '../config/env.js';
import { run_cleanup, is_cleanup_available } from '../providers/cleanup/index.js';

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
	let url: string;
	let provider: string | undefined;
	let cleanup: boolean | undefined;
	let cleanup_query: string | undefined;
	let cleanup_model: string | undefined;
	let cleanup_max_tokens: number | undefined;
	try {
		const body = await request.json() as { url?: string; provider?: string; cleanup?: boolean; cleanup_query?: string; cleanup_model?: string; cleanup_max_tokens?: number };
		url = body.url as string;
		provider = body.provider;
		cleanup = body.cleanup;
		cleanup_query = body.cleanup_query;
		cleanup_model = body.cleanup_model;
		cleanup_max_tokens = body.cleanup_max_tokens;
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
		provider: provider ?? 'auto (waterfall)',
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
		let content: string;
		let cleanup_meta: Record<string, unknown> = {};
		let result;

		if (cleanup && cleanup_query && is_cleanup_available()) {
			const fetch_start = Date.now();
			const versions = await run_fetch_waterfall_collect(fetch_provider, url, 3);
			if (versions.length === 0) throw new Error('All fetch providers failed');

			const cleaned = await run_cleanup(versions, cleanup_query, cleanup_model, cleanup_max_tokens);
			content = cleaned.content;
			cleanup_meta = {
				cleanup_applied: cleaned.cleanup_applied,
				cleanup_model: cleaned.cleanup_model,
				cleanup_latency_ms: cleaned.cleanup_latency_ms,
				original_length: cleaned.original_length,
				cleaned_length: cleaned.cleaned_length,
				versions_provided: cleaned.versions_provided,
			};

			// Use first version metadata for the response envelope
			result = {
				result: { url: versions[0].url, title: versions[0].title, content: versions[0].content, source_provider: versions[0].provider, metadata: undefined as Record<string, unknown> | undefined },
				provider_used: versions[0].provider,
				total_duration_ms: Date.now() - fetch_start,
				providers_attempted: versions.map((v) => v.provider),
				providers_failed: [] as Array<{ provider: string; error: string; duration_ms: number }>,
			};
		} else {
			result = await run_fetch_race(fetch_provider, url, { provider: provider as FetchProviderName | undefined });
			content = result.result.content;
		}

		const duration = Date.now() - start_time;
		logger.info('Fetch completed', {
			op: 'fetch_complete',
			url: sanitize_for_log(url),
			provider_used: result.provider_used,
			duration_ms: result.total_duration_ms,
			providers_failed_count: result.providers_failed.length,
			cleanup_applied: !!cleanup_meta.cleanup_applied,
		});

		logger.response('POST', '/fetch', 200, duration, {
			provider_used: result.provider_used,
		});

		return Response.json({
			url: result.result.url,
			title: result.result.title,
			content,
			source_provider: result.provider_used,
			duration_ms: result.total_duration_ms,
			providers_attempted: result.providers_attempted,
			providers_failed: result.providers_failed,
			metadata: result.result.metadata,
			...cleanup_meta,
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
