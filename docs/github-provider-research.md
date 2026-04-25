# GitHub Fetch Provider — Comprehensive Research Report

**For:** Omnisearch MCP Server  
**Date:** 2026-04-09  
**Purpose:** Implementation blueprint for a dedicated GitHub API-based fetch provider

---

## Executive Summary

This report provides a complete technical reference for building a GitHub fetch provider that uses the official GitHub REST API (and optionally GraphQL) to return rich, structured, LLM-optimized content for any github.com URL. The provider would replace noisy HTML-to-markdown scraping with clean API-driven data including real metadata (stars, forks, languages, topics) that scrapers cannot provide.

---

## 1. GitHub REST API v3 — Endpoint Reference

### Base Configuration

```
Base URL: https://api.github.com
API Version: 2022-11-28 (or latest)
```

### Required Headers (All Requests)

```http
Accept: application/vnd.github+json
Authorization: Bearer {PAT}
X-GitHub-Api-Version: 2022-11-28
```

### Special Accept Header Variants

| Variant | Purpose |
|---------|---------|
| `application/vnd.github+json` | Default JSON response |
| `application/vnd.github.raw+json` | Raw file/README content |
| `application/vnd.github.html+json` | HTML-rendered markdown |
| `application/vnd.github.object+json` | Consistent object format for directories |
| `application/vnd.github.base64+json` | Base64-encoded content |
| `application/vnd.github.text+json` | Adds plain-text issue/PR body fields |
| `application/vnd.github.full+json` | Adds raw/text/HTML issue or PR body fields |
| `application/vnd.github.diff` | Unified diff for compare / commit / PR diff URLs |
| `application/vnd.github.patch` | Patch format for compare / commit / PR patch URLs |

---

### Endpoint Catalog

#### 1.1 Repository Metadata
**URL Pattern:** `github.com/{owner}/{repo}`

```http
GET /repos/{owner}/{repo}
```

**Key Response Fields:**
```typescript
{
  id: number;                    // 1296269
  node_id: string;               // "MDEwOlJlcG9zaXRvcnkxMjk2MjY5"
  name: string;                  // "Hello-World"
  full_name: string;             // "octocat/Hello-World"
  owner: {
    login: string;               // "octocat"
    id: number;
    avatar_url: string;
    type: "User" | "Organization";
  };
  private: boolean;
  html_url: string;              // "https://github.com/octocat/Hello-World"
  description: string;
  fork: boolean;
  url: string;                   // API URL
  created_at: string;            // ISO 8601
  updated_at: string;
  pushed_at: string;
  homepage: string | null;
  size: number;                  // Repository size in KB
  stargazers_count: number;      // ⭐ Stars
  watchers_count: number;
  forks_count: number;           // 🍴 Forks
  open_issues_count: number;     // 📋 Open issues
  default_branch: string;        // "main" or "master"
  topics: string[];              // ["api", "electron", "atom"]
  archived: boolean;
  disabled: boolean;
  visibility: "public" | "private" | "internal";
  license: {
    key: string;                 // "mit"
    name: string;                // "MIT License"
    spdx_id: string;             // "MIT"
    url: string;
  } | null;
  allow_forking: boolean;
  is_template: boolean;
  has_issues: boolean;
  has_projects: boolean;
  has_wiki: boolean;
  has_pages: boolean;
  has_downloads: boolean;
  has_discussions: boolean;
  // Parent repo info (if fork)
  parent?: Repository;
  source?: Repository;
  // Security analysis (requires admin permissions)
  security_and_analysis?: {
    advanced_security: { status: "enabled" | "disabled" };
    secret_scanning: { status: "enabled" | "disabled" };
    secret_scanning_push_protection: { status: "enabled" | "disabled" };
  };
}
```

---

#### 1.2 README Content
**URL Pattern:** `github.com/{owner}/{repo}` (README extraction)

```http
GET /repos/{owner}/{repo}/readme
GET /repos/{owner}/{repo}/readme/{dir}  // README in subdirectory
```

**Query Parameters:**
- `ref` — branch, tag, or commit SHA (default: default branch)

**Response:**
```typescript
{
  type: "file";
  encoding: "base64";
  size: number;
  name: string;                  // "README.md"
  path: string;                  // "README.md"
  content: string;               // Base64 encoded content
  sha: string;
  url: string;
  git_url: string;
  html_url: string;
  download_url: string;          // Direct raw URL
  _links: {
    git: string;
    self: string;
    html: string;
  };
}
```

**To get raw markdown:** Use `Accept: application/vnd.github.raw+json` header

---

#### 1.3 Directory Listing
**URL Pattern:** `github.com/{owner}/{repo}/tree/{ref}/{path}`

```http
GET /repos/{owner}/{repo}/contents/{path}
```

**Query Parameters:**
- `ref` — branch, tag, or commit SHA

**Response (Array of items):**
```typescript
Array<{
  type: "file" | "dir" | "symlink" | "submodule";
  name: string;                  // "src"
  path: string;                  // "src"
  sha: string;
  size: number;                  // 0 for directories
  url: string;
  git_url: string | null;
  html_url: string | null;
  download_url: string | null;
  // Only for files
  content?: string;              // Base64 encoded (only if single file)
  encoding?: "base64";
  // Only for submodules
  submodule_git_url?: string;
}>
```

**Important Limits:**
- Maximum 1,000 files per directory
- For larger directories, use Git Trees API instead

---

#### 1.4 File Content
**URL Pattern:** `github.com/{owner}/{repo}/blob/{ref}/{path}`

```http
GET /repos/{owner}/{repo}/contents/{path}
```

**Query Parameters:**
- `ref` — branch, tag, or commit SHA

**Response:**
```typescript
{
  type: "file";
  encoding: "base64";
  size: number;
  name: string;
  path: string;
  content: string;               // Base64 encoded
  sha: string;
  url: string;
  git_url: string;
  html_url: string;
  download_url: string;
  _links: { ... };
}
```

**File Size Limits:**
| Size | Behavior |
|------|----------|
| ≤ 1 MB | All features supported |
| 1-100 MB | Only `raw` or `object` media types supported |
| > 100 MB | Contents API unsupported; return metadata only or fall back to raw download URL if available |

---

#### 1.5 Issue List
**URL Pattern:** `github.com/{owner}/{repo}/issues`

```http
GET /repos/{owner}/{repo}/issues
```

**Query Parameters:**
- `state` — `open`, `closed`, `all` (default: `open`)
- `labels` — comma-separated label names
- `sort` — `created`, `updated`, `comments` (default: `created`)
- `direction` — `asc`, `desc` (default: `desc`)
- `since` — ISO 8601 timestamp (only issues updated after)
- `per_page` — 1-100 (default: 30)
- `page` — page number

**Key Response Fields:**
```typescript
{
  id: number;
  node_id: string;
  number: number;                // Issue #1347
  title: string;
  body: string | null;           // Markdown content
  state: "open" | "closed";
  locked: boolean;
  user: {
    login: string;
    id: number;
    avatar_url: string;
    type: "User" | "Bot";
  };
  labels: Array<{
    id: number;
    name: string;
    description: string | null;
    color: string;               // "f29513"
    default: boolean;
  }>;
  assignees: User[];
  milestone: Milestone | null;
  comments: number;              // Comment count
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  author_association: "OWNER" | "COLLABORATOR" | "CONTRIBUTOR" | ...;
  // Pull request info (if PR)
  pull_request?: {
    url: string;
    html_url: string;
    diff_url: string;
    patch_url: string;
  };
}
```

**Note:** This endpoint returns both issues and pull requests. Check for `pull_request` field to distinguish.

---

#### 1.6 Single Issue + Comments
**URL Pattern:** `github.com/{owner}/{repo}/issues/{number}`

```http
GET /repos/{owner}/{repo}/issues/{issue_number}
GET /repos/{owner}/{repo}/issues/{issue_number}/comments
```

**Comment Response:**
```typescript
{
  id: number;
  node_id: string;
  url: string;
  html_url: string;
  body: string;                  // Markdown
  user: User;
  created_at: string;
  updated_at: string;
  author_association: string;
  reactions?: {
    url: string;
    total_count: number;
    "+1": number;
    "-1": number;
    laugh: number;
    confused: number;
    heart: number;
    hooray: number;
    eyes: number;
    rocket: number;
  };
}
```

---

#### 1.7 Pull Request
**URL Pattern:** `github.com/{owner}/{repo}/pull/{number}`

```http
GET /repos/{owner}/{repo}/pulls/{pull_number}
```

**Custom Media Types for PR Body:**
- `application/vnd.github.raw+json` — raw markdown (default)
- `application/vnd.github.text+json` — text only
- `application/vnd.github.html+json` — HTML rendered
- `application/vnd.github.full+json` — raw, text, and HTML

**Key Response Fields:**
```typescript
{
  id: number;
  node_id: string;
  number: number;
  state: "open" | "closed";
  locked: boolean;
  title: string;
  body: string | null;
  user: User;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  merge_commit_sha: string | null;
  draft: boolean;
  // Branch info
  head: {
    label: string;               // "octocat:new-feature"
    ref: string;                 // "new-feature"
    sha: string;
    user: User;
    repo: Repository;
  };
  base: {
    label: string;               // "octocat:main"
    ref: string;                 // "main"
    sha: string;
    user: User;
    repo: Repository;
  };
  // PR-specific
  diff_url: string;              // https://github.com/.../pull/1.diff
  patch_url: string;             // https://github.com/.../pull/1.patch
  // Related URLs
  issue_url: string;             // Associated issue
  commits_url: string;
  review_comments_url: string;
  review_comment_url: string;
  comments_url: string;
  statuses_url: string;
  // Reviewers
  requested_reviewers: User[];
  requested_teams: Team[];
  // Merge status
  merged: boolean;
  mergeable: boolean | null;
  rebaseable: boolean | null;
  mergeable_state: string;       // "clean", "dirty", "blocked", "behind"
  merged_by: User | null;
  additions: number;             // Lines added
  deletions: number;             // Lines deleted
  changed_files: number;         // Number of files changed
}
```

**PR Files (Diff):**
```http
GET /repos/{owner}/{repo}/pulls/{pull_number}/files
```

Response includes file-level diff stats:
```typescript
{
  sha: string;
  filename: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  changes: number;
  blob_url: string;
  raw_url: string;
  contents_url: string;
  patch: string;                 // Actual diff patch
  previous_filename?: string;    // For renamed files
}
```

---

#### 1.8 Releases
**URL Pattern:** `github.com/{owner}/{repo}/releases`

```http
GET /repos/{owner}/{repo}/releases
GET /repos/{owner}/{repo}/releases/latest
GET /repos/{owner}/{repo}/releases/tags/{tag}
```

**Query Parameters:**
- `per_page` — 1-100
- `page` — page number

**Key Response Fields:**
```typescript
{
  id: number;
  node_id: string;
  url: string;
  html_url: string;
  tag_name: string;              // "v1.0.0"
  target_commitish: string;      // "master"
  name: string | null;           // Release title
  body: string | null;           // Release notes (markdown)
  draft: boolean;
  prerelease: boolean;
  created_at: string;
  published_at: string;
  author: User;
  // Assets
  assets: Array<{
    id: number;
    name: string;                // "example.zip"
    label: string | null;
    state: "uploaded" | "open";
    content_type: string;        // "application/zip"
    size: number;
    download_count: number;
    created_at: string;
    updated_at: string;
    browser_download_url: string;
  }>;
  // Download URLs
  tarball_url: string;
  zipball_url: string;
  upload_url: string;            // For uploading assets
}
```

---

#### 1.9 Commits
**URL Pattern:** `github.com/{owner}/{repo}/commits`

```http
GET /repos/{owner}/{repo}/commits
GET /repos/{owner}/{repo}/commits/{ref}  // Specific commit
```

**Query Parameters:**
- `sha` — branch name or commit SHA
- `path` — commits affecting this path
- `author` — GitHub login or email
- `since`, `until` — ISO 8601 timestamps
- `per_page` — 1-100

**Key Response Fields:**
```typescript
{
  sha: string;
  node_id: string;
  commit: {
    message: string;
    author: {
      name: string;
      email: string;
      date: string;
    };
    committer: {
      name: string;
      email: string;
      date: string;
    };
    tree: {
      sha: string;
      url: string;
    };
    comment_count: number;
  };
  url: string;
  html_url: string;
  comments_url: string;
  author: User | null;           // GitHub user (may be null if not linked)
  committer: User | null;
  parents: Array<{
    sha: string;
    url: string;
    html_url: string;
  }>;
  stats?: {
    additions: number;
    deletions: number;
    total: number;
  };
  files?: Array<{
    filename: string;
    additions: number;
    deletions: number;
    changes: number;
    status: string;
    raw_url: string;
    blob_url: string;
    patch: string;
  }>;
}
```

---

#### 1.10 Git Trees (Recursive Directory)
**For large directories > 1,000 files:**

```http
GET /repos/{owner}/{repo}/git/trees/{tree_sha}
GET /repos/{owner}/{repo}/git/trees/{tree_sha}?recursive=1
```

**Response:**
```typescript
{
  sha: string;
  url: string;
  tree: Array<{
    path: string;
    mode: string;                  // "100644" (file), "040000" (dir)
    type: "blob" | "tree" | "commit";
    sha: string;
    size?: number;                 // Only for blobs
    url: string;
  }>;
  truncated: boolean;            // true if tree exceeded limits
}
```

**Limits:**
- 100,000 entries max with recursive
- 7 MB max response size

---

#### 1.11 Git Blobs (Large Files)
**For files > 1 MB and up to 100 MB:**

```http
GET /repos/{owner}/{repo}/git/blobs/{file_sha}
```

**With header:** `Accept: application/vnd.github.raw+json`

**Response (default):**
```typescript
{
  content: string;               // Base64 encoded
  encoding: "base64";
  url: string;
  sha: string;
  size: number;
  node_id: string;
}
```

---

#### 1.12 Actions / Workflow Runs
**URL Pattern:** `github.com/{owner}/{repo}/actions`

```http
GET /repos/{owner}/{repo}/actions/runs
GET /repos/{owner}/{repo}/actions/runs/{run_id}
```

**Query Parameters:**
- `actor` — filter by user
- `branch` — filter by branch
- `event` — push, pull_request, etc.
- `status` — queued, in_progress, completed
- `per_page` — 1-100

**Key Response Fields:**
```typescript
{
  id: number;
  name: string;                  // Workflow name
  node_id: string;
  head_branch: string;
  head_sha: string;
  path: string;                  // ".github/workflows/build.yml@main"
  run_number: number;
  event: string;
  display_title: string;
  status: "queued" | "in_progress" | "completed" | "waiting";
  conclusion: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required" | null;
  workflow_id: number;
  url: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  run_attempt: number;
  run_started_at: string;
  triggering_actor: User;
  jobs_url: string;
  logs_url: string;
  artifacts_url: string;
  head_commit: {
    id: string;
    tree_id: string;
    message: string;
    timestamp: string;
    author: { name: string; email: string };
    committer: { name: string; email: string };
  };
}
```

---

#### 1.13 Gists
**URL Pattern:** `gist.github.com/{user}/{id}`

```http
GET /gists/{gist_id}
```

**Key Response Fields:**
```typescript
{
  id: string;                    // "aa5a315d61ae9438b18d"
  node_id: string;
  url: string;
  forks_url: string;
  commits_url: string;
  git_pull_url: string;          // Clone URL
  git_push_url: string;
  html_url: string;
  files: {
    [filename: string]: {
      filename: string;
      type: string;              // MIME type
      language: string | null;   // "Ruby", "Markdown"
      raw_url: string;           // Direct content URL
      size: number;
      truncated: boolean;        // true if content truncated
      content?: string;          // Content (if not truncated)
      encoding?: "utf-8";
    }
  };
  public: boolean;
  created_at: string;
  updated_at: string;
  description: string | null;
  comments: number;
  user: User | null;
  comments_url: string;
  owner: User;
  truncated: boolean;            // true if files list truncated (>300 files)
}
```

**Note:** Files > 1 MB have `truncated: true` — fetch via `raw_url` instead.

---

#### 1.14 User / Organization Profile
**URL Patterns:** `github.com/{user}` and `github.com/orgs/{org}`

```http
GET /users/{username}
GET /orgs/{org}
```

**Key Response Fields:**
```typescript
{
  login: string;                 // "octocat"
  id: number;
  node_id: string;
  avatar_url: string;
  html_url: string;
  type: "User" | "Organization";
  site_admin: boolean;
  name: string | null;           // Display name
  company: string | null;
  blog: string | null;           // URL
  location: string | null;
  email: string | null;          // Public email only
  hireable: boolean | null;
  bio: string | null;            // Profile bio
  twitter_username: string | null;
  public_repos: number;
  public_gists: number;
  followers: number;
  following: number;
  created_at: string;
  updated_at: string;
  // Authenticated-only fields
  private_gists?: number;
  total_private_repos?: number;
  owned_private_repos?: number;
  disk_usage?: number;
  collaborators?: number;
  two_factor_authentication?: boolean;
  plan?: {
    name: string;
    space: number;
    private_repos: number;
    collaborators: number;
  };
}
```

---

#### 1.15 User Repositories
```http
GET /users/{username}/repos
GET /orgs/{org}/repos
```

**Query Parameters:**
- `type` — all, owner, member (default: owner)
- `sort` — created, updated, pushed, full_name (default: created)
- `direction` — asc, desc
- `per_page` — 1-100

---

#### 1.16 Languages
```http
GET /repos/{owner}/{repo}/languages
```

**Response:**
```typescript
{
  "JavaScript": 12345,
  "TypeScript": 67890,
  "CSS": 1234,
  // Language: bytes of code
}
```

---

#### 1.17 Raw GitHubusercontent URLs
**URL Pattern:** `raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}`

There is no GitHub REST schema for the raw host itself; it returns bytes, not structured metadata.

**Recommended Provider Mapping:**
```http
GET /repos/{owner}/{repo}/contents/{path}?ref={ref}
Accept: application/vnd.github.raw+json
```

Use the Contents API first so the provider can:
- authenticate private repositories with a PAT
- return file metadata (`sha`, `size`, `path`, `html_url`, `download_url`)
- fall back to the Git Blobs API for 1-100 MB text files
- classify binary files and avoid dumping garbage into LLM context

Only use the raw host as a last-resort download URL already provided by the API response.

---

### Pagination

GitHub uses the `Link` header for pagination:

```http
Link: <https://api.github.com/repos/octocat/Hello-World/issues?page=2>; rel="next",
      <https://api.github.com/repos/octocat/Hello-World/issues?page=5>; rel="last"
```

**Rel values:** `next`, `last`, `first`, `prev`

---

## 2. GitHub GraphQL API v4 — Single-Query Alternative

### Endpoint
```http
POST /graphql
```

### Rate Limiting Model

| Metric | Value |
|--------|-------|
| Primary limit | 5,000 points/hour (10,000 for GitHub Enterprise Cloud) |
| Secondary limit | 2,000 points/minute |
| Cost calculation | Based on complexity (nodes requested) |
| Minimum cost | 1 point per query |

**Rate Limit Headers (same as REST):**
```http
X-RateLimit-Limit: 5000
X-RateLimit-Remaining: 4999
X-RateLimit-Used: 1
X-RateLimit-Reset: 1691591363
```

### Query Cost Calculation

Formula:
1. Count unique connections (assume `first`/`last` limits reached)
2. Divide by 100, round to nearest integer
3. Minimum cost = 1

Example: Querying 100 repos × 50 issues × 60 labels = 5,101 requests → 51 points

### Single Query for Repo Overview

```graphql
query RepositoryOverview(
  $owner: String!
  $repo: String!
  $readmeExpr: String = "HEAD:README.md"
  $rootExpr: String = "HEAD:"
) {
  repository(owner: $owner, name: $repo) {
    id
    name
    nameWithOwner
    description
    url
    homepageUrl
    updatedAt
    pushedAt
    
    stargazerCount
    forkCount
    watchers {
      totalCount
    }
    openIssuesCount: issues(states: OPEN) {
      totalCount
    }
    
    isPrivate
    isArchived
    isFork
    parent {
      nameWithOwner
      url
    }
    isTemplate
    visibility
    defaultBranchRef {
      name
      target {
        ... on Commit {
          history(first: 10) {
            nodes {
              oid
              committedDate
              authoredDate
              messageHeadline
              url
              author {
                name
                email
                user {
                  login
                  url
                }
              }
            }
          }
        }
      }
    }
    licenseInfo {
      name
      spdxId
      url
    }
    repositoryTopics(first: 20) {
      nodes {
        topic { name }
      }
    }
    languages(first: 10, orderBy: {field: SIZE, direction: DESC}) {
      totalSize
      edges {
        node { name color }
        size
      }
    }
    
    readme: object(expression: $readmeExpr) {
      __typename
      ... on Blob {
        oid
        byteSize
        isBinary
        isTruncated
        text
      }
    }
    
    rootTree: object(expression: $rootExpr) {
      __typename
      ... on Tree {
        entries {
          name
          path
          type
          oid
          object {
            __typename
            ... on Blob {
              byteSize
              isBinary
              isTruncated
            }
          }
        }
      }
    }
    
    recentOpenIssues: issues(first: 5, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        id
        number
        title
        url
        createdAt
        updatedAt
        author {
          login
          url
        }
        labels(first: 10) {
          nodes {
            name
            color
          }
        }
      }
    }
    
    recentReleases: releases(first: 3, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        id
        name
        tagName
        url
        isDraft
        isPrerelease
        createdAt
        publishedAt
        description
        releaseAssets(first: 10) {
          nodes {
            name
            contentType
            size
            downloadCount
            downloadUrl
          }
        }
      }
    }
  }
  
  rateLimit {
    limit
    remaining
    used
    resetAt
    cost
  }
}
```

**Variables:**
```json
{
  "owner": "facebook",
  "repo": "react",
  "readmeExpr": "HEAD:README.md",
  "rootExpr": "HEAD:"
}
```

**Notes:**
- This query is a practical single-request fast path for `github.com/{owner}/{repo}`.
- README lookup is still imperfect in one query because repositories may use `README`, `README.rst`, `README.adoc`, or a subdirectory README. REST `GET /repos/{owner}/{repo}/readme` is more robust for production.
- GraphQL `Blob.text` is not a large-file strategy. Keep REST/Git Blobs fallbacks for larger files and binary detection.
- Rate-limit inspection is built in via the `rateLimit` object.

**Implementation Recommendation:**
- Keep this query as an optional optimization for repo overview pages.
- Retain the REST batch as the canonical fallback because it handles README detection, large blobs, and per-resource retries more cleanly.

### Pros/Cons vs REST

| Aspect | GraphQL | REST |
|--------|---------|------|
| **Request count** | Single query for multiple resources | Multiple endpoints |
| **Bandwidth** | Only requested fields | Fixed response schema |
| **Complexity** | Higher learning curve | Simpler, well-documented |
| **Rate limit** | Points-based (complex) | Simple request count |
| **File content** | Limited (no blobs > 1 MB) | Full access via Git Blobs API |
| **Caching** | Harder (unique queries) | Easier (URL-based) |
| **Error handling** | Partial errors possible | All-or-nothing |
| **Tooling** | Requires GraphQL client | Standard HTTP tools |

### Recommendation: Hybrid Approach

**Recommendation: REST-first, with GraphQL as an optional repo-overview fast path**

Use REST as the canonical implementation for:
- file and directory fetching
- README resolution
- issues, PRs, releases, commits, actions, gists, users, orgs
- binary classification and large-file fallback handling
- simpler per-endpoint retries, pagination, and URL-based caching

Use GraphQL only for:
- collapsing repo overview aggregation into a single request when rate budget is healthy
- GraphQL-only surfaces such as Discussions
- optional future enhancements where one large query is materially faster than 7-10 REST calls

Do not make GraphQL the only repo-overview path. A single query is elegant, but it is more brittle around README discovery, large blobs, and partial failure handling.

---

## 3. Authentication & Rate Limits

### Personal Access Token (PAT) Types

#### Classic PAT
```
Scopes needed for read-only access:
- repo        - Read private repositories through the REST and GraphQL APIs
- gist        - Access private gists
```

For public-only fetching, classic PATs are optional. Unauthenticated requests or a classic PAT with no scopes can read public resources, but the 60/hour unauthenticated limit is too small for a production fetch provider.

#### Fine-Grained PAT (Recommended)
More secure, resource-specific permissions. Fine-grained PATs always include read-only access to public repositories; to read private repositories you must select the target owner/repositories and grant repository permissions.

| Permission | Level | Endpoints |
|------------|-------|-----------|
| Metadata | Read | Repo metadata, languages, refs, visibility |
| Contents | Read | Files, README, trees, blobs, releases |
| Issues | Read | Issues and comments |
| Pull requests | Read | PR metadata and PR files |
| Actions | Read | Workflow runs |
| Discussions | Read (optional) | Discussions via GraphQL |

**If private gists matter:** add the account-level Gists permission, or use a classic PAT with `gist`.

**Benefits of Fine-Grained PATs:**
- Repository-specific access
- No broad classic `repo` scope
- Expiration required (security)
- Organization approval and policy controls

### Rate Limit Summary

#### Primary Rate Limits

| Authentication | Limit |
|----------------|-------|
| Unauthenticated | 60 requests/hour |
| Classic PAT | 5,000 requests/hour |
| GitHub App (user) | 5,000 requests/hour |
| GitHub App (installation) | 5,000-12,500/hour (scales) |
| GitHub Enterprise Cloud | 15,000 requests/hour |
| GITHUB_TOKEN (Actions) | 1,000-15,000/hour |

#### Secondary Rate Limits (Abuse Prevention)

| Trigger | Limit |
|---------|-------|
| Concurrent requests | Max 100 (shared REST + GraphQL) |
| Per-endpoint per minute | 900 points (REST), 2,000 points (GraphQL) |
| CPU time | Max 90s CPU per 60s real time |
| Content creation | Max 80/min, 500/hour |
| OAuth token requests | Max 2,000/hour |

**Point Costs (Secondary):**
| Request Type | Points |
|--------------|--------|
| GET/HEAD/OPTIONS | 1 |
| POST/PATCH/PUT/DELETE | 5 |
| GraphQL (no mutation) | 1 |
| GraphQL (mutation) | 5 |

### Rate Limit Headers

Every response includes:
```http
X-RateLimit-Limit: 5000
X-RateLimit-Remaining: 4999
X-RateLimit-Used: 1
X-RateLimit-Reset: 1691591363    // UTC epoch seconds
X-RateLimit-Resource: core       // core, search, graphql, etc.
```

**Check rate limit without consuming quota:**
```http
GET /rate_limit
```

`GET /rate_limit` does not count against the primary REST limit, but GitHub notes that it can still count against secondary limits. Prefer reading the rate-limit headers already returned by normal API calls.

### Rate Limit Response

**Primary limit exceeded:**
```http
HTTP/1.1 403 Forbidden
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1691591363

{"message": "API rate limit exceeded"}
```

**Secondary limit exceeded:**
```http
HTTP/1.1 403 Forbidden
Retry-After: 60

{"message": "You have exceeded a secondary rate limit"}
```

### Graceful Degradation Strategy

```typescript
interface RateLimitStatus {
  remaining: number;
  resetAt: number;
  isSecondaryLimited: boolean;
  retryAfter?: number;
}

function shouldDegrade(status: RateLimitStatus): boolean {
  // Degrade when low on quota
  if (status.remaining < 10) return true;
  
  // Degrade when secondary limited
  if (status.isSecondaryLimited) return true;
  
  return false;
}

async function fetchWithDegradation(
  url: string,
  token: string
): Promise<FetchResult> {
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json'
    }
  });
  
  // Check rate limit headers
  const remaining = parseInt(response.headers.get('X-RateLimit-Remaining') || '0');
  const resetAt = parseInt(response.headers.get('X-RateLimit-Reset') || '0');
  const retryAfter = response.headers.get('Retry-After');
  
  if (response.status === 403 || response.status === 429) {
    if (retryAfter) {
      // Secondary rate limit - wait specified time
      throw new ProviderError(
        ErrorType.RATE_LIMIT,
        `Secondary rate limit. Retry after ${retryAfter}s`,
        'github',
        { retryAfter: parseInt(retryAfter) }
      );
    }
    
    if (remaining === 0) {
      // Primary rate limit - wait until reset
      const waitMs = (resetAt * 1000) - Date.now();
      throw new ProviderError(
        ErrorType.RATE_LIMIT,
        `Rate limit exceeded. Resets at ${new Date(resetAt * 1000).toISOString()}`,
        'github',
        { resetAt, waitMs }
      );
    }
  }
  
  return response;
}
```

### Best Practices

1. **Always use authenticated requests** — 5,000 vs 60/hour
2. **Monitor headers** — don't wait for 403/429
3. **Implement exponential backoff** — 1s, 2s, 4s, 8s...
4. **Use conditional requests** — ETag for caching
5. **Pause between mutative requests** — 1 second minimum
6. **Avoid unbounded concurrency** — keep repo-overview fan-out small (for example 3-4 in-flight requests), not dozens
7. **Exploit existing Omnisearch caching** — final fetch results already sit behind a 36-hour cache; use ETags before adding another heavy internal cache layer

---

## 4. URL Parsing — All GitHub URL Patterns

### URL Pattern Catalog

| GitHub URL Pattern | Resource Type | API Endpoint(s) |
|-------------------|---------------|-----------------|
| `github.com/{owner}/{repo}` | repo_overview | `/repos/{owner}/{repo}` + enrichment |
| `github.com/{owner}/{repo}/tree/{ref}/{path}` | directory | `/repos/{owner}/{repo}/contents/{path}?ref={ref}` |
| `github.com/{owner}/{repo}/blob/{ref}/{path}` | file | `/repos/{owner}/{repo}/contents/{path}?ref={ref}` |
| `github.com/{owner}/{repo}/issues` | issue_list | `/repos/{owner}/{repo}/issues` |
| `github.com/{owner}/{repo}/issues/{number}` | issue | `/repos/{owner}/{repo}/issues/{number}` + `/comments` |
| `github.com/{owner}/{repo}/pull/{number}` | pull_request | `/repos/{owner}/{repo}/pulls/{number}` |
| `github.com/{owner}/{repo}/pull/{number}/files` | pr_files | `/repos/{owner}/{repo}/pulls/{number}/files` |
| `github.com/{owner}/{repo}/releases` | release_list | `/repos/{owner}/{repo}/releases` |
| `github.com/{owner}/{repo}/releases/tag/{tag}` | release | `/repos/{owner}/{repo}/releases/tags/{tag}` |
| `github.com/{owner}/{repo}/commits` | commit_list | `/repos/{owner}/{repo}/commits` |
| `github.com/{owner}/{repo}/commits/{ref}` | commit_list | `/repos/{owner}/{repo}/commits?sha={ref}` |
| `github.com/{owner}/{repo}/commit/{sha}` | commit | `/repos/{owner}/{repo}/commits/{sha}` |
| `github.com/{owner}/{repo}/actions` | actions | `/repos/{owner}/{repo}/actions/runs` |
| `github.com/{owner}/{repo}/actions/runs/{id}` | action_run | `/repos/{owner}/{repo}/actions/runs/{id}` |
| `github.com/{owner}/{repo}/wiki` | wiki | No first-class REST wiki page API; wiki is a separate git repo (`{repo}.wiki.git`) |
| `github.com/{owner}/{repo}/discussions` | discussions | GraphQL only |
| `github.com/{owner}/{repo}/discussions/{number}` | discussion | GraphQL only |
| `github.com/{owner}/{repo}/compare/{base}...{head}` | compare | `/repos/{owner}/{repo}/compare/{basehead}` |
| `github.com/{user}` | user_profile | `/users/{user}` + `/users/{user}/repos` |
| `github.com/orgs/{org}` | org_profile | `/orgs/{org}` + `/orgs/{org}/repos` |
| `gist.github.com/{id}` | gist | `/gists/{id}` |
| `gist.github.com/{user}/{id}` | gist | `/gists/{id}` |
| `raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}` | raw_file | Parse and map to `/repos/{owner}/{repo}/contents/{path}?ref={ref}` |

### URL Parser Pseudocode

```typescript
interface ParsedGitHubUrl {
  platform: 'github' | 'gist' | 'raw';
  resource_type: string;
  owner?: string;
  repo?: string;
  ref?: string;           // branch, tag, or commit
  path?: string;
  resource_id?: string;   // issue number, PR number, etc.
  gist_id?: string;
}

async function parseGitHubUrl(url: string): Promise<ParsedGitHubUrl | null> {
  const u = new URL(url);
  const parts = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean);

  if (u.hostname === 'gist.github.com') {
    const gistId = parts.at(-1);
    if (!gistId) return null;
    return { platform: 'gist', resource_type: 'gist', gist_id: gistId };
  }

  if (u.hostname === 'raw.githubusercontent.com') {
    if (parts.length < 4) return null;
    const { ref, path } = await resolveRefAndPath(parts[0], parts[1], parts.slice(2));
    return {
      platform: 'raw',
      resource_type: 'raw_file',
      owner: parts[0],
      repo: parts[1],
      ref,
      path,
    };
  }

  if (u.hostname !== 'github.com') return null;

  if (parts[0] === 'orgs' && parts[1]) {
    return {
      platform: 'github',
      resource_type: 'org_profile',
      owner: parts[1],
      resource_id: parts[1],
    };
  }

  if (parts.length === 1) {
    return {
      platform: 'github',
      resource_type: 'user_profile',
      owner: parts[0],
      resource_id: parts[0],
    };
  }

  const [owner, repo, ...rest] = parts;
  if (!owner || !repo) return null;
  if (rest.length === 0) return { platform: 'github', resource_type: 'repo_overview', owner, repo };

  const head = rest[0];

  if (head === 'issues' && rest.length === 1) return { platform: 'github', resource_type: 'issue_list', owner, repo };
  if (head === 'issues' && /^\d+$/.test(rest[1] ?? '')) return { platform: 'github', resource_type: 'issue', owner, repo, resource_id: rest[1] };
  if (head === 'pull' && /^\d+$/.test(rest[1] ?? '')) {
    return {
      platform: 'github',
      resource_type: rest[2] === 'files' ? 'pr_files' : 'pull_request',
      owner,
      repo,
      resource_id: rest[1],
    };
  }
  if (head === 'releases' && rest[1] === 'tag' && rest[2]) return { platform: 'github', resource_type: 'release', owner, repo, resource_id: decodeURIComponent(rest.slice(2).join('/')) };
  if (head === 'releases') return { platform: 'github', resource_type: 'release_list', owner, repo };
  if (head === 'commits' && rest.length === 1) return { platform: 'github', resource_type: 'commit_list', owner, repo };
  if (head === 'commits' && rest[1]) return { platform: 'github', resource_type: 'commit_list', owner, repo, ref: decodeURIComponent(rest.slice(1).join('/')) };
  if (head === 'commit' && rest[1]) return { platform: 'github', resource_type: 'commit', owner, repo, resource_id: rest[1] };
  if (head === 'actions' && rest.length === 1) return { platform: 'github', resource_type: 'actions', owner, repo };
  if (head === 'actions' && rest[1] === 'runs' && rest[2]) return { platform: 'github', resource_type: 'action_run', owner, repo, resource_id: rest[2] };
  if (head === 'wiki') return { platform: 'github', resource_type: 'wiki', owner, repo, path: rest.slice(1).join('/') || undefined };
  if (head === 'discussions' && rest.length === 1) return { platform: 'github', resource_type: 'discussions', owner, repo };
  if (head === 'discussions' && rest[1]) return { platform: 'github', resource_type: 'discussion', owner, repo, resource_id: rest[1] };
  if (head === 'compare' && rest[1]) return { platform: 'github', resource_type: 'compare', owner, repo, resource_id: decodeURIComponent(rest.slice(1).join('/')) };

  if (head === 'blob' || head === 'tree') {
    // Important: refs can contain slashes (for example feature/foo or release/2026/Q2),
    // so do not parse ref with a single regex capture.
    const { ref, path } = await resolveRefAndPath(owner, repo, rest.slice(1));
    return {
      platform: 'github',
      resource_type: head === 'blob' ? 'file' : 'directory',
      owner,
      repo,
      ref,
      path,
    };
  }

  return null;
}
```

**Ref resolution for `/tree/{ref}/{path}` and `/blob/{ref}/{path}`**

GitHub refs can contain `/`, so parsing `blob/main/src/index.ts` is easy but parsing `blob/feature/foo/src/index.ts` is ambiguous. The provider should resolve the ref with repository-aware logic, not regex alone.

```typescript
async function resolveRefAndPath(
  owner: string,
  repo: string,
  remainder: string[],
): Promise<{ ref: string; path: string }> {
  const joined = remainder.join('/');

  // Fast path: 40-char SHA at the front
  const shaMatch = joined.match(/^([a-f0-9]{40})(?:\/(.*))?$/i);
  if (shaMatch) return { ref: shaMatch[1], path: shaMatch[2] ?? '' };

  // 1. Try the default branch name first (cheap and very common)
  const repoMeta = await GET(`/repos/${owner}/${repo}`);
  const defaultBranch = repoMeta.default_branch;
  if (joined === defaultBranch || joined.startsWith(`${defaultBranch}/`)) {
    return {
      ref: defaultBranch,
      path: joined.slice(defaultBranch.length).replace(/^\//, ''),
    };
  }

  // 2. Resolve by longest matching ref prefix.
  //    GitHub exposes git refs under refs/heads/* and refs/tags/*.
  //    A practical strategy is to test prefixes from longest to shortest.
  for (let i = remainder.length; i >= 1; i--) {
    const candidateRef = remainder.slice(0, i).join('/');

    if (await refExists(owner, repo, candidateRef)) {
      return {
        ref: candidateRef,
        path: remainder.slice(i).join('/'),
      };
    }
  }

  throw new Error('Unable to resolve GitHub ref from URL path');
}

async function refExists(owner: string, repo: string, ref: string): Promise<boolean> {
  const encoded = encodeURIComponent(ref);
  const branch = await GET(`/repos/${owner}/${repo}/branches/${encoded}`, { allow404: true });
  if (branch) return true;

  const tag = await GET(`/repos/${owner}/${repo}/git/ref/tags/${encoded}`, { allow404: true });
  if (tag) return true;

  return false;
}
```

**Practical recommendation:** cache resolved `(owner, repo, blob|tree path prefix) -> ref` decisions for the duration of the fetch. Repositories often use the same branch naming patterns repeatedly.

---

## 5. LLM-Optimized Output Format

### Design Principles

1. **Structured markdown** — Easy for LLMs to parse
2. **Clear section headers** — Hierarchical organization
3. **Consistent metadata** — Always present key fields
4. **Token-efficient** — Avoid redundant information
5. **Linked references** — Include URLs for drill-down

### 5.1 Repository Overview Template

```markdown
# {full_name}

> {description}

**Project Identity**
| Field | Value |
|-------|-------|
| Owner | [{owner.login}]({owner.html_url}) ({owner.type}) |
| License | {license.name} ({license.spdx_id}) |
| Visibility | {visibility} |
| Default Branch | `{default_branch}` |
| Created | {created_at} |
| Updated | {updated_at} |
| Pushed | {pushed_at} |

**Stats**
- ⭐ Stars: {stargazers_count}
- 🍴 Forks: {forks_count}
- 📋 Open Issues: {open_issues_count}
- 👀 Watchers: {watchers_count}
- 📦 Size: {size} KB

**Language Breakdown**
| Language | Bytes |
|----------|-------|
| TypeScript | 45,230 |
| JavaScript | 12,450 |
| CSS | 3,200 |

**Topics**
{topics.map(t => `- ${t}`).join('\n')}

**Repository Flags**
- Archived: {archived ? 'Yes ⚠️' : 'No'}
- Fork: {fork ? 'Yes (parent: {parent.full_name})' : 'No'}
- Template: {is_template ? 'Yes' : 'No'}
- Features: Issues {has_issues ? '✓' : '✗'}, Wiki {has_wiki ? '✓' : '✗'}, 
  Discussions {has_discussions ? '✓' : '✗'}, Projects {has_projects ? '✓' : '✗'}

---

## README

{readme_content}

---

## Directory Structure

```
{tree_output}
```

---

## Recent Commits (last 10)

| Date | Author | Message |
|------|--------|---------|
| 2026-04-09 | @alice | `fix: resolve race condition` |
| 2026-04-08 | @bob | `feat: add OAuth support` |
| ... | ... | ... |

---

## Open Issues (last 5)

### #{number}: {title}
- **State:** {state} | **Labels:** {labels.join(', ')}
- **Author:** @{author.login} | **Created:** {created_at}
- {body.substring(0, 500)}...

[View Issue]({html_url})

---

## Recent Releases (last 3)

### {name} ({tag_name})
- **Date:** {published_at}
- **Pre-release:** {prerelease ? 'Yes' : 'No'}
- **Draft:** {draft ? 'Yes' : 'No'}

{body.substring(0, 1000)}

[Download]({assets[0].browser_download_url})

---

## Context Files Detected

- [CLAUDE.md](...) - Claude Code instructions
- [AGENTS.md](...) - Multi-agent instructions
- [llms.txt](...) - LLM context file

---

*Fetched via GitHub API on {timestamp}*
```

### 5.2 File View Template

```markdown
# {path}

**File Metadata**
| Field | Value |
|-------|-------|
| Repository | {owner}/{repo} |
| Branch | {ref} |
| Size | {size} bytes |
| SHA | `{sha}` |

**URL**: [View on GitHub]({html_url})

---

## Content

```{language}
{content}
```

---

*Note: Large files (>1MB) may be truncated. Use [raw URL]({download_url}) for full content.*
```

### 5.3 Issue Template

```markdown
# Issue #{number}: {title}

**Metadata**
| Field | Value |
|-------|-------|
| State | {state} |
| Author | @{user.login} |
| Created | {created_at} |
| Updated | {updated_at} |
| Closed | {closed_at || 'N/A'} |
| Labels | {labels.map(l => l.name).join(', ') || 'None'} |
| Assignees | {assignees.map(a => '@' + a.login).join(', ') || 'None'} |
| Milestone | {milestone?.title || 'None'} |
| Comments | {comments} |

**Body**

{body}

---

## Comments ({comments})

### @{comment.user.login} - {comment.created_at}

{comment.body}

---
```

### 5.4 Pull Request Template

```markdown
# PR #{number}: {title}

**Overview**
| Field | Value |
|-------|-------|
| State | {state} |
| Draft | {draft ? 'Yes' : 'No'} |
| Author | @{user.login} |
| Created | {created_at} |
| Merged | {merged ? `Yes at ${merged_at}` : 'No'} |

**Branches**
| | Branch | Commit |
|---|--------|--------|
| **Head** | `{head.ref}` | `{head.sha.substring(0,7)}` |
| **Base** | `{base.ref}` | `{base.sha.substring(0,7)}` |

**Diff Stats**
- Files changed: {changed_files}
- Additions: +{additions}
- Deletions: -{deletions}

**Body**

{body}

---

## Changes

```diff
{file.patch.substring(0, 5000)}
```

---

[View diff]({diff_url}) | [View patch]({patch_url})
```

### 5.5 Directory Listing Template

```markdown
# {path || 'Root Directory'}

**Location**: `{owner}/{repo}/{ref}:{path}`

**Contents** ({items.length} items)

| Type | Name | Size |
|------|------|------|
| 📁 | [src/](...) | - |
| 📄 | [package.json](...) | 2.3 KB |
| 📄 | [README.md](...) | 5.1 KB |

---

## Subdirectories

- [src/](...) - Source code
- [docs/](...) - Documentation

## Files

- [package.json](...) - Dependencies
- [tsconfig.json](...) - TypeScript config
```

### 5.6 User Profile Template

```markdown
# {name || login}

@{login} ({type})

> {bio}

**Profile**
| Field | Value |
|-------|-------|
| Company | {company || 'N/A'} |
| Location | {location || 'N/A'} |
| Website | {blog || 'N/A'} |
| Email | {email || 'N/A'} |
| Twitter | {twitter_username ? `@${twitter_username}` : 'N/A'} |
| Joined | {created_at} |

**Stats**
- Public Repos: {public_repos}
- Public Gists: {public_gists}
- Followers: {followers}
- Following: {following}

**Contribution Snapshot**
- Total Contributions (if GraphQL used): {total_contributions_last_year}
- Pinned / Popular Repos Considered: {repo_count_considered}
- Account Created: {created_at}

---

## Popular Repositories

| Repo | Stars | Language | Description |
|------|-------|----------|-------------|
| [repo1](...) | 1.2k | TypeScript | ... |
| [repo2](...) | 850 | Python | ... |
```

---

## 6. LLM Context Enrichment — Structured Discovery Files

### 6.1 llms.txt (https://llmstxt.org/)

**Specification:**
- Location: `/llms.txt` in website root
- Format: Markdown with specific structure
- Purpose: Provide LLM-friendly documentation overview

**Required Sections:**
```markdown
# {Project Name}

> Short summary (blockquote)

Optional details paragraphs...

## Section Name

- [Link title](https://url): Optional description
- [Another link](https://url2): Description

## Optional

- [Secondary link](https://url): Less critical docs
```

**Key Features:**
1. **H1 Title** — Only required section
2. **Blockquote summary** — Essential context
3. **H2 Sections** — Grouped resources
4. **"Optional" section** — Can be skipped for shorter context
5. **Markdown links** — Each with optional description after `:`

**Examples in the Wild:**
- FastHTML: https://fastht.ml/llms.txt
- Answer.AI projects
- nbdev-generated documentation

**Auto-Generation Potential:**
Yes — can generate from GitHub API:
- Project name → repo name
- Description → repo description
- Docs section → README sections
- Examples → linked example files
- Optional → secondary documentation

### 6.2 llms-full.txt

`llms-full.txt` is best treated as a convention, not part of the core `llmstxt.org` spec. The official proposal standardizes `llms.txt`; some tools and sites additionally publish expanded context artifacts that inline linked content. The `llmstxt.org` example ecosystem also uses names such as `llms-ctx.txt` and `llms-ctx-full.txt`.

**Usage:**
```bash
# Using llms_txt2ctx tool
llms_txt2ctx llms.txt --output llms-ctx.txt      # Without optional
llms_txt2ctx llms.txt --full --output llms-ctx-full.txt  # With optional
```

**Structure:**
```markdown
# {Project Name} — Full Context

> Summary

## {Section Name}

### {Linked Page Title}

Full markdown content of the linked page...

---

### {Another Linked Page}

...
```

### 6.3 AI Tool Instruction Files

| File | Tool | Purpose | Location |
|------|------|---------|----------|
| `CLAUDE.md` | Claude Code | Claude Code project instructions | Root or `.claude/` |
| `AGENTS.md` | GitHub Copilot, Cursor, Codex-style agents | Agent instructions | Root or nested directories |
| `.cursorrules` | Cursor (legacy) | Legacy Cursor rules format | Root |
| `.cursor/rules/*.md` / `.mdc` | Cursor | Scoped project rules | `.cursor/rules/` |
| `.github/copilot-instructions.md` | GitHub Copilot | Copilot context | `.github/` |
| `CONTRIBUTING.md` | All | Contribution guidelines | Root |
| `CHANGELOG.md` | All | Version history | Root |
| `.github/instructions/*.instructions.md` | GitHub Copilot | Path-specific instructions | `.github/instructions/` |

**CLAUDE.md Example:**
```markdown
# Project Instructions

## Tech Stack
- TypeScript 5.9
- Cloudflare Workers
- MCP SDK

## Commands
- Build: `npm run typecheck`
- Test: `npm test`
- Deploy: `npm run deploy`

## Code Style
- Use explicit types, avoid `any`
- Prefer `interface` over `type` for objects
- Use Zod for validation
```

**AGENTS.md Example:**
```markdown
# AGENTS.md

## Project Context
MCP server for multi-provider search aggregation.

## Build & Test
- `npm ci` — install dependencies
- `npm run typecheck` — type check
- `npm run dev` — local dev

## Conventions
- All providers in `src/providers/{type}/{name}/`
- Use registry pattern for registration
- KV cache with 36h TTL
```

### 6.4 Detection Strategy

**Option B Recommended:** use root contents from batch 1, then do targeted subdirectory discovery only when `.github` or `.cursor` exists.

```typescript
const ROOT_CONTEXT_FILES = [
  'CLAUDE.md',
  'AGENTS.md', 
  'llms.txt',
  'llms-full.txt',
  '.cursorrules',
  'CONTRIBUTING.md',
  'CHANGELOG.md',
  'README.md'  // Always fetch anyway
];

async function detectContextFiles(
  owner: string,
  repo: string,
  ref: string
): Promise<string[]> {
  const root = await fetchContents(owner, repo, '', ref); // already needed for repo overview
  const rootNames = new Set(root.map(entry => entry.name));
  const hits = ROOT_CONTEXT_FILES.filter(name => rootNames.has(name));

  if (rootNames.has('.github')) {
    const githubDir = await fetchContents(owner, repo, '.github', ref);
    if (githubDir.some(entry => entry.name === 'copilot-instructions.md')) {
      hits.push('.github/copilot-instructions.md');
    }
    if (githubDir.some(entry => entry.name === 'instructions')) {
      // Optional: fetch .github/instructions only if you decide to ingest path-specific Copilot rules
    }
  }

  if (rootNames.has('.cursor')) {
    // Optional: inspect .cursor/rules when high-value repo overview context is desired.
    // Do not recursively ingest an entire rules tree by default.
  }

  return hits;
}

async function fetchContextFiles(
  owner: string,
  repo: string,
  ref: string,
  filenames: string[]
): Promise<Record<string, string>> {
  const results: Record<string, string> = {};
  
  await Promise.all(
    filenames.map(async (path) => {
      try {
        const content = await fetchFileContent(owner, repo, path, ref);
        results[path] = content;
      } catch (e) {
        // Skip files that fail to fetch
      }
    })
  );
  
  return results;
}
```

**Provider recommendation:**
- Always check root-level `AGENTS.md`, `CLAUDE.md`, `llms.txt`, `CONTRIBUTING.md`, and `CHANGELOG.md`.
- Check `.github/copilot-instructions.md` with one extra `.github` directory listing when `.github` exists.
- Treat `.cursor/rules/` as optional enrichment. Those directories can contain many scoped files and are easy to over-ingest.
- Include detected context files in repo-overview output, but cap total bytes so they do not swamp the README or core repository summary.

**Why Option B over Option A?**
- No 404 errors (cleaner logs)
- Fewer API calls (1 tree vs N file checks)
- Tree API call already needed for directory listing

---

## 7. Content Assembly Strategy

### Recommended: Optimized Parallel Batching

```
Batch 1 (core — bounded parallelism, always):
  GET /repos/{owner}/{repo}              → metadata, stats, flags
  GET /repos/{owner}/{repo}/readme       → README content (raw)
  GET /repos/{owner}/{repo}/contents     → root directory listing
  GET /repos/{owner}/{repo}/languages    → language breakdown
  
Batch 2 (enrichment — bounded parallelism, optional):
  GET /repos/{owner}/{repo}/commits?per_page=10
  GET /repos/{owner}/{repo}/issues?state=open&per_page=5
  GET /repos/{owner}/{repo}/releases?per_page=3
  
Batch 3 (context files — conditional, targeted):
  // Use root contents from Batch 1 to find root-level hits
  // If .github exists, list .github once and fetch only matches
  GET /repos/{owner}/{repo}/contents/CLAUDE.md?ref={ref}     // if exists
  GET /repos/{owner}/{repo}/contents/AGENTS.md?ref={ref}     // if exists
  GET /repos/{owner}/{repo}/contents/llms.txt?ref={ref}      // if exists
  GET /repos/{owner}/{repo}/contents/.github?ref={ref}       // if .github exists
  GET /repos/{owner}/{repo}/contents/.github/copilot-instructions.md?ref={ref}  // if exists
```

**Concurrency recommendation:** despite the “parallel batch” framing, keep the actual in-flight request count small. A good default is 3-4 concurrent GitHub API calls per repo fetch, not a firehose.

### API Call Estimates

| URL Type | Min Calls | Max Calls | Notes |
|----------|-----------|-----------|-------|
| Repo overview | 4 | 11 | 4 core + 3 enrichment + 0-4 targeted context calls |
| File | 1 | 2 | Contents API + blob fallback |
| Directory | 1 | 2 | Contents API + tree fallback |
| Issue | 1 | 2 | Issue + comments |
| PR | 2 | 3 | PR + files + maybe diff |
| User profile | 2 | 2 | User + repos |
| Org profile | 2 | 2 | Org + repos |
| Gist | 1 | 2 | Single endpoint, plus raw fetch for truncated files |
| Raw file | 1 | 2 | Contents API mapping + blob fallback |

### Latency Estimates

Assuming:
- GitHub API latency: 100-300ms
- Small bounded parallelism within batches
- Sequential batches

| Scenario | Estimated Latency |
|----------|-------------------|
| Repo overview (min) | 300-500ms |
| Repo overview (full) | 700-1200ms |
| Single file | 100-200ms |
| Directory listing | 100-200ms |
| Issue with comments | 200-400ms |

### Optimization Strategies

1. **Parallelize within batches conservatively** — enough to reduce latency, not enough to trigger secondary throttling
2. **Use conditional requests** — ETag caching reduces quota usage
3. **Use root-contents-driven discovery** — avoid 404-heavy probing for context files
4. **Let Omnisearch's existing fetch cache do most of the heavy lifting** — add ETag-based revalidation before building another large cache tier
5. **Short-circuit on errors** — Don't wait for optional data

---

## 8. Edge Cases & Error Handling

### 8.1 Private Repositories

**Problem:** PAT may not have access

**Detection:**
```http
HTTP/1.1 404 Not Found
{
  "message": "Not Found",
  "documentation_url": "https://docs.github.com/rest/repos/repos#get-a-repository"
}
```

**Handling:**
```typescript
if (response.status === 404) {
  // GitHub commonly returns 404 for private resources you cannot see.
  throw new ProviderError(
    ErrorType.API_ERROR,
    `Repository not found or not accessible: ${owner}/${repo}`,
    'github',
    {
      status: 404,
      reason: 'not_found_or_private',
      repo: `${owner}/${repo}`,
      recommendation: 'Try a PAT with Metadata/Contents read access, or fall through to the next fetch provider'
    }
  );
}
```

**Omnisearch-specific recommendation:** surface this as a normal provider failure so the fetch orchestrator can fall through to another provider. If GitHub is the only provider attempted for GitHub URLs, then return a short structured “not accessible” markdown response to the caller.

### 8.2 Rate Limiting

**Detection:** See Section 3

**Response to caller:**
```typescript
throw new ProviderError(
  ErrorType.RATE_LIMIT,
  `GitHub API rate limit exceeded. ${
    retryAfter 
      ? `Retry after ${retryAfter}s.` 
      : `Resets at ${new Date(resetAt * 1000).toISOString()}`
  }`,
  'github',
  { 
    rateLimitRemaining: remaining,
    rateLimitReset: resetAt,
    retryAfter,
    suggestion: 'Consider using a different fetch provider or wait for rate limit reset'
  }
);
```

**Omnisearch-specific recommendation:** preserve `ErrorType.RATE_LIMIT` so the orchestrator can move to the next provider instead of treating this as a generic provider outage.

### 8.3 Large Files (> 1 MB)

**Problem:** the Contents API changes behavior above 1 MB.

**Actual GitHub behavior:**
- `<= 1 MB`: normal JSON response with base64 `content`
- `1-100 MB`: use `Accept: application/vnd.github.raw+json` or `application/vnd.github.object+json`
- `> 100 MB`: Contents API unsupported

**Recommended fallback path:** use the Git Blobs API for 1-100 MB text files when you already have the blob SHA, otherwise return metadata only.
```typescript
async function fetchLargeFile(
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<string> {
  // 1. Get file SHA from tree
  const tree = await fetchTree(owner, repo, ref);
  const entry = tree.tree.find(e => e.path === path);
  
  if (!entry) throw new Error('File not found in tree');
  
  // 2. Fetch blob with raw accept header
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/blobs/${entry.sha}`,
    {
      headers: {
        'Accept': 'application/vnd.github.raw+json',
        'Authorization': `Bearer ${token}`
      }
    }
  );
  
  return response.text();
}
```

**Important limit:** the Git Blobs API also tops out at 100 MB. For larger files, return metadata plus download/raw links instead of attempting inline text extraction.

### 8.4 Binary Files

**Detection:** Check `content` field or file extension

```typescript
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'ico', 'svg',
  'pdf', 'zip', 'tar', 'gz', 'rar',
  'exe', 'dll', 'so', 'dylib',
  'mp3', 'mp4', 'avi', 'mov',
  'woff', 'woff2', 'ttf', 'otf'
]);

function isBinaryFile(filename: string, encoding?: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext && BINARY_EXTENSIONS.has(ext)) return true;
  if (encoding && encoding !== 'base64') return true;
  return false;
}

// Response for binary files
{
  content: `## Binary File

**File:** ${path}
**Type:** ${mimeType}
**Size:** ${size} bytes

This is a binary file that cannot be displayed as text.
[Download file](${download_url})
`,
  metadata: { isBinary: true, mimeType, size }
}
```

### 8.5 Empty Repositories

**Detection:**
```typescript
if (repo.size === 0 && !repo.default_branch) {
  return {
    content: `# ${repo.full_name}

> ${repo.description || 'No description'}

⚠️ This repository is empty. No files or commits yet.

[Initialize repository](${repo.html_url})
`
  };
}
```

### 8.6 Renamed/Redirected Repositories

**Detection:**
```http
HTTP/1.1 301 Moved Permanently
Location: https://api.github.com/repos/NEW_OWNER/NEW_REPO
```

**Handling:**
```typescript
if (response.status === 301 || response.status === 308) {
  const newUrl = response.headers.get('Location');
  // Follow redirect, update canonical URL
  return fetchWithRedirect(newUrl, options, redirectCount + 1);
}
```

Also check repo metadata:
```typescript
if (repo.name !== requestedRepo || repo.owner.login !== requestedOwner) {
  // Repository was renamed
  return {
    content: `...`,
    metadata: {
      renamedFrom: `${requestedOwner}/${requestedRepo}`,
      renamedTo: repo.full_name,
      originalUrl: requestedUrl
    }
  };
}
```

### 8.7 Forked Repositories

**Detection:**
```typescript
if (repo.fork) {
  const parent = repo.parent;
  const source = repo.source;
  
  content += `
## Fork Information

This is a fork of [${parent.full_name}](${parent.html_url}).

| | Fork | Upstream |
|---|------|----------|
| Stars | ${repo.stargazers_count} | ${parent.stargazers_count} |
| Forks | ${repo.forks_count} | ${parent.forks_count} |
| Updated | ${repo.updated_at} | ${parent.updated_at} |
`;
}
```

### 8.8 GitHub Enterprise

**Configuration:**
```typescript
interface GitHubConfig {
  baseUrl: string;        // https://api.github.com or https://github.company.com/api/v3
  token: string;
  apiVersion: string;     // 2022-11-28
}

// Build URLs dynamically
function buildUrl(config: GitHubConfig, path: string): string {
  return `${config.baseUrl}${path}`;
}
```

### 8.9 Monorepos (Large Root Directories)

**Problem:** Contents API limited to 1,000 files

**Detection:**
```typescript
const contents = await fetchContents(owner, repo, '');
if (contents.length === 1000) {
  // Likely truncated, use tree API
  return fetchTreeRecursive(owner, repo, ref);
}
```

**Fallback to Tree API:**
```typescript
async function fetchLargeDirectory(
  owner: string,
  repo: string,
  ref: string
): Promise<TreeEntry[]> {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`
  );
  
  const tree = await response.json();
  
  if (tree.truncated) {
    // Even tree is too large - fetch non-recursively and paginate
    return fetchTreePaginated(owner, repo, ref);
  }
  
  return tree.tree;
}
```

### 8.10 Truncated Content

**Detection (gists):**
```typescript
if (file.truncated) {
  // Fetch full content from raw_url
  const fullContent = await fetch(file.raw_url);
  return fullContent;
}
```

---

## 9. Implementation Recommendations

### 9.1 Architecture Decision: REST vs GraphQL vs Hybrid

**Recommendation: Hybrid, but REST-first**

| Criterion | REST | GraphQL | Winner |
|-----------|------|---------|--------|
| Simplicity | ✅ Simple URLs | ❌ Complex queries | REST |
| Caching | ✅ URL-based | ❌ Query-based | REST |
| File access | ✅ Full blobs | ❌ Limited | REST |
| Bandwidth | ❌ Fixed schema | ✅ Precise fields | GraphQL |
| Request count | ❌ Multiple | ✅ Single | GraphQL |
| Error handling | ✅ All/nothing | ⚠️ Partial | REST |
| Tooling | ✅ Standard HTTP | ❌ GraphQL client | REST |

**Decision Matrix:**
- **Repo overview** → REST batch as the canonical path, with optional GraphQL fast path
- **File fetching** → REST (blob support, raw content, binary handling)
- **Discussions** → GraphQL
- **General use** → REST (more predictable, easier to debug)

### 9.2 Recommended Parallel Batching Strategy

```typescript
interface FetchBatch {
  name: string;
  requests: ApiRequest[];
  optional: boolean;
}

const BATCHES: FetchBatch[] = [
  {
    name: 'core',
    optional: false,
    requests: [
      { endpoint: '/repos/{owner}/{repo}', priority: 1 },
      { endpoint: '/repos/{owner}/{repo}/readme', priority: 1 },
      { endpoint: '/repos/{owner}/{repo}/contents', priority: 1 },
      { endpoint: '/repos/{owner}/{repo}/languages', priority: 2 }
    ]
  },
  {
    name: 'enrichment',
    optional: true,
    requests: [
      { endpoint: '/repos/{owner}/{repo}/commits?per_page=10', priority: 2 },
      { endpoint: '/repos/{owner}/{repo}/issues?state=open&per_page=5', priority: 2 },
      { endpoint: '/repos/{owner}/{repo}/releases?per_page=3', priority: 3 }
    ]
  },
  {
    name: 'context_files',
    optional: true,
    requests: []  // Dynamic based on root contents and targeted subdir listings
  }
];
```

**Operational recommendation:** throttle these batches through a small concurrency limiter. The implementation should feel parallel to the caller, but should not blast GitHub with large simultaneous request bursts.

### 9.3 API Calls per URL Type

| URL Type | Calls (min) | Calls (max) | Typical |
|----------|-------------|-------------|---------|
| Repo overview | 4 | 11 | 7-9 |
| File | 1 | 2 | 1 |
| Directory | 1 | 2 | 1 |
| Issue | 1 | 2 | 2 |
| PR | 2 | 3 | 2 |
| Release list / tag | 1 | 1 | 1 |
| Commit list / commit | 1 | 1 | 1 |
| Compare | 1 | 1 | 1 |
| Actions / action run | 1 | 1 | 1 |
| User | 2 | 2 | 2 |
| Org | 2 | 2 | 2 |
| Gist | 1 | 2 | 1 |
| Raw file | 1 | 2 | 1 |

### 9.4 Recommended PAT Permissions

**Minimal Scope for Read-Only Public Access:**
- Unauthenticated access works, but only at 60 requests/hour
- For production, prefer an authenticated token even for public repos

**Recommended for Full Functionality:**
- **Fine-Grained PAT** with:
  - `Metadata: Read`
  - `Contents: Read`
  - `Issues: Read`
  - `Pull requests: Read`
  - `Actions: Read`
  - `Discussions: Read` only if you implement discussions support
  - repository selection scoped to the repos you want to read privately

**Classic PAT scopes:**
- `repo` — Read private repositories
- `gist` — Read private gists

**Practical recommendation:** default to a fine-grained PAT. Fall back to classic only when the deployment environment cannot yet manage fine-grained tokens cleanly.

### 9.5 Caching Strategy

**What to Cache:**

Omnisearch already caches the final fetch result for 36 hours. That means the GitHub provider does not need a second large, long-lived cache on day one. The best first step is conditional revalidation with `ETag` / `If-None-Match` on GitHub API calls.

| Resource | TTL | Key Strategy |
|----------|-----|--------------|
| Final assembled fetch result | Reuse existing 36h Omnisearch cache | URL hash |
| Repo metadata ETag | 1-6 hours local memoization | `github:etag:repo:{owner}:{repo}` |
| README ETag | 1-6 hours local memoization | `github:etag:readme:{owner}:{repo}:{ref}` |
| File/blob ETag | 1-24 hours local memoization | `github:etag:file:{owner}:{repo}:{sha-or-ref-path}` |
| Short-lived ref resolution cache | Per fetch / a few minutes | `github:ref:{owner}:{repo}:{url-fragment}` |

**Cache Invalidation:**
- Use `ETag` headers for conditional requests
- Treat `304 Not Modified` as a quota optimization
- Prefer stale-while-revalidate only after the provider is stable
- Keep cache keys tied to `ref` or `sha` for file/directory content, not just path

### 9.6 Priority Order for URL Type Support

**Phase 1 (MVP):**
1. `github.com/{owner}/{repo}` — Repo overview (highest value)
2. `github.com/{owner}/{repo}/blob/{ref}/{path}` — File view
3. `github.com/{owner}/{repo}/tree/{ref}/{path}` — Directory listing
4. `raw.githubusercontent.com/...` — Raw files, mapped to Contents API

**Phase 2:**
5. `github.com/{owner}/{repo}/issues/{number}` — Single issue
6. `github.com/{owner}/{repo}/issues` — Issue list
7. `github.com/{owner}/{repo}/pull/{number}` — Pull request
8. `github.com/{owner}/{repo}/releases` — Releases
9. `github.com/{owner}/{repo}/commit/{sha}` and `/commits` — Commits

**Phase 3:**
10. `github.com/{owner}` — User profile
11. `github.com/orgs/{org}` — Organization profile
12. `gist.github.com/{id}` — Gists
13. `github.com/{owner}/{repo}/actions` — CI/CD runs
14. `github.com/{owner}/{repo}/compare/{base}...{head}` — Compare view

**Phase 4:**
15. GraphQL-powered discussions support
16. Optional GraphQL repo-overview fast path

---

## Appendix A: Quick Reference Card

### Common API Patterns

```typescript
// Fetch with auth
fetch(`https://api.github.com/repos/${owner}/${repo}`, {
  headers: {
    'Accept': 'application/vnd.github+json',
    'Authorization': `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28'
  }
});

// Raw content
fetch(`https://api.github.com/repos/${owner}/${repo}/readme`, {
  headers: { 'Accept': 'application/vnd.github.raw+json' }
});

// Pagination
fetch(`${endpoint}?per_page=100&page=2`);

// Conditional request (caching)
fetch(endpoint, {
  headers: { 'If-None-Match': cachedEtag }
});
```

### Error Code Quick Reference

| Status | Meaning | Action |
|--------|---------|--------|
| 200 | Success | Process response |
| 204 | No content | Success, no body |
| 301 | Moved permanently | Follow Location header |
| 304 | Not modified | Use cached version |
| 401 | Unauthorized | Check token |
| 403 | Forbidden / Rate limited | Check rate limit headers |
| 404 | Not found | May be private without access |
| 409 | Conflict | Retry with backoff |
| 422 | Validation failed | Check request parameters |
| 451 | Unavailable for legal reasons | DMCA takedown |

### Rate Limit Header Reference

| Header | Description |
|--------|-------------|
| `X-RateLimit-Limit` | Max requests per hour |
| `X-RateLimit-Remaining` | Remaining this window |
| `X-RateLimit-Used` | Used this window |
| `X-RateLimit-Reset` | UTC epoch seconds |
| `X-RateLimit-Resource` | `core`, `search`, `graphql` |
| `Retry-After` | Seconds to wait (secondary limit) |
| `ETag` | Cache validation |
| `Last-Modified` | Cache validation |

---

## Appendix B: TypeScript Interface Definitions

```typescript
// Core types for implementation

interface GitHubRepository {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  owner: GitHubUser;
  private: boolean;
  html_url: string;
  description: string | null;
  fork: boolean;
  url: string;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  homepage: string | null;
  size: number;
  stargazers_count: number;
  watchers_count: number;
  forks_count: number;
  open_issues_count: number;
  default_branch: string;
  topics: string[];
  archived: boolean;
  disabled: boolean;
  visibility: 'public' | 'private' | 'internal';
  license: GitHubLicense | null;
  parent?: GitHubRepository;
  source?: GitHubRepository;
  has_issues: boolean;
  has_projects: boolean;
  has_wiki: boolean;
  has_pages: boolean;
  has_downloads: boolean;
  has_discussions: boolean;
  is_template: boolean;
  allow_forking: boolean;
}

interface GitHubUser {
  login: string;
  id: number;
  node_id: string;
  avatar_url: string;
  html_url: string;
  type: 'User' | 'Organization' | 'Bot';
  site_admin: boolean;
  name?: string | null;
  company?: string | null;
  blog?: string | null;
  location?: string | null;
  email?: string | null;
  hireable?: boolean | null;
  bio?: string | null;
  twitter_username?: string | null;
  public_repos?: number;
  public_gists?: number;
  followers?: number;
  following?: number;
  created_at?: string;
  updated_at?: string;
}

interface GitHubContent {
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  name: string;
  path: string;
  sha: string;
  size: number;
  url: string;
  git_url: string | null;
  html_url: string | null;
  download_url: string | null;
  content?: string;
  encoding?: 'base64';
}

interface GitHubIssue {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  locked: boolean;
  user: GitHubUser;
  labels: GitHubLabel[];
  assignees: GitHubUser[];
  milestone: GitHubMilestone | null;
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  pull_request?: {
    url: string;
    html_url: string;
    diff_url: string;
    patch_url: string;
  };
}

interface GitHubPullRequest extends GitHubIssue {
  merged: boolean;
  mergeable: boolean | null;
  mergeable_state: string;
  merged_by: GitHubUser | null;
  additions: number;
  deletions: number;
  changed_files: number;
  head: GitHubBranchRef;
  base: GitHubBranchRef;
  draft: boolean;
}

interface GitHubFetchResult {
  url: string;
  title: string;
  content: string;
  source_provider: 'github';
  metadata: {
    resource_type: string;
    owner?: string;
    repo?: string;
    ref?: string;
    path?: string;
    [key: string]: unknown;
  };
}
```

---

## Appendix C: Sources

### GitHub REST / GraphQL
- GitHub REST API overview and repositories: https://docs.github.com/en/rest/repos/repos?apiVersion=2022-11-28
- Repository contents and README: https://docs.github.com/en/rest/repos/contents?apiVersion=2022-11-28
- Issues: https://docs.github.com/en/rest/issues/issues?apiVersion=2022-11-28
- Issue comments: https://docs.github.com/en/rest/issues/comments?apiVersion=2022-11-28
- Pull requests: https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28
- Releases: https://docs.github.com/en/rest/releases/releases?apiVersion=2022-11-28
- Commits and compare: https://docs.github.com/en/rest/commits/commits?apiVersion=2022-11-28
- Git trees: https://docs.github.com/en/rest/git/trees?apiVersion=2022-11-28
- Git blobs: https://docs.github.com/en/rest/git/blobs?apiVersion=2022-11-28
- Workflow runs: https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2022-11-28
- Gists: https://docs.github.com/en/rest/gists/gists?apiVersion=2022-11-28
- Users: https://docs.github.com/en/rest/users/users?apiVersion=2022-11-28
- Organizations: https://docs.github.com/en/rest/orgs/orgs?apiVersion=2022-11-28
- REST rate limits: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2022-11-28
- REST best practices: https://docs.github.com/en/rest/guides/best-practices-for-using-the-rest-api
- Personal access tokens: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
- GraphQL rate limits and query limits: https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api
- GitHub Copilot repository instructions / AGENTS.md support: https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions

### LLM Context Conventions
- llms.txt proposal: https://llmstxt.org/
- Anthropic Claude Code memory / `CLAUDE.md`: https://docs.anthropic.com/en/docs/claude-code/memory
- Cursor rules / `AGENTS.md`: https://cursor.com/docs/context/rules

*Report compiled for Omnisearch MCP Server implementation.*
*Last updated: 2026-04-09*
