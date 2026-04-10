// GitHub API HTTP wrappers — REST + GraphQL

import { http_json, http_text } from '../../../common/http.js';
import { config } from '../../../config/env.js';
import { loggers } from '../../../common/logger.js';

const logger = loggers.fetch();

export function api_headers(token: string): Record<string, string> {
	return {
		'Authorization': `Bearer ${token}`,
		'Accept': 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28',
		'User-Agent': 'omnisearch-mcp/1.0',
	};
}

function raw_headers(token: string): Record<string, string> {
	return {
		...api_headers(token),
		'Accept': 'application/vnd.github.raw+json',
	};
}

export async function github_get<T>(token: string, endpoint: string): Promise<T> {
	const base = config.fetch.github.base_url;
	return http_json<T>('github', `${base}${endpoint}`, {
		headers: api_headers(token),
		signal: AbortSignal.timeout(config.fetch.github.timeout),
	});
}

export async function github_get_raw(token: string, endpoint: string): Promise<string> {
	const base = config.fetch.github.base_url;
	return http_text('github', `${base}${endpoint}`, {
		headers: raw_headers(token),
		signal: AbortSignal.timeout(config.fetch.github.timeout),
	});
}

export async function github_get_safe<T>(token: string, endpoint: string): Promise<T | null> {
	try {
		return await github_get<T>(token, endpoint);
	} catch (error) {
		logger.debug('GitHub API optional call failed', {
			op: 'github_get_safe_fail',
			endpoint: endpoint.slice(0, 200),
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

export async function github_get_starred(token: string, endpoint: string): Promise<Array<{ starred_at: string }> | null> {
	try {
		const base = config.fetch.github.base_url;
		return await http_json<Array<{ starred_at: string }>>('github', `${base}${endpoint}`, {
			headers: { ...api_headers(token), 'Accept': 'application/vnd.github.star+json' },
			signal: AbortSignal.timeout(config.fetch.github.timeout),
		});
	} catch {
		return null;
	}
}

export async function github_get_raw_safe(token: string, endpoint: string): Promise<string | null> {
	try {
		return await github_get_raw(token, endpoint);
	} catch {
		return null;
	}
}

export async function github_graphql<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
	const base = config.fetch.github.base_url;
	return http_json<T>('github', `${base}/graphql`, {
		method: 'POST',
		headers: { ...api_headers(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ query, variables }),
		signal: AbortSignal.timeout(config.fetch.github.timeout),
	});
}
