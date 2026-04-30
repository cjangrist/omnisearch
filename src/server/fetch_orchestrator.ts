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

const is_valid_cached_fetch = (raw: unknown): raw is FetchRaceResult => {
	if (!raw || typeof raw !== 'object') return false;
	const r = raw as Record<string, unknown>;
	if (typeof r.provider_used !== 'string') return false;
	if (typeof r.total_duration_ms !== 'number') return false;
	if (!Array.isArray(r.providers_attempted)) return false;
	if (!r.providers_attempted.every((s) => typeof s === 'string')) return false;
	if (!Array.isArray(r.providers_failed)) return false;
	if (!r.providers_failed.every((f) =>
		f && typeof f === 'object' &&
		typeof (f as Record<string, unknown>).provider === 'string' &&
		typeof (f as Record<string, unknown>).error === 'string' &&
		typeof (f as Record<string, unknown>).duration_ms === 'number'
	)) return false;
	if (!r.result || typeof r.result !== 'object') return false;
	const result = r.result as Record<string, unknown>;
	if (typeof result.url !== 'string') return false;
	if (typeof result.title !== 'string') return false;
	if (typeof result.content !== 'string') return false;
	// alternative_results is optional, but if present must be an array of correct shape
	if (r.alternative_results !== undefined) {
		if (!Array.isArray(r.alternative_results)) return false;
		if (!r.alternative_results.every((a) =>
			a && typeof a === 'object' &&
			typeof (a as Record<string, unknown>).provider === 'string' &&
			(a as Record<string, unknown>).result &&
			typeof (a as Record<string, unknown>).result === 'object'
		)) return false;
	}
	return true;
};

const get_fetch_cached = async (url: string): Promise<FetchRaceResult | undefined> => {
	if (!kv_cache) return undefined;
	try {
		const key = await hash_key('fetch:', url);
		const raw = await kv_cache.get(key, 'json') as unknown;
		// Full shape validation — legacy / corrupted entries are silently
		// treated as a miss so downstream code can't crash on undefined fields.
		return is_valid_cached_fetch(raw) ? raw : undefined;
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
	if (!result.content) return true; // null/empty content is always a failure
	// API-native providers (github gists, supadata transcripts) may return
	// genuinely short payloads. Bypass the length + challenge-pattern checks
	// for them BEFORE rejecting on length, so a 50-char gist isn't flagged
	// as "blocked or empty".
	if (provider && API_NATIVE_PROVIDERS.has(provider)) return false;
	if (result.content.length < CONFIG.failure.min_content_chars) return true;
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
	target_count: number,
): Promise<Array<{ provider: string; result: FetchResult }>> => {
	const available = providers.filter((p) => ctx.active.has(p));
	if (available.length === 0) return [];

	ctx.attempted.push(...available);
	const trace = get_active_trace();

	// Multi-winner race: collect successes up to `target_count`, settle when reached
	// (or all providers complete). When target_count > 1 we want both/all alternatives,
	// not just the first — Promise.any orphaned alternatives unnecessarily.
	// resolved flag suppresses BOTH ctx.failed mutations AND trace error events for
	// losers that reject after we return — keeps the public response and the trace
	// log telling the same story.
	const winners: Array<{ provider: string; result: FetchResult }> = [];
	let resolved = false;
	let completed = 0;

	return new Promise<Array<{ provider: string; result: FetchResult }>>((resolve) => {
		const try_settle = () => {
			if (resolved) return;
			if (winners.length >= target_count || completed >= available.length) {
				resolved = true;
				if (winners.length === 0) {
					logger.debug('All parallel providers failed', {
						op: 'parallel_all_failed',
						providers: available,
						url: ctx.url.slice(0, 200),
					});
				}
				resolve([...winners]);
			}
		};

		for (const p of available) {
			const t0 = Date.now();
			trace?.record_provider_start(p, { url: ctx.url });
			try_provider(ctx.unified, ctx.url, p)
				.then((r) => {
					if (resolved) return; // post-settle: discard, don't pollute trace
					trace?.record_provider_complete(p, r, Date.now() - t0);
					if (winners.length < target_count) {
						winners.push({ provider: p, result: r });
					}
				})
				.catch((error) => {
					if (resolved) return; // post-settle: drop the loser's error from trace + ctx.failed
					const duration_ms = Date.now() - t0;
					const error_msg = error instanceof Error ? error.message : String(error);
					ctx.failed.push({ provider: p, error: error_msg, duration_ms });
					trace?.record_provider_error(p, error_msg, duration_ms);
				})
				.finally(() => {
					completed++;
					try_settle();
				});
		}
	});
};

const run_sequential = async (
	ctx: StepContext,
	providers: string[],
	target_count: number,
): Promise<Array<{ provider: string; result: FetchResult }>> => {
	const trace = get_active_trace();
	const winners: Array<{ provider: string; result: FetchResult }> = [];
	for (const provider of providers) {
		if (winners.length >= target_count) break;
		if (!ctx.active.has(provider)) continue;
		ctx.attempted.push(provider);
		const t0 = Date.now();
		trace?.record_provider_start(provider, { url: ctx.url });
		try {
			const result = await try_provider(ctx.unified, ctx.url, provider);
			trace?.record_provider_complete(provider, result, Date.now() - t0);
			winners.push({ provider, result });
		} catch (error) {
			const duration_ms = Date.now() - t0;
			const error_msg = error instanceof Error ? error.message : String(error);
			ctx.failed.push({ provider, error: error_msg, duration_ms });
			trace?.record_provider_error(provider, error_msg, duration_ms);
		}
	}
	return winners;
};

const execute_step = async (
	ctx: StepContext,
	step: WaterfallStep,
	target_count: number,
): Promise<Array<{ provider: string; result: FetchResult }>> => {
	if ('solo' in step) {
		const result = await run_solo(ctx, step.solo);
		return result ? [{ provider: step.solo, result }] : [];
	}
	if ('parallel' in step) {
		return run_parallel(ctx, step.parallel, target_count);
	}
	if ('sequential' in step) {
		return run_sequential(ctx, step.sequential, target_count);
	}
	return [];
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
// Accepts whatever the LLM sends:
//   - native arrays of strings: ["tavily","firecrawl"]
//   - JSON-encoded array strings: '["tavily","firecrawl"]' (parsed via JSON.parse)
//   - comma-separated strings: "tavily, firecrawl"
//   - single name strings: "tavily"
//   - null / undefined / "null" / "undefined" → []
// Non-string array entries are dropped, not stringified.
// Falls back to regex strip-and-split when JSON.parse fails — handles
// loosely-formatted bracketed strings like "[tavily,firecrawl]" or with
// smart quotes from clipboard paste.

const SMART_QUOTES_RE = /[‘’“”]/g;

const MAX_PARSER_INPUT_CHARS = 4096; // generous; real provider names are <30 chars
const MAX_ARRAY_ENTRIES = 64;

const normalize_str_entry = (s: string): string => s.trim().toLowerCase();

export const parse_skip_providers = (raw: unknown): string[] => {
	if (raw == null) return [];
	if (Array.isArray(raw)) {
		// Cap array length to prevent malicious clients from forcing N-quadratic
		// work via a million-entry array.
		const slice = raw.slice(0, MAX_ARRAY_ENTRIES);
		return slice
			.filter((v): v is string => typeof v === 'string' && v.length <= 200)
			.map(normalize_str_entry)
			.filter(Boolean);
	}
	if (typeof raw !== 'string') return [];
	if (raw.length > MAX_PARSER_INPUT_CHARS) return [];
	const str = raw.trim();
	if (!str) return [];
	// Literal "null" / "undefined" from a stringified null → empty skip set.
	const lower = str.toLowerCase();
	if (lower === 'null' || lower === 'undefined') return [];
	// JSON-encoded array string: try real JSON.parse first so internal commas /
	// escaped quotes don't get split by the regex fallback.
	if (str.startsWith('[')) {
		try {
			const parsed: unknown = JSON.parse(str);
			if (Array.isArray(parsed)) {
				return parsed
					.filter((v): v is string => typeof v === 'string')
					.map(normalize_str_entry)
					.filter(Boolean);
			}
		} catch {
			// fall through to regex strip-and-split for malformed JSON
		}
	}
	// Fallback: strip surrounding brackets / quotes (incl. smart quotes), then split on commas.
	const stripped = str
		.replace(SMART_QUOTES_RE, '')
		.replace(/^\[|\]$/g, '')
		.replace(/"/g, '')
		.replace(/'/g, '');
	return stripped.split(',').map(normalize_str_entry).filter(Boolean);
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
			let result: FetchResult;
			try {
				result = await fetch_provider.fetch_url(url, provider);
			} catch (error) {
				// fetch_url throws on auth / network / provider-side errors.
				// Record on trace + flush before rethrowing so the trace reflects
				// the failure (was bypassed by the bare-await pre-fix).
				const error_msg = error instanceof Error ? error.message : String(error);
				trace.record_provider_error(provider, error_msg, Date.now() - start_time);
				trace.flush_background({ error: error_msg });
				throw error;
			}
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
		const skip_set = new Set(effective_skip);
		const active = new Set(get_active_fetch_providers().map((p) => p.name).filter((n) => !skip_set.has(n)));
		trace.set_active_providers(Array.from(active));
		trace.record_decision('waterfall_start', { active_providers: Array.from(active), skipped_providers: Array.from(skip_set), url: url.slice(0, 200) });

		logger.info('Waterfall start', {
			op: 'waterfall_start',
			url: url.slice(0, 200),
			skip_providers: Array.from(skip_set),
			active_count: active.size,
		});

		// Empty active set: either the caller skipped every active provider, or
		// no provider has API keys configured. Throw INVALID_INPUT (REST → 400)
		// rather than running the waterfall to exhaustion and emitting the
		// misleading "All providers failed. Tried: <empty>" message that maps
		// to 502.
		if (active.size === 0) {
			const reason = skip_set.size > 0
				? `all candidates skipped via skip_providers (${Array.from(skip_set).join(', ')})`
				: 'no providers configured with API keys';
			const error_msg = `No fetch providers available — ${reason}`;
			trace.record_decision('empty_active_set', { skipped_providers: Array.from(skip_set) });
			trace.flush_background({ error: error_msg });
			throw new ProviderError(ErrorType.INVALID_INPUT, error_msg, 'waterfall');
		}

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
		// Clamp to active.size so a heavily-skipped fanout (1 active provider
		// left) doesn't iterate every empty step looking for a second winner.
		const target_count = Math.min(has_skip_providers ? 2 : 1, active.size);
		const winners: Array<{ provider: string; result: FetchResult }> = [];

		// Breakers: domain-specific providers tried before the waterfall
		for (const [breaker_name, breaker_config] of Object.entries(CONFIG.breakers)) {
			if (winners.length >= target_count) break;
			if (matches_breaker(url, breaker_config)) {
				if (!active.has(breaker_config.provider)) {
					// Domain matched but the breaker provider is in skip_set
					// (or has no key). Record so trace makes the bypass visible.
					trace.record_decision('breaker_skipped', {
						breaker: breaker_name,
						provider: breaker_config.provider,
						reason: skip_set.has(breaker_config.provider) ? 'in_skip_set' : 'inactive',
					});
					continue;
				}
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
			const step_label = 'solo' in step ? `solo:${step.solo}` : 'parallel' in step ? `parallel:${step.parallel.join(',')}` : `sequential:${step.sequential.join(',')}`;
			trace.record_decision('waterfall_step', { step: step_label });

			const remaining = target_count - winners.length;
			const step_winners = await execute_step(ctx, step, remaining);
			for (const w of step_winners) {
				winners.push(w);
				if (winners.length >= target_count) break;
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
