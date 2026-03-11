import { ErrorType, ProviderError } from './types.js';
import { handle_rate_limit } from './utils.js';

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
	const res = await fetch(url, options);
	const content_length = parseInt(res.headers.get('content-length') ?? '0', 10) || 0;
	if (content_length > MAX_RESPONSE_BYTES) {
		throw new ProviderError(ErrorType.API_ERROR, `Response too large (${content_length} bytes)`, provider);
	}
	const raw_full = await res.text();
	if (raw_full.length > MAX_RESPONSE_BYTES) {
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

	if (body !== undefined) return body as T;
	throw new ProviderError(ErrorType.API_ERROR, `Invalid JSON response from ${provider}`, provider);
};
