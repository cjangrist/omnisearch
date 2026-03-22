// Fetch orchestrator: tiered waterfall with parallel groups and domain breakers
//
// Flow:
//   1. Check domain breakers in order (youtube→supadata, social→sociavault)
//   2. Walk waterfall steps top-to-bottom (tavily first, then firecrawl, etc.)
//   3. Return first good result; throw if all providers exhausted
//
// Config: config.yaml (source of truth) — keep the const below in sync.

import type { FetchResult } from '../common/types.js';
import { ErrorType, ProviderError } from '../common/types.js';
import { loggers } from '../common/logger.js';
import {
	type FetchProviderName,
	type UnifiedFetchProvider,
	get_active_fetch_providers,
} from '../providers/unified/fetch.js';
import { kv_cache } from '../config/env.js';

const logger = loggers.fetch();

const KV_FETCH_TTL_SECONDS = 86_400; // 24 hours
const KV_FETCH_PREFIX = 'fetch:';

const get_fetch_cached = async (url: string): Promise<FetchRaceResult | undefined> => {
	if (!kv_cache) return undefined;
	try {
		return await kv_cache.get(KV_FETCH_PREFIX + url, 'json') as FetchRaceResult | undefined;
	} catch {
		return undefined;
	}
};

const set_fetch_cached = (url: string, result: FetchRaceResult): void => {
	if (!kv_cache) return;
	kv_cache.put(KV_FETCH_PREFIX + url, JSON.stringify(result), { expirationTtl: KV_FETCH_TTL_SECONDS })
		.catch((err) => logger.warn('KV fetch cache write failed', { op: 'kv_write_error', error: err instanceof Error ? err.message : String(err) }));
};

// ── Config (runtime mirror of config.yaml) ───────────────────────

type WaterfallStep =
	| { solo: string }
	| { parallel: string[] }
	| { sequential: string[] };

interface BreakerConfig {
	provider: string;
	domains: string[];
}

const CONFIG = {
	breakers: {
		youtube: {
			provider: 'supadata',
			domains: ['youtube.com', 'youtu.be'],
		},
		social_media: {
			provider: 'sociavault',
			domains: [
				'tiktok.com', 'instagram.com', 'youtube.com', 'youtu.be',
				'linkedin.com', 'facebook.com', 'fb.com',
				'twitter.com', 'x.com', 'pinterest.com',
				'reddit.com', 'threads.net', 'snapchat.com',
			],
		},
	} as Record<string, BreakerConfig>,

	waterfall: [
		{ solo: 'tavily' },
		{ solo: 'firecrawl' },
		{ parallel: ['linkup', 'cloudflare_browser'] },
		{ parallel: ['diffbot', 'olostep'] },
		{ parallel: ['scrapfly', 'scrapedo', 'decodo'] },
		{ solo: 'zyte' },
		{ solo: 'brightdata' },
		{
			sequential: [
				'jina', 'spider', 'you', 'scrapeless',
				'scrapingbee', 'scrapegraphai', 'scrappey', 'scrapingant',
				'oxylabs', 'scraperapi', 'leadmagic', 'opengraph',
			],
		},
	] as WaterfallStep[],

	failure: {
		min_content_chars: 200,
		challenge_patterns: [
			'cf-browser-verification', 'challenge-platform', 'captcha',
			'just a moment', 'ray id', 'checking your browser', 'access denied',
			'enable javascript and cookies', 'please turn javascript on', 'one more step',
			'[Chrome](https://www.google.com/chrome/',
			'does not have access to this endpoint',
		],
	},
};

// ── Types ────────────────────────────────────────────────────────

export interface FetchRaceResult {
	total_duration_ms: number;
	provider_used: string;
	providers_attempted: string[];
	providers_failed: Array<{ provider: string; error: string; duration_ms: number }>;
	result: FetchResult;
}

// ── Failure detection ────────────────────────────────────────────

const is_fetch_failure = (result: FetchResult): boolean => {
	if (!result.content || result.content.length < CONFIG.failure.min_content_chars) {
		return true;
	}
	const lower = result.content.toLowerCase();
	return CONFIG.failure.challenge_patterns.some((p) => lower.includes(p.toLowerCase()));
};

// ── Domain breaker detection ─────────────────────────────────────

const matches_breaker = (url: string, breaker: BreakerConfig): boolean => {
	try {
		const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
		return breaker.domains.some(
			(d) => hostname === d || hostname.endsWith(`.${d}`),
		);
	} catch {
		return false;
	}
};

// ── Single-provider attempt ──────────────────────────────────────

const try_provider = async (
	unified: UnifiedFetchProvider,
	url: string,
	provider: string,
): Promise<FetchResult> => {
	const result = await unified.fetch_url(url, provider as FetchProviderName);
	if (is_fetch_failure(result)) {
		throw new ProviderError(
			ErrorType.PROVIDER_ERROR,
			`Blocked or empty (${result.content?.length ?? 0} chars)`,
			provider,
		);
	}
	return result;
};

// ── Step executors ───────────────────────────────────────────────

interface StepContext {
	unified: UnifiedFetchProvider;
	url: string;
	active: Set<string>;
	attempted: string[];
	failed: Array<{ provider: string; error: string; duration_ms: number }>;
}

const run_solo = async (ctx: StepContext, provider: string): Promise<FetchResult | undefined> => {
	if (!ctx.active.has(provider)) return undefined;
	ctx.attempted.push(provider);
	const t0 = Date.now();
	try {
		return await try_provider(ctx.unified, ctx.url, provider);
	} catch (error) {
		ctx.failed.push({
			provider,
			error: error instanceof Error ? error.message : String(error),
			duration_ms: Date.now() - t0,
		});
		return undefined;
	}
};

const run_parallel = async (
	ctx: StepContext,
	providers: string[],
): Promise<{ provider: string; result: FetchResult } | undefined> => {
	const available = providers.filter((p) => ctx.active.has(p));
	if (available.length === 0) return undefined;

	ctx.attempted.push(...available);

	// Race providers — return the first success instead of waiting for all.
	// Each provider promise individually tracks its own failure for logging.
	const promises = available.map((p) => {
		const t0 = Date.now();
		return try_provider(ctx.unified, ctx.url, p)
			.then((r) => ({ provider: p, result: r }))
			.catch((error) => {
				ctx.failed.push({
					provider: p,
					error: error instanceof Error ? error.message : String(error),
					duration_ms: Date.now() - t0,
				});
				throw error; // re-throw so Promise.any skips it
			});
	});

	try {
		return await Promise.any(promises);
	} catch {
		// AggregateError — all providers failed (individual errors already in ctx.failed)
		logger.debug('All parallel providers failed', {
			op: 'parallel_all_failed',
			providers: available,
			url: ctx.url.slice(0, 200),
		});
		return undefined;
	}
};

const run_sequential = async (
	ctx: StepContext,
	providers: string[],
): Promise<{ provider: string; result: FetchResult } | undefined> => {
	for (const provider of providers) {
		if (!ctx.active.has(provider)) continue;
		ctx.attempted.push(provider);
		const t0 = Date.now();
		try {
			const result = await try_provider(ctx.unified, ctx.url, provider);
			return { provider, result };
		} catch (error) {
			ctx.failed.push({
				provider,
				error: error instanceof Error ? error.message : String(error),
				duration_ms: Date.now() - t0,
			});
		}
	}
	return undefined;
};

const execute_step = async (
	ctx: StepContext,
	step: WaterfallStep,
): Promise<{ provider: string; result: FetchResult } | undefined> => {
	if ('solo' in step) {
		const result = await run_solo(ctx, step.solo);
		return result ? { provider: step.solo, result } : undefined;
	}
	if ('parallel' in step) {
		return run_parallel(ctx, step.parallel);
	}
	if ('sequential' in step) {
		return run_sequential(ctx, step.sequential);
	}
	return undefined;
};

// ── Build result helper ──────────────────────────────────────────

const build_result = (
	start_time: number,
	provider: string,
	result: FetchResult,
	attempted: string[],
	failed: Array<{ provider: string; error: string; duration_ms: number }>,
): FetchRaceResult => ({
	total_duration_ms: Date.now() - start_time,
	provider_used: provider,
	providers_attempted: attempted,
	providers_failed: failed,
	result,
});

// ── Main entry point ─────────────────────────────────────────────

export const run_fetch_race = async (
	fetch_provider: UnifiedFetchProvider,
	url: string,
	options?: { provider?: FetchProviderName },
): Promise<FetchRaceResult> => {
	const start_time = Date.now();
	const attempted: string[] = [];
	const failed: Array<{ provider: string; error: string; duration_ms: number }> = [];

	// Check KV cache first (skip for explicit provider mode — user wants a specific provider)
	if (!options?.provider) {
		const cached = await get_fetch_cached(url);
		if (cached) {
			logger.debug('Returning cached fetch result', { op: 'fetch_cache_hit', url: url.slice(0, 200), provider: cached.provider_used });
			return cached;
		}
	}

	// Explicit provider mode (no waterfall) — still validate against challenge/empty detection
	if (options?.provider) {
		const provider = options.provider;
		attempted.push(provider);
		logger.info('Fetch with explicit provider', {
			op: 'fetch_explicit',
			provider,
			url: url.slice(0, 200),
		});
		const result = await fetch_provider.fetch_url(url, provider);
		if (is_fetch_failure(result)) {
			logger.warn('Explicit provider returned blocked/empty content', {
				op: 'fetch_explicit_failure',
				provider,
				content_length: result.content?.length ?? 0,
			});
		}
		return build_result(start_time, provider, result, attempted, failed);
	}

	// Auto waterfall mode
	logger.info('Waterfall start', { op: 'waterfall_start', url: url.slice(0, 200) });

	// Helper: build result and cache it for future requests
	const build_and_cache = (provider: string, result: FetchResult): FetchRaceResult => {
		const race_result = build_result(start_time, provider, result, attempted, failed);
		set_fetch_cached(url, race_result); // fire-and-forget
		return race_result;
	};

	const active = new Set(get_active_fetch_providers().map((p) => p.name));
	const ctx: StepContext = { unified: fetch_provider, url, active, attempted, failed };

	// Breakers: domain-specific providers tried before the waterfall
	for (const [breaker_name, breaker_config] of Object.entries(CONFIG.breakers)) {
		if (matches_breaker(url, breaker_config) && active.has(breaker_config.provider)) {
			logger.info('Breaker matched', {
				op: 'breaker_match',
				breaker: breaker_name,
				provider: breaker_config.provider,
				url: url.slice(0, 200),
			});
			const breaker_result = await run_solo(ctx, breaker_config.provider);
			if (breaker_result) {
				return build_and_cache(breaker_config.provider, breaker_result);
			}
			logger.warn('Breaker failed, continuing', { op: 'breaker_fallthrough', breaker: breaker_name });
		}
	}

	// Waterfall: walk steps top-to-bottom
	for (const step of CONFIG.waterfall) {
		const step_result = await execute_step(ctx, step);
		if (step_result) {
			logger.info('Waterfall resolved', {
				op: 'waterfall_done',
				provider: step_result.provider,
				steps_tried: attempted.length,
				total_ms: Date.now() - start_time,
			});
			return build_and_cache(step_result.provider, step_result.result);
		}
	}

	// All exhausted
	logger.error('Waterfall exhausted', {
		op: 'waterfall_exhausted',
		attempted: attempted.join(', '),
		failed_count: failed.length,
		total_ms: Date.now() - start_time,
	});

	throw new ProviderError(
		ErrorType.PROVIDER_ERROR,
		`All providers failed for ${url.slice(0, 200)}. Tried: ${attempted.join(', ')}`,
		'waterfall',
	);
};
