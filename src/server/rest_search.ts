// REST search endpoint — lightweight alternative to the MCP tool
// POST /search  { query: string, count?: number, raw?: boolean }
// Returns [{ link, title, snippet }]
// raw: true skips quality filtering (returns all results including low-quality ones)
// Compatible with Open WebUI and any REST client.

import { ProviderError } from '../common/types.js';
import { get_web_search_provider } from './tools.js';
import { run_web_search_fanout } from './web_search_fanout.js';
import { OPENWEBUI_API_KEY, OMNISEARCH_API_KEY } from '../config/env.js';

const sanitize_for_log = (s: string): string =>
	s.replace(/[\x00-\x1F\x7F]/g, '').slice(0, 200);

const timing_safe_equal = (a: string, b: string): boolean => {
	const encoder = new TextEncoder();
	const a_buf = encoder.encode(a);
	const b_buf = encoder.encode(b);
	if (a_buf.byteLength !== b_buf.byteLength) return false;
	return crypto.subtle.timingSafeEqual(a_buf, b_buf);
};

export async function handle_rest_search(
	request: Request,
): Promise<Response> {
	// Validate Bearer token if OMNISEARCH_API_KEY is set
	const expected_key = (OPENWEBUI_API_KEY || OMNISEARCH_API_KEY || '').trim();
	if (expected_key) {
		const auth = request.headers.get('Authorization') ?? '';
		const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
		if (!token || !timing_safe_equal(token, expected_key)) {
			return Response.json(
				{ error: 'Unauthorized' },
				{ status: 401 },
			);
		}
	}

	// Reject oversized request bodies before parsing
	const content_length = parseInt(request.headers.get('content-length') ?? '0', 10) || 0;
	if (content_length > 65536) {
		return Response.json({ error: 'Request body too large' }, { status: 413 });
	}

	// Parse request body
	let query: string;
	let count: number;
	let raw: boolean;
	try {
		const body = await request.json() as { query?: string; count?: number; raw?: boolean };
		query = body.query as string;
		count = Math.max(0, body.count ?? 0);
		raw = body.raw === true;
	} catch {
		return Response.json(
			{ error: 'Invalid JSON body' },
			{ status: 400 },
		);
	}

	if (!query || typeof query !== 'string' || query.trim().length === 0) {
		return Response.json(
			{ error: 'query is required' },
			{ status: 400 },
		);
	}
	if (query.length > 2000) {
		return Response.json(
			{ error: 'query too long (max 2000 chars)' },
			{ status: 400 },
		);
	}
	query = query.trim();

	const web_provider = get_web_search_provider();
	if (!web_provider) {
		return Response.json(
			{ error: 'No search providers configured' },
			{ status: 503 },
		);
	}

	let result;
	try {
		result = await run_web_search_fanout(web_provider, query, { skip_quality_filter: raw });
	} catch (err) {
		console.error('[rest-search] fanout error:', err);
		const message = err instanceof ProviderError ? 'Search provider error' : 'Internal server error';
		return Response.json({ error: message }, { status: 502 });
	}

	const sorted = (count > 0 ? result.web_results.slice(0, count) : result.web_results)
		.map((r) => ({
			link: r.url,
			title: r.title || '',
			snippet: r.snippets?.join(' ') || '',
		}));

	const provider_names = result.providers_succeeded.map((p) => p.provider);
	console.error(
		`[rest-search] query="${sanitize_for_log(query)}" count=${count} providers=[${provider_names.join(',')}] results=${sorted.length} ${result.total_duration_ms}ms`,
	);

	return Response.json(sorted);
}
