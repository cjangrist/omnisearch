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
		github: {
			provider: 'github',
			domains: ['github.com', 'gist.github.com', 'raw.githubusercontent.com'],
		},
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
		{ solo: 'kimi' },
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
	alternative_results?: Array<{ provider: string; result: FetchResult }>;
}

// ── Failure detection ────────────────────────────────────────────

// API-native providers return structured data, not scraped HTML.
// Challenge-pattern detection (Cloudflare, captcha, etc.) causes false positives
// when docs legitimately mention "access denied", "captcha", etc.
const API_NATIVE_PROVIDERS = new Set(['github', 'supadata']);

const is_fetch_failure = (result: FetchResult, provider?: string): boolean => {
	if (!result.content || result.content.length < CONFIG.failure.min_content_chars) {
		return true;
	}
	if (provider && API_NATIVE_PROVIDERS.has(provider)) return false;
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
	if (is_fetch_failure(result, provider)) {
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

// ── Skip-providers parser ───────────────────────────────────────
// Accepts whatever the LLM sends: JSON array, comma string, bracketed
// string, quoted variants, single string, null/undefined → string[].
// Non-string array entries (numbers, objects, null, undefined, Symbol)
// are dropped rather than coerced — the prior `String(v)` produced
// "null", "undefined", "42", "[object Object]" which then survived
// filter(Boolean) and silently flipped has_skip_providers true.

export const parse_skip_providers = (raw: unknown): string[] => {
	if (raw == null) return [];
	if (Array.isArray(raw)) {
		return raw
			.filter((v): v is string => typeof v === 'string')
			.map((v) => v.trim().toLowerCase())
			.filter(Boolean);
	}
	if (typeof raw !== 'string') return [];
	const str = raw.trim();
	if (!str) return [];
	// Strip surrounding brackets and quotes: "[\"tavily\", \"firecrawl\"]" → tavily, firecrawl
	const stripped = str.replace(/^\[|\]$/g, '').replace(/"/g, '').replace(/'/g, '');
	return stripped.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
};

// Intersect parsed skip names with currently-active providers.
// Returns { valid: known names that will actually be skipped, unknown: typos/garbage }.
// Callers should reject (REST 400 / MCP error) when unknown.length > 0 so a typo
// like "tavly" doesn't silently flip has_skip_providers true and trigger
// dual-fetch + cache bypass without actually skipping anything.
export const validate_skip_providers = (parsed: string[]): { valid: string[]; unknown: string[] } => {
	const known = new Set(get_active_fetch_providers().map((p) => p.name));
	const valid: string[] = [];
	const unknown: string[] = [];
	for (const name of parsed) {
		if (known.has(name)) valid.push(name);
		else unknown.push(name);
	}
	return { valid, unknown };
};

// ── Main entry point ─────────────────────────────────────────────

export const run_fetch_race = async (
	fetch_provider: UnifiedFetchProvider,
	url: string,
	options?: { provider?: FetchProviderName; skip_cache?: boolean; skip_providers?: string[] },
): Promise<FetchRaceResult> => {
	const trace = new TraceContext(crypto.randomUUID(), 'fetch');
	trace.set_strategy(options?.provider ? 'explicit_provider' : 'waterfall');
	trace.request_environment = { url, explicit_provider: options?.provider ?? null };

	return run_with_trace(trace, async () => {
		const start_time = Date.now();
		const attempted: string[] = [];
		const failed: Array<{ provider: string; error: string; duration_ms: number }> = [];

		// Defense-in-depth: drop any unknown names that slipped past callers.
		// Callers (REST, MCP) should already have rejected requests with unknown
		// names — this is the safety net. Compute has_skip_providers from the
		// validated set so garbage-only inputs (e.g. "tavly") don't flip it true.
		const skip_validated = validate_skip_providers(options?.skip_providers ?? []);
		if (skip_validated.unknown.length > 0) {
			logger.warn('Dropping unknown skip_providers names', {
				op: 'skip_providers_validation',
				unknown: skip_validated.unknown,
			});
		}
		const effective_skip = skip_validated.valid;

		// Check KV cache first (skip for explicit provider mode, skip_cache flag, or skip_providers)
		const has_skip_providers = effective_skip.length > 0;
		if (!options?.provider && !options?.skip_cache && !has_skip_providers) {
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
			if (is_fetch_failure(result, provider)) {
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

		const skip_set = new Set(effective_skip);
		const active = new Set(get_active_fetch_providers().map((p) => p.name).filter((n) => !skip_set.has(n)));
		trace.set_active_providers(Array.from(active));
		trace.record_decision('waterfall_start', { active_providers: Array.from(active), skipped_providers: Array.from(skip_set), url: url.slice(0, 200) });

		// Helper: build result and cache it for future requests.
		// Skip the write when skip_providers is active — caller asked us to bypass
		// specific providers, and the resulting shape (e.g. dual-fetch with
		// alternative_results) would mislead future cache hits that did not.
		const build_and_cache = async (provider: string, result: FetchResult): Promise<FetchRaceResult> => {
			const race_result = build_result(start_time, provider, result, attempted, failed);
			if (!has_skip_providers) {
				await set_fetch_cached(url, race_result);
			}
			return race_result;
		};

		const ctx: StepContext = { unified: fetch_provider, url, active, attempted, failed };

		// When skip_providers is used we know the page is tricky — proactively
		// fetch from TWO providers so the caller can compare results.
		const target_count = has_skip_providers ? 2 : 1;
		const winners: Array<{ provider: string; result: FetchResult }> = [];

		// Breakers: domain-specific providers tried before the waterfall
		for (const [breaker_name, breaker_config] of Object.entries(CONFIG.breakers)) {
			if (winners.length >= target_count) break;
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
					winners.push({ provider: breaker_config.provider, result: breaker_result });
				} else {
					trace.record_decision('breaker_fallthrough', { breaker: breaker_name });
					logger.warn('Breaker failed, continuing', { op: 'breaker_fallthrough', breaker: breaker_name });
				}
			}
		}

		// Waterfall: walk steps top-to-bottom
		for (const step of CONFIG.waterfall) {
			if (winners.length >= target_count) break;
			const step_label = 'solo' in step ? `solo:${step.solo}` : 'parallel' in step ? `parallel:${step.parallel.join(',')}` : `sequential:${(step as { sequential: string[] }).sequential.join(',')}`;
			trace.record_decision('waterfall_step', { step: step_label });

			const step_result = await execute_step(ctx, step);
			if (step_result) {
				winners.push(step_result);
			}
		}

		// Return collected results
		if (winners.length > 0) {
			const primary = winners[0];
			trace.record_decision('waterfall_resolved', {
				provider: primary.provider,
				steps_tried: attempted.length,
				total_ms: Date.now() - start_time,
				alternative_count: winners.length - 1,
			});
			logger.info('Waterfall resolved', {
				op: 'waterfall_done',
				provider: primary.provider,
				steps_tried: attempted.length,
				total_ms: Date.now() - start_time,
				alternative_count: winners.length - 1,
			});
			const race_result = await build_and_cache(primary.provider, primary.result);
			if (winners.length > 1) {
				race_result.alternative_results = winners.slice(1);
			}
			trace.flush_background(race_result);
			return race_result;
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
