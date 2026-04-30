// Answer tool orchestration: fans out to AI providers in parallel,
// tracks progress, and aggregates results.

import type { SearchResult } from '../common/types.js';
import { loggers } from '../common/logger.js';
import { hash_key } from '../common/utils.js';
import { config, kv_cache } from '../config/env.js';
import { get_active_ai_providers, type AISearchProvider, type UnifiedAISearchProvider } from '../providers/unified/ai_search.js';
import type { UnifiedWebSearchProvider } from '../providers/unified/web_search.js';
import { gemini_grounded_search } from '../providers/ai_response/gemini_grounded/index.js';
import { run_web_search_fanout } from './web_search_fanout.js';
import { TraceContext, get_active_trace, run_with_trace } from '../common/r2_trace.js';

const logger = loggers.aiResponse();

const GLOBAL_TIMEOUT_MS = 295_000; // 4m55s hard deadline for the entire fanout
const PROGRESS_INTERVAL_MS = 5_000;
const KV_ANSWER_TTL_SECONDS = 129_600; // 36 hours

interface ProviderTask {
	name: string;
	started_at: number;
	promise: Promise<SearchResult[]>;
}

interface AnswerEntry {
	source: string;
	answer: string;
	duration_ms: number;
	citations: Array<{ title: string; url: string; snippet?: string }>;
}

interface FailedProvider {
	provider: string;
	error: string;
	duration_ms: number;
}

export interface AnswerResult {
	query: string;
	total_duration_ms: number;
	providers_queried: string[];
	providers_succeeded: string[];
	providers_failed: FailedProvider[];
	answers: AnswerEntry[];
}

const build_answer_entry = (
	provider_name: string,
	items: SearchResult[],
): Omit<AnswerEntry, 'duration_ms'> => {
	if (items.length === 0) {
		return { source: provider_name, answer: 'No answer returned', citations: [] };
	}
	const answer_item = items[0];
	const citation_items = items.slice(1);
	return {
		source: provider_name,
		answer: answer_item.snippet || 'No answer returned',
		citations: citation_items
			.filter((c) => c.url)
			.map((c) => ({
				title: c.title,
				url: c.url,
				...(c.snippet && c.snippet !== 'Source citation' && !c.snippet.startsWith('Source: http') && !c.snippet.startsWith('Research source:')
					? { snippet: c.snippet }
					: {}),
			})),
	};
};

const build_tasks = (
	ai_search_ref: UnifiedAISearchProvider,
	web_search_ref: UnifiedWebSearchProvider | undefined,
	query: string,
	signal?: AbortSignal,
): ProviderTask[] => {
	// No retry_with_backoff — the multi-provider fanout IS the redundancy strategy.
	// Retrying individual providers doubles worst-case latency (2x timeout + backoff).
	const trace = get_active_trace();
	const tasks: ProviderTask[] = get_active_ai_providers().map((ap) => {
		trace?.record_provider_start(ap.name, { query });
		return {
			name: ap.name,
			started_at: Date.now(),
			promise: ai_search_ref.search({ query, provider: ap.name as AISearchProvider, signal }),
		};
	});

	if (web_search_ref && config.ai_response.gemini_grounded.api_key) {
		trace?.record_provider_start('gemini-grounded', { query, strategy: 'web_search_fanout + gemini_url_context' });
		tasks.push({
			name: 'gemini-grounded',
			started_at: Date.now(),
			promise: (async () => {
				const fanout = await run_web_search_fanout(web_search_ref, query, { signal, timeout_ms: 10_000 });
				const sources = fanout.web_results.map((r) => ({
					url: r.url,
					snippets: r.snippets,
				}));
				return gemini_grounded_search(query, sources, signal);
			})(),
		});
	}

	logger.debug('Built AI provider tasks', {
		op: 'build_tasks',
		query: query.slice(0, 100),
		total_tasks: tasks.length,
		ai_providers: get_active_ai_providers().map((p) => p.name),
		web_search_enabled: !!web_search_ref,
	});

	return tasks;
};

const execute_tasks = async (
	tasks: ProviderTask[],
	abort_controller?: AbortController,
): Promise<{ answers: AnswerEntry[]; failed: FailedProvider[] }> => {
	const answers: AnswerEntry[] = [];
	const failed: FailedProvider[] = [];
	let completed_count = 0;
	const completed_set = new Set<string>();
	const start_time = Date.now();
	const total_count = tasks.length;

	logger.info('Starting AI provider fanout', {
		op: 'ai_fanout_start',
		total_providers: total_count,
		providers: tasks.map((t) => t.name),
	});

	let is_done = false;

	const trace = get_active_trace();
	const tracked = tasks.map((task) =>
		task.promise.then(
			(value) => {
				if (is_done) return; // post-deadline — don't mutate arrays
				const duration_ms = Date.now() - task.started_at;
				completed_count++;
				completed_set.add(task.name);
				const entry = { ...build_answer_entry(task.name, value), duration_ms };
				answers.push(entry);
				trace?.record_provider_complete(task.name, value, duration_ms);

				logger.info('Provider completed', {
					op: 'provider_done',
					provider: task.name,
					progress: `${completed_count}/${total_count}`,
					duration_ms,
					answer_length: entry.answer.length,
					citation_count: entry.citations.length,
				});
			},
			(reason) => {
				if (is_done) return; // post-deadline — don't mutate arrays
				const duration_ms = Date.now() - task.started_at;
				completed_count++;
				completed_set.add(task.name);
				const error_msg = reason instanceof Error ? reason.message : String(reason);
				failed.push({ provider: task.name, error: error_msg, duration_ms });
				trace?.record_provider_error(task.name, error_msg, duration_ms);

				logger.warn('Provider failed', {
					op: 'provider_failed',
					provider: task.name,
					progress: `${completed_count}/${total_count}`,
					duration_ms,
					error: error_msg,
				});
			},
		),
	);

	const progress_interval = setInterval(() => {
		const pending = tasks.filter((t) => !completed_set.has(t.name)).map((t) => t.name);
		if (pending.length > 0) {
			logger.debug('Waiting for providers', {
				op: 'provider_progress',
				completed: completed_count,
				total: total_count,
				done: Array.from(completed_set),
				pending,
			});
		}
	}, PROGRESS_INTERVAL_MS);

	try {
		let timer_id: ReturnType<typeof setTimeout>;
		const deadline = new Promise<void>((resolve) => { timer_id = setTimeout(resolve, GLOBAL_TIMEOUT_MS); });
		const winner = Promise.race([
			Promise.all(tracked).then(() => 'all_done' as const),
			deadline.then(() => 'deadline' as const),
		]);
		const result = await winner;
		clearTimeout(timer_id!);
		is_done = true; // prevent late-arriving promises from mutating arrays
		if (result === 'deadline' && abort_controller) {
			abort_controller.abort();
		}
	} finally {
		clearInterval(progress_interval);
	}

	// Mark still-pending providers so they don't silently disappear from the response
	if (completed_count < total_count) {
		const deadline_duration = Date.now() - start_time;
		const pending = tasks.filter((t) => !completed_set.has(t.name));
		for (const t of pending) {
			failed.push({ provider: t.name, error: 'Timed out (global deadline)', duration_ms: deadline_duration });
			logger.warn('Provider timed out', {
				op: 'provider_timeout',
				provider: t.name,
				duration_ms: deadline_duration,
			});
		}
	}

	logger.info('AI fanout complete', {
		op: 'ai_fanout_complete',
		total: total_count,
		succeeded: answers.length,
		failed: failed.length,
		timed_out: completed_count < total_count,
		duration_ms: Date.now() - start_time,
	});

	// Defensive copy + sort — late-arriving promises may still push into the
	// original arrays after we return (they run past the deadline).
	const final_answers = [...answers].sort((a, b) => a.source.localeCompare(b.source));
	const final_failed = [...failed];

	return { answers: final_answers, failed: final_failed };
};

export const run_answer_fanout = async (
	ai_search_ref: UnifiedAISearchProvider,
	web_search_ref: UnifiedWebSearchProvider | undefined,
	query: string,
): Promise<AnswerResult | null> => {
	const trace = new TraceContext(crypto.randomUUID(), 'answer');
	trace.set_strategy('parallel_fanout');
	trace.request_environment = { query };

	return run_with_trace(trace, async () => {
		// Check KV cache first
		if (kv_cache) {
			try {
				const answer_cache_key = await hash_key('answer:', query);
				const cached = await kv_cache.get(answer_cache_key, 'json') as AnswerResult | null;
				if (cached) {
					logger.debug('Returning cached answer result', { op: 'answer_cache_hit', query: query.slice(0, 100) });
					trace.cache_hit = true;
					trace.record_decision('cache_hit', { query: query.slice(0, 100) });
					trace.flush_background(cached);
					return cached;
				}
			} catch { /* cache miss or read error — proceed normally */ }
		}

		const abort_controller = new AbortController();
		const tasks = build_tasks(ai_search_ref, web_search_ref, query, abort_controller.signal);
		if (tasks.length === 0) {
			logger.warn('No AI providers available for answer', {
				op: 'answer_fanout',
				query: query.slice(0, 100),
			});
			trace.record_decision('no_providers_available', {});
			trace.flush_background(null);
			return null;
		}

		trace.set_active_providers(tasks.map((t) => t.name));
		trace.record_decision('fanout_start', {
			provider_count: tasks.length,
			providers: tasks.map((t) => t.name),
		});

		const start_time = Date.now();
		logger.info('Starting answer fanout', {
			op: 'answer_fanout_start',
			query: query.slice(0, 100),
			providers_count: tasks.length,
		});

		const { answers, failed } = await execute_tasks(tasks, abort_controller);

		trace.record_decision('fanout_complete', {
			succeeded: answers.length,
			failed: failed.length,
			duration_ms: Date.now() - start_time,
		});

		const result: AnswerResult = {
			query,
			total_duration_ms: Date.now() - start_time,
			providers_queried: tasks.map((t) => t.name),
			providers_succeeded: answers.map((a) => a.source),
			providers_failed: failed,
			answers,
		};

		logger.info('Answer fanout complete', {
			op: 'answer_fanout_complete',
			query: query.slice(0, 100),
			total_duration_ms: result.total_duration_ms,
			providers_queried: result.providers_queried.length,
			providers_succeeded: result.providers_succeeded.length,
			providers_failed: result.providers_failed.length,
		});

		// Await KV write — prevents REST path from killing the promise after response is sent.
		// Only cache COMPLETE fanouts (no failed providers, no timed-out providers).
		// A partial result with one transient kimi 524 would otherwise lock that one-provider-
		// short answer in for 36 hours, preventing retry once the upstream recovers.
		const is_complete_fanout = result.answers.length > 0 && result.providers_failed.length === 0;
		if (kv_cache && is_complete_fanout) {
			try {
				const answer_write_key = await hash_key('answer:', query);
				await kv_cache.put(answer_write_key, JSON.stringify(result), { expirationTtl: KV_ANSWER_TTL_SECONDS });
			} catch (err) {
				logger.warn('KV answer cache write failed', { op: 'kv_write_error', error: err instanceof Error ? err.message : String(err) });
			}
		} else if (kv_cache && result.answers.length > 0) {
			logger.debug('Skipping answer cache write (partial fanout)', {
				op: 'answer_cache_skip_partial',
				succeeded: result.answers.length,
				failed: result.providers_failed.length,
			});
		}

		trace.flush_background(result);
		return result;
	});
};
