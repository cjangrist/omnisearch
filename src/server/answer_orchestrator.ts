// Answer tool orchestration: fans out to AI providers in parallel,
// tracks progress, and aggregates results.

import type { SearchResult } from '../common/types.js';
import { loggers } from '../common/logger.js';
import { config } from '../config/env.js';
import { get_active_ai_providers, type AISearchProvider, type UnifiedAISearchProvider } from '../providers/unified/ai_search.js';
import type { UnifiedWebSearchProvider } from '../providers/unified/web_search.js';
import { gemini_grounded_search } from '../providers/ai_response/gemini_grounded/index.js';
import { run_web_search_fanout } from './web_search_fanout.js';

const logger = loggers.aiResponse();

const GLOBAL_TIMEOUT_MS = 120_000; // 2 min hard deadline for the entire fanout
const PROGRESS_INTERVAL_MS = 5_000;

// Providers routed through the oauth-llm proxy — consistently slowest.
// We return early if these are the only ones still pending (at most 1 straggler).
const LLM_PROXY_PROVIDERS = new Set(['chatgpt', 'claude', 'gemini']);

interface ProviderTask {
	name: string;
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
				...(c.snippet && c.snippet !== 'Source citation' && !c.snippet.startsWith('Research source:')
					? { snippet: c.snippet }
					: {}),
			})),
	};
};

const build_tasks = (
	ai_search_ref: UnifiedAISearchProvider,
	web_search_ref: UnifiedWebSearchProvider | undefined,
	query: string,
): ProviderTask[] => {
	// No retry_with_backoff — the multi-provider fanout IS the redundancy strategy.
	// Retrying individual providers doubles worst-case latency (2x timeout + backoff).
	const tasks: ProviderTask[] = get_active_ai_providers().map((ap) => ({
		name: ap.name,
		promise: ai_search_ref.search({ query, provider: ap.name as AISearchProvider }),
	}));

	if (web_search_ref && config.ai_response.gemini_grounded.api_key) {
		tasks.push({
			name: 'gemini-grounded',
			promise: (async () => {
				const fanout = await run_web_search_fanout(web_search_ref, query);
				const sources = fanout.web_results.map((r) => ({
					url: r.url,
					snippets: r.snippets,
				}));
				return gemini_grounded_search(query, sources);
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

	// Resolves when we can return early (only LLM proxy stragglers remain)
	let resolve_early!: () => void;
	const early_exit = new Promise<void>((resolve) => { resolve_early = resolve; });

	const check_early_exit = () => {
		const pending = tasks.filter((t) => !completed_set.has(t.name));
		if (pending.length === 0) { resolve_early(); return; }
		// Early exit disabled by default — wait for all providers.
		// Uncomment below to skip the last LLM proxy straggler:
		// if (pending.length <= 1 && pending.every((t) => LLM_PROXY_PROVIDERS.has(t.name))) {
		// 	logger.info('Early exit: only LLM proxy straggler(s) remaining', {
		// 		op: 'early_exit',
		// 		pending: pending.map((t) => t.name),
		// 		completed: completed_count,
		// 		total: total_count,
		// 	});
		// 	resolve_early();
		// }
	};

	const tracked = tasks.map((task) =>
		task.promise.then(
			(value) => {
				const duration_ms = Date.now() - start_time;
				completed_count++;
				completed_set.add(task.name);
				const entry = { ...build_answer_entry(task.name, value), duration_ms };
				answers.push(entry);

				// Log metadata only — not full answer text (avoids 10KB+ log bloat)
				logger.info('Provider completed', {
					op: 'provider_done',
					provider: task.name,
					progress: `${completed_count}/${total_count}`,
					duration_ms,
					answer_length: entry.answer.length,
					citation_count: entry.citations.length,
				});
				check_early_exit();
			},
			(reason) => {
				const duration_ms = Date.now() - start_time;
				completed_count++;
				completed_set.add(task.name);
				const error_msg = reason instanceof Error ? reason.message : String(reason);
				failed.push({ provider: task.name, error: error_msg, duration_ms });

				logger.warn('Provider failed', {
					op: 'provider_failed',
					provider: task.name,
					progress: `${completed_count}/${total_count}`,
					duration_ms,
					error: error_msg,
				});
				check_early_exit();
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
		// Race: early exit (LLM stragglers only) vs global deadline vs all done
		let timer_id: ReturnType<typeof setTimeout>;
		const deadline = new Promise<void>((resolve) => { timer_id = setTimeout(resolve, GLOBAL_TIMEOUT_MS); });
		await Promise.race([Promise.all(tracked), early_exit, deadline]);
		clearTimeout(timer_id!);
	} finally {
		clearInterval(progress_interval);
	}

	// Mark still-pending providers so they don't silently disappear from the response
	if (completed_count < total_count) {
		const pending = tasks.filter((t) => !completed_set.has(t.name));
		for (const t of pending) {
			const is_early = LLM_PROXY_PROVIDERS.has(t.name);
			const error_msg = is_early ? 'Skipped (early exit — LLM straggler)' : 'Timed out (global deadline)';
			failed.push({ provider: t.name, error: error_msg, duration_ms: Date.now() - start_time });
			logger.warn(is_early ? 'Provider skipped (early exit)' : 'Provider timed out', {
				op: is_early ? 'provider_skipped' : 'provider_timeout',
				provider: t.name,
				duration_ms: Date.now() - start_time,
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
	const tasks = build_tasks(ai_search_ref, web_search_ref, query);
	if (tasks.length === 0) {
		logger.warn('No AI providers available for answer', {
			op: 'answer_fanout',
			query: query.slice(0, 100),
		});
		return null;
	}

	const start_time = Date.now();
	logger.info('Starting answer fanout', {
		op: 'answer_fanout_start',
		query: query.slice(0, 100),
		providers_count: tasks.length,
	});

	const { answers, failed } = await execute_tasks(tasks);

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

	return result;
};
