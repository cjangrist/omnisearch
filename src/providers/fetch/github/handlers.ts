// GitHub resource handlers — individual resource fetch functions
// Repo overview (GQL + REST) is in repo-overview.ts

import type { FetchResult } from '../../../common/types.js';
import { loggers } from '../../../common/logger.js';
import type { GitHubAny } from './types.js';
import { github_get, github_get_raw, github_get_safe, github_get_raw_safe } from './api.js';
import { format_size, format_date, format_tree, is_binary, snippet_two_sentences, escape_table_cell } from './formatters.js';
import { LIST_PER_PAGE, COMMENTS_PER_PAGE, PATCH_MAX_CHARS, RELEASE_BODY_MAX_CHARS } from './constants.js';
import { fetch_repo_overview } from './repo-overview.js';
export { fetch_repo_overview };
export { fetch_file, fetch_directory, fetch_wiki_page } from './handlers-file.js';

const logger = loggers.fetch();


export async function fetch_issue(token: string, owner: string, repo: string, issue_number: string): Promise<FetchResult> {
	const [issue, comments] = await Promise.all([
		github_get<GitHubAny>(token, `/repos/${owner}/${repo}/issues/${issue_number}`),
		github_get_safe<GitHubAny[]>(token, `/repos/${owner}/${repo}/issues/${issue_number}/comments?per_page=${COMMENTS_PER_PAGE}`),
	]);

	const labels = ((issue.labels as Array<{ name: string }>) ?? []).map((l) => `\`${l.name}\``).join(' ');
	const assignees = ((issue.assignees as Array<{ login: string }>) ?? []).map((a) => `@${a.login}`).join(', ');

	let content = `# Issue #${issue.number}: ${issue.title}\n\n`;
	content += `| Field | Value |\n|-------|-------|\n`;
	content += `| State | ${issue.state} |\n`;
	content += `| Author | @${((issue.user as GitHubAny)?.login ?? "ghost")} |\n`;
	content += `| Created | ${format_date(issue.created_at as string)} |\n`;
	content += `| Updated | ${format_date(issue.updated_at as string)} |\n`;
	if (issue.closed_at) content += `| Closed | ${format_date(issue.closed_at as string)} |\n`;
	content += `| Labels | ${labels || 'None'} |\n`;
	content += `| Assignees | ${assignees || 'None'} |\n`;
	content += `| Comments | ${issue.comments} |\n`;
	content += `\n---\n\n`;

	if (issue.body) content += `${issue.body}\n\n`;

	if (comments && comments.length > 0) {
		const comments_note = comments.length >= COMMENTS_PER_PAGE ? ` (showing first 50 of ${issue.comments})` : '';
		content += `---\n\n## Comments (${comments.length}${comments_note})\n\n`;
		for (const c of comments) {
			content += `### @${((c.user as GitHubAny)?.login ?? "ghost")} - ${format_date(c.created_at as string)}\n\n${(c.body as string) ?? ''}\n\n---\n\n`;
		}
	}

	return {
		url: issue.html_url as string,
		title: `Issue #${issue.number}: ${issue.title} - ${owner}/${repo}`,
		content,
		source_provider: 'github',
		metadata: { resource_type: 'issue', state: issue.state, comments_count: issue.comments },
	};
}

export async function fetch_issue_list(token: string, owner: string, repo: string): Promise<FetchResult> {
	const issues = await github_get<GitHubAny[]>(token, `/repos/${owner}/${repo}/issues?state=open&per_page=${LIST_PER_PAGE}&sort=updated`);

	// Filter out PRs
	const real_issues = issues.filter((i) => !(i as GitHubAny).pull_request);

	const truncated_note = issues.length >= LIST_PER_PAGE ? ' (API returned 100 results — more may exist)' : '';
	let content = `# Open Issues - ${owner}/${repo}\n\n**Total shown:** ${real_issues.length}${truncated_note}\n\n`;
	content += `| # | Title | Labels | Author | Updated |\n|---|-------|--------|--------|---------|\n`;
	for (const issue of real_issues) {
		const labels = ((issue.labels as Array<{ name: string }>) ?? []).map((l) => l.name).join(', ');
		content += `| ${issue.number} | ${escape_table_cell(issue.title as string)} | ${escape_table_cell(labels) || '-'} | @${((issue.user as GitHubAny)?.login ?? "ghost")} | ${format_date(issue.updated_at as string)} |\n`;
	}
	content += `\n---\n*Fetched via GitHub API*\n`;

	return {
		url: `https://github.com/${owner}/${repo}/issues`,
		title: `Open Issues - ${owner}/${repo}`,
		content,
		source_provider: 'github',
		metadata: { resource_type: 'issue_list', count: real_issues.length },
	};
}

export async function fetch_pr_list(token: string, owner: string, repo: string): Promise<FetchResult> {
	const prs = await github_get<GitHubAny[]>(token, `/repos/${owner}/${repo}/pulls?state=open&per_page=${LIST_PER_PAGE}&sort=updated&direction=desc`);

	const truncated_note = prs.length >= LIST_PER_PAGE ? ' (showing first 100 — more may exist)' : '';
	let content = `# Open Pull Requests - ${owner}/${repo}\n\n**Total shown:** ${prs.length}${truncated_note}\n\n`;
	content += `| # | Title | Author | Draft | Updated |\n|---|-------|--------|-------|---------|\n`;
	for (const pr of prs) {
		content += `| ${pr.number} | ${escape_table_cell(pr.title as string)} | @${((pr.user as GitHubAny)?.login ?? "ghost")} | ${pr.draft ? 'Yes' : '-'} | ${format_date(pr.updated_at as string)} |\n`;
	}
	content += `\n---\n*Fetched via GitHub API*\n`;

	return {
		url: `https://github.com/${owner}/${repo}/pulls`,
		title: `Open Pull Requests - ${owner}/${repo}`,
		content,
		source_provider: 'github',
		metadata: { resource_type: 'pr_list', count: prs.length },
	};
}


export async function fetch_pull_request(token: string, owner: string, repo: string, pr_number: string, include_files: boolean): Promise<FetchResult> {
	const [pr, files] = await Promise.all([
		github_get<GitHubAny>(token, `/repos/${owner}/${repo}/pulls/${pr_number}`),
		include_files ? github_get_safe<GitHubAny[]>(token, `/repos/${owner}/${repo}/pulls/${pr_number}/files?per_page=${LIST_PER_PAGE}`) : Promise.resolve(null),
	]);

	const state = pr.merged_at ? 'merged' : (pr.state as string);

	let content = `# PR #${pr.number}: ${pr.title}\n\n`;
	content += `| Field | Value |\n|-------|-------|\n`;
	content += `| State | ${state} |\n`;
	content += `| Draft | ${pr.draft ? 'Yes' : 'No'} |\n`;
	content += `| Author | @${((pr.user as GitHubAny)?.login ?? "ghost")} |\n`;
	content += `| Created | ${format_date(pr.created_at as string)} |\n`;
	if (pr.merged_at) content += `| Merged | ${format_date(pr.merged_at as string)} |\n`;
	content += `| Base | \`${(pr.base as GitHubAny).ref}\` <- Head: \`${(pr.head as GitHubAny).ref}\` |\n`;
	content += `| Files Changed | ${pr.changed_files} |\n`;
	content += `| Additions | +${pr.additions} |\n`;
	content += `| Deletions | -${pr.deletions} |\n`;
	content += `\n`;

	if (pr.body) content += `---\n\n${pr.body}\n\n`;

	if (files && files.length > 0) {
		const files_truncated = (pr.changed_files as number) > files.length ? ` (showing ${files.length} of ${pr.changed_files})` : '';
		content += `---\n\n## Changed Files (${files.length}${files_truncated})\n\n`;
		for (const f of files) {
			content += `### ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})\n\n`;
			if (f.patch) {
				const patch = (f.patch as string).slice(0, PATCH_MAX_CHARS);
				content += `\`\`\`\`\`diff\n${patch}${(f.patch as string).length > PATCH_MAX_CHARS ? '\n... (truncated)' : ''}\n\`\`\`\`\`\n\n`;
			}
		}
	}

	return {
		url: pr.html_url as string,
		title: `PR #${pr.number}: ${pr.title} - ${owner}/${repo}`,
		content,
		source_provider: 'github',
		metadata: { resource_type: include_files ? 'pr_files' : 'pull_request', state, additions: pr.additions, deletions: pr.deletions, changed_files: pr.changed_files },
	};
}

export async function fetch_release_list(token: string, owner: string, repo: string): Promise<FetchResult> {
	const releases = await github_get<GitHubAny[]>(token, `/repos/${owner}/${repo}/releases?per_page=10`);

	let content = `# Releases - ${owner}/${repo}\n\n`;
	if (releases.length === 0) {
		content += `_No releases published_\n`;
	} else {
		for (const rel of releases) {
			content += `## ${rel.name || rel.tag_name} (\`${rel.tag_name}\`)\n`;
			content += `**Published:** ${format_date(rel.published_at as string)} | **Author:** @${((rel.author as GitHubAny)?.login as string) ?? 'ghost'}`;
			if (rel.prerelease) content += ` | Pre-release`;
			if (rel.draft) content += ` | Draft`;
			content += `\n\n`;
			const body = (rel.body as string) ?? '';
			if (body) content += `${body.slice(0, RELEASE_BODY_MAX_CHARS)}${body.length > RELEASE_BODY_MAX_CHARS ? '\n... (truncated)' : ''}\n\n`;
			content += `---\n\n`;
		}
	}

	return {
		url: `https://github.com/${owner}/${repo}/releases`,
		title: `Releases - ${owner}/${repo}`,
		content,
		source_provider: 'github',
		metadata: { resource_type: 'release_list', count: releases.length },
	};
}

export function format_release_detail(rel: GitHubAny, owner: string, repo: string): FetchResult {
	let content = `# Release: ${rel.name || rel.tag_name}\n\n`;
	content += `**Tag:** \`${rel.tag_name}\` | **Published:** ${format_date(rel.published_at as string)} | **Author:** @${((rel.author as GitHubAny)?.login as string) ?? 'ghost'}\n\n`;
	if (rel.body) content += `${rel.body}\n\n`;

	const assets = (rel.assets as GitHubAny[]) ?? [];
	if (assets.length > 0) {
		content += `## Assets\n\n| Name | Size | Downloads |\n|------|------|-----------|\n`;
		for (const a of assets) {
			content += `| ${escape_table_cell((a.name as string) ?? '')} | ${format_size(a.size as number)} | ${a.download_count} |\n`;
		}
	}

	return {
		url: rel.html_url as string,
		title: `Release ${rel.tag_name} - ${owner}/${repo}`,
		content,
		source_provider: 'github',
		metadata: { resource_type: 'release', tag: rel.tag_name },
	};
}

export async function fetch_release(token: string, owner: string, repo: string, tag: string): Promise<FetchResult> {
	const rel = await github_get<GitHubAny>(token, `/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`);
	return format_release_detail(rel, owner, repo);
}

export async function fetch_release_latest(token: string, owner: string, repo: string): Promise<FetchResult> {
	const rel = await github_get<GitHubAny>(token, `/repos/${owner}/${repo}/releases/latest`);
	return format_release_detail(rel, owner, repo);
}

export async function fetch_commit_list(token: string, owner: string, repo: string, ref: string | undefined): Promise<FetchResult> {
	const sha_param = ref ? `?sha=${encodeURIComponent(ref)}&per_page=30` : '?per_page=30';
	const commits = await github_get<GitHubAny[]>(token, `/repos/${owner}/${repo}/commits${sha_param}`);

	let content = `# Commits - ${owner}/${repo}${ref ? ` (${ref})` : ''}\n\n`;
	content += `| Date | Author | SHA | Message |\n|------|--------|-----|---------|\n`;
	for (const c of commits) {
		const commit_obj = c.commit as GitHubAny;
		const author_obj = (commit_obj?.author ?? {}) as GitHubAny;
		const sha_short = (c.sha as string).slice(0, 7);
		const msg = escape_table_cell(((commit_obj?.message as string) ?? '').split('\n')[0].slice(0, 80));
		content += `| ${format_date(author_obj?.date as string)} | ${escape_table_cell((author_obj?.name as string) ?? 'unknown')} | \`${sha_short}\` | ${msg} |\n`;
	}
	content += `\n---\n*Fetched via GitHub API*\n`;

	return {
		url: `https://github.com/${owner}/${repo}/commits${ref ? `/${ref}` : ''}`,
		title: `Commits - ${owner}/${repo}`,
		content,
		source_provider: 'github',
		metadata: { resource_type: 'commit_list', count: commits.length, ref },
	};
}

export async function fetch_commit(token: string, owner: string, repo: string, sha: string): Promise<FetchResult> {
	const c = await github_get<GitHubAny>(token, `/repos/${owner}/${repo}/commits/${sha}`);
	const commit_obj = c.commit as GitHubAny;
	const author_obj = (commit_obj?.author ?? {}) as GitHubAny;
	const stats = c.stats as GitHubAny | undefined;
	const files = (c.files as GitHubAny[]) ?? [];

	let content = `# Commit \`${(c.sha as string).slice(0, 7)}\`\n\n`;
	content += `**Message:** ${commit_obj?.message ?? ''}\n\n`;
	content += `**Author:** ${(author_obj?.name as string) ?? 'unknown'} <${(author_obj?.email as string) ?? ''}>\n**Date:** ${format_date(author_obj?.date as string)}\n`;
	if (stats) {
		content += `**Stats:** +${stats.additions} -${stats.deletions} (${stats.total} total)\n`;
	}
	content += `\n`;

	if (files.length > 0) {
		const files_note = files.length >= 300 ? ' (API limit — more files may exist)' : '';
		content += `## Changed Files (${files.length}${files_note})\n\n`;
		for (const f of files) {
			content += `### ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})\n\n`;
			if (f.patch) {
				const patch = (f.patch as string).slice(0, PATCH_MAX_CHARS);
				content += `\`\`\`\`\`diff\n${patch}${(f.patch as string).length > PATCH_MAX_CHARS ? '\n... (truncated)' : ''}\n\`\`\`\`\`\n\n`;
			}
		}
	}

	return {
		url: c.html_url as string,
		title: `Commit ${(c.sha as string).slice(0, 7)} - ${owner}/${repo}`,
		content,
		source_provider: 'github',
		metadata: { resource_type: 'commit', sha: c.sha, additions: stats?.additions, deletions: stats?.deletions },
	};
}

export async function fetch_user_profile(token: string, username: string): Promise<FetchResult> {
	const [user, repos] = await Promise.all([
		github_get<GitHubAny>(token, `/users/${username}`),
		github_get_safe<GitHubAny[]>(token, `/users/${username}/repos?sort=updated&per_page=10`),
	]);

	let content = `# ${user.name || user.login}\n\n`;
	if (user.bio) content += `> ${user.bio}\n\n`;

	content += `| Field | Value |\n|-------|-------|\n`;
	content += `| Username | @${user.login} |\n`;
	content += `| Type | ${user.type} |\n`;
	if (user.company) content += `| Company | ${escape_table_cell(user.company as string)} |\n`;
	if (user.location) content += `| Location | ${escape_table_cell(user.location as string)} |\n`;
	if (user.blog) content += `| Blog | ${escape_table_cell(user.blog as string)} |\n`;
	content += `| Public Repos | ${user.public_repos} |\n`;
	content += `| Followers | ${user.followers} |\n`;
	content += `| Following | ${user.following} |\n`;
	content += `| Member Since | ${format_date(user.created_at as string)} |\n`;
	content += `\n`;

	if (repos && repos.length > 0) {
		content += `## Recent Repositories\n\n| Repo | Stars | Language | Description |\n|------|-------|----------|-------------|\n`;
		for (const r of repos) {
			const desc = escape_table_cell(((r.description as string) ?? '').slice(0, 60));
			content += `| [${escape_table_cell(r.name as string)}](${r.html_url}) | ${r.stargazers_count} | ${r.language || '-'} | ${desc} |\n`;
		}
	}
	content += `\n---\n*Fetched via GitHub API*\n`;

	return {
		url: user.html_url as string,
		title: `${user.name || user.login} (@${user.login})`,
		content,
		source_provider: 'github',
		metadata: { resource_type: 'user_profile', public_repos: user.public_repos, followers: user.followers },
	};
}

export async function fetch_gist(token: string, gist_id: string): Promise<FetchResult> {
	const gist = await github_get<GitHubAny>(token, `/gists/${gist_id}`);
	const files = gist.files as Record<string, GitHubAny>;

	let content = `# Gist: ${gist.description || gist_id}\n\n`;
	content += `**Author:** @${(gist.owner as GitHubAny)?.login || 'anonymous'} | **Public:** ${gist.public ? 'Yes' : 'No'} | **Created:** ${format_date(gist.created_at as string)}\n\n`;

	for (const [filename, file_data] of Object.entries(files)) {
		const lang = (file_data.language as string) ?? '';
		content += `## ${filename}\n\n`;
		if (file_data.truncated) {
			content += `_File truncated (${format_size(file_data.size as number)}). Fetch from raw URL._\n\n`;
		} else if (file_data.content) {
			content += `\`\`\`\`\`${lang.toLowerCase()}\n${file_data.content}\n\`\`\`\`\`\n\n`;
		}
	}

	return {
		url: gist.html_url as string,
		title: `Gist: ${gist.description || gist_id}`,
		content,
		source_provider: 'github',
		metadata: { resource_type: 'gist', file_count: Object.keys(files).length },
	};
}

export async function fetch_actions(token: string, owner: string, repo: string): Promise<FetchResult> {
	const runs = await github_get<{ workflow_runs: GitHubAny[] }>(token, `/repos/${owner}/${repo}/actions/runs?per_page=10`);

	let content = `# Actions - ${owner}/${repo}\n\n`;
	content += `| Status | Workflow | Branch | Event | Duration | Date |\n|--------|----------|--------|-------|----------|------|\n`;
	for (const r of runs.workflow_runs ?? []) {
		const conclusion = (r.conclusion as string) || (r.status as string);
		const icon = conclusion === 'success' ? 'pass' : conclusion === 'failure' ? 'FAIL' : conclusion;
		content += `| ${icon} | ${escape_table_cell((r.name as string) ?? '')} | ${escape_table_cell((r.head_branch as string) ?? '')} | ${r.event} | - | ${format_date(r.created_at as string)} |\n`;
	}
	content += `\n---\n*Fetched via GitHub API*\n`;

	return {
		url: `https://github.com/${owner}/${repo}/actions`,
		title: `Actions - ${owner}/${repo}`,
		content,
		source_provider: 'github',
		metadata: { resource_type: 'actions', run_count: (runs.workflow_runs ?? []).length },
	};
}

