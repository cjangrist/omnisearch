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
		// Use raw fetch to inspect actual JSON field names from Gemini API
		const api_url = `${cfg.base_url}/models/${cfg.model}:generateContent`;
		const raw_res = await fetch(api_url, {
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
		});
		const raw_json = await raw_res.text();
		const response = JSON.parse(raw_json) as Record<string, unknown>;

		// Extract candidate — inspect raw field names
		const candidates = response.candidates as Array<Record<string, unknown>> | undefined;
		const candidate = candidates?.[0];
		const raw_keys = candidate ? Object.keys(candidate) : [];

		// Try both camelCase and snake_case field names
		const content_obj = (candidate?.content ?? candidate?.['content']) as { parts?: Array<{ text?: string }> } | undefined;
		const answer = content_obj?.parts?.map((p) => p.text).filter(Boolean).join('\n') ?? '';

		// Try both naming conventions for url metadata
		const url_ctx = (candidate?.urlContextMetadata ?? candidate?.url_context_metadata) as Record<string, unknown> | undefined;
		const url_metadata_arr = (url_ctx?.urlMetadata ?? url_ctx?.url_metadata) as Array<Record<string, string>> | undefined ?? [];

		const fetched_urls = url_metadata_arr
			.filter((m) => (m.urlRetrievalStatus ?? m.url_retrieval_status) === 'URL_RETRIEVAL_STATUS_SUCCESS')
			.map((m) => m.retrievedUrl ?? m.retrieved_url)
			.filter(Boolean);

		const model = (response.modelVersion ?? response.model_version ?? cfg.model) as string;

		// Use Gemini-fetched URLs as citations if available, otherwise fall back to
		// the web search sources we provided in the prompt (they ARE the grounding).
		const citation_urls = fetched_urls.length > 0
			? fetched_urls
			: filtered_sources.map((s) => s.url).slice(0, 10);

		const results: SearchResult[] = [
			{
				title: `${PROVIDER_NAME} (${model})`,
				url: 'https://gemini.google.com',
				snippet: answer,
				score: PRIMARY_SCORE,
				source_provider: PROVIDER_NAME,
				metadata: {
				model,
				urls_provided: filtered_sources.length,
				urls_fetched_by_gemini: fetched_urls.length,
				citations_from: fetched_urls.length > 0 ? 'gemini_url_context' : 'web_search_fanout',
			},
			},
			...citation_urls.map((u) => ({
				title: new URL(u).hostname.replace(/^www\./, ''),
				url: u,
				snippet: `Source: ${u}`,
				score: 0,
				source_provider: PROVIDER_NAME,
			})),
		];

		return results;
	} catch (error) {
		handle_provider_error(error, PROVIDER_NAME, `fetch ${PROVIDER_NAME} answer`);
	}
}
