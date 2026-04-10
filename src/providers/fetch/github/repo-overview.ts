// Repo overview handlers — GraphQL fast path with REST fallback
// Data extraction happens here; markdown rendering is in markdown-builder.ts

import type { FetchResult } from '../../../common/types.js';
import { loggers } from '../../../common/logger.js';
import type { GqlBlob, GitHubAny, RepoOverviewData } from './types.js';
import {
	CONTEXT_FILE_LIMITS, AI_RULES_DIRS, AI_RULES_INLINE_MAX_BYTES,
	DEP_CONFIG_ALLOWLIST, DOCS_DIR_NAMES, NOISY_DIR_NAMES, CONTEXT_FILE_NAMES,
	README_MAX_BYTES, COMMIT_MESSAGE_MAX_CHARS, STARGAZER_MAX_PAGE,
	OVERVIEW_COMMITS_PER_PAGE, OVERVIEW_ISSUES_PER_PAGE, OVERVIEW_PRS_PER_PAGE,
	OVERVIEW_RELEASES_PER_PAGE,
} from './constants.js';
import { github_get, github_get_safe, github_get_starred, github_get_raw_safe, github_graphql } from './api.js';
import { format_star_velocity, format_size, is_docs_md_file, escape_table_cell } from './formatters.js';
import { extract_gql_blob, build_core_gql, build_tree_children_query, merge_tree_children, filter_rest_tree } from './graphql.js';
import { build_repo_overview_result } from './markdown-builder.js';

const logger = loggers.fetch();

export async function fetch_docs_tree(token: string, owner: string, repo: string, docs_dir: string, tree_sha_or_branch: string): Promise<string[]> {
	const tree_data = await github_get_safe<{ tree: Array<{ path: string; type: string }> }>(
		token, `/repos/${owner}/${repo}/git/trees/${tree_sha_or_branch}:${docs_dir}?recursive=1`,
	);
	if (!tree_data?.tree) return [];
	return tree_data.tree
		.filter((entry) => entry.type === 'blob' && is_docs_md_file(entry.path))
		.map((entry) => entry.path);
}

export async function fetch_repo_overview(token: string, owner: string, repo: string): Promise<FetchResult> {
	try {
		return await fetch_repo_overview_gql(token, owner, repo);
	} catch (gql_error) {
		logger.warn('GraphQL fast path failed, falling back to REST', {
			op: 'graphql_fallback', owner, repo,
			error: gql_error instanceof Error ? gql_error.message : String(gql_error),
		});
		return await fetch_repo_overview_rest(token, owner, repo);
	}
}

// ── GraphQL path ────────────────────────────────────────────────

export async function fetch_repo_overview_gql(token: string, owner: string, repo: string): Promise<FetchResult> {
	type GqlResponse = { data?: { repository: GitHubAny; rateLimit: { remaining: number; resetAt: string } }; errors?: Array<{ message: string }> };
	logger.info('Fetching repo overview via GraphQL', { op: 'gql_overview', owner, repo });

	const gql = await github_graphql<GqlResponse>(token, build_core_gql(), { owner, repo });
	if (gql.errors?.length) throw new Error(gql.errors.map((error) => error.message).join('; '));
	const repository = gql.data?.repository;
	if (!repository) throw new Error('Repository not found via GraphQL');

	const rate = gql.data?.rateLimit as { remaining: number; resetAt: string } | undefined;
	const default_branch = (repository.defaultBranchRef as GitHubAny)?.name as string || 'main';
	const owner_obj = repository.owner as { login: string; url: string; __typename: string };
	const license_info = repository.licenseInfo as { name: string; spdxId: string } | null;

	const { tree_entries, docs_files, docs_dir_name } = await fetch_gql_tree_and_docs(token, owner, repo, repository, default_branch);
	const { context_files, too_large_context } = extract_gql_context_files(repository);
	const { ai_rules_listing, ai_rules_inline } = extract_gql_ai_rules(repository);
	const dep_configs = extract_gql_dep_configs(repository);
	const monthly_commits = extract_gql_monthly_commits(repository);

	const { commit_nodes, issues_data, prs_data, release_nodes, star_edges, languages, parent } = extract_gql_enrichment(repository);
	const data: RepoOverviewData = {
		full_name: repository.nameWithOwner as string,
		description: (repository.description as string) || '_No description_',
		owner: { login: owner_obj.login, url: owner_obj.url, type: owner_obj.__typename },
		license: license_info ? { name: license_info.name, id: license_info.spdxId } : null,
		visibility: repository.visibility as string,
		default_branch,
		created_at: repository.createdAt as string,
		pushed_at: repository.pushedAt as string,
		is_fork: repository.isFork as boolean,
		is_archived: repository.isArchived as boolean,
		fork_parent: parent ? { name: parent.nameWithOwner as string, url: parent.url as string } : null,
		disk_usage_bytes: (repository.diskUsage as number) * 1024,
		stars: repository.stargazerCount as number,
		forks: repository.forkCount as number,
		open_issues_count: issues_data?.totalCount ?? 0,
		open_prs_count: prs_data?.totalCount ?? 0,
		watchers: (repository.watchers as { totalCount: number })?.totalCount ?? 0,
		star_velocity: format_star_velocity(repository.stargazerCount as number, star_edges.map((edge) => edge.starredAt)),
		topics: ((repository.repositoryTopics as { nodes: Array<{ topic: { name: string } }> })?.nodes ?? []).map((node) => node.topic.name),
		features: (['Issues', 'Wiki', 'Discussions', 'Projects'] as const).filter((feature) => repository[`has${feature}Enabled`]).map((feature) => feature.toLowerCase()).join(', '),
		languages,
		tree_entries,
		docs_dir_name,
		docs_files,
		ai_rules_listing,
		ai_rules_inline,
		dep_configs,
		readme: [0, 1, 2, 3, 4].reduce<{ text: string; size: number } | null>((found, index) => found ?? extract_gql_blob(repository[`readme_${index}`], README_MAX_BYTES), null),
		context_files,
		too_large_context,
		extra_detected: [repository.contributing_md ? 'CONTRIBUTING.md' : '', repository.changelog_md ? 'CHANGELOG.md' : ''].filter(Boolean),
		commits: commit_nodes.map((commit) => ({ date: commit.committedDate, author: commit.author?.name ?? 'unknown', message: commit.message.split('\n')[0].slice(0, COMMIT_MESSAGE_MAX_CHARS) })),
		monthly_commits,
		issues: (issues_data?.nodes ?? []).map(map_gql_issue),
		pull_requests: (prs_data?.nodes ?? []).map(map_gql_pull_request),
		releases: release_nodes.map(map_gql_release),
		api_source: 'graphql',
		rate_limit_remaining: rate?.remaining,
	};

	return build_repo_overview_result(data);
}

// ── GQL data extraction helpers ────────────────────────────────

async function fetch_gql_tree_and_docs(
	token: string, owner: string, repo: string, repository: GitHubAny, default_branch: string,
): Promise<{ tree_entries: Array<{ path: string; type: string; size?: number }>; docs_files: string[]; docs_dir_name: string | null }> {
	type GqlResponse = { data?: { repository: GitHubAny }; errors?: Array<{ message: string }> };
	const root_tree_entries = (repository.rootTree as GitHubAny)?.entries as Array<{ name: string; type: string; object?: unknown }> ?? [];
	const queryable_dirs = root_tree_entries.filter((entry) => entry.type === 'tree' && !NOISY_DIR_NAMES.has(entry.name.toLowerCase())).map((entry) => entry.name);

	const tree_children_promise = queryable_dirs.length > 0
		? (async () => {
			try {
				const children_gql = await github_graphql<GqlResponse>(token, build_tree_children_query(queryable_dirs), { owner, repo });
				if (!children_gql.errors?.length && children_gql.data?.repository) return children_gql.data.repository;
			} catch (tree_error) {
				logger.debug('Tree children query failed (graceful)', { op: 'tree_children_fail', owner, repo, error: tree_error instanceof Error ? tree_error.message : String(tree_error) });
			}
			return null;
		})()
		: Promise.resolve(null);

	const docs_dir_name = root_tree_entries.find((entry) => entry.type === 'tree' && DOCS_DIR_NAMES.has(entry.name.toLowerCase()))?.name ?? null;
	const docs_files_promise = docs_dir_name ? fetch_docs_tree(token, owner, repo, docs_dir_name, default_branch) : Promise.resolve([]);

	const [tree_children_data, docs_files] = await Promise.all([tree_children_promise, docs_files_promise]);
	return { tree_entries: merge_tree_children(root_tree_entries, tree_children_data, queryable_dirs), docs_files, docs_dir_name };
}

const GQL_CONTEXT_MAP: Record<string, string> = {
	'CLAUDE.md': 'claude_md', 'AGENTS.md': 'agents_md', 'GEMINI.md': 'gemini_md', 'AGENT.md': 'agent_md',
	'ARCHITECTURE.md': 'architecture_md', 'DEVELOPMENT.md': 'development_md', 'CONVENTIONS.md': 'conventions_md', 'REVIEW.md': 'review_md',
	'.cursorrules': 'cursorrules', '.windsurfrules': 'windsurfrules', '.clinerules': 'clinerules', '.goosehints': 'goosehints',
	'.roorules': 'roorules', '.continuerules': 'continuerules', '.github/copilot-instructions.md': 'copilot_md',
	'.junie/guidelines.md': 'junie_guidelines', 'llms.txt': 'llms_txt', 'llms-full.txt': 'llms_full_txt',
};

function extract_gql_context_files(repository: GitHubAny): { context_files: Map<string, { text: string; size: number }>; too_large_context: string[] } {
	const context_files = new Map<string, { text: string; size: number }>();
	const too_large_context: string[] = [];
	for (const [name, gql_field] of Object.entries(GQL_CONTEXT_MAP)) {
		const blob = extract_gql_blob(repository[gql_field], CONTEXT_FILE_LIMITS[name]);
		if (blob) { context_files.set(name, blob); continue; }
		const raw_obj = repository[gql_field] as GqlBlob | null;
		if (raw_obj?.byteSize) too_large_context.push(`${name} (${format_size(raw_obj.byteSize)} — too large to inline)`);
	}
	return { context_files, too_large_context };
}

function extract_gql_ai_rules(repository: GitHubAny): { ai_rules_listing: Map<string, Array<{ name: string; size: number }>>; ai_rules_inline: Map<string, { name: string; text: string; size: number }> } {
	const ai_rules_listing = new Map<string, Array<{ name: string; size: number }>>();
	const ai_rules_inline = new Map<string, { name: string; text: string; size: number }>();
	for (const [directory_path, { gql_alias }] of Object.entries(AI_RULES_DIRS)) {
		const tree = repository[gql_alias] as { entries?: Array<{ name: string; type: string; object?: { text?: string; byteSize?: number } }> } | null;
		if (!tree?.entries) continue;
		const files = tree.entries.filter((entry) => entry.type === 'blob' && entry.object?.byteSize).map((entry) => ({ name: entry.name, size: entry.object!.byteSize!, text: entry.object?.text }));
		if (files.length === 0) continue;
		ai_rules_listing.set(directory_path, files.map((file) => ({ name: file.name, size: file.size })));
		if (files.length === 1 && files[0].size <= AI_RULES_INLINE_MAX_BYTES && files[0].text) {
			ai_rules_inline.set(directory_path, { name: files[0].name, text: files[0].text, size: files[0].size });
		}
	}
	return { ai_rules_listing, ai_rules_inline };
}

function extract_gql_dep_configs(repository: GitHubAny): Array<{ name: string; text: string }> {
	const dep_configs: Array<{ name: string; text: string }> = [];
	for (const [name, { gql_alias, max_bytes }] of Object.entries(DEP_CONFIG_ALLOWLIST)) {
		const blob = extract_gql_blob(repository[gql_alias], max_bytes);
		if (blob) dep_configs.push({ name, text: blob.text });
	}
	return dep_configs;
}

function extract_gql_enrichment(repository: GitHubAny) {
	const target = (repository.defaultBranchRef as GitHubAny)?.target as GitHubAny;
	const commit_history = target?.history as { nodes: Array<{ oid: string; message: string; committedDate: string; author: { name: string } }> } | undefined;
	const languages: Record<string, number> = {};
	for (const edge of ((repository.languages as { edges: Array<{ size: number; node: { name: string } }> })?.edges ?? [])) languages[edge.node.name] = edge.size;
	return {
		commit_nodes: commit_history?.nodes ?? [],
		issues_data: repository.issues as { totalCount: number; nodes: GitHubAny[] } | undefined,
		prs_data: repository.pullRequests as { totalCount: number; nodes: GitHubAny[] } | undefined,
		release_nodes: (repository.releases as { nodes: GitHubAny[] })?.nodes ?? [],
		star_edges: (repository.recent_stars as { edges: Array<{ starredAt: string }> })?.edges ?? [],
		languages,
		parent: repository.parent as GitHubAny | undefined,
	};
}

function map_rest_commit(commit: GitHubAny) {
	const commit_obj = commit.commit as GitHubAny;
	const author_obj = (commit_obj?.author ?? {}) as GitHubAny;
	return { date: (author_obj?.date as string) ?? '', author: (author_obj?.name as string) ?? 'unknown', message: ((commit_obj?.message as string) ?? '').split('\n')[0].slice(0, COMMIT_MESSAGE_MAX_CHARS) };
}

function map_rest_issue(issue: GitHubAny) {
	return {
		number: issue.number as number, title: issue.title as string, state: issue.state as string,
		author: ((issue.user as GitHubAny)?.login as string) ?? 'ghost',
		labels: ((issue.labels as Array<{ name: string }>) ?? []).map((label) => `\`${label.name}\``).join(' '),
		updated_at: issue.updated_at as string, body: (issue.body as string) ?? '',
	};
}

function map_rest_pull_request(pull_request: GitHubAny) {
	return {
		number: pull_request.number as number, title: pull_request.title as string,
		author: ((pull_request.user as GitHubAny)?.login as string) ?? 'ghost',
		labels: ((pull_request.labels as Array<{ name: string }>) ?? []).map((label) => `\`${label.name}\``).join(' '),
		updated_at: pull_request.updated_at as string, is_draft: pull_request.draft as boolean, body: (pull_request.body as string) ?? '',
	};
}

function map_rest_release(release: GitHubAny) {
	return {
		name: (release.name as string) || (release.tag_name as string),
		tag: release.tag_name as string, published_at: release.published_at as string,
		is_prerelease: release.prerelease as boolean, body: (release.body as string) ?? '',
	};
}

function map_gql_issue(issue: GitHubAny) {
	return {
		number: issue.number as number, title: issue.title as string,
		state: ((issue.state as string) ?? '').toLowerCase(),
		author: (issue.author as { login: string })?.login ?? 'ghost',
		labels: ((issue.labels as { nodes: Array<{ name: string }> })?.nodes ?? []).map((label) => `\`${label.name}\``).join(' '),
		updated_at: issue.updatedAt as string, body: (issue.body as string) ?? '',
	};
}

function map_gql_pull_request(pull_request: GitHubAny) {
	return {
		number: pull_request.number as number, title: pull_request.title as string,
		author: (pull_request.author as { login: string })?.login ?? 'ghost',
		labels: ((pull_request.labels as { nodes: Array<{ name: string }> })?.nodes ?? []).map((label) => `\`${label.name}\``).join(' '),
		updated_at: pull_request.updatedAt as string, is_draft: pull_request.isDraft as boolean, body: (pull_request.body as string) ?? '',
	};
}

function map_gql_release(release: GitHubAny) {
	return {
		name: (release.name as string) || (release.tagName as string),
		tag: release.tagName as string, published_at: release.publishedAt as string,
		is_prerelease: release.isPrerelease as boolean, body: (release.description as string) ?? '',
	};
}

function extract_gql_monthly_commits(repository: GitHubAny): Array<{ month: string; count: number }> {
	const target = (repository.defaultBranchRef as GitHubAny)?.target as GitHubAny;
	if (!target) return [];
	const monthly: Array<{ month: string; count: number }> = [];
	for (const [key, value] of Object.entries(target)) {
		if (key.startsWith('m') && typeof value === 'object' && value !== null && 'totalCount' in (value as Record<string, unknown>)) {
			const month = key.substring(1).replace('_', '-');
			const count = (value as { totalCount: number }).totalCount;
			if (count > 0) monthly.push({ month, count });
		}
	}
	return monthly.sort((a, b) => a.month.localeCompare(b.month));
}

// ── REST path ───────────────────────────────────────────────────

export async function fetch_repo_overview_rest(token: string, owner: string, repo: string): Promise<FetchResult> {
	logger.info('Fetching repo overview via REST', { op: 'rest_overview', owner, repo });

	const [repo_data, readme_raw, languages] = await Promise.all([
		github_get<GitHubAny>(token, `/repos/${owner}/${repo}`),
		github_get_raw_safe(token, `/repos/${owner}/${repo}/readme`),
		github_get_safe<Record<string, number>>(token, `/repos/${owner}/${repo}/languages`),
	]);

	const default_branch = repo_data.default_branch as string;
	const total_stars = repo_data.stargazers_count as number;
	const star_last_page = Math.min(STARGAZER_MAX_PAGE, Math.max(1, Math.ceil(total_stars / 30)));

	const [commits, issues, pulls, releases, tree_data, stargazers_raw] = await Promise.all([
		github_get_safe<GitHubAny[]>(token, `/repos/${owner}/${repo}/commits?sha=${default_branch}&per_page=${OVERVIEW_COMMITS_PER_PAGE}`),
		github_get_safe<GitHubAny[]>(token, `/repos/${owner}/${repo}/issues?state=open&per_page=${OVERVIEW_ISSUES_PER_PAGE}&sort=updated`),
		github_get_safe<GitHubAny[]>(token, `/repos/${owner}/${repo}/pulls?state=open&per_page=${OVERVIEW_PRS_PER_PAGE}&sort=updated&direction=desc`),
		github_get_safe<GitHubAny[]>(token, `/repos/${owner}/${repo}/releases?per_page=${OVERVIEW_RELEASES_PER_PAGE}`),
		github_get_safe<{ tree: Array<{ path: string; type: string; size?: number }>; truncated?: boolean }>(token, `/repos/${owner}/${repo}/git/trees/${default_branch}?recursive=1`),
		total_stars > 0 ? github_get_starred(token, `/repos/${owner}/${repo}/stargazers?per_page=30&page=${star_last_page}`) : Promise.resolve(null),
	]);

	const { full_tree, tree_truncated, tree_paths, raw_tree, docs_dir_name, docs_files } = process_rest_tree(tree_data);
	const { context_files, dep_configs_rest } = await fetch_rest_context_and_deps(token, owner, repo, tree_paths, tree_truncated);
	const { ai_rules_listing, ai_rules_inline } = await fetch_rest_ai_rules(token, owner, repo, full_tree);
	const parent = repo_data.parent as GitHubAny | undefined;
	const license_info = repo_data.license as GitHubAny | null;
	const real_issues = (issues ?? []).filter((issue) => !(issue as GitHubAny).pull_request);

	const data: RepoOverviewData = {
		full_name: repo_data.full_name as string,
		description: (repo_data.description as string) || '_No description_',
		owner: { login: (repo_data.owner as GitHubAny).login as string, url: (repo_data.owner as GitHubAny).html_url as string, type: (repo_data.owner as GitHubAny).type as string },
		license: license_info ? { name: license_info.name as string, id: (license_info.spdx_id as string) ?? 'NOASSERTION' } : null,
		visibility: repo_data.visibility as string,
		default_branch,
		created_at: repo_data.created_at as string,
		pushed_at: repo_data.pushed_at as string,
		is_fork: repo_data.fork as boolean,
		is_archived: repo_data.archived as boolean,
		fork_parent: parent ? { name: parent.full_name as string, url: parent.html_url as string } : null,
		disk_usage_bytes: (repo_data.size as number) * 1024,
		stars: repo_data.stargazers_count as number,
		forks: repo_data.forks_count as number,
		open_issues_count: repo_data.open_issues_count as number,
		open_prs_count: (pulls ?? []).length,
		watchers: (repo_data.subscribers_count ?? repo_data.watchers_count) as number,
		star_velocity: format_star_velocity(total_stars, (stargazers_raw ?? []).map((stargazer) => stargazer.starred_at).filter(Boolean)),
		topics: (repo_data.topics as string[]) ?? [],
		features: ['issues', 'wiki', 'discussions', 'projects', 'pages'].filter((feature) => repo_data[`has_${feature}`]).join(', '),
		languages: languages ?? {},
		tree_entries: filter_rest_tree(raw_tree),
		docs_dir_name,
		docs_files,
		ai_rules_listing,
		ai_rules_inline,
		dep_configs: dep_configs_rest,
		readme: readme_raw ? { text: readme_raw, size: readme_raw.length } : null,
		context_files: new Map([...context_files.entries()].map(([key, value]) => [key, { text: value.content, size: value.size }])),
		too_large_context: [],
		extra_detected: ['CONTRIBUTING.md', 'CHANGELOG.md'].filter((filename) => tree_paths.has(filename) && !context_files.has(filename)),
		commits: (commits ?? []).map(map_rest_commit),
		monthly_commits: [],
		issues: real_issues.map(map_rest_issue),
		pull_requests: (pulls ?? []).map(map_rest_pull_request),
		releases: (releases ?? []).map(map_rest_release),
		api_source: 'rest',
	};

	return build_repo_overview_result(data);
}

// ── REST data extraction helpers ────────────────────────────────

function process_rest_tree(tree_data: { tree: Array<{ path: string; type: string; size?: number }>; truncated?: boolean } | null) {
	const full_tree = tree_data?.tree ?? [];
	const tree_truncated = tree_data?.truncated === true;
	const tree_paths = new Set(full_tree.map((entry) => entry.path));
	const raw_tree = full_tree.filter((entry) => entry.path.split('/').length <= 2);
	const docs_dir_name = raw_tree.find((entry) => entry.type === 'tree' && DOCS_DIR_NAMES.has(entry.path.toLowerCase()))?.path ?? null;
	const docs_files = docs_dir_name
		? full_tree.filter((entry) => entry.type === 'blob' && entry.path.startsWith(`${docs_dir_name}/`) && is_docs_md_file(entry.path)).map((entry) => entry.path.substring(docs_dir_name.length + 1))
		: [];
	return { full_tree, tree_truncated, tree_paths, raw_tree, docs_dir_name, docs_files };
}

async function fetch_rest_context_and_deps(
	token: string, owner: string, repo: string, tree_paths: Set<string>, tree_truncated: boolean,
): Promise<{ context_files: Map<string, { content: string; size: number }>; dep_configs_rest: Array<{ name: string; text: string }> }> {
	const context_fetches = CONTEXT_FILE_NAMES
		.filter((name) => tree_truncated || tree_paths.has(name))
		.map(async (name): Promise<[string, { content: string; size: number }] | null> => {
			const raw = await github_get_raw_safe(token, `/repos/${owner}/${repo}/contents/${name}`);
			if (!raw || raw.length > CONTEXT_FILE_LIMITS[name]) return null;
			return [name, { content: raw, size: raw.length }];
		});

	const dep_config_fetches = Object.entries(DEP_CONFIG_ALLOWLIST)
		.filter(([name]) => tree_truncated || tree_paths.has(name))
		.map(async ([name, { max_bytes }]): Promise<{ name: string; text: string } | null> => {
			const raw = await github_get_raw_safe(token, `/repos/${owner}/${repo}/contents/${name}`);
			if (!raw || raw.length > max_bytes) return null;
			return { name, text: raw };
		});

	const [context_results, ...dep_config_results] = await Promise.all([Promise.all(context_fetches), ...dep_config_fetches]);
	const context_files = new Map<string, { content: string; size: number }>();
	for (const context_result of context_results) {
		if (context_result) context_files.set(context_result[0], context_result[1]);
	}
	return { context_files, dep_configs_rest: dep_config_results.filter((result): result is { name: string; text: string } => result != null) };
}

async function fetch_rest_ai_rules(
	token: string, owner: string, repo: string, full_tree: Array<{ path: string; type: string; size?: number }>,
): Promise<{ ai_rules_listing: Map<string, Array<{ name: string; size: number }>>; ai_rules_inline: Map<string, { name: string; text: string; size: number }> }> {
	const ai_rules_listing = new Map<string, Array<{ name: string; size: number }>>();
	const ai_rules_inline = new Map<string, { name: string; text: string; size: number }>();
	for (const [directory_path] of Object.entries(AI_RULES_DIRS)) {
		const matching_files = full_tree.filter((entry) =>
			entry.type === 'blob' && entry.path.startsWith(`${directory_path}/`) && entry.path.split('/').length === directory_path.split('/').length + 1,
		);
		if (matching_files.length === 0) continue;
		ai_rules_listing.set(directory_path, matching_files.map((file) => ({ name: file.path.split('/').pop()!, size: file.size ?? 0 })));
		if (matching_files.length === 1 && (matching_files[0].size ?? 0) <= AI_RULES_INLINE_MAX_BYTES) {
			const raw = await github_get_raw_safe(token, `/repos/${owner}/${repo}/contents/${matching_files[0].path}`);
			if (raw) ai_rules_inline.set(directory_path, { name: matching_files[0].path.split('/').pop()!, text: raw, size: raw.length });
		}
	}
	return { ai_rules_listing, ai_rules_inline };
}
