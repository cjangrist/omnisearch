import { ErrorType, ProviderError } from './types.js';
import { loggers } from './logger.js';
import { handle_rate_limit } from './utils.js';

const logger = loggers.http();

interface HttpJsonOptions extends RequestInit {
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

export const http_json = async <T = unknown>(
	provider: string,
	url: string,
	options: HttpJsonOptions = {},
): Promise<T> => {
	logger.debug('HTTP request', {
		op: 'http_request',
		provider,
		method: options.method ?? 'GET',
		url: url.slice(0, 200),
	});

	const res = await fetch(url, options);
	const content_length = parseInt(res.headers.get('content-length') ?? '0', 10) || 0;

	if (content_length > MAX_RESPONSE_BYTES) {
		logger.error('Response too large', {
			op: 'http_response',
			provider,
			content_length,
			max_size: MAX_RESPONSE_BYTES,
			status: res.status,
		});
		throw new ProviderError(ErrorType.API_ERROR, `Response too large (${content_length} bytes)`, provider);
	}

	const raw_full = await res.text();

	if (raw_full.length > MAX_RESPONSE_BYTES) {
		logger.error('Response too large', {
			op: 'http_response',
			provider,
			response_length: raw_full.length,
			max_size: MAX_RESPONSE_BYTES,
			status: res.status,
		});
		throw new ProviderError(ErrorType.API_ERROR, `Response too large (${raw_full.length} chars)`, provider);
	}

	const body = tryParseJson(raw_full);

	const okOrExpected =
		res.ok ||
		(options.expectedStatuses &&
			options.expectedStatuses.includes(res.status));

	if (!okOrExpected) {
		// Sanitize: only use structured error fields from JSON, never raw response body
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
				throw new ProviderError(
					ErrorType.API_ERROR,
					'Invalid API key',
					provider,
				);
			case 403:
				throw new ProviderError(
					ErrorType.API_ERROR,
					'API key does not have access to this endpoint',
					provider,
				);
			case 429:
				handle_rate_limit(provider);
				break; // handle_rate_limit always throws, but break for safety
			default:
				if (res.status >= 500) {
					throw new ProviderError(
						ErrorType.PROVIDER_ERROR,
						`${provider} API internal error (${res.status}): ${safe_message}`,
						provider,
					);
				}
				throw new ProviderError(
					ErrorType.API_ERROR,
					`${provider} error (${res.status}): ${safe_message}`,
					provider,
				);
		}
	}

	logger.debug('HTTP response received', {
		op: 'http_response',
		provider,
		status: res.status,
		content_length: raw_full.length,
	});

	if (body !== undefined) return body as T;
	throw new ProviderError(ErrorType.API_ERROR, `Invalid JSON response from ${provider}`, provider);
};
