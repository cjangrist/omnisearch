// GitHub fetch provider — structured API-driven content for any github.com URL
// Entry point: GitHubFetchProvider class dispatches to resource-specific handlers.

import type { FetchProvider, FetchResult } from '../../../common/types.js';
import { ErrorType, ProviderError } from '../../../common/types.js';
import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
import { config } from '../../../config/env.js';
import { loggers } from '../../../common/logger.js';
import { parse_github_url } from './url-parser.js';
import {
	fetch_repo_overview, fetch_file, fetch_directory,
	fetch_issue, fetch_issue_list, fetch_pr_list, fetch_wiki_page,
	fetch_pull_request, fetch_release_list, fetch_release, fetch_release_latest,
	fetch_commit_list, fetch_commit, fetch_user_profile, fetch_gist, fetch_actions,
} from './handlers.js';

const logger = loggers.fetch();

export class GitHubFetchProvider implements FetchProvider {
	name = 'github';
	description = 'Fetch GitHub content via REST API. Returns structured, LLM-optimized markdown for repos, files, issues, PRs, and more.';

	async fetch_url(url: string): Promise<FetchResult> {
		const token = validate_api_key(config.fetch.github.api_key, this.name);
		const parsed = parse_github_url(url);

		if (!parsed) {
			throw new ProviderError(ErrorType.INVALID_INPUT, `Not a recognized GitHub URL: ${url}`, this.name);
		}

		logger.info('GitHub fetch', {
			op: 'github_fetch',
			resource_type: parsed.resource_type,
			owner: parsed.owner,
			repo: parsed.repo,
			url: url.slice(0, 200),
		});

		try {
			switch (parsed.resource_type) {
				case 'repo_overview':
					return await fetch_repo_overview(token, parsed.owner!, parsed.repo!);
				case 'file':
					return await fetch_file(token, parsed.owner!, parsed.repo!, parsed.ref, parsed.path);
				case 'directory':
					return await fetch_directory(token, parsed.owner!, parsed.repo!, parsed.ref, parsed.path);
				case 'issue':
					return await fetch_issue(token, parsed.owner!, parsed.repo!, parsed.resource_id!);
				case 'issue_list':
					return await fetch_issue_list(token, parsed.owner!, parsed.repo!);
				case 'pr_list':
					return await fetch_pr_list(token, parsed.owner!, parsed.repo!);
				case 'wiki_page':
					return await fetch_wiki_page(token, parsed.owner!, parsed.repo!, parsed.resource_id!);
				case 'wiki':
					return await fetch_repo_overview(token, parsed.owner!, parsed.repo!);
				case 'pull_request':
					return await fetch_pull_request(token, parsed.owner!, parsed.repo!, parsed.resource_id!, false);
				case 'pr_files':
					return await fetch_pull_request(token, parsed.owner!, parsed.repo!, parsed.resource_id!, true);
				case 'release_list':
					return await fetch_release_list(token, parsed.owner!, parsed.repo!);
				case 'release':
					return await fetch_release(token, parsed.owner!, parsed.repo!, parsed.resource_id!);
				case 'release_latest':
					return await fetch_release_latest(token, parsed.owner!, parsed.repo!);
				case 'commit_list':
					return await fetch_commit_list(token, parsed.owner!, parsed.repo!, parsed.ref);
				case 'commit':
					return await fetch_commit(token, parsed.owner!, parsed.repo!, parsed.resource_id!);
				case 'actions':
					return await fetch_actions(token, parsed.owner!, parsed.repo!);
				case 'user_profile':
				case 'org_profile':
					return await fetch_user_profile(token, parsed.owner!);
				case 'gist':
					return await fetch_gist(token, parsed.resource_id!);
				case 'raw_file':
					return await fetch_file(token, parsed.owner!, parsed.repo!, parsed.ref, parsed.path);
				case 'compare':
				case 'discussion':
				case 'discussion_list':
				default:
					// Unsupported resource types — throw so fetch orchestrator falls through
					// to a general-purpose provider that can scrape the page
					throw new ProviderError(ErrorType.INVALID_INPUT, `GitHub resource type '${parsed.resource_type}' not yet supported via API — falling through to scraper`, this.name);
			}
		} catch (error) {
			handle_provider_error(error, this.name, `fetch ${parsed.resource_type}`);
		}
	}
}

export const registration = {
	key: () => config.fetch.github.api_key,
};
