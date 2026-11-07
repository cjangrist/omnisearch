// Thin client for the external omnifetch service.
//
// omnisearch no longer runs a fetch waterfall internally — URL fetching is
// delegated entirely to the standalone omnifetch service (the same multi-
// provider waterfall, externalized). This module is the single point of
// contact: POST {url} to <OMNIFETCH_ENDPOINT>/web_fetch, map the response,
// done. No providers, no waterfall, no skip_providers, no breakers — omnifetch
// owns all of that.
//
// Auth: none. The omnifetch /web_fetch endpoint is public by design; the only
// configuration is OMNIFETCH_ENDPOINT (the service base URL).

import { http_json } from '../common/http.js';
import { ErrorType, ProviderError } from '../common/types.js';
import { make_signal } from '../common/utils.js';
import { loggers } from '../common/logger.js';
import { OMNIFETCH_ENDPOINT } from '../config/env.js';

const logger = loggers.fetch();
const OMNIFETCH_TIMEOUT_MS = 60000;

export interface OmnifetchResult {
	url: string;
	title: string;
	content: string;
	source_provider: string;
	total_duration_ms: number;
	metadata?: Record<string, unknown>;
}

// omnifetch's FetchResponse shape (subset omnisearch consumes). The service
// also returns providers_attempted / providers_failed / alternative_results
// but those are waterfall internals omnisearch no longer surfaces.
interface OmnifetchResponse {
	url?: string;
	title?: string;
	content?: string;
	source_provider?: string;
	total_duration_ms?: number;
	metadata?: Record<string, unknown>;
}

export const omnifetch_available = (): boolean => !!OMNIFETCH_ENDPOINT;

// Fetch one URL via omnifetch. Errors from the service surface as ProviderError
// (mapped by http_json from the HTTP status) so callers' existing error handling
// (REST status mapping, MCP format_error) works unchanged.
export const fetch_url = async (url: string, signal?: AbortSignal): Promise<OmnifetchResult> => {
	if (!OMNIFETCH_ENDPOINT) {
		throw new ProviderError(ErrorType.INVALID_INPUT, 'OMNIFETCH_ENDPOINT is not configured', 'omnifetch');
	}

	const started_at = Date.now();
	const response = await http_json<OmnifetchResponse>(
		'omnifetch',
		`${OMNIFETCH_ENDPOINT}/web_fetch`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ url }),
			signal: make_signal(OMNIFETCH_TIMEOUT_MS, signal),
		},
	);

	const result: OmnifetchResult = {
		url: response.url ?? url,
		title: response.title ?? '',
		content: response.content ?? '',
		source_provider: response.source_provider ?? 'omnifetch',
		total_duration_ms: response.total_duration_ms ?? (Date.now() - started_at),
		...(response.metadata ? { metadata: response.metadata } : {}),
	};

	logger.info('omnifetch fetch completed', {
		op: 'omnifetch_complete',
		source_provider: result.source_provider,
		total_duration_ms: result.total_duration_ms,
		content_length: result.content.length,
	});

	return result;
};
