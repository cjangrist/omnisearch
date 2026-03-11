// Common utility functions for the MCP Omnisearch server

import pRetry from 'p-retry';
import { ErrorType, ProviderError } from './types.js';

const normalize_api_key = (raw: string): string => {
	const trimmed = raw.trim();
	return trimmed.replace(/^(['"])(.*)\1$/, '$2');
};

export const validate_api_key = (
	key: string | undefined,
	provider: string,
): string => {
	if (!key) {
		throw new ProviderError(
			ErrorType.INVALID_INPUT,
			`API key not found for ${provider}`,
			provider,
		);
	}
	return normalize_api_key(key);
};

export const handle_rate_limit = (
	provider: string,
	reset_time?: Date,
): never => {
	throw new ProviderError(
		ErrorType.RATE_LIMIT,
		`Rate limit exceeded for ${provider}${
			reset_time ? `. Reset at ${reset_time.toISOString()}` : ''
		}`,
		provider,
		{ reset_time },
	);
};

export function handle_provider_error(
	error: unknown,
	provider_name: string,
	operation: string = 'operation',
): never {
	if (error instanceof ProviderError) {
		throw error;
	}
	const error_message =
		error instanceof Error
			? error.message
			: typeof error === 'string'
				? error
				: JSON.stringify(error);
	const original = new Error(error_message);
	if (error instanceof Error && error.stack) {
		original.stack = error.stack;
	}
	const provider_error = new ProviderError(
		ErrorType.API_ERROR,
		`Failed to ${operation}: ${original.message}`,
		provider_name,
	);
	if (original.stack) {
		provider_error.stack = `${provider_error.stack}\nCaused by: ${original.stack}`;
	}
	throw provider_error;
}

export const create_error_response = (
	error: Error,
): { error: string } => {
	if (error instanceof ProviderError) {
		return {
			error: `${error.provider} error: ${error.message}`,
		};
	}
	return {
		error: `Unexpected error: ${error.message}`,
	};
};

export const retry_with_backoff = async <T>(
	fn: () => Promise<T>,
	max_retries: number = 3,
): Promise<T> => {
	return pRetry(fn, {
		retries: max_retries,
		minTimeout: 2000,
		maxTimeout: 5000,
		randomize: true,
		shouldRetry: (error: unknown) => {
			if (error instanceof ProviderError) {
				// Only retry transient provider errors — never auth, rate limit, or bad input
				return error.type === ErrorType.PROVIDER_ERROR;
			}
			// Network errors (TypeError from fetch), timeouts, etc. are retryable
			return true;
		},
	});
};
