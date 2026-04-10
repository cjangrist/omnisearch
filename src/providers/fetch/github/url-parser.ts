// GitHub URL parser — maps any github.com URL to a resource type

import type { ParsedGitHubUrl } from './types.js';

const RESERVED_ROUTES = new Set([
	'trending', 'explore', 'new', 'settings', 'notifications',
	'login', 'logout', 'signup', 'join', 'features', 'pricing',
	'about', 'contact', 'security', 'sponsors', 'marketplace',
	'codespaces', 'copilot', 'enterprise', 'topics', 'collections',
	'search', 'pulls', 'issues', 'stars', 'dashboard',
]);

export function parse_github_url(url: string): ParsedGitHubUrl | null {
	let parsed: URL;
	try { parsed = new URL(url); } catch { return null; }

	const hostname = parsed.hostname.toLowerCase();
	const parts = parsed.pathname.replace(/\/+$/, '').split('/').filter(Boolean).map(decode_segment);

	if (hostname === 'gist.github.com') return parse_gist_url(parts);
	if (hostname === 'raw.githubusercontent.com') return parse_raw_url(parts);
	if (hostname !== 'github.com') return null;

	if (parts[0] === 'orgs' && parts[1]) return { resource_type: 'org_profile', owner: parts[1] };
	if (parts.length === 1) return RESERVED_ROUTES.has(parts[0].toLowerCase()) ? null : { resource_type: 'user_profile', owner: parts[0] };

	const [owner, repo, ...rest] = parts;
	if (!owner || !repo) return null;
	if (rest.length === 0) return { resource_type: 'repo_overview', owner, repo };

	return parse_repo_subpath(owner, repo, rest);
}

function decode_segment(segment: string): string {
	try { return decodeURIComponent(segment); } catch { return segment; }
}

function parse_gist_url(parts: string[]): ParsedGitHubUrl | null {
	if (parts.length === 0) return null;
	const gist_id = parts.length >= 2 ? parts[1] : parts[0];
	if (!gist_id || !/^[0-9a-f]+$/i.test(gist_id)) return null;
	return { resource_type: 'gist', owner: parts.length >= 2 ? parts[0] : undefined, resource_id: gist_id };
}

function parse_raw_url(parts: string[]): ParsedGitHubUrl | null {
	if (parts.length < 3) return null;
	const [owner, repo, ...rest] = parts;
	return { resource_type: 'raw_file', owner, repo, ref: rest.join('/') };
}

function parse_repo_subpath(owner: string, repo: string, rest: string[]): ParsedGitHubUrl {
	const head = rest[0];

	if (head === 'raw' && rest.length >= 2) return { resource_type: 'file', owner, repo, ref: rest.slice(1).join('/') };

	if (head === 'issues' && rest.length === 1) return { resource_type: 'issue_list', owner, repo };
	if (head === 'issues' && /^\d+$/.test(rest[1] ?? '')) return { resource_type: 'issue', owner, repo, resource_id: rest[1] };

	if (head === 'pulls' && rest.length === 1) return { resource_type: 'pr_list', owner, repo };
	if (head === 'pull') {
		const pr_segment = (rest[1] ?? '').replace(/\.(diff|patch)$/, '');
		if (/^\d+$/.test(pr_segment)) return { resource_type: rest[2] === 'files' ? 'pr_files' : 'pull_request', owner, repo, resource_id: pr_segment };
	}

	if (head === 'wiki' && rest[1]) return { resource_type: 'wiki_page', owner, repo, resource_id: rest.slice(1).join('/') };
	if (head === 'wiki') return { resource_type: 'wiki', owner, repo };

	if (head === 'releases' && rest[1] === 'tag' && rest[2]) return { resource_type: 'release', owner, repo, resource_id: rest.slice(2).join('/') };
	if (head === 'releases' && rest[1] === 'latest') return { resource_type: 'release_latest', owner, repo };
	if (head === 'releases' && rest.length === 1) return { resource_type: 'release_list', owner, repo };

	if (head === 'commits' && rest.length === 1) return { resource_type: 'commit_list', owner, repo };
	if (head === 'commits' && rest[1]) return { resource_type: 'commit_list', owner, repo, ref: rest.slice(1).join('/') };
	if (head === 'commit' && rest[1]) return { resource_type: 'commit', owner, repo, resource_id: rest[1].replace(/\.(diff|patch)$/, '') };

	if (head === 'actions' && rest[1] === 'runs' && rest[2]) return { resource_type: 'action_run', owner, repo, resource_id: rest[2] };
	if (head === 'actions' && rest.length === 1) return { resource_type: 'actions', owner, repo };

	if (head === 'compare' && rest[1]) return { resource_type: 'compare', owner, repo, resource_id: rest.slice(1).join('/') };

	if (head === 'discussions' && rest[1] && /^\d+$/.test(rest[1])) return { resource_type: 'discussion', owner, repo, resource_id: rest[1] };
	if (head === 'discussions') return { resource_type: 'discussion_list', owner, repo };

	if (head === 'blob' || head === 'tree' || head === 'blame' || head === 'edit') return parse_blob_tree_url(owner, repo, head, rest.slice(1));

	return { resource_type: 'repo_overview', owner, repo };
}

function parse_blob_tree_url(owner: string, repo: string, head: string, ref_and_path: string[]): ParsedGitHubUrl {
	const resource_type = head === 'tree' ? 'directory' : 'file';
	if (ref_and_path.length === 0) return { resource_type, owner, repo };
	const first_segment = ref_and_path[0];
	if (/^[0-9a-f]{40}$/i.test(first_segment)) {
		return { resource_type, owner, repo, ref: first_segment, path: ref_and_path.slice(1).join('/') || undefined };
	}
	return { resource_type, owner, repo, ref: ref_and_path.join('/') };
}
