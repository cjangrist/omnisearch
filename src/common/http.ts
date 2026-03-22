import { ErrorType, ProviderError } from './types.js';
import { loggers } from './logger.js';
import { handle_rate_limit } from './utils.js';

const logger = loggers.http();

interface HttpOptions extends RequestInit {
	expectedStatuses?: number[];
}

const tryParseJson = (text: string) => {
	if (!text) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
};

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB guard

const SENSITIVE_PARAMS = new Set(['api_key', 'key', 'token', 'app_id', 'x-api-key', 'apikey']);

// Redact sensitive query params before logging
const sanitize_url = (raw_url: string): string => {
	try {
		const u = new URL(raw_url);
		for (const key of u.searchParams.keys()) {
			if (SENSITIVE_PARAMS.has(key.toLowerCase())) {
				u.searchParams.set(key, '[REDACTED]');
			}
		}
		return u.toString().slice(0, 200);
	} catch {
		return raw_url.slice(0, 200);
	}
};

// Shared core: fetch + timing + size guard + error handling + logging
const http_core = async (
	provider: string,
	url: string,
	options: HttpOptions = {},
): Promise<{ raw: string; status: number }> => {
	const request_start = Date.now();
	logger.debug('HTTP request', {
		op: 'http_request',
		provider,
		method: options.method ?? 'GET',
		url: sanitize_url(url),
	});

	const res = await fetch(url, options);
	const content_length = parseInt(res.headers.get('content-length') ?? '0', 10) || 0;

	// Fast path: reject if content-length header exceeds limit
	if (content_length > MAX_RESPONSE_BYTES) {
		res.body?.cancel();
		throw new ProviderError(ErrorType.API_ERROR, `Response too large (${content_length} bytes)`, provider);
	}

	// Stream-read with byte counter to catch chunked-encoding responses that lie about
	// or omit content-length. Prevents OOM from unbounded res.text() on malicious payloads.
	let raw: string;
	let total_bytes = 0;
	if (res.body) {
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		const chunks: string[] = [];
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			total_bytes += value.byteLength;
			if (total_bytes > MAX_RESPONSE_BYTES) {
				reader.cancel();
				throw new ProviderError(ErrorType.API_ERROR, `Response too large (>${MAX_RESPONSE_BYTES} bytes, chunked)`, provider);
			}
			chunks.push(decoder.decode(value, { stream: true }));
		}
		chunks.push(decoder.decode()); // flush remaining
		raw = chunks.join('');
	} else {
		raw = '';
	}

	const okOrExpected =
		res.ok ||
		(options.expectedStatuses &&
			options.expectedStatuses.includes(res.status));

	if (!okOrExpected) {
		const body = tryParseJson(raw);
		const safe_message =
			(body && typeof (body.message || body.error || body.detail) === 'string')
				? (body.message || body.error || body.detail)
				: res.statusText;

		logger.warn('HTTP error response', {
			op: 'http_error',
			provider,
			status: res.status,
			status_text: res.statusText,
			message: safe_message.slice(0, 200),
		});

		switch (res.status) {
			case 401:
				throw new ProviderError(ErrorType.API_ERROR, 'Invalid API key', provider);
			case 403:
				throw new ProviderError(ErrorType.API_ERROR, 'API key does not have access to this endpoint', provider);
			case 429:
				handle_rate_limit(provider);
				break;
			default:
				if (res.status >= 500) {
					throw new ProviderError(ErrorType.PROVIDER_ERROR, `${provider} API internal error (${res.status}): ${safe_message}`, provider);
				}
				throw new ProviderError(ErrorType.API_ERROR, `${provider} error (${res.status}): ${safe_message}`, provider);
		}
	}

	const duration_ms = Date.now() - request_start;
	logger.info('HTTP response', {
		op: 'http_response',
		provider,
		status: res.status,
		duration_ms,
		content_length_bytes: total_bytes,
	});

	return { raw, status: res.status };
};

// Returns parsed JSON
export const http_json = async <T = unknown>(
	provider: string,
	url: string,
	options: HttpOptions = {},
): Promise<T> => {
	const { raw } = await http_core(provider, url, options);
	const body = tryParseJson(raw);
	if (body !== undefined) return body as T;
	throw new ProviderError(ErrorType.API_ERROR, `Invalid JSON response from ${provider}`, provider);
};

// Returns raw text (for providers that return HTML/markdown/plain text)
export const http_text = async (
	provider: string,
	url: string,
	options: HttpOptions = {},
): Promise<string> => {
	const { raw } = await http_core(provider, url, options);
	return raw;
};
