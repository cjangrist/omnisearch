// Fetch orchestrator: tiered waterfall with parallel groups and domain breakers
//
// Flow:
//   1. Check domain breakers in order (youtube→supadata, social→sociavault)
//   2. Walk waterfall steps top-to-bottom (tavily first, then firecrawl, etc.)
//   3. Return first good result; throw if all providers exhausted
//
// Config: waterfall order, breakers, and failure heuristics are defined below.

import type { FetchResult } from '../common/types.js';
import { ErrorType, ProviderError } from '../common/types.js';
import { loggers } from '../common/logger.js';
import {
	type FetchProviderName,
	type UnifiedFetchProvider,
	get_active_fetch_providers,
} from '../providers/unified/fetch.js';
import { kv_cache } from '../config/env.js';
import { hash_key } from '../common/utils.js';
import { TraceContext, get_active_trace, run_with_trace } from '../common/r2_trace.js';

const logger = loggers.fetch();

const KV_FETCH_TTL_SECONDS = 129_600; // 36 hours

const get_fetch_cached = async (url: string): Promise<FetchRaceResult | undefined> => {
	if (!kv_cache) return undefined;
	try {
		const key = await hash_key('fetch:', url);
		return await kv_cache.get(key, 'json') as FetchRaceResult | undefined;
	} catch {
		return undefined;
	}
};

const set_fetch_cached = async (url: string, result: FetchRaceResult): Promise<void> => {
	if (!kv_cache) return;
	try {
		const key = await hash_key('fetch:', url);
		await kv_cache.put(key, JSON.stringify(result), { expirationTtl: KV_FETCH_TTL_SECONDS });
	} catch (err) {
		logger.warn('KV fetch cache write failed', { op: 'kv_write_error', error: err instanceof Error ? err.message : String(err) });
	}
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
			// Cloudflare / bot detection
			'cf-browser-verification', 'challenge-platform', 'captcha',
			'just a moment', 'ray id', 'checking your browser', 'access denied',
			'enable javascript and cookies', 'please turn javascript on', 'one more step',
			'[Chrome](https://www.google.com/chrome/',
			'does not have access to this endpoint',
			// Paywall / login walls
			'subscribe to continue reading',
			'you\'ve reached your limit of free articles',
			'create a free account to continue',
			'sign in to continue',
			'this content is for subscribers',
			'to read the full story',
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
	const trace = get_active_trace();
	trace?.record_provider_start(provider, { url: ctx.url });
	try {
		const result = await try_provider(ctx.unified, ctx.url, provider);
		trace?.record_provider_complete(provider, result, Date.now() - t0);
		return result;
	} catch (error) {
		const duration_ms = Date.now() - t0;
		const error_msg = error instanceof Error ? error.message : String(error);
		ctx.failed.push({ provider, error: error_msg, duration_ms });
		trace?.record_provider_error(provider, error_msg, duration_ms);
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
	const trace = get_active_trace();

	// Race providers — return the first success, cancel losers.
	// resolved flag prevents loser .catch() from mutating ctx.failed after winner returns.
	let resolved = false;

	const promises = available.map((p) => {
		const t0 = Date.now();
		trace?.record_provider_start(p, { url: ctx.url });
		return try_provider(ctx.unified, ctx.url, p)
			.then((r) => {
				trace?.record_provider_complete(p, r, Date.now() - t0);
				return { provider: p, result: r };
			})
			.catch((error) => {
				const duration_ms = Date.now() - t0;
				const error_msg = error instanceof Error ? error.message : String(error);
				if (!resolved) {
					ctx.failed.push({ provider: p, error: error_msg, duration_ms });
				}
				trace?.record_provider_error(p, error_msg, duration_ms);
				throw error; // re-throw so Promise.any skips it
			});
	});

	try {
		const winner = await Promise.any(promises);
		resolved = true;
		return winner;
	} catch {
		// AggregateError — all providers failed (individual errors already in ctx.failed)
		resolved = true;
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
	const trace = get_active_trace();
	for (const provider of providers) {
		if (!ctx.active.has(provider)) continue;
		ctx.attempted.push(provider);
		const t0 = Date.now();
		trace?.record_provider_start(provider, { url: ctx.url });
		try {
			const result = await try_provider(ctx.unified, ctx.url, provider);
			trace?.record_provider_complete(provider, result, Date.now() - t0);
			return { provider, result };
		} catch (error) {
			const duration_ms = Date.now() - t0;
			const error_msg = error instanceof Error ? error.message : String(error);
			ctx.failed.push({ provider, error: error_msg, duration_ms });
			trace?.record_provider_error(provider, error_msg, duration_ms);
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

// ── Waterfall collect (for cleanup — walk waterfall, collect N winners) ──
// Same cheap-to-expensive ordering as run_fetch_race, but doesn't stop at 1.
// Keeps walking the waterfall until it has `target_count` successes or exhausts all steps.

export interface WaterfallVersion {
	provider: string;
	content: string;
	title: string;
	url: string;
}

export const run_fetch_waterfall_collect = async (
	fetch_provider: UnifiedFetchProvider,
	url: string,
	target_count: number = 3,
): Promise<WaterfallVersion[]> => {
	const active = new Set(get_active_fetch_providers().map((p) => p.name));
	if (active.size === 0) return [];

	const versions: WaterfallVersion[] = [];
	const seen = new Set<string>();

	const try_and_collect = async (provider: string): Promise<boolean> => {
		if (!active.has(provider) || seen.has(provider)) return false;
		seen.add(provider);
		try {
			const result = await fetch_provider.fetch_url(url, provider as FetchProviderName);
			if (is_fetch_failure(result)) return false;
			versions.push({ provider, content: result.content, title: result.title, url: result.url });
			return true;
		} catch {
			return false;
		}
	};

	// Breakers first (domain-specific providers)
	for (const breaker of Object.values(CONFIG.breakers)) {
		if (versions.length >= target_count) break;
		if (matches_breaker(url, breaker)) {
			await try_and_collect(breaker.provider);
		}
	}

	// Walk waterfall steps in order
	for (const step of CONFIG.waterfall) {
		if (versions.length >= target_count) break;

		if ('solo' in step) {
			await try_and_collect(step.solo);
		} else if ('parallel' in step) {
			// Race the parallel group, collect winners
			const available = step.parallel.filter((p) => active.has(p) && !seen.has(p));
			if (available.length > 0) {
				available.forEach((p) => seen.add(p));
				const results = await Promise.all(
					available.map(async (p): Promise<WaterfallVersion | undefined> => {
						try {
							const result = await fetch_provider.fetch_url(url, p as FetchProviderName);
							if (is_fetch_failure(result)) return undefined;
							return { provider: p, content: result.content, title: result.title, url: result.url };
						} catch {
							return undefined;
						}
					}),
				);
				for (const r of results) {
					if (r && versions.length < target_count) versions.push(r);
				}
			}
		} else if ('sequential' in step) {
			for (const p of step.sequential) {
				if (versions.length >= target_count) break;
				await try_and_collect(p);
			}
		}
	}

	logger.info('Waterfall collect complete', {
		op: 'waterfall_collect_done',
		url: url.slice(0, 200),
		target: target_count,
		collected: versions.length,
		providers: versions.map((v) => v.provider),
	});

	return versions;
};

// ── Main entry point ─────────────────────────────────────────────

export const run_fetch_race = async (
	fetch_provider: UnifiedFetchProvider,
	url: string,
	options?: { provider?: FetchProviderName },
): Promise<FetchRaceResult> => {
	const trace = new TraceContext(crypto.randomUUID(), 'fetch');
	trace.set_strategy(options?.provider ? 'explicit_provider' : 'waterfall');
	trace.request_environment = { url, explicit_provider: options?.provider ?? null };

	return run_with_trace(trace, async () => {
		const start_time = Date.now();
		const attempted: string[] = [];
		const failed: Array<{ provider: string; error: string; duration_ms: number }> = [];

		// Check KV cache first (skip for explicit provider mode — user wants a specific provider)
		if (!options?.provider) {
			const cached = await get_fetch_cached(url);
			if (cached) {
				logger.debug('Returning cached fetch result', { op: 'fetch_cache_hit', url: url.slice(0, 200), provider: cached.provider_used });
				trace.cache_hit = true;
				trace.record_decision('cache_hit', { url: url.slice(0, 200), provider_used: cached.provider_used });
				trace.flush_background(cached);
				return cached;
			}
		}

		// Explicit provider mode (no waterfall) — still validate against challenge/empty detection
		if (options?.provider) {
			const provider = options.provider;
			attempted.push(provider);
			trace.set_active_providers([provider]);
			trace.record_provider_start(provider, { url });
			logger.info('Fetch with explicit provider', {
				op: 'fetch_explicit',
				provider,
				url: url.slice(0, 200),
			});
			const result = await fetch_provider.fetch_url(url, provider);
			if (is_fetch_failure(result)) {
				const error_msg = `${provider} returned blocked or empty content (${result.content?.length ?? 0} chars)`;
				trace.record_provider_error(provider, error_msg, Date.now() - start_time);
				trace.flush_background({ error: error_msg });
				throw new ProviderError(ErrorType.PROVIDER_ERROR, error_msg, provider);
			}
			trace.record_provider_complete(provider, result, Date.now() - start_time);
			const race_result = build_result(start_time, provider, result, attempted, failed);
			trace.flush_background(race_result);
			return race_result;
		}

		// Auto waterfall mode
		logger.info('Waterfall start', { op: 'waterfall_start', url: url.slice(0, 200) });

		const active = new Set(get_active_fetch_providers().map((p) => p.name));
		trace.set_active_providers(Array.from(active));
		trace.record_decision('waterfall_start', { active_providers: Array.from(active), url: url.slice(0, 200) });

		// Helper: build result and cache it for future requests
		const build_and_cache = async (provider: string, result: FetchResult): Promise<FetchRaceResult> => {
			const race_result = build_result(start_time, provider, result, attempted, failed);
			await set_fetch_cached(url, race_result);
			return race_result;
		};

		const ctx: StepContext = { unified: fetch_provider, url, active, attempted, failed };

		// Breakers: domain-specific providers tried before the waterfall
		for (const [breaker_name, breaker_config] of Object.entries(CONFIG.breakers)) {
			if (matches_breaker(url, breaker_config) && active.has(breaker_config.provider)) {
				trace.record_decision('breaker_match', { breaker: breaker_name, provider: breaker_config.provider });
				logger.info('Breaker matched', {
					op: 'breaker_match',
					breaker: breaker_name,
					provider: breaker_config.provider,
					url: url.slice(0, 200),
				});
				const breaker_result = await run_solo(ctx, breaker_config.provider);
				if (breaker_result) {
					trace.record_decision('breaker_resolved', { breaker: breaker_name, provider: breaker_config.provider });
					const race_result = await build_and_cache(breaker_config.provider, breaker_result);
					trace.flush_background(race_result);
					return race_result;
				}
				trace.record_decision('breaker_fallthrough', { breaker: breaker_name });
				logger.warn('Breaker failed, continuing', { op: 'breaker_fallthrough', breaker: breaker_name });
			}
		}

		// Waterfall: walk steps top-to-bottom
		for (const step of CONFIG.waterfall) {
			const step_label = 'solo' in step ? `solo:${step.solo}` : 'parallel' in step ? `parallel:${step.parallel.join(',')}` : `sequential:${(step as { sequential: string[] }).sequential.join(',')}`;
			trace.record_decision('waterfall_step', { step: step_label });

			const step_result = await execute_step(ctx, step);
			if (step_result) {
				trace.record_decision('waterfall_resolved', {
					provider: step_result.provider,
					steps_tried: attempted.length,
					total_ms: Date.now() - start_time,
				});
				logger.info('Waterfall resolved', {
					op: 'waterfall_done',
					provider: step_result.provider,
					steps_tried: attempted.length,
					total_ms: Date.now() - start_time,
				});
				const race_result = await build_and_cache(step_result.provider, step_result.result);
				trace.flush_background(race_result);
				return race_result;
			}
		}

		// All exhausted
		trace.record_decision('waterfall_exhausted', {
			attempted: attempted,
			failed_count: failed.length,
			total_ms: Date.now() - start_time,
		});

		logger.error('Waterfall exhausted', {
			op: 'waterfall_exhausted',
			attempted: attempted.join(', '),
			failed_count: failed.length,
			total_ms: Date.now() - start_time,
		});

		trace.flush_background({ error: 'all_providers_failed', attempted, failed });

		throw new ProviderError(
			ErrorType.PROVIDER_ERROR,
			`All providers failed for ${url.slice(0, 200)}. Tried: ${attempted.join(', ')}`,
			'waterfall',
		);
	});
};
