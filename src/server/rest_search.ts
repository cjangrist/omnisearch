// REST search endpoint — lightweight alternative to the MCP tool
// POST /search  { query: string, count?: number, raw?: boolean }
// Returns [{ link, title, snippet }]
// raw: true skips quality filtering (returns all results including low-quality ones)
// Compatible with Open WebUI and any REST client.

import { ProviderError } from '../common/types.js';
import { loggers } from '../common/logger.js';
import { authenticate_rest_request, sanitize_for_log } from '../common/utils.js';
import { get_web_search_provider, get_fetch_provider } from './tools.js';
import { run_web_search_fanout, truncate_web_results } from './web_search_fanout.js';
import { run_fetch_waterfall_collect } from './fetch_orchestrator.js';
import { OPENWEBUI_API_KEY, OMNISEARCH_API_KEY } from '../config/env.js';
import { run_cleanup, is_cleanup_available } from '../providers/cleanup/index.js';

const logger = loggers.rest();

export async function handle_rest_search(
	request: Request,
): Promise<Response> {
	const start_time = Date.now();

	const auth_error = authenticate_rest_request(request, OPENWEBUI_API_KEY || OMNISEARCH_API_KEY);
	if (auth_error) return auth_error;

	// Reject oversized request bodies before parsing
	const content_length = parseInt(request.headers.get('content-length') ?? '0', 10) || 0;
	if (content_length > 65536) {
		logger.warn('Request body too large', {
			op: 'request_validation',
			content_length,
			max_size: 65536,
			status: 413,
		});
		return Response.json({ error: 'Request body too large' }, { status: 413 });
	}

	// Parse request body
	let query: string;
	let count: number;
	let raw: boolean;
	let fetch_and_cleanup: boolean;
	let cleanup_model: string | undefined;
	try {
		const body = await request.json() as { query?: string; count?: number; raw?: boolean; fetch_and_cleanup?: boolean; cleanup_model?: string };
		query = body.query as string;
		count = Math.min(100, Math.max(0, body.count ?? 0));
		raw = body.raw === true;
		fetch_and_cleanup = body.fetch_and_cleanup !== false;
		cleanup_model = body.cleanup_model;
	} catch (err) {
		logger.warn('Invalid JSON body', {
			op: 'request_validation',
			error: err instanceof Error ? err.message : 'Unknown error',
			status: 400,
		});
		return Response.json(
			{ error: 'Invalid JSON body' },
			{ status: 400 },
		);
	}

	if (!query || typeof query !== 'string' || query.trim().length === 0) {
		logger.warn('Missing or empty query', {
			op: 'request_validation',
			has_query: !!query,
			status: 400,
		});
		return Response.json(
			{ error: 'query is required' },
			{ status: 400 },
		);
	}
	if (query.length > 2000) {
		logger.warn('Query too long', {
			op: 'request_validation',
			query_length: query.length,
			max_length: 2000,
			status: 400,
		});
		return Response.json(
			{ error: 'query too long (max 2000 chars)' },
			{ status: 400 },
		);
	}
	query = query.trim();

	logger.info('Search request received', {
		op: 'search_request',
		query: sanitize_for_log(query),
		requested_count: count,
		raw_mode: raw,
	});

	const web_provider = get_web_search_provider();
	if (!web_provider) {
		logger.error('No search providers configured', {
			op: 'provider_check',
			status: 503,
		});
		return Response.json(
			{ error: 'No search providers configured' },
			{ status: 503 },
		);
	}

	let result;
	logger.info('Starting search fanout', {
		op: 'search_fanout',
		provider: web_provider.name,
		query: sanitize_for_log(query),
	});

	try {
		result = await run_web_search_fanout(web_provider, query, { skip_quality_filter: raw });
	} catch (err) {
		const error_message = err instanceof Error ? err.message : String(err);
		logger.error('Search fanout failed', {
			op: 'search_fanout',
			error: error_message,
			provider: web_provider.name,
			status: 502,
		});
		const message = err instanceof ProviderError ? 'Search provider error' : 'Internal server error';
		return Response.json({ error: message }, { status: 502 });
	}

	let web_results = result.web_results;

	if (fetch_and_cleanup && is_cleanup_available()) {
		const fetch_provider = get_fetch_provider();
		if (fetch_provider) {
			// No truncation — cleanup compresses content enough to return all results
			const targets = count > 0 ? web_results.slice(0, count) : web_results;

			const cleanup_promises = targets.map(async (web_result) => {
				try {
					const versions = await run_fetch_waterfall_collect(fetch_provider, web_result.url, 3);
					if (versions.length === 0) return web_result;
					const cleaned = await run_cleanup(versions, query, cleanup_model);
					if (cleaned.content === 'NO_RELEVANT_CONTENT') return web_result;
					return { ...web_result, snippets: [cleaned.content] };
				} catch {
					return web_result;
				}
			});

			const settled = await Promise.allSettled(cleanup_promises);
			web_results = settled.map((s, i) =>
				s.status === 'fulfilled' ? s.value : targets[i],
			);
		}
	}

	const sorted = (count > 0 ? web_results.slice(0, count) : web_results)
		.map((r) => ({
			link: r.url,
			title: r.title || '',
			snippet: r.snippets?.join(' ') || '',
		}));

	const provider_names = result.providers_succeeded.map((p) => p.provider);
	const failed_count = result.providers_failed?.length ?? 0;

	logger.info('Search completed', {
		op: 'search_complete',
		query: sanitize_for_log(query),
		requested_count: count,
		returned_count: sorted.length,
		providers_succeeded: provider_names,
		providers_succeeded_count: provider_names.length,
		providers_failed_count: failed_count,
		duration_ms: result.total_duration_ms,
		raw_mode: raw,
	});

	if (failed_count > 0) {
		logger.warn('Some providers failed during search', {
			op: 'search_complete',
			failed_providers: result.providers_failed?.map((p) => p.provider),
			failed_count,
		});
	}

	// All providers failed — return 502 instead of a misleading 200 with empty results
	if (provider_names.length === 0 && failed_count > 0) {
		const duration = Date.now() - start_time;
		logger.response('POST', '/search', 502, duration, { failed_count });
		return Response.json(
			{ error: 'All search providers failed', failed_providers: result.providers_failed?.map((p) => p.provider) },
			{ status: 502 },
		);
	}

	const duration = Date.now() - start_time;
	logger.response('POST', '/search', 200, duration, {
		result_count: sorted.length,
		providers_count: provider_names.length,
	});

	return Response.json(sorted);
}
