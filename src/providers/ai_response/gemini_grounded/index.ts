// Gemini Grounded: runs web search fanout, then feeds top URLs + snippets to
// Gemini's native generateContent API with url_context tool enabled. Gemini
// fetches the URLs server-side (when possible) and uses the inline snippets
// as additional context, producing a grounded answer.

import { http_json } from '../../../common/http.js';
import type { SearchResult } from '../../../common/types.js';
import { handle_provider_error, make_signal } from '../../../common/utils.js';
import { config } from '../../../config/env.js';

const PROVIDER_NAME = 'gemini-grounded';
const MAX_URLS = 20; // Gemini API hard limit
const PRIMARY_SCORE = 1.0;

const BLOCKED_URL_PATTERNS = [
	'youtube.com', 'youtu.be', // video — not supported
	'docs.google.com', 'drive.google.com', // workspace files
];

export interface GroundingSource {
	url: string;
	snippets: string[];
}

interface GeminiContentPart {
	text?: string;
}

interface GeminiUrlMetadata {
	retrievedUrl: string;
	urlRetrievalStatus: string;
}

interface GeminiGenerateContentResponse {
	candidates?: Array<{
		content?: {
			parts?: GeminiContentPart[];
			role?: string;
		};
		urlContextMetadata?: {
			urlMetadata?: GeminiUrlMetadata[];
		};
	}>;
	modelVersion?: string;
}

const build_prompt = (query: string, sources: GroundingSource[]): string => {
	if (sources.length === 0) return query;

	const source_blocks = sources.map((s) => {
		const snippet_text = s.snippets.filter(Boolean).join('\n');
		return snippet_text
			? `${s.url}\n${snippet_text}`
			: s.url;
	});

	return `${query}\n\n${source_blocks.join('\n\n')}`;
};

export async function gemini_grounded_search(
	query: string,
	sources: GroundingSource[],
	external_signal?: AbortSignal,
): Promise<SearchResult[]> {
	const cfg = config.ai_response.gemini_grounded;
	if (!cfg.api_key) {
		throw new Error(`${PROVIDER_NAME} API key not configured`);
	}

	const filtered_sources = sources
		.filter((s) => !BLOCKED_URL_PATTERNS.some((pat) => s.url.includes(pat)))
		.slice(0, MAX_URLS);

	const prompt = build_prompt(query, filtered_sources);

	try {
		const response = await http_json<GeminiGenerateContentResponse>(
			PROVIDER_NAME,
			`${cfg.base_url}/models/${cfg.model}:generateContent`,
			{
				method: 'POST',
				headers: {
					'x-goog-api-key': cfg.api_key,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					contents: [{ parts: [{ text: prompt }] }],
					tools: [{ url_context: {} }],
				}),
				signal: make_signal(cfg.timeout, external_signal),
			},
		);

		const answer = response.candidates?.[0]?.content?.parts
			?.map((p) => p.text)
			.filter(Boolean)
			.join('\n') ?? '';

		const url_metadata = response.candidates?.[0]?.urlContextMetadata?.urlMetadata ?? [];
		const fetched_urls = url_metadata
			.filter((m) => m.urlRetrievalStatus === 'URL_RETRIEVAL_STATUS_SUCCESS')
			.map((m) => m.retrievedUrl);

		const model = response.modelVersion || cfg.model;

		const results: SearchResult[] = [
			{
				title: `${PROVIDER_NAME} (${model})`,
				url: 'https://gemini.google.com',
				snippet: answer,
				score: PRIMARY_SCORE,
				source_provider: PROVIDER_NAME,
				metadata: { model, urls_provided: filtered_sources.length, urls_fetched: fetched_urls.length },
			},
			...fetched_urls.map((u) => ({
				title: new URL(u).hostname,
				url: u,
				snippet: 'Source citation',
				score: 0,
				source_provider: PROVIDER_NAME,
			})),
		];

		return results;
	} catch (error) {
		handle_provider_error(error, PROVIDER_NAME, `fetch ${PROVIDER_NAME} answer`);
	}
}
