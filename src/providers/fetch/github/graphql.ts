// GraphQL query builders and tree merge/filter helpers

import type { GqlBlob, GitHubAny } from './types.js';
import {
	AI_RULES_DIRS, DEP_CONFIG_ALLOWLIST, TREE_CHILD_FRAGMENT,
	MAX_TREE_CHILDREN_DIRS, NOISY_DIR_NAMES,
} from './constants.js';

export function extract_gql_blob(obj: unknown, max_bytes: number): { text: string; size: number } | null {
	if (!obj || typeof obj !== 'object') return null;
	const blob = obj as GqlBlob;
	if (blob.text == null || blob.byteSize == null) return null;
	if (blob.byteSize > max_bytes) return null;
	return { text: blob.text, size: blob.byteSize };
}

// Build monthly commit history aliases for the last 24 months
function build_monthly_history_aliases(): string {
	const now = new Date();
	const aliases: string[] = [];
	for (let i = 0; i < 24; i++) {
		const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
		const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
		const label = `m${start.getUTCFullYear()}_${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
		aliases.push(`${label}: history(since: "${start.toISOString()}", until: "${end.toISOString()}", first: 1) { totalCount }`);
	}
	return aliases.join('\n          ');
}

// Core query: everything we need, with root-level tree only (no nested children).
// Nested tree resolution can 502 on massive repos (rocksdb, golang/go, swift, minio).
// Tree depth-2 children are fetched in a targeted follow-up query.
function build_context_file_aliases(): string {
	const GQL_CONTEXT_ALIASES: Record<string, string> = {
		'CLAUDE.md': 'claude_md', 'AGENTS.md': 'agents_md', 'GEMINI.md': 'gemini_md', 'AGENT.md': 'agent_md',
		'ARCHITECTURE.md': 'architecture_md', 'DEVELOPMENT.md': 'development_md', 'CONVENTIONS.md': 'conventions_md', 'REVIEW.md': 'review_md',
		'.cursorrules': 'cursorrules', '.windsurfrules': 'windsurfrules', '.clinerules': 'clinerules', '.goosehints': 'goosehints',
		'.roorules': 'roorules', '.continuerules': 'continuerules', '.github/copilot-instructions.md': 'copilot_md',
		'.junie/guidelines.md': 'junie_guidelines', 'llms.txt': 'llms_txt', 'llms-full.txt': 'llms_full_txt',
	};
	const blob_fragment = '... on Blob { text byteSize }';
	const context_aliases = Object.entries(GQL_CONTEXT_ALIASES).map(([filename, alias]) => `${alias}: object(expression: "HEAD:${filename}") { ${blob_fragment} }`);
	const detect_aliases = ['CONTRIBUTING.md', 'CHANGELOG.md'].map((filename) => `${filename.replace('.', '_').toLowerCase()}: object(expression: "HEAD:${filename}") { ... on Blob { byteSize } }`);
	const rules_dir_aliases = Object.entries(AI_RULES_DIRS).map(([directory_path, { gql_alias }]) => `${gql_alias}: object(expression: "HEAD:${directory_path}") { ... on Tree { entries { name type object { ${blob_fragment} } } } }`);
	const dep_config_aliases = Object.entries(DEP_CONFIG_ALLOWLIST).map(([filename, { gql_alias }]) => `${gql_alias}: object(expression: "HEAD:${filename}") { ${blob_fragment} }`);
	return [...context_aliases, ...detect_aliases, ...rules_dir_aliases, ...dep_config_aliases].join('\n    ');
}

export function build_core_gql(): string {
	const readme_variants = ['README.md', 'readme.md', 'README.rst', 'README.markdown', 'README']
		.map((filename, index) => `readme_${index}: object(expression: "HEAD:${filename}") { ... on Blob { text byteSize } }`)
		.join('\n    ');
	return `
query RepoOverview($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    nameWithOwner description url isArchived isFork visibility createdAt pushedAt diskUsage
    defaultBranchRef { name target { ... on Commit {
      history(first: 10) { nodes { oid message committedDate author { name } } }
      ${build_monthly_history_aliases()}
    } } }
    parent { nameWithOwner url }
    licenseInfo { name spdxId }
    repositoryTopics(first: 20) { nodes { topic { name } } }
    languages(first: 15, orderBy: {field: SIZE, direction: DESC}) { edges { size node { name } } totalSize }
    stargazerCount forkCount
    watchers { totalCount }
    recent_stars: stargazers(last: 30, orderBy: {field: STARRED_AT, direction: ASC}) { edges { starredAt } }
    issues(states: OPEN, first: 5, orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount nodes { number title state author { login } labels(first: 5) { nodes { name } } updatedAt body }
    }
    pullRequests(states: OPEN, first: 5, orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount nodes { number title body updatedAt isDraft author { login } labels(first: 5) { nodes { name } } }
    }
    releases(first: 3, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { name tagName publishedAt isPrerelease description } }
    hasIssuesEnabled hasWikiEnabled hasDiscussionsEnabled hasProjectsEnabled
    owner { login url __typename }
    ${readme_variants}
    ${build_context_file_aliases()}
    rootTree: object(expression: "HEAD:") { ... on Tree { entries { name type object { ... on Blob { byteSize } } } } }
  }
  rateLimit { remaining resetAt }
}
`;
}

export function build_tree_children_query(dirs: string[]): string {
	const capped = dirs.slice(0, MAX_TREE_CHILDREN_DIRS);
	const fields = capped.map((d, i) =>
		`d${i}: object(expression: "HEAD:${d.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}") { ${TREE_CHILD_FRAGMENT} }`,
	).join('\n    ');
	return `query TreeChildren($owner: String!, $repo: String!) {\n  repository(owner: $owner, name: $repo) {\n    ${fields}\n  }\n}`;
}

export function merge_tree_children(
	root_entries: Array<{ name: string; type: string; object?: unknown }>,
	children_data: GitHubAny | null,
	queried_dirs?: string[],
): Array<{ path: string; type: string; size?: number }> {
	const result: Array<{ path: string; type: string; size?: number }> = [];
	const lookup_dirs = queried_dirs ?? root_entries.filter((e) => e.type === 'tree' && !NOISY_DIR_NAMES.has(e.name.toLowerCase())).map((e) => e.name);
	const capped_lookup = lookup_dirs.slice(0, MAX_TREE_CHILDREN_DIRS);

	for (const entry of root_entries) {
		if (entry.type === 'tree') {
			result.push({ path: entry.name, type: 'tree' });
			const idx = capped_lookup.indexOf(entry.name);
			if (idx !== -1 && children_data) {
				const sub = (children_data[`d${idx}`] as { entries?: Array<{ name: string; type: string; object?: { byteSize?: number } }> })?.entries;
				if (sub) {
					for (const s of sub) {
						result.push({
							path: `${entry.name}/${s.name}`,
							type: s.type === 'tree' ? 'tree' : 'blob',
							size: s.type === 'blob' ? s.object?.byteSize : undefined,
						});
					}
				}
			}
		} else {
			const size = (entry.object as { byteSize?: number })?.byteSize;
			result.push({ path: entry.name, type: 'blob', size });
		}
	}
	return result;
}

export function filter_rest_tree(entries: Array<{ path: string; type: string; size?: number }>): Array<{ path: string; type: string; size?: number }> {
	const result: Array<{ path: string; type: string; size?: number }> = [];
	for (const e of entries) {
		const parts = e.path.split('/');
		if (parts.length === 1) {
			result.push(e);
		} else if (parts.length === 2) {
			const parent = parts[0];
			if (NOISY_DIR_NAMES.has(parent.toLowerCase())) continue;
			result.push(e);
		}
	}
	return result;
}
