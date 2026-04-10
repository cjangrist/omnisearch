// File, directory, and wiki page handlers

import type { FetchResult } from '../../../common/types.js';
import { loggers } from '../../../common/logger.js';
import type { GitHubAny } from './types.js';
import { github_get, github_get_raw, github_get_safe, github_get_raw_safe } from './api.js';
import { format_size, format_date, is_binary, escape_table_cell } from './formatters.js';
import { fetch_repo_overview } from './repo-overview.js';

const logger = loggers.fetch();

// Resolve ambiguous blob/tree URLs where ref and path can't be separated (branch names with slashes).
// Try splitting at each '/' from left to right — first successful API call wins.
async function resolve_ambiguous_ref_path(
	token: string, owner: string, repo: string, combined: string, type: 'file' | 'directory',
): Promise<FetchResult> {
	const parts = combined.split('/');
	// Try single-segment ref first (most common: main, master, develop), then longest-first
	// to match GitHub's resolution for overlapping branches (release vs release/v2.0)
	const try_order = [0, ...Array.from({ length: parts.length - 1 }, (_, i) => parts.length - 1 - i)].filter((v, i, a) => a.indexOf(v) === i);
	for (const i of try_order) {
		const try_ref = parts.slice(0, i + 1).join('/');
		const try_path = parts.slice(i + 1).join('/');
		const encoded = try_path.split('/').map(encodeURIComponent).join('/');
		const endpoint = `/repos/${owner}/${repo}/contents/${encoded}?ref=${encodeURIComponent(try_ref)}`;
		try {
			await github_get<GitHubAny>(token, endpoint);
			// Success — call with explicit path (empty string is valid, prevents re-entry)
			if (type === 'file') return fetch_file(token, owner, repo, try_ref, try_path);
			return fetch_directory(token, owner, repo, try_ref, try_path);
		} catch { /* try next split */ }
	}
	// All splits failed — fall back to first-segment heuristic
	if (type === 'file') return fetch_file(token, owner, repo, parts[0], parts.slice(1).join('/'));
	return fetch_directory(token, owner, repo, parts[0], parts.slice(1).join('/'));
}

export async function fetch_file(token: string, owner: string, repo: string, ref: string | undefined, path: string | undefined): Promise<FetchResult> {
	// When path is undefined (not empty string) and ref contains combined ref+path (ambiguous branch names),
	// try progressively to resolve. Empty string path means "resolved, root of ref" — do NOT re-enter.
	if (path === undefined && ref && ref.includes('/')) {
		return resolve_ambiguous_ref_path(token, owner, repo, ref, 'file');
	}
	const file_path = path || '';
	const ref_param = ref ? `?ref=${encodeURIComponent(ref)}` : '';
	const encoded_path = file_path.split('/').map(encodeURIComponent).join('/');
	const endpoint = `/repos/${owner}/${repo}/contents/${encoded_path}${ref_param}`;

	if (is_binary(file_path)) {
		try {
			const meta = await github_get<GitHubAny>(token, endpoint);
			if (Array.isArray(meta)) return fetch_directory(token, owner, repo, ref, path);
			return {
				url: (meta.html_url as string) || `https://github.com/${owner}/${repo}/blob/${ref || 'main'}/${file_path}`,
				title: `${file_path} - ${owner}/${repo}`,
				content: `# ${meta.name}\n\n**Type:** Binary file\n**Size:** ${format_size(meta.size as number)}\n**SHA:** \`${meta.sha}\`\n\nThis is a binary file that cannot be displayed as text.\n${meta.download_url ? `\n**Download:** [${meta.name}](${meta.download_url})\n` : ''}`,
				source_provider: 'github',
				metadata: { resource_type: 'file', is_binary: true, size: meta.size },
			};
		} catch { /* binary check failed — fall through to raw fetch */ }
	}

	// Try raw content — if endpoint returns a directory listing, redirect to fetch_directory
	let raw_content: string;
	try {
		raw_content = await github_get_raw(token, endpoint);
	} catch {
		// Raw fetch failed — might be a directory; try as directory instead
		try { return await fetch_directory(token, owner, repo, ref, path); } catch { /* rethrow original */ }
		throw new Error(`Failed to fetch file: ${file_path}`);
	}
	const file_ext = file_path.split('.').pop() ?? '';
	const lang_hint = file_ext || '';

	const content = `# ${file_path || 'File'}\n\n**Repository:** ${owner}/${repo}\n**Branch:** \`${ref || 'default'}\`\n**Size:** ${format_size(raw_content.length)}\n\n---\n\n\`\`\`\`\`${lang_hint}\n${raw_content}\n\`\`\`\`\`\n\n---\n*Fetched via GitHub API*\n`;

	return {
		url: `https://github.com/${owner}/${repo}/blob/${ref || 'main'}/${file_path}`,
		title: `${file_path} - ${owner}/${repo}`,
		content,
		source_provider: 'github',
		metadata: { resource_type: 'file', path: file_path, ref },
	};
}

export async function fetch_directory(token: string, owner: string, repo: string, ref: string | undefined, path: string | undefined): Promise<FetchResult> {
	if (path === undefined && ref && ref.includes('/')) {
		return resolve_ambiguous_ref_path(token, owner, repo, ref, 'directory');
	}
	const dir_path = path || '';
	const ref_param = ref ? `?ref=${encodeURIComponent(ref)}` : '';
	const encoded_path = dir_path.split('/').map(encodeURIComponent).join('/');
	const endpoint = `/repos/${owner}/${repo}/contents/${encoded_path}${ref_param}`;
	const result = await github_get<GitHubAny>(token, endpoint);
	// Contents API returns an object (file) or array (directory) — if object, redirect to file handler
	if (!Array.isArray(result)) {
		return fetch_file(token, owner, repo, ref, path);
	}
	const entries = result as Array<{ name: string; type: string; size: number; path: string; html_url: string }>;

	const dirs = entries.filter((e) => e.type === 'dir').sort((a, b) => a.name.localeCompare(b.name));
	const files = entries.filter((e) => e.type !== 'dir').sort((a, b) => a.name.localeCompare(b.name));

	let content = `# Directory: ${dir_path || '/'}\n\n`;
	content += `**Repository:** ${owner}/${repo}\n**Branch:** \`${ref || 'default'}\`\n**Items:** ${entries.length}\n\n`;

	content += `| Type | Name | Size |\n|------|------|------|\n`;
	for (const d of dirs) content += `| dir | ${escape_table_cell(d.name)}/ | - |\n`;
	for (const f of files) content += `| file | ${escape_table_cell(f.name)} | ${format_size(f.size)} |\n`;

	content += `\n---\n*Fetched via GitHub API*\n`;

	return {
		url: `https://github.com/${owner}/${repo}/tree/${ref || 'main'}/${dir_path}`,
		title: `${dir_path || '/'} - ${owner}/${repo}`,
		content,
		source_provider: 'github',
		metadata: { resource_type: 'directory', path: dir_path, ref, item_count: entries.length },
	};
}
export async function fetch_wiki_page(token: string, owner: string, repo: string, page_slug: string): Promise<FetchResult> {
	const title = decodeURIComponent(page_slug).replace(/-/g, ' ');
	const url = `https://github.com/${owner}/${repo}/wiki/${page_slug}`;

	// GitHub wikis are git repos — raw content at raw.githubusercontent.com/wiki/{owner}/{repo}/{page}.md
	const encoded_slug = page_slug.split('/').map(encodeURIComponent).join('/');
	const raw_url = `https://raw.githubusercontent.com/wiki/${owner}/${repo}/${encoded_slug}.md`;
	try {
		const resp = await fetch(raw_url, { headers: { 'User-Agent': 'omnisearch', 'Authorization': `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
		if (resp.ok) {
			const raw = await resp.text();
			if (raw.length > 0) {
				return {
					url,
					title: `${title} - ${owner}/${repo} Wiki`,
					content: `# ${title}\n\n**Wiki page** from [${owner}/${repo}](https://github.com/${owner}/${repo})\n\n---\n\n${raw}\n`,
					source_provider: 'github',
					metadata: { resource_type: 'wiki_page' },
				};
			}
		}
	} catch { /* raw fetch failed — try .mediawiki extension */ }

	// Some wikis use .mediawiki or no extension
	for (const ext of ['', '.mediawiki', '.asciidoc', '.rst']) {
		try {
			const alt_url = `https://raw.githubusercontent.com/wiki/${owner}/${repo}/${encoded_slug}${ext}`;
			const resp = await fetch(alt_url, { headers: { 'User-Agent': 'omnisearch', 'Authorization': `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) });
			if (resp.ok) {
				const raw = await resp.text();
				if (raw.length > 0) {
					return {
						url,
						title: `${title} - ${owner}/${repo} Wiki`,
						content: `# ${title}\n\n**Wiki page** from [${owner}/${repo}](https://github.com/${owner}/${repo})\n\n---\n\n${raw}\n`,
						source_provider: 'github',
						metadata: { resource_type: 'wiki_page' },
					};
				}
			}
		} catch { /* continue */ }
	}

	// Last resort — return repo overview
	return fetch_repo_overview(token, owner, repo);
}
