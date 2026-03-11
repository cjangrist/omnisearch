// Answer tool orchestration: fans out to AI providers in parallel,
// tracks progress, and aggregates results.

import type { SearchResult } from '../common/types.js';
import { get_active_ai_providers, type AISearchProvider, type UnifiedAISearchProvider } from '../providers/unified/ai_search.js';
import type { UnifiedWebSearchProvider } from '../providers/unified/web_search.js';
import { run_web_search_fanout } from './web_search_fanout.js';

const GLOBAL_TIMEOUT_MS = 120_000; // 2 min hard deadline for the entire fanout
const PROGRESS_INTERVAL_MS = 5_000;

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

	if (web_search_ref) {
		tasks.push({
			name: 'web_search',
			promise: run_web_search_fanout(web_search_ref, query).then((fanout) =>
				fanout.web_results.map((r) => ({
					title: r.title,
					url: r.url,
					snippet: r.snippets[0] || '',
					source_provider: 'web_search',
				})),
			),
		});
	}

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

	console.error(JSON.stringify({
		event: 'progress', progress: 0, total: total_count,
		message: `Querying ${total_count} providers: ${tasks.map((t) => t.name).join(', ')}`,
	}));

	const tracked = tasks.map((task) =>
		task.promise.then(
			(value) => {
				const duration_ms = Date.now() - start_time;
				completed_count++;
				completed_set.add(task.name);
				const entry = { ...build_answer_entry(task.name, value), duration_ms };
				answers.push(entry);
				// Log metadata only — not full answer text (avoids 10KB+ log bloat)
				console.error(JSON.stringify({
					event: 'provider_done', progress: completed_count, total: total_count,
					source: entry.source, duration_ms, answer_length: entry.answer.length,
					citation_count: entry.citations.length,
				}));
			},
			(reason) => {
				const duration_ms = Date.now() - start_time;
				completed_count++;
				completed_set.add(task.name);
				const error_msg = reason instanceof Error ? reason.message : String(reason);
				failed.push({ provider: task.name, error: error_msg, duration_ms });
				console.error(JSON.stringify({
					event: 'provider_failed', progress: completed_count, total: total_count,
					provider: task.name, error: error_msg, duration_ms,
				}));
			},
		),
	);

	const progress_interval = setInterval(() => {
		const pending = tasks.filter((t) => !completed_set.has(t.name)).map((t) => t.name);
		if (pending.length > 0) {
			console.error(JSON.stringify({
				event: 'waiting', progress: completed_count, total: total_count,
				done: Array.from(completed_set), pending,
			}));
		}
	}, PROGRESS_INTERVAL_MS);

	try {
		// Race all providers against a global deadline to avoid exceeding Workers limits
		let timer_id: ReturnType<typeof setTimeout>;
		const deadline = new Promise<void>((resolve) => { timer_id = setTimeout(resolve, GLOBAL_TIMEOUT_MS); });
		await Promise.race([Promise.all(tracked), deadline]);
		clearTimeout(timer_id!);
	} finally {
		clearInterval(progress_interval);
	}

	// Mark timed-out providers as failed so they don't silently disappear
	if (completed_count < total_count) {
		const pending = tasks.filter((t) => !completed_set.has(t.name));
		for (const t of pending) {
			failed.push({ provider: t.name, error: 'Timed out (global deadline)', duration_ms: GLOBAL_TIMEOUT_MS });
		}
	}

	console.error(JSON.stringify({
		event: 'all_done', progress: completed_count, total: total_count,
		timed_out: completed_count < total_count,
	}));

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
	if (tasks.length === 0) return null;

	const start_time = Date.now();
	const { answers, failed } = await execute_tasks(tasks);

	return {
		query,
		total_duration_ms: Date.now() - start_time,
		providers_queried: tasks.map((t) => t.name),
		providers_succeeded: answers.map((a) => a.source),
		providers_failed: failed,
		answers,
	};
};
