// Shared markdown renderer for repo overview — used by both GQL and REST paths

import type { FetchResult } from '../../../common/types.js';
import type { RepoOverviewData } from './types.js';
import {
	format_size, format_date, format_language_breakdown, escape_table_cell,
	snippet_two_sentences, truncate_readme, format_docs_listing,
	format_ai_rules_listing, format_dep_configs, format_commit_activity,
	format_depth2_tree,
} from './formatters.js';

const CONTEXT_RENDER_ORDER = [
	'CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'AGENT.md',
	'ARCHITECTURE.md', 'DEVELOPMENT.md', 'CONVENTIONS.md', 'REVIEW.md',
	'.cursorrules', '.windsurfrules', '.clinerules', '.goosehints', '.roorules', '.continuerules',
	'.github/copilot-instructions.md', '.junie/guidelines.md',
];

function render_identity(data: RepoOverviewData): string {
	const lines = [
		`# ${data.full_name}\n\n> ${data.description}\n`,
		`\n**Project Identity**`,
		`| Field | Value |\n|-------|-------|`,
		`| Owner | [${data.owner.login}](${data.owner.url}) (${data.owner.type}) |`,
		`| License | ${data.license ? `${data.license.name} (${data.license.id})` : 'None'} |`,
		`| Visibility | ${data.visibility} |`,
		`| Default Branch | \`${data.default_branch}\` |`,
		`| Created | ${format_date(data.created_at)} |`,
		`| Last Push | ${format_date(data.pushed_at)} |`,
	];
	if (data.is_fork && data.fork_parent) lines.push(`| Forked From | [${data.fork_parent.name}](${data.fork_parent.url}) |`);
	lines.push(`| Archived | ${data.is_archived ? 'Yes' : 'No'} |`);
	lines.push('');
	return lines.join('\n');
}

function render_stats(data: RepoOverviewData): string {
	let result = `\n**Stats:** ${data.stars} stars, ${data.forks} forks, ${data.open_issues_count} open issues, ${data.open_prs_count} open PRs, ${data.watchers} watchers, ${format_size(data.disk_usage_bytes)}\n`;
	if (data.star_velocity) result += `**Star velocity:** ${data.star_velocity}\n`;
	result += '\n';
	if (data.topics.length > 0) result += `**Topics:** ${data.topics.map((topic) => `\`${topic}\``).join(' ')}\n\n`;
	if (data.features) result += `**Features:** ${data.features}\n\n`;
	return result;
}

function render_structure(data: RepoOverviewData): string {
	let result = '';
	if (Object.keys(data.languages).length > 0) {
		result += `## Languages\n\n| Language | Share | Size |\n|----------|-------|------|\n`;
		result += format_language_breakdown(data.languages);
		result += '\n\n';
	}
	if (data.tree_entries.length > 0) {
		result += `## Directory Structure (depth 2)\n\n\`\`\`\n${format_depth2_tree(data.tree_entries)}\n\`\`\`\n\n`;
	}
	if (data.docs_dir_name && data.docs_files.length > 0) {
		result += format_docs_listing(data.docs_dir_name, data.docs_files);
	}
	result += format_ai_rules_listing(data.ai_rules_listing);
	result += format_dep_configs(data.dep_configs);
	return result;
}

function render_context_files(data: RepoOverviewData): string {
	let result = '';
	const llms = data.context_files.get('llms.txt');
	if (llms) result += `## llms.txt\n\n\`\`\`\`\`markdown\n${llms.text.trimEnd()}\n\`\`\`\`\`\n\n`;
	if (data.readme) result += `## README\n\n${data.readme.text}\n\n`;
	for (const name of CONTEXT_RENDER_ORDER) {
		const context_file = data.context_files.get(name);
		if (context_file) result += `## ${name}\n\n\`\`\`\`\`markdown\n${context_file.text.trimEnd()}\n\`\`\`\`\`\n\n`;
	}
	for (const [directory_path, file] of data.ai_rules_inline) {
		result += `## ${directory_path}/${file.name}\n\n\`\`\`\`\`\n${file.text.trimEnd()}\n\`\`\`\`\`\n\n`;
	}
	return result;
}

function render_activity(data: RepoOverviewData): string {
	let result = '';
	if (data.commits.length > 0) {
		result += `## Recent Commits\n\n| Date | Author | Message |\n|------|--------|---------|\n`;
		result += data.commits.map((commit) =>
			`| ${format_date(commit.date)} | ${escape_table_cell(commit.author)} | ${escape_table_cell(commit.message)} |`,
		).join('\n');
		result += '\n\n';
	}
	result += format_commit_activity(data.monthly_commits);
	return result;
}

function render_issues(data: RepoOverviewData): string {
	if (data.issues.length === 0) return '';
	let result = '## Open Issues\n\n';
	for (const issue of data.issues) {
		result += `### #${issue.number}: ${issue.title}\n`;
		result += `**State:** ${issue.state} | **Labels:** ${issue.labels || 'none'} | **Author:** @${issue.author} | **Updated:** ${format_date(issue.updated_at)}\n\n`;
		if (issue.body) result += `${issue.body.slice(0, 500)}${issue.body.length > 500 ? '...' : ''}\n\n`;
	}
	return result;
}

function render_pull_requests(data: RepoOverviewData): string {
	if (data.pull_requests.length === 0) return '';
	let result = '## Open Pull Requests\n\n';
	for (const pull_request of data.pull_requests) {
		const draft_tag = pull_request.is_draft ? ' (draft)' : '';
		result += `### #${pull_request.number}: ${pull_request.title}${draft_tag}\n`;
		result += `**Author:** @${pull_request.author} | **Labels:** ${pull_request.labels || 'none'} | **Updated:** ${format_date(pull_request.updated_at)}\n`;
		const snippet = snippet_two_sentences(pull_request.body);
		if (snippet) result += `${snippet}\n`;
		result += '\n';
	}
	return result;
}

function render_releases(data: RepoOverviewData): string {
	if (data.releases.length === 0) return '';
	let result = '## Recent Releases\n\n';
	for (const release of data.releases) {
		result += `### ${release.name || release.tag} (\`${release.tag}\`)\n`;
		result += `**Published:** ${format_date(release.published_at)}`;
		if (release.is_prerelease) result += ' | **Pre-release**';
		result += '\n\n';
		if (release.body) result += `${release.body.slice(0, 1000)}${release.body.length > 1000 ? '...' : ''}\n\n`;
	}
	return result;
}

function render_ai_summary(data: RepoOverviewData): string {
	const inlined_files = [...data.context_files.keys()];
	const ai_rules_notes: string[] = [];
	for (const [directory_path] of data.ai_rules_inline) {
		ai_rules_notes.push(`${directory_path}/ (inlined above)`);
	}
	for (const [directory_path, files] of data.ai_rules_listing) {
		if (!data.ai_rules_inline.has(directory_path)) {
			ai_rules_notes.push(`${directory_path}/ (${files.length} files listed above)`);
		}
	}
	if (inlined_files.length === 0 && data.too_large_context.length === 0 && ai_rules_notes.length === 0 && data.extra_detected.length === 0) return '';
	let result = '## AI Context Files\n\n';
	for (const filename of inlined_files) result += `- \`${filename}\` (inlined above)\n`;
	for (const note of ai_rules_notes) result += `- \`${note}\`\n`;
	for (const entry of data.too_large_context) result += `- \`${entry}\`\n`;
	for (const filename of data.extra_detected) result += `- \`${filename}\` (detected)\n`;
	result += '\n';
	return result;
}

function render_footer(data: RepoOverviewData): string {
	const api_label = data.api_source === 'graphql' ? 'GitHub GraphQL API' : 'GitHub REST API';
	const rate_info = data.rate_limit_remaining != null ? ` | Rate limit: ${data.rate_limit_remaining} remaining` : '';
	return `---\n*Fetched via ${api_label} at ${new Date().toISOString()}${rate_info}*\n`;
}

export function build_repo_overview_result(data: RepoOverviewData): FetchResult {
	let content = render_identity(data)
		+ render_stats(data)
		+ render_structure(data)
		+ render_context_files(data)
		+ render_activity(data)
		+ render_issues(data)
		+ render_pull_requests(data)
		+ render_releases(data);

	const llms_full = data.context_files.get('llms-full.txt');
	if (llms_full) content += `## llms-full.txt\n\n\`\`\`\`\`markdown\n${llms_full.text.trimEnd()}\n\`\`\`\`\`\n\n`;

	content += render_ai_summary(data);
	content += render_footer(data);

	const truncation_result = truncate_readme(content);
	const all_ai_files = [
		...data.context_files.keys(),
		...[...data.ai_rules_inline.keys()].map((directory_path) => `${directory_path}/`),
		...[...data.ai_rules_listing.keys()].filter((directory_path) => !data.ai_rules_inline.has(directory_path)).map((directory_path) => `${directory_path}/`),
		...data.extra_detected,
	];

	return {
		url: `https://github.com/${data.full_name}`,
		title: `${data.full_name} - ${data.description}`,
		content: truncation_result.content,
		source_provider: 'github',
		metadata: {
			resource_type: 'repo_overview',
			stars: data.stars,
			forks: data.forks,
			language: Object.keys(data.languages)[0] ?? null,
			archived: data.is_archived,
			default_branch: data.default_branch,
			ai_context_files: all_ai_files,
			graphql: data.api_source === 'graphql',
			readme_truncated: truncation_result.readme_truncated,
			...(truncation_result.readme_original_tokens != null && { readme_original_tokens: truncation_result.readme_original_tokens }),
		},
	};
}
