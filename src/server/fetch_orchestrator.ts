// Fetch orchestrator: dispatches to a single provider (default: tavily) with retry

import type { FetchResult } from '../common/types.js';
import { loggers } from '../common/logger.js';
import { retry_with_backoff } from '../common/utils.js';
import { config } from '../config/env.js';
import {
	type FetchProviderName,
	type UnifiedFetchProvider,
} from '../providers/unified/fetch.js';

const logger = loggers.fetch();

export interface FetchRaceResult {
	total_duration_ms: number;
	provider_used: string;
	providers_attempted: string[];
	providers_failed: Array<{ provider: string; error: string; duration_ms: number }>;
	result: FetchResult;
}

const DEFAULT_PROVIDER: FetchProviderName = 'tavily';

export const run_fetch_race = async (
	fetch_provider: UnifiedFetchProvider,
	url: string,
	options?: { provider?: FetchProviderName },
): Promise<FetchRaceResult> => {
	const start_time = Date.now();
	const provider = options?.provider ?? DEFAULT_PROVIDER;
	const { max_retries, min_timeout_ms, max_timeout_ms } = config.fetch_retry;

	logger.info('Fetching URL', {
		op: 'fetch',
		provider,
		url: url.slice(0, 200),
		max_retries,
	});

	let attempt = 0;
	const result = await retry_with_backoff(
		() => {
			attempt++;
			if (attempt > 1) {
				logger.warn('Retrying fetch', {
					op: 'fetch_retry',
					provider,
					attempt,
					elapsed_ms: Date.now() - start_time,
				});
			}
			return fetch_provider.fetch_url(url, provider);
		},
		{ max_retries, min_timeout_ms, max_timeout_ms },
	);

	const total_duration_ms = Date.now() - start_time;
	logger.info('Fetch complete', {
		op: 'fetch_complete',
		provider,
		attempts: attempt,
		total_duration_ms,
	});

	return {
		total_duration_ms,
		provider_used: provider,
		providers_attempted: [provider],
		providers_failed: [],
		result,
	};
};
