import {
	BaseSearchParams,
	ErrorType,
	ProviderError,
	SearchProvider,
	SearchResult,
} from '../../../common/types.js';
import {
	handle_provider_error,
	validate_api_key,
} from '../../../common/utils.js';
import { config } from '../../../config/env.js';

const DEFAULT_MODEL = 'brave';
const RESULT_URL = 'https://search.brave.com';
const PRIMARY_SCORE = 1.0;
const CITATION_SCORE_BASE = 0.9;
const CITATION_SCORE_DECAY = 0.05;
const ENABLE_ENTITIES = true;
const ENABLE_CITATIONS = true;
const ENABLE_RESEARCH = false;

interface BraveCitation {
	start_index: number;
	end_index: number;
	number: number;
	url: string;
	favicon?: string;
	snippet?: string;
}

interface BraveSSEChunk {
	model: string;
	choices: Array<{
		delta: { role?: string; content?: string };
		finish_reason: string | null;
	}>;
	id: string;
}

export class BraveAnswerProvider implements SearchProvider {
	name = 'brave_answer';
	description =
		'AI-powered answers from Brave Search with inline citations and entity information. Uses real-time web search for grounded responses.';

	private static readonly MAX_SSE_BUFFER = 64 * 1024; // 64 KB max incomplete-line buffer
	private static readonly MAX_ACCUMULATED = 512 * 1024; // 512 KB max total content

	private async consume_sse_stream(
		response: Response,
	): Promise<{ content: string; model: string }> {
		const reader = response.body?.getReader();
		if (!reader) {
			throw new ProviderError(
				ErrorType.API_ERROR,
				'No response body from Brave Answer API',
				this.name,
			);
		}

		const decoder = new TextDecoder();
		let accumulated_content = '';
		let model = DEFAULT_MODEL;
		let buffer = '';

		const process_line = (line: string) => {
			const trimmed = line.trim();
			if (!trimmed || !trimmed.startsWith('data: ')) return;

			const data_str = trimmed.slice(6);
			if (data_str === '[DONE]') return;

			try {
				const chunk: BraveSSEChunk = JSON.parse(data_str);
				model = chunk.model || model;
				const delta_content = chunk.choices?.[0]?.delta?.content;
				if (delta_content) {
					accumulated_content += delta_content;
				}
			} catch {
				// skip malformed chunks
			}
		};

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });

				if (buffer.length > BraveAnswerProvider.MAX_SSE_BUFFER) {
					reader.cancel();
					throw new ProviderError(ErrorType.API_ERROR, 'SSE buffer exceeded limit — malformed stream', this.name);
				}

				const lines = buffer.split('\n');
				// Keep the last potentially incomplete line in the buffer
				buffer = lines.pop() || '';

				for (const line of lines) {
					process_line(line);
				}

				if (accumulated_content.length > BraveAnswerProvider.MAX_ACCUMULATED) {
					reader.cancel();
					throw new ProviderError(ErrorType.API_ERROR, 'SSE stream exceeded content size limit', this.name);
				}
			}

			// Process any remaining data in the buffer after stream ends
			if (buffer.trim()) {
				process_line(buffer);
			}
		} finally {
			reader.releaseLock();
		}

		return { content: accumulated_content, model };
	}

	async search(params: BaseSearchParams): Promise<SearchResult[]> {
		const api_key = validate_api_key(
			config.ai_response.brave_answer.api_key,
			this.name,
		);

		try {
			const response = await fetch(
				`${config.ai_response.brave_answer.base_url}/chat/completions`,
				{
					method: 'POST',
					headers: {
						Accept: 'text/event-stream',
						'Content-Type': 'application/json',
						'x-subscription-token': api_key,
					},
					body: JSON.stringify({
						model: DEFAULT_MODEL,
						messages: [
							{
								role: 'user',
								content: params.query,
							},
						],
						stream: true,
						enable_entities: ENABLE_ENTITIES,
						enable_citations: ENABLE_CITATIONS,
						enable_research: ENABLE_RESEARCH,
					}),
					signal: AbortSignal.timeout(
						config.ai_response.brave_answer.timeout,
					),
				},
			);

			if (!response.ok) {
				const status_label = response.status === 401 ? 'Invalid API key'
					: response.status === 429 ? 'Rate limited'
					: `HTTP ${response.status}`;
				throw new ProviderError(
					response.status === 401
						? ErrorType.API_ERROR
						: response.status === 429
							? ErrorType.RATE_LIMIT
							: ErrorType.PROVIDER_ERROR,
					`Brave Answer API error: ${status_label}`,
					this.name,
				);
			}

			const { content: raw_content, model } =
				await this.consume_sse_stream(response);

			// Extract citations from XML-like tags in the accumulated content
			const citations: BraveCitation[] = [];
			const citation_regex = /<citation>([^<]*(?:<(?!\/citation>)[^<]*)*)<\/citation>/g;
			let match;
			while ((match = citation_regex.exec(raw_content)) !== null) {
				try {
					citations.push(JSON.parse(match[1]));
				} catch {
					// skip malformed citation
				}
			}

			// Strip XML tags to get clean answer text
			const clean_content = raw_content
				.replace(/<citation>[^<]*(?:<(?!\/citation>)[^<]*)*<\/citation>/g, '')
				.replace(/<enum_item>[^<]*(?:<(?!\/enum_item>)[^<]*)*<\/enum_item>/g, '')
				.replace(/<usage>[^<]*(?:<(?!\/usage>)[^<]*)*<\/usage>/g, '')
				.trim();

			const results: SearchResult[] = [
				{
					title: 'Brave Answer',
					url: RESULT_URL,
					snippet: clean_content,
					score: PRIMARY_SCORE,
					source_provider: this.name,
					metadata: {
						model,
						citations_count: citations.length,
					},
				},
			];

			// Add citations as source results
			for (const citation of citations) {
				if (citation.url) {
					results.push({
						title: `Citation [${citation.number}]`,
						url: citation.url,
						snippet: citation.snippet || 'Source citation',
						score: Math.max(0, CITATION_SCORE_BASE - citation.number * CITATION_SCORE_DECAY),
						source_provider: this.name,
						metadata: {
							citation_number: citation.number,
							start_index: citation.start_index,
							end_index: citation.end_index,
						},
					});
				}
			}

			if (params.limit && params.limit > 0) {
				return results.slice(0, params.limit);
			}

			return results;
		} catch (error) {
			handle_provider_error(error, this.name, 'fetch AI answer');
		}
	}
}

export const registration = {
	key: () => config.ai_response.brave_answer.api_key,
};
