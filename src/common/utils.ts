// Common utility functions for the MCP Omnisearch server

import pRetry from 'p-retry';
import { ErrorType, ProviderError } from './types.js';

// Combine an external abort signal with a provider-level timeout into a single signal.
// Returns the combined signal, or just the timeout if no external signal is provided.
export const make_signal = (timeout_ms: number, external?: AbortSignal): AbortSignal =>
	external
		? AbortSignal.any([external, AbortSignal.timeout(timeout_ms)])
		: AbortSignal.timeout(timeout_ms);

export const timing_safe_equal = (a: string, b: string): boolean => {
	const encoder = new TextEncoder();
	const a_buf = encoder.encode(a);
	const b_buf = encoder.encode(b);
	if (a_buf.byteLength !== b_buf.byteLength) return false;
	return crypto.subtle.timingSafeEqual(a_buf, b_buf);
};

export const sanitize_for_log = (s: string): string =>
	s.replace(/[\x00-\x1F\x7F]/g, '').slice(0, 200);

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

export interface RetryOptions {
	max_retries?: number;
	min_timeout_ms?: number;
	max_timeout_ms?: number;
}

export const retry_with_backoff = async <T>(
	fn: () => Promise<T>,
	options?: number | RetryOptions,
): Promise<T> => {
	// Accept legacy (number) or new (options object) signature
	const opts: RetryOptions = typeof options === 'number'
		? { max_retries: options }
		: options ?? {};

	return pRetry(fn, {
		retries: opts.max_retries ?? 3,
		minTimeout: opts.min_timeout_ms ?? 2000,
		maxTimeout: opts.max_timeout_ms ?? 5000,
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
