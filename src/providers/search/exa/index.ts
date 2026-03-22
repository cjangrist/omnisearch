import { http_json } from '../../../common/http.js';
import {
	BaseSearchParams,
	SearchProvider,
	SearchResult,
} from '../../../common/types.js';
import {
	handle_provider_error,
	make_signal,
	validate_api_key,
} from '../../../common/utils.js';
import { config } from '../../../config/env.js';

const DEFAULT_LIMIT = 20;
const DEFAULT_SEARCH_TYPE = 'auto';
const MAX_CONTENT_CHARS = 1500;
const DEFAULT_LIVECRAWL = 'fallback';

interface ExaSearchRequest {
	query: string;
	type?: string;
	numResults?: number;
	includeDomains?: string[];
	excludeDomains?: string[];
	contents?: {
		text?: { maxCharacters?: number };
		livecrawl?: 'always' | 'fallback' | 'preferred';
	};
	category?: string;
	useAutoprompt?: boolean;
}

interface ExaSearchResult {
	id: string;
	title: string;
	url: string;
	publishedDate?: string;
	author?: string;
	text?: string;
	score?: number;
	highlights?: string[];
	summary?: string;
}

interface ExaSearchResponse {
	requestId: string;
	autopromptString?: string;
	resolvedSearchType: string;
	results: ExaSearchResult[];
}

export class ExaSearchProvider implements SearchProvider {
	name = 'exa';
	description =
		'AI-powered web search using neural and keyword search. Optimized for AI applications with semantic understanding, content extraction, and research capabilities.';

	async search(params: BaseSearchParams): Promise<SearchResult[]> {
		const api_key = validate_api_key(
			config.search.exa.api_key,
			this.name,
		);

		try {
			const request_body: ExaSearchRequest = {
				query: params.query,
				type: DEFAULT_SEARCH_TYPE,
				numResults: params.limit ?? DEFAULT_LIMIT,
				useAutoprompt: true,
				contents: {
					text: { maxCharacters: MAX_CONTENT_CHARS },
					livecrawl: DEFAULT_LIVECRAWL,
				},
			};

			// Add domain filtering if provided
			if (
				params.include_domains &&
				params.include_domains.length > 0
			) {
				request_body.includeDomains = params.include_domains;
			}
			if (
				params.exclude_domains &&
				params.exclude_domains.length > 0
			) {
				request_body.excludeDomains = params.exclude_domains;
			}

			const data = await http_json<ExaSearchResponse>(
				this.name,
				`${config.search.exa.base_url}/search`,
				{
					method: 'POST',
					headers: {
						// Exa accepts either x-api-key or Authorization Bearer
						'x-api-key': api_key,
						Authorization: `Bearer ${api_key}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify(request_body),
					signal: make_signal(config.search.exa.timeout, params.signal),
				},
			);

			return data.results.map((result) => ({
				title: result.title,
				url: result.url,
				snippet:
					result.text || result.summary || 'No content available',
				score: result.score || 0,
				source_provider: this.name,
				metadata: {
					id: result.id,
					author: result.author,
					publishedDate: result.publishedDate,
					highlights: result.highlights,
					autopromptString: data.autopromptString,
					resolvedSearchType: data.resolvedSearchType,
				},
			}));
		} catch (error) {
			handle_provider_error(error, this.name, 'fetch search results');
		}
	}
}

export const registration = {
	key: () => config.search.exa.api_key,
};
