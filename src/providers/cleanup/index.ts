// Content cleanup via Groq (OpenAI-compatible API)
// Post-fetch extraction pass: given multiple versions of the same page (from
// different fetch providers) and a query, returns only the verbatim sections
// relevant to the query. NOT a summary — targeted extraction.

import { config } from '../../config/env.js';
import { http_json } from '../../common/http.js';
import { loggers } from '../../common/logger.js';

const logger = loggers.fetch();

const CLEANUP_SYSTEM_PROMPT = `You are a strict content extractor. You copy text from the provided page versions — nothing else.

ABSOLUTE RULE: Every sentence in your output MUST exist in the provided page text. Do NOT add facts, examples, definitions, comparisons, or tables from your own knowledge. If the page does not contain specific information the query asks about, extract what IS there and note what is missing — never fill gaps with your own knowledge.

You receive one or more versions of the same web page (fetched by different providers). Each version may differ in formatting, completeness, or artifacts.

TASK:
1. Cross-reference ALL versions to find the most complete text of the page.
2. Identify sections relevant to the user's query.
3. Copy those sections verbatim into your output. Fix formatting artifacts only (broken markdown, raw HTML tags).
4. Target 500-3000 words. Be thorough but selective.

OUTPUT FORMAT:
- Start with the page title as a markdown heading (# Title).
- Then the extracted content as clean markdown, in the order it appears on the page.
- Preserve tables, code blocks, formulas, and lists exactly as they appear in the source.
- Clean up: raw HTML tags, broken link syntax, navigation, menus, ads, footers, cookie banners.

EXTRACTION RULES:
- VERBATIM ONLY. Copy relevant paragraphs, sentences, tables, and lists word-for-word from the page.
- Do NOT paraphrase, summarize, restructure, or rewrite any content. When extracting table cells or descriptions, use the exact wording from the source — do not rephrase or "clean up" the language.
- Do NOT create new tables, bullet lists, or comparisons that don't exist on the page.
- Do NOT add examples, database names, dates, numbers, or facts not explicitly stated on the page.
- If the page discusses a topic partially (e.g., mentions some databases but not others), extract ONLY what the page says. Do NOT complete the list from your knowledge.
- If the page has NO relevant content for the query, return exactly: NO_RELEVANT_CONTENT
- If the page has SOME relevant content but doesn't fully answer the query, extract what exists and end with: [Page does not cover: <brief note of what's missing>]

SELF-CHECK before outputting: For each table, list, or factual claim in your response, verify it appears in the provided text. If you cannot point to where it came from, delete it.`;

const MIN_CONTENT_LENGTH = 500;
const MAX_INPUT_CHARS_PER_VERSION = 24000; // ~6k tokens per version, 3 versions ≈ 18k tokens
const MAX_OUTPUT_CHARS = 12000; // Hard cap on cleanup output to prevent page dumps
const DEFAULT_MAX_TOKENS = 8192;

export interface CleanupResult {
	content: string;
	cleanup_applied: boolean;
	cleanup_model: string;
	cleanup_latency_ms: number;
	original_length: number;
	cleaned_length: number;
	versions_provided: number;
}

export interface ContentVersion {
	provider: string;
	content: string;
}

interface GroqChatResponse {
	choices: Array<{
		message: {
			content: string;
		};
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
	};
}

export const is_cleanup_available = (): boolean =>
	!!config.cleanup.groq.api_key?.trim();

const format_versions_for_prompt = (versions: ContentVersion[]): string =>
	versions.map((version, index) => {
		const truncated = version.content.length > MAX_INPUT_CHARS_PER_VERSION
			? version.content.slice(0, MAX_INPUT_CHARS_PER_VERSION)
			: version.content;
		return `=== VERSION ${index + 1} (fetched by: ${version.provider}) ===\n${truncated}\n=== END VERSION ${index + 1} ===`;
	}).join('\n\n');

const make_skip_result = (
	content: string,
	model: string,
	original_length: number,
	versions_provided: number,
): CleanupResult => ({
	content,
	cleanup_applied: false,
	cleanup_model: model,
	cleanup_latency_ms: 0,
	original_length,
	cleaned_length: original_length,
	versions_provided,
});

const random_jitter_ms = () => Math.floor(Math.random() * 1000);

export const run_cleanup = async (
	versions: ContentVersion[],
	query: string,
	model_override?: string,
	max_tokens?: number,
): Promise<CleanupResult> => {
	const groq_config = config.cleanup.groq;
	const model = model_override || groq_config.model;

	logger.info('Cleanup started', {
		op: 'cleanup_start',
		query: query.slice(0, 200),
		model,
		versions_received: versions.length,
		version_providers: versions.map((v) => v.provider),
		version_lengths: versions.map((v) => v.content?.length ?? 0),
	});

	const valid_versions = versions.filter((v) => v.content && v.content.length >= MIN_CONTENT_LENGTH);
	const total_original_length = valid_versions.reduce((sum, v) => sum + v.content.length, 0);

	logger.info('Cleanup version filtering', {
		op: 'cleanup_filter',
		total_received: versions.length,
		valid_count: valid_versions.length,
		rejected_count: versions.length - valid_versions.length,
		rejected_reasons: versions
			.filter((v) => !v.content || v.content.length < MIN_CONTENT_LENGTH)
			.map((v) => ({ provider: v.provider, length: v.content?.length ?? 0, reason: !v.content ? 'no_content' : 'too_short' })),
		valid_providers: valid_versions.map((v) => v.provider),
		valid_lengths: valid_versions.map((v) => v.content.length),
		total_original_length,
	});

	if (!groq_config.api_key) {
		logger.warn('Cleanup skipped — no GROQ_API_KEY configured', { op: 'cleanup_skip', reason: 'no_api_key' });
		return make_skip_result(valid_versions[0]?.content ?? '', model, total_original_length, valid_versions.length);
	}

	if (valid_versions.length === 0) {
		logger.warn('Cleanup skipped — no valid content versions', {
			op: 'cleanup_skip',
			reason: 'no_valid_versions',
			total_received: versions.length,
			min_content_length: MIN_CONTENT_LENGTH,
		});
		return make_skip_result(versions[0]?.content ?? '', model, 0, 0);
	}

	const formatted_content = format_versions_for_prompt(valid_versions);
	const user_message = valid_versions.length > 1
		? `Query: ${query}\n\nBelow are ${valid_versions.length} versions of the same web page, each fetched by a different provider. They represent the same page but may differ in formatting, completeness, or artifacts. Cross-reference all versions to extract the most complete relevant content.\n\n${formatted_content}`
		: `Query: ${query}\n\nContent:\n${valid_versions[0].content.slice(0, MAX_INPUT_CHARS_PER_VERSION)}`;

	const prompt_chars = CLEANUP_SYSTEM_PROMPT.length + user_message.length;

	logger.info('Cleanup prompt built', {
		op: 'cleanup_prompt',
		system_prompt_chars: CLEANUP_SYSTEM_PROMPT.length,
		user_message_chars: user_message.length,
		total_prompt_chars: prompt_chars,
		estimated_tokens: Math.ceil(prompt_chars / 4),
		max_tokens: max_tokens ?? DEFAULT_MAX_TOKENS,
		versions_in_prompt: valid_versions.length,
		per_version_chars: valid_versions.map((v) => Math.min(v.content.length, MAX_INPUT_CHARS_PER_VERSION)),
		per_version_truncated: valid_versions.map((v) => v.content.length > MAX_INPUT_CHARS_PER_VERSION),
	});

	// Random jitter before Groq call to prevent thundering herd when multiple
	// search results are cleaned concurrently
	const jitter = random_jitter_ms();
	logger.debug('Cleanup jitter delay', { op: 'cleanup_jitter', delay_ms: jitter });
	await new Promise((resolve) => setTimeout(resolve, jitter));

	const start_time = Date.now();

	try {
		logger.info('Groq API call starting', {
			op: 'cleanup_groq_start',
			model,
			base_url: groq_config.base_url,
			timeout_ms: groq_config.timeout,
			max_tokens: max_tokens ?? DEFAULT_MAX_TOKENS,
		});

		const response = await http_json<GroqChatResponse>(
			'groq_cleanup',
			groq_config.base_url,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${groq_config.api_key}`,
				},
				body: JSON.stringify({
					model,
					messages: [
						{ role: 'system', content: CLEANUP_SYSTEM_PROMPT },
						{ role: 'user', content: user_message },
					],
					// max_completion_tokens covers reasoning + content on reasoning models (gpt-oss).
					// Plain max_tokens only caps content, so reasoning can eat the whole budget.
					max_completion_tokens: max_tokens ?? DEFAULT_MAX_TOKENS,
					reasoning_effort: 'low',
					temperature: 1,
				}),
				signal: AbortSignal.timeout(groq_config.timeout),
			},
		);

		const raw_response_dump = JSON.stringify(response).slice(0, 4000);
		const raw_content = response.choices?.[0]?.message?.content ?? null;
		let cleaned = raw_content?.trim() ?? '';
		const latency_ms = Date.now() - start_time;

		logger.info('Groq API raw response', {
			op: 'cleanup_groq_raw',
			latency_ms,
			raw_response: raw_response_dump,
		});

		logger.info('Groq API response parsed', {
			op: 'cleanup_groq_response',
			latency_ms,
			choices_count: response.choices?.length ?? 0,
			raw_content_null: raw_content === null,
			raw_content_empty: raw_content === '',
			raw_content_whitespace_only: raw_content !== null && raw_content.trim() === '' && raw_content.length > 0,
			cleaned_length: cleaned.length,
			cleaned_preview: cleaned.slice(0, 500),
			is_no_relevant_content: cleaned === 'NO_RELEVANT_CONTENT',
			input_tokens: response.usage?.prompt_tokens ?? null,
			output_tokens: response.usage?.completion_tokens ?? null,
		});

		// Treat empty, very short, or NO_RELEVANT_CONTENT as cleanup failure
		// — fall back to raw content instead of returning garbage to callers
		if (cleaned === 'NO_RELEVANT_CONTENT' || cleaned.length < 50) {
			logger.info('Cleanup returned unusable content, falling back', {
				op: 'cleanup_unusable',
				reason: cleaned === 'NO_RELEVANT_CONTENT' ? 'no_relevant_content' : 'too_short',
				cleaned_length: cleaned.length,
				latency_ms,
			});

			const best = valid_versions.reduce((a, b) => a.content.length > b.content.length ? a : b);
			return {
				content: best.content,
				cleanup_applied: false,
				cleanup_model: model,
				cleanup_latency_ms: latency_ms,
				original_length: total_original_length,
				cleaned_length: best.content.length,
				versions_provided: valid_versions.length,
			};
		}

		// Hard cap: prevent page dumps where model returns entire page as "relevant"
		if (cleaned.length > MAX_OUTPUT_CHARS) {
			logger.info('Cleanup output capped', {
				op: 'cleanup_cap',
				raw_length: cleaned.length,
				capped_to: MAX_OUTPUT_CHARS,
			});
			const truncated = cleaned.slice(0, MAX_OUTPUT_CHARS);
			const last_break = Math.max(
				truncated.lastIndexOf('\n\n'),
				truncated.lastIndexOf('\n# '),
				truncated.lastIndexOf('\n## '),
			);
			cleaned = last_break > MAX_OUTPUT_CHARS * 0.6
				? truncated.slice(0, last_break).trimEnd()
				: truncated.trimEnd();

			logger.debug('Cleanup cap applied', {
				op: 'cleanup_cap_result',
				final_length: cleaned.length,
				truncated_at: last_break > MAX_OUTPUT_CHARS * 0.6 ? 'paragraph_boundary' : 'hard_limit',
			});
		}

		const compression_ratio = total_original_length > 0
			? (cleaned.length / total_original_length).toFixed(3)
			: 'N/A';

		logger.info('Cleanup completed', {
			op: 'cleanup_complete',
			model,
			latency_ms,
			jitter_ms: jitter,
			versions_provided: valid_versions.length,
			version_providers: valid_versions.map((v) => v.provider),
			total_original_length,
			cleaned_length: cleaned.length,
			compression_ratio,
			input_tokens: response.usage?.prompt_tokens,
			output_tokens: response.usage?.completion_tokens,
			was_capped: cleaned.length === MAX_OUTPUT_CHARS || (response.usage?.completion_tokens ?? 0) > 0 && cleaned.length > MAX_OUTPUT_CHARS * 0.95,
		});

		return {
			content: cleaned,
			cleanup_applied: true,
			cleanup_model: model,
			cleanup_latency_ms: latency_ms,
			original_length: total_original_length,
			cleaned_length: cleaned.length,
			versions_provided: valid_versions.length,
		};
	} catch (error) {
		const latency_ms = Date.now() - start_time;
		const error_message = error instanceof Error ? error.message : String(error);
		const error_name = error instanceof Error ? error.constructor.name : 'Unknown';

		logger.warn('Cleanup failed — returning best raw content', {
			op: 'cleanup_error',
			error: error_message,
			error_type: error_name,
			is_timeout: error_message.includes('timeout') || error_message.includes('abort'),
			is_rate_limit: error_message.includes('429') || error_message.includes('rate'),
			model,
			latency_ms,
			jitter_ms: jitter,
			versions_provided: valid_versions.length,
			total_original_length,
		});

		// Fallback: return the longest version's content
		const best = valid_versions.reduce((a, b) => a.content.length > b.content.length ? a : b);

		logger.info('Cleanup fallback selected', {
			op: 'cleanup_fallback',
			fallback_provider: best.provider,
			fallback_length: best.content.length,
		});

		return {
			content: best.content,
			cleanup_applied: false,
			cleanup_model: model,
			cleanup_latency_ms: latency_ms,
			original_length: total_original_length,
			cleaned_length: best.content.length,
			versions_provided: valid_versions.length,
		};
	}
};
