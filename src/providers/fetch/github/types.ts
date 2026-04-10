// Shared types for the GitHub fetch provider

export interface ParsedGitHubUrl {
	resource_type: string;
	owner?: string;
	repo?: string;
	ref?: string;
	path?: string;
	resource_id?: string;
}

export interface ReadmeTruncation { content: string; readme_truncated: boolean; readme_original_tokens?: number }

export interface GqlBlob { text?: string; byteSize?: number }

export type GitHubAny = Record<string, unknown>;

// Common shape for repo overview data — used by both GQL and REST paths
export interface RepoOverviewData {
	full_name: string;
	description: string;
	owner: { login: string; url: string; type: string };
	license: { name: string; id: string } | null;
	visibility: string;
	default_branch: string;
	created_at: string;
	pushed_at: string;
	is_fork: boolean;
	is_archived: boolean;
	fork_parent: { name: string; url: string } | null;
	disk_usage_bytes: number;
	stars: number;
	forks: number;
	open_issues_count: number;
	open_prs_count: number;
	watchers: number;
	star_velocity: string;
	topics: string[];
	features: string;
	languages: Record<string, number>;
	tree_entries: Array<{ path: string; type: string; size?: number }>;
	docs_dir_name: string | null;
	docs_files: string[];
	ai_rules_listing: Map<string, Array<{ name: string; size: number }>>;
	ai_rules_inline: Map<string, { name: string; text: string; size: number }>;
	dep_configs: Array<{ name: string; text: string }>;
	readme: { text: string; size: number } | null;
	context_files: Map<string, { text: string; size: number }>;
	too_large_context: string[];
	extra_detected: string[];
	commits: Array<{ date: string; author: string; message: string }>;
	monthly_commits: Array<{ month: string; count: number }>;
	issues: Array<{ number: number; title: string; state: string; author: string; labels: string; updated_at: string; body: string }>;
	pull_requests: Array<{ number: number; title: string; author: string; labels: string; updated_at: string; is_draft: boolean; body: string }>;
	releases: Array<{ name: string; tag: string; published_at: string; is_prerelease: boolean; body: string }>;
	api_source: 'graphql' | 'rest';
	rate_limit_remaining?: number;
}
