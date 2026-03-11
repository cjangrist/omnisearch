// Common type definitions for the MCP Omnisearch server

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	score?: number;
	source_provider: string;
	metadata?: Record<string, unknown>;
}

export interface BaseSearchParams {
	query: string;
	limit?: number;
	include_domains?: string[];
	exclude_domains?: string[];
}

// Provider interfaces
export interface SearchProvider {
	search(params: BaseSearchParams): Promise<SearchResult[]>;
	name: string;
	description: string;
}

// Error types
export enum ErrorType {
	API_ERROR = 'API_ERROR',
	RATE_LIMIT = 'RATE_LIMIT',
	INVALID_INPUT = 'INVALID_INPUT',
	PROVIDER_ERROR = 'PROVIDER_ERROR',
}

export class ProviderError extends Error {
	constructor(
		public type: ErrorType,
		message: string,
		public provider: string,
		public details?: unknown,
	) {
		super(message);
		this.name = 'ProviderError';
	}
}
