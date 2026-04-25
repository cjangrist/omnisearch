# GitHub Fetch Provider — Research Report

A comprehensive technical blueprint for building a dedicated GitHub fetch provider for the Omnisearch MCP server.

**Date:** April 9, 2026  
**Purpose:** Implementation blueprint for a GitHub REST/GraphQL API provider delivering LLM-optimized, structured content for any github.com URL.

---

## Table of Contents

1. [GitHub REST API v3 — Endpoint Reference](#1-github-rest-api-v3--endpoint-reference)
2. [GitHub GraphQL API v4 — Single-Query Alternative](#2-github-graphql-api-v4--single-query-alternative)
3. [Authentication & Rate Limits](#3-authentication--rate-limits)
4. [URL Parsing — All GitHub URL Patterns](#4-url-parsing--all-github-url-patterns)
5. [LLM-Optimized Output Format](#5-llm-optimized-output-format)
6. [LLM Context Enrichment — Structured Discovery Files](#6-llm-context-enrichment--structured-discovery-files)
7. [Content Assembly Strategy](#7-content-assembly-strategy)
8. [Edge Cases & Error Handling](#8-edge-cases--error-handling)
9. [Implementation Recommendations](#9-implementation-recommendations)

---

## 1. GitHub REST API v3 — Endpoint Reference

### Core Headers (Required for All Requests)

```http
Authorization: Bearer {PERSONAL_ACCESS_TOKEN}
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28
```

**Base URL:** `https://api.github.com`

### 1.1 Repository Metadata

**Endpoint:** `GET /repos/{owner}/{repo}`

**Headers:**
```
Accept: application/vnd.github+json
```

**Query Parameters:**
- `ref` (optional): The name of the commit/branch/tag. Defaults to repository's default branch.

**Key Response Fields:**
```json
{
  "id": 1296269,
  "name": "Hello-World",
  "full_name": "octocat/Hello-World",
  "owner": { "login": "octocat", "type": "User" },
  "private": false,
  "description": "This your first repo!",
  "fork": false,
  "url": "https://api.github.com/repos/octocat/Hello-World",
  "html_url": "https://github.com/octocat/Hello-World",
  "stargazers_count": 80,
  "forks_count": 9,
  "watchers_count": 80,
  "language": "JavaScript",
  "default_branch": "master",
  "open_issues_count": 0,
  "topics": ["octocat", "atom", "electron", "api"],
  "license": { "key": "mit", "name": "MIT License", "spdx_id": "MIT" },
  "archived": false,
  "disabled": false,
  "visibility": "public",
  "pushed_at": "2011-01-26T19:06:43Z",
  "created_at": "2011-01-26T19:01:12Z",
  "updated_at": "2011-01-26T19:14:43Z",
  "homepage": "https://github.com",
  "has_issues": true,
  "has_projects": true,
  "has_wiki": true,
  "has_pages": false,
  "has_discussions": false,
  "parent": null,           // For forks: the parent repository
  "source": null,           // For forks: the root repository
  "network_count": 0,
  "subscribers_count": 42
}
```

**Pagination:** Not applicable (single resource).

**Status Codes:** 200 OK, 301 Moved Permanently (repo renamed), 403 Forbidden, 404 Not Found.

---

### 1.2 README Content

**Endpoint:** `GET /repos/{owner}/{repo}/readme`

**Headers:**
```
Accept: application/vnd.github.raw+json  (raw markdown — recommended)
# OR
Accept: application/vnd.github.html+json  (rendered HTML)
# OR
Accept: application/vnd.github.object+json  (consistent object format)
```

**Query Parameters:**
- `ref` (optional): The name of the commit/branch/tag.

**Key Response Fields (with `raw` media type):**
```json
{
  "name": "README.md",
  "path": "README.md",
  "sha": "3d21ec53a331a6f037a91c368710b99387d012c1",
  "size": 5362,
  "content": "IyBZb2dhIEJvmsgaW4gcHJvZ...",
  "encoding": "base64",
  "download_url": "https://raw.githubusercontent.com/octocat/Hello-World/master/README.md"
}
```

**Important Notes:**
- The `content` field is Base64-encoded. Decode to get raw markdown.
- `download_url` expires and should not be cached for reuse.
- Returns 404 if no README exists.

**Status Codes:** 200 OK, 304 Not Modified, 404 Not Found.

---

### 1.3 Root Directory Listing

**Endpoint:** `GET /repos/{owner}/{repo}/contents/{path}`

**Headers:**
```
Accept: application/vnd.github.object+json  (recommended for directories)
# OR
Accept: application/vnd.github.raw+json  (raw file content)
```

**Query Parameters:**
- `ref` (optional): The name of the commit/branch/tag.

**Key Response Fields (for directory):**
```json
[
  {
    "name": "README.md",
    "path": "README.md",
    "sha": "3d21ec53a331a6f037a91c368710b99387d012c1",
    "size": 5362,
    "type": "file",
    "download_url": "https://raw.githubusercontent.com/octocat/Hello-World/master/README.md"
  },
  {
    "name": "src",
    "path": "src",
    "sha": "a1b2c3d4e5f6...",
    "size": 0,
    "type": "dir",
    "download_url": null
  }
]
```

**Key Response Fields (for file):**
```json
{
  "name": "README.md",
  "path": "README.md",
  "sha": "3d21ec53a331a6f037a91c368710b99387d012c1",
  "size": 5362,
  "type": "file",
  "content": "IyBZb2dhIEJvmsgaW4gcHJvZ...",  // Base64 encoded
  "encoding": "base64",
  "download_url": "https://raw.githubusercontent.com/octocat/Hello-World/master/README.md",
  "git_url": "https://api.github.com/repos/octocat/Hello-World/git/blobs/3d21ec53a...",
  "html_url": "https://github.com/octocat/Hello-World/blob/master/README.md"
}
```

**File Size Limits:**
- ≤1 MB: Full response with all features.
- 1-100 MB: `content` field is empty string, `encoding` is `"none"`. Use `raw` media type.
- >100 MB: Endpoint not supported. Must use Git Data API.

**Directory Limit:** Maximum 1,000 files per directory. For larger directories, use the Git Trees API.

**Status Codes:** 200 OK, 302 Found (redirect), 403 Forbidden, 404 Not Found.

---

### 1.4 Git Trees (Recursive Directory Listing)

**Endpoint:** `GET /repos/{owner}/{repo}/git/trees/{tree_sha}`

**Query Parameters:**
- `recursive` (required): Set to `1` for recursive listing.

**Key Response Fields:**
```json
{
  "sha": "123abc...",
  "url": "https://api.github.com/repos/octocat/Hello-World/git/trees/123abc...",
  "tree": [
    {
      "path": "README.md",
      "mode": "100644",
      "type": "blob",
      "sha": "3d21ec53a331a6f037a91c368710b99387d012c1",
      "size": 5362,
      "url": "https://api.github.com/repos/octocat/Hello-World/git/blobs/3d21ec53a..."
    },
    {
      "path": "src/index.js",
      "mode": "100644",
      "type": "blob",
      "sha": "abc123...",
      "size": 1234,
      "url": "..."
    }
  ],
  "truncated": false
}
```

**Note:** For very large trees, `truncated` may be `true`. Use pagination via commit history.

---

### 1.5 Git Blobs (Large File Content)

**Endpoint:** `GET /repos/{owner}/{repo}/git/blobs/{sha}`

**Headers:**
```
Accept: application/vnd.github.raw+json  (raw content)
```

**Key Response Fields:**
```json
{
  "content": "// This is the raw file content...",
  "encoding": "utf-8",
  "url": "https://api.github.com/repos/octocat/Hello-World/git/blobs/sha...",
  "sha": "sha...",
  "size": 12345
}
```

**Use Case:** Retrieve content for files >1 MB that fail the contents API.

---

### 1.6 Issue List

**Endpoint:** `GET /repos/{owner}/{repo}/issues`

**Query Parameters:**
- `state` (optional): `open`, `closed`, or `all`. Default: `open`.
- `labels` (optional): Comma-separated list of label names (e.g., `bug,help wanted`).
- `sort` (optional): `created`, `updated`, `comments`. Default: `created`.
- `direction` (optional): `asc` or `desc`. Default: `desc`.
- `since` (optional): ISO 8601 timestamp. Issues updated after this time.
- `per_page` (optional): 1-100. Default: 30.
- `page` (optional): Page number.

**Key Response Fields:**
```json
[
  {
    "id": 1,
    "number": 1,
    "title": "Bug: Something doesn't work",
    "state": "open",
    "user": {
      "login": "octocat",
      "avatar_url": "https://github.com/images/error/octocat_happy.gif"
    },
    "labels": [
      { "id": 1, "name": "bug", "color": "f29513" }
    ],
    "comments": 0,
    "created_at": "2011-01-26T19:01:12Z",
    "updated_at": "2011-01-26T19:14:43Z",
    "closed_at": null,
    "body": "Describe the issue here...",
    "url": "https://api.github.com/repos/octocat/Hello-World/issues/1",
    "html_url": "https://github.com/octocat/Hello-World/issues/1",
    "assignees": [...],
    "milestone": null
  }
]
```

**Pagination:** Use `Link` header for pagination:
```
Link: <https://api.github.com/repos/owner/repo/issues?page=2>; rel="next",
      <https://api.github.com/repos/owner/repo/issues?page=5>; rel="last"
```

**Note:** Pull requests are included in issues by default. Filter with `pull_request=true` in query.

---

### 1.7 Single Issue with Comments

**Endpoint:** `GET /repos/{owner}/{repo}/issues/{issue_number}`

**Key Response Fields:** Same as issue list item, plus:
```json
{
  "body": "Issue body in markdown...",
  "body_html": "<p>Issue body in HTML...</p>",
  "timeline_url": "https://api.github.com/repos/owner/repo/issues/1/timeline",
  "events_url": "https://api.github.com/repos/owner/repo/issues/1/events"
}
```

**Issue Comments:** `GET /repos/{owner}/{repo}/issues/{issue_number}/comments`

**Key Comment Fields:**
```json
[
  {
    "id": 1,
    "body": "Comment text...",
    "user": { "login": "octocat" },
    "created_at": "2011-01-26T19:01:12Z",
    "updated_at": "2011-01-26T19:14:43Z"
  }
]
```

---

### 1.8 Pull Request Metadata

**Endpoint:** `GET /repos/{owner}/{repo}/pulls/{pull_number}`

**Key Response Fields:**
```json
{
  "id": 1,
  "number": 1,
  "title": "Add new feature",
  "state": "open",
  "user": { "login": "octocat" },
  "body": "PR description...",
  "created_at": "2011-01-26T19:01:12Z",
  "updated_at": "2011-01-26T19:14:43Z",
  "closed_at": null,
  "merged_at": null,
  "merge_commit_sha": "abc123...",
  "commits": 3,
  "additions": 150,
  "deletions": 20,
  "changed_files": 5,
  "draft": false,
  "head": {
    "ref": "feature-branch",
    "sha": "abc123..."
  },
  "base": {
    "ref": "main",
    "sha": "def456..."
  },
  "mergeable": true,
  "mergeable_state": "clean",
  "comments": 0,
  "review_comments": 0,
  "commits_url": "https://api.github.com/repos/octocat/Hello-World/pulls/1/commits",
  "url": "https://api.github.com/repos/octocat/Hello-World/pulls/1",
  "html_url": "https://github.com/octocat/Hello-World/pull/1",
  "labels": [...],
  "requested_reviewers": [...],
  "milestone": null,
  "draft": false,
  "rebaseable": true,
  "head_repository": { "full_name": "octocat/Hello-World" }
}
```

**PR Diff:** `GET /repos/{owner}/{repo}/pulls/{pull_number}` with header `Accept: application/vnd.github.diff+json`

**PR Files:** `GET /repos/{owner}/{repo}/pulls/{pull_number}/files`

---

### 1.9 Release List

**Endpoint:** `GET /repos/{owner}/{repo}/releases`

**Query Parameters:**
- `per_page` (optional): 1-100. Default: 30.
- `page` (optional): Page number.

**Key Response Fields:**
```json
[
  {
    "id": 1,
    "tag_name": "v1.0.0",
    "target_commitish": "main",
    "name": "v1.0.0 Release",
    "draft": false,
    "prerelease": false,
    "created_at": "2011-01-26T19:01:12Z",
    "published_at": "2011-01-26T19:06:43Z",
    "body": "Release notes...",
    "url": "https://api.github.com/repos/octocat/Hello-World/releases/1",
    "html_url": "https://github.com/octocat/Hello-World/releases/tag/v1.0.0",
    "zipball_url": "https://api.github.com/repos/octocat/Hello-World/zipball/v1.0.0",
    "tarball_url": "https://api.github.com/repos/octocat/Hello-World/tarball/v1.0.0",
    "assets": [...],
    "author": { "login": "octocat" }
  }
]
```

**Latest Release Only:** `GET /repos/{owner}/{repo}/releases/latest`

---

### 1.10 Commit History

**Endpoint:** `GET /repos/{owner}/{repo}/commits`

**Query Parameters:**
- `sha` (optional): Branch, tag, or commit SHA to start listing commits from.
- `path` (optional): Only commits containing this file path.
- `author` (optional): GitHub username or email.
- `since` (optional): ISO 8601 timestamp.
- `until` (optional): ISO 8601 timestamp.
- `per_page` (optional): 1-100. Default: 30.
- `page` (optional): Page number.

**Key Response Fields:**
```json
[
  {
    "sha": "abc123...",
    "node_id": "MDY6Q29tbWl0...",
    "commit": {
      "author": {
        "name": "Monalisa Octocat",
        "email": "octocat@github.com",
        "date": "2011-06-26T18:30:00Z"
      },
      "committer": {
        "name": "Monalisa Octocat",
        "email": "octocat@github.com",
        "date": "2011-06-26T18:30:00Z"
      },
      "message": "Fix all the bugs",
      "tree": {
        "sha": "...",
        "url": "..."
      }
    },
    "url": "https://api.github.com/repos/octocat/Hello-World/commits/abc123...",
    "html_url": "https://github.com/octocat/Hello-World/commit/abc123...",
    "comments_url": "...",
    "author": { "login": "octocat", "avatar_url": "..." },
    "committer": { "login": "octocat", "avatar_url": "..." },
    "parents": [
      { "sha": "...", "url": "...", "html_url": "..." }
    ]
  }
]
```

---

### 1.11 CI/CD Actions

**Workflow Runs:** `GET /repos/{owner}/{repo}/actions/runs`

**Query Parameters:**
- `workflow_id` (optional): Filter by workflow file name or ID.
- `branch` (optional): Filter by branch name.
- `status` (optional): `queued`, `in_progress`, `completed`, `action_required`, `cancelled`, `failure`, `neutral`, `skipped`, `stale`, `success`, `timed_out`, `waiting`.
- `per_page` (optional): 1-100. Default: 20.

**Key Response Fields:**
```json
{
  "total_count": 1,
  "workflow_runs": [
    {
      "id": 123456,
      "name": "CI",
      "head_branch": "main",
      "head_sha": "abc123...",
      "status": "completed",
      "conclusion": "success",
      "workflow_id": 123,
      "run_number": 42,
      "event": "push",
      "head_commit": {
        "id": "abc123...",
        "message": "Commit message...",
        "timestamp": "2024-01-01T00:00:00Z",
        "author": { "name": "Octocat" }
      },
      "run_started_at": "2024-01-01T00:00:00Z",
      "created_at": "2024-01-01T00:00:00Z",
      "updated_at": "2024-01-01T00:05:00Z",
      "html_url": "https://github.com/octocat/Hello-World/actions/runs/123456",
      "jobs_url": "...",
      "logs_url": "...",
      "check_suite_url": "...",
      "artifacts_url": "...",
      "cancel_url": "...",
      "rerun_url": "..."
    }
  ]
}
```

---

### 1.12 Gist Content

**Endpoint:** `GET /gists/{gist_id}`

**Key Response Fields:**
```json
{
  "id": "gist-id",
  "description": "Gist description",
  "public": true,
  "files": {
    "filename.md": {
      "filename": "filename.md",
      "type": "text/markdown",
      "language": "Markdown",
      "raw_url": "https://gist.githubusercontent.com/user/gist-id/raw/...",
      "size": 1234,
      "content": "File content..."
    }
  },
  "owner": { "login": "octocat" },
  "created_at": "2011-01-26T19:01:12Z",
  "updated_at": "2011-01-26T19:14:43Z",
  "html_url": "https://gist.github.com/gist-id"
}
```

---

### 1.13 User Profile

**Endpoint:** `GET /users/{username}`

**Key Response Fields:**
```json
{
  "login": "octocat",
  "id": 1,
  "avatar_url": "https://github.com/images/error/octocat_happy.gif",
  "html_url": "https://github.com/octocat",
  "type": "User",
  "name": "The Octocat",
  "company": "GitHub",
  "blog": "https://github.com/blog",
  "location": "San Francisco, CA",
  "email": "octocat@github.com",
  "bio": "GitHub mascot",
  "twitter_username": null,
  "public_repos": 8,
  "public_gists": 8,
  "followers": 20,
  "following": 0,
  "created_at": "2011-01-25T18:30:00Z",
  "updated_at": "2024-01-01T00:00:00Z",
  "plan": { "name": "free", "space": 976562499, "collaborators": 0, "private_repos": 10000 }
}
```

---

### 1.14 Raw File Content

**Endpoint:** Direct access via `download_url` from contents API response.

**Note:** Download URLs expire after a single use for private repos, and after ~5 minutes. Always fetch a fresh URL from the API.

**Alternative (persistent):** `https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}`

**For very large files:** Use the Git Blobs API endpoint.

---

## 2. GitHub GraphQL API v4 — Single-Query Alternative

### Rate Limiting Model

**Primary Rate Limit:**
- 5,000 points per hour per user (PAT authentication)
- 10,000 points per hour for GitHub Enterprise Cloud org member apps
- 1,000 points per hour for GITHUB_TOKEN in GitHub Actions

**Point Calculation:**
1. Count unique connections in the query (each `first`/`last` arg = one connection)
2. Divide by 100 and round to nearest whole number
3. Minimum: 1 point per request

**Example Calculation:**
```
Query fetching 100 repos with 50 issues each:
- 1 connection for repos
- 100 connections for issues (one per repo)
- Total: 101 connections / 100 = 1.01 → rounded to 2 points
```

**Secondary Rate Limits:**
- No more than 100 concurrent requests (shared with REST API)
- No more than 2,000 points per minute for GraphQL endpoint
- No more than 60 seconds of CPU time per 60 seconds real time

### Single-Query for Repository Overview

**The GraphQL Query:**
```graphql
query RepositoryOverview($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    # Core metadata
    name
    nameWithOwner
    description
    homepageUrl
    url
    createdAt
    updatedAt
    pushedAt
    defaultBranchRef {
      name
    }
    
    # Stats
    stargazerCount
    forkCount
    watchers {
      totalCount
    }
    
    # Visibility
    isPrivate
    isArchived
    isDisabled
    isMirror
    isTemplate
    
    # License
    licenseInfo {
      key
      name
      nickname
      url
    }
    
    # Languages
    languages(first: 20) {
      edges {
        node {
          name
          color
        }
        size
      }
      totalSize
    }
    
    # Topics
    repositoryTopics(first: 30) {
      nodes {
        topic {
          name
        }
      }
    }
    
    # Owner info
    owner {
      ... on Organization {
        name
        description
        url
      }
      ... on User {
        name
        login
        url
      }
    }
    
    # Parent (for forks)
    parent {
      nameWithOwner
      url
    }
    
    # README content
    object(expression: "HEAD:README.md") {
      ... on Blob {
        byteSize
        text
      }
    }
    
    # Root directory tree
    object(expression: "HEAD:") {
      ... on Tree {
        entries {
          name
          type
          object {
            ... on Blob {
              byteSize
            }
            ... on Tree {
              entries {
                name
                type
              }
            }
          }
        }
      }
    }
    
    # Recent commits (last 10)
    defaultBranchRef {
      target {
        ... on Commit {
          history(first: 10) {
            nodes {
              oid
              message
              committedDate
              author {
                name
                user {
                  login
                  avatarUrl
                }
              }
              url
            }
          }
        }
      }
    }
    
    # Open issues (last 5)
    issues(first: 5, states: [OPEN], orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        title
        body
        bodyText
        state
        url
        createdAt
        updatedAt
        labels(first: 5) {
          nodes {
            name
            color
          }
        }
        author {
          login
          avatarUrl
        }
      }
    }
    
    # Recent releases (last 3)
    releases(first: 3, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        tagName
        name
        description
        createdAt
        url
        isDraft
        isPrerelease
        author {
          login
          avatarUrl
        }
      }
    }
    
    # Recent PRs (last 5 open)
    pullRequests(first: 5, states: [OPEN], orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        title
        body
        state
        url
        createdAt
        updatedAt
        additions
        deletions
        changedFiles
        author {
          login
          avatarUrl
        }
        labels(first: 5) {
          nodes {
            name
            color
          }
        }
      }
    }
  }
  
  # Rate limit info
  rateLimit {
    limit
    remaining
    resetAt
    used
  }
}
```

**Point Cost Estimation for Above Query:**
```
Connections:
- repository: 1
- languages: 1
- repositoryTopics: 1
- owner (org/user): 1 (based on type)
- object (README): 1
- object (tree): 1
- defaultBranchRef → history: 1
- issues: 1
- releases: 1
- pullRequests: 1

Total connections: ~10
Point cost: ~1 point
```

### REST vs GraphQL Comparison

| Aspect | REST API | GraphQL API |
|--------|----------|-------------|
| **Requests for repo overview** | 6-10 parallel requests | 1 request |
| **Latency** | Higher (many HTTP round trips) | Lower (single round trip) |
| **Rate limit cost** | 6-10 points per repo overview | 1-5 points per repo overview |
| **Flexibility** | Fixed response structure | Flexible field selection |
| **Partial failures** | Some data may load | All or nothing |
| **Caching** | Easier (per-endpoint) | Harder (unique queries) |
| **Complexity** | Simpler to implement | Schema knowledge required |
| **Binary files** | Better support via download_url | Limited |
| **Large repos** | Better pagination support | Node limits (500k) |
| **Rate limit headers** | Comprehensive | Limited |

### Recommendation: Hybrid Approach

**Use REST when:**
- Fetching single resources (file content, specific issues)
- Caching is critical (REST endpoints are more cacheable)
- Binary file content needed
- Need comprehensive rate limit monitoring
- Simple, predictable requests

**Use GraphQL when:**
- Building comprehensive repo overview
- Fetching multiple related resources
- Need fine-grained field selection
- Minimizing request count is priority
- Complex nested queries needed

**Best Practice:** Start with REST for simplicity, add GraphQL for the comprehensive repo overview use case.

---

## 3. Authentication & Rate Limits

### 3.1 Personal Access Token Types

#### Classic PAT

**Scopes Required for Read-Only Access:**

| Scope | Access Level | Use Case |
|-------|--------------|----------|
| `repo` | Full private repo access | Read + write to private repos |
| `public_repo` | Public repo only | Read + write to public repos |
| No scope | Public repo read-only | Public repos only (unauthenticated) |

**For Omnisearch (read-only, public + private):**
- Classic PAT with `repo` scope (full read access to private repos)
- Note: `repo` scope grants both read AND write access (cannot restrict to read-only with classic PAT)

#### Fine-Grained PAT (Recommended)

**Permissions for Read-Only Repository Access:**

| Permission | Access Level | Required For |
|------------|--------------|--------------|
| `Contents` | Read | Repository contents, files, README |
| `Metadata` | Read | Repository metadata, issues, PRs, releases, commits |
| `Pull requests` | Read | PR data and comments |
| `Actions` | Read | Workflow runs (if implementing actions support) |

**Configuration:**
1. Create fine-grained PAT at: `Settings → Developer settings → Personal access tokens → Fine-grained tokens`
2. Set token access: "Repositories" → "All repositories" (or specific repos)
3. Set permissions as listed above
4. Set expiration as needed

**Advantages of Fine-Grained PAT:**
- Can restrict to read-only access
- Can limit to specific repositories
- More granular permission control
- Better security posture

### 3.2 Rate Limits

#### Primary Rate Limits

| Authentication | Limit | Applicable To |
|----------------|-------|---------------|
| Unauthenticated | 60 requests/hour | IP address |
| Classic PAT | 5,000 requests/hour | Per token |
| Fine-grained PAT | 5,000 requests/hour | Per token |
| GitHub App (installation) | 5,000 + 50/repo + 50/user | Up to 12,500/hour |
| GitHub Enterprise Cloud | 15,000 requests/hour | Org-owned apps |

#### Rate Limit Response Headers

```http
X-RateLimit-Limit: 5000
X-RateLimit-Remaining: 4999
X-RateLimit-Used: 1
X-RateLimit-Reset: 1704067200
X-RateLimit-Resource: core
```

**Interpretation:**
- `Limit`: Maximum requests per hour
- `Remaining`: Requests left in current window
- `Used`: Requests used so far
- `Reset`: Unix timestamp when window resets

#### Secondary Rate Limits

**Triggers:**
1. **Concurrent requests:** Max 100 concurrent (shared REST + GraphQL)
2. **Single endpoint rate:** Max 900 points/minute for REST, 2,000 points/minute for GraphQL
3. **CPU time:** Max 90 seconds per 60 seconds real time
4. **Content creation:** Max 80 requests/minute, 500/hour for write operations

**Point Costs:**
| Request Type | Points |
|--------------|--------|
| REST GET/HEAD/OPTIONS | 1 |
| REST POST/PATCH/PUT/DELETE | 5 |
| GraphQL query | 1 |
| GraphQL mutation | 5 |

**Secondary Rate Limit Response:**
```http
HTTP/1.1 403 Forbidden
Retry-After: 60
X-RateLimit-Remaining: 0
```

### 3.3 Unauthenticated Fallback

**60 requests/hour** — useful for:
- Testing without token
- Limited public repository access
- Emergency fallback when token exhausted

**Limitation:** Cannot access private repositories without authentication.

### 3.4 Graceful Degradation Strategy

```typescript
interface RateLimitState {
  remaining: number;
  resetAt: number;
  isLimited: boolean;
  retryAfter?: number;
}

async function fetchWithRateLimitHandling(
  url: string,
  options: RequestInit
): Promise<Response> {
  const response = await fetch(url, options);
  
  // Check primary rate limit
  const remaining = parseInt(response.headers.get('X-RateLimit-Remaining') || '0');
  const resetAt = parseInt(response.headers.get('X-RateLimit-Reset') || '0');
  
  if (response.status === 403 && remaining === 0) {
    // Primary rate limit exhausted
    const retryAfter = Math.ceil((resetAt * 1000 - Date.now()) / 1000);
    throw new RateLimitError('Primary rate limit exhausted', retryAfter);
  }
  
  // Check for secondary rate limit
  if (response.status === 403) {
    const retryAfter = response.headers.get('Retry-After');
    if (retryAfter) {
      throw new RateLimitError('Secondary rate limit hit', parseInt(retryAfter));
    }
  }
  
  return response;
}
```

**Retry Strategy:**
1. Primary limit: Wait until `X-RateLimit-Reset` timestamp
2. Secondary limit: Wait for `Retry-After` seconds
3. Implement exponential backoff for repeated failures
4. Track remaining requests and proactively throttle at 20% remaining
5. Queue requests to avoid burst triggering secondary limits

---

## 4. URL Parsing — All GitHub URL Patterns

### 4.1 Complete URL Pattern Catalog

| URL Pattern | Resource Type | Example |
|-------------|---------------|---------|
| `github.com/{owner}/{repo}` | `repo_overview` | github.com/facebook/react |
| `github.com/{owner}/{repo}/` | `repo_overview` | github.com/facebook/react/ |
| `github.com/{owner}/{repo}/tree/{ref}` | `directory` | github.com/facebook/react/tree/main |
| `github.com/{owner}/{repo}/tree/{ref}/{path}` | `directory` | github.com/facebook/react/tree/main/packages |
| `github.com/{owner}/{repo}/blob/{ref}` | `file` (root) | github.com/facebook/react/blob/main |
| `github.com/{owner}/{repo}/blob/{ref}/{path}` | `file` | github.com/facebook/react/blob/main/README.md |
| `github.com/{owner}/{repo}/issues` | `issue_list` | github.com/facebook/react/issues |
| `github.com/{owner}/{repo}/issues/{number}` | `issue` | github.com/facebook/react/issues/123 |
| `github.com/{owner}/{repo}/pull/{number}` | `pull_request` | github.com/facebook/react/pull/456 |
| `github.com/{owner}/{repo}/pull/{number}/files` | `pr_files` | github.com/facebook/react/pull/456/files |
| `github.com/{owner}/{repo}/releases` | `release_list` | github.com/facebook/react/releases |
| `github.com/{owner}/{repo}/releases/tag/{tag}` | `release` | github.com/facebook/react/releases/tag/v18.0.0 |
| `github.com/{owner}/{repo}/releases/latest` | `release` | github.com/facebook/react/releases/latest |
| `github.com/{owner}/{repo}/commits` | `commit_list` | github.com/facebook/react/commits |
| `github.com/{owner}/{repo}/commits/{ref}` | `commit_list` | github.com/facebook/react/commits/main |
| `github.com/{owner}/{repo}/commit/{sha}` | `commit` | github.com/facebook/react/commit/abc123 |
| `github.com/{owner}/{repo}/actions` | `actions` | github.com/facebook/react/actions |
| `github.com/{owner}/{repo}/actions/runs/{id}` | `action_run` | github.com/facebook/react/actions/runs/123 |
| `github.com/{owner}/{repo}/wiki` | `wiki` | github.com/facebook/react/wiki |
| `github.com/{owner}/{repo}/discussions` | `discussion_list` | github.com/facebook/react/discussions |
| `github.com/{owner}/{repo}/discussions/{number}` | `discussion` | github.com/facebook/react/discussions/789 |
| `github.com/{owner}/{repo}/compare/{base}...{head}` | `compare` | github.com/facebook/react/compare/main...feature |
| `github.com/{user}` | `user_profile` | github.com/torvalds |
| `github.com/orgs/{org}` | `org_profile` | github.com/orgs/google |
| `github.com/{owner}/{repo}/packages` | `packages` | github.com/facebook/react/packages |
| `github.com/{owner}/{repo}/projects` | `projects` | github.com/facebook/react/projects |
| `github.com/{owner}/{repo}/projects/{number}` | `project` | github.com/facebook/react/projects/1 |
| `gist.github.com/{user}/{id}` | `gist` | gist.github.com/octocat/abc123 |
| `gist.github.com/{user}/{id}/raw/{filename}` | `gist_file` | gist.github.com/octocat/abc123/raw/file.md |
| `raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}` | `raw_file` | raw.githubusercontent.com/facebook/react/main/README.md |
| `api.github.com/repos/{owner}/{repo}` | `repo_api` | (internal, redirect target) |

### 4.2 URL Parser Implementation

```typescript
interface ParsedGitHubURL {
  resourceType: string;
  owner?: string;
  repo?: string;
  ref?: string;
  path?: string;
  resourceId?: string | number;
  isRaw?: boolean;
  rawUrl?: string;
}

const GITHUB_PATTERNS = [
  // Gist patterns
  {
    pattern: /^https?:\/\/gist\.github\.com\/([a-zA-Z0-9-]+)\/([a-f0-9]+)(?:\/raw(?:\/[a-zA-Z0-9._-]+)?)?\/?$/,
    parse: (match: RegExpMatchArray): ParsedGitHubURL => ({
      resourceType: match[3] ? 'gist_file' : 'gist',
      owner: match[1],
      resourceId: match[2],
    }),
  },
  
  // Raw content patterns
  {
    pattern: /^https?:\/\/raw\.githubusercontent\.com\/([a-zA-Z0-9-_]+)\/([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._/-]+)\/?$/,
    parse: (match: RegExpMatchArray): ParsedGitHubURL => ({
      resourceType: 'raw_file',
      owner: match[1],
      repo: match[2],
      path: match[3],
      isRaw: true,
    }),
  },
  
  // User profile
  {
    pattern: /^https?:\/\/github\.com\/([a-zA-Z0-9-]+(?![a-zA-Z0-9-]|\/))\/?$/,
    parse: (match: RegExpMatchArray): ParsedGitHubURL => ({
      resourceType: 'user_profile',
      owner: match[1],
    }),
  },
  
  // Org profile
  {
    pattern: /^https?:\/\/github\.com\/orgs\/([a-zA-Z0-9-]+)\/?$/,
    parse: (match: RegExpMatchArray): ParsedGitHubURL => ({
      resourceType: 'org_profile',
      owner: match[1],
    }),
  },
  
  // Repository with complex paths
  {
    pattern: /^https?:\/\/github\.com\/([a-zA-Z0-9-_]+)\/([a-zA-Z0-9._-]+)\/(tree|blob)\/([a-zA-Z0-9._/-]+)(?:\/(.+))?$/,
    parse: (match: RegExpMatchArray): ParsedGitHubURL => ({
      resourceType: match[3] === 'tree' ? 'directory' : 'file',
      owner: match[1],
      repo: match[2],
      ref: match[4],
      path: match[5] || '',
    }),
  },
  
  // Repository root tree/blob
  {
    pattern: /^https?:\/\/github\.com\/([a-zA-Z0-9-_]+)\/([a-zA-Z0-9._-]+)\/(tree|blob)\/([a-zA-Z0-9._-]+)\/?$/,
    parse: (match: RegExpMatchArray): ParsedGitHubURL => ({
      resourceType: match[3] === 'tree' ? 'directory' : 'file',
      owner: match[1],
      repo: match[2],
      ref: match[4],
    }),
  },
  
  // Pull request files
  {
    pattern: /^https?:\/\/github\.com\/([a-zA-Z0-9-_]+)\/([a-zA-Z0-9._-]+)\/pull\/(\d+)\/files\/?$/,
    parse: (match: RegExpMatchArray): ParsedGitHubURL => ({
      resourceType: 'pr_files',
      owner: match[1],
      repo: match[2],
      resourceId: parseInt(match[3]),
    }),
  },
  
  // Pull request
  {
    pattern: /^https?:\/\/github\.com\/([a-zA-Z0-9-_]+)\/([a-zA-Z0-9._-]+)\/pull\/(\d+)\/?$/,
    parse: (match: RegExpMatchArray): ParsedGitHubURL => ({
      resourceType: 'pull_request',
      owner: match[1],
      repo: match[2],
      resourceId: parseInt(match[3]),
    }),
  },
  
  // Release by tag
  {
    pattern: /^https?:\/\/github\.com\/([a-zA-Z0-9-_]+)\/([a-zA-Z0-9._-]+)\/releases\/tag\/([a-zA-Z0-9._-]+)\/?$/,
    parse: (match: RegExpMatchArray): ParsedGitHubURL => ({
      resourceType: 'release',
      owner: match[1],
      repo: match[2],
      resourceId: match[3],
    }),
  },
  
  // Releases list or latest
  {
    pattern: /^https?:\/\/github\.com\/([a-zA-Z0-9-_]+)\/([a-zA-Z0-9._-]+)\/releases(?:\/(latest))?\/?$/,
    parse: (match: RegExpMatchArray): ParsedGitHubURL => ({
      resourceType: 'release_list',
      owner: match[1],
      repo: match[2],
      resourceId: match[3] || 'list',
    }),
  },
  
  // Single issue
  {
    pattern: /^https?:\/\/github\.com\/([a-zA-Z0-9-_]+)\/([a-zA-Z0-9._-]+)\/issues\/(\d+)\/?$/,
    parse: (match: RegExpMatchArray): ParsedGitHubURL => ({
      resourceType: 'issue',
      owner: match[1],
      repo: match[2],
      resourceId: parseInt(match[3]),
    }),
  },
  
  // Issue list
  {
    pattern: /^https?:\/\/github\.com\/([a-zA-Z0-9-_]+)\/([a-zA-Z0-9._-]+)\/issues\/?$/,
    parse: (match: RegExpMatchArray): ParsedGitHubURL => ({
      resourceType: 'issue_list',
      owner: match[1],
      repo: match[2],
    }),
  },
  
  // Commit
  {
    pattern: /^https?:\/\/github\.com\/([a-zA-Z0-9-_]+)\/([a-zA-Z0-9._-]+)\/commit\/([a-f0-9]+)\/?$/,
    parse: (match: RegExpMatchArray): ParsedGitHubURL => ({
      resourceType: 'commit',
      owner: match[1],
      repo: match[2],
      resourceId: match[3],
    }),
  },
  
  // Commit list
  {
    pattern: /^https?:\/\/github\.com\/([a-zA-Z0-9-_]+)\/([a-zA-Z0-9._-]+)\/commits(?:\/([a-zA-Z0-9._-]+))?\/?$/,
    parse: (match: RegExpMatchArray): ParsedGitHubURL => ({
      resourceType: 'commit_list',
      owner: match[1],
      repo: match[2],
      ref: match[3],
    }),
  },
  
  // Actions
  {
    pattern: /^https?:\/\/github\.com\/([a-zA-Z0-9-_]+)\/([a-zA-Z0-9._-]+)\/actions(?:\/runs\/(\d+))?\/?$/,
    parse: (match: RegExpMatchArray): ParsedGitHubURL => ({
      resourceType: match[3] ? 'action_run' : 'actions',
      owner: match[1],
      repo: match[2],
      resourceId: match[3] ? parseInt(match[3]) : undefined,
    }),
  },
  
  // Discussions
  {
    pattern: /^https?:\/\/github\.com\/([a-zA-Z0-9-_]+)\/([a-zA-Z0-9._-]+)\/discussions(?:\/(\d+))?\/?$/,
    parse: (match: RegExpMatchArray): ParsedGitHubURL => ({
      resourceType: match[3] ? 'discussion' : 'discussion_list',
      owner: match[1],
      repo: match[2],
      resourceId: match[3] ? parseInt(match[3]) : undefined,
    }),
  },
  
  // Compare
  {
    pattern: /^https?:\/\/github\.com\/([a-zA-Z0-9-_]+)\/([a-zA-Z0-9._-]+)\/compare\/([a-zA-Z0-9._:-]+)\.\.\.([a-zA-Z0-9._:-]+)\/?$/,
    parse: (match: RegExpMatchArray): ParsedGitHubURL => ({
      resourceType: 'compare',
      owner: match[1],
      repo: match[2],
      path: `${match[3]}...${match[4]}`,
    }),
  },
  
  // Repository overview (default, must be last)
  {
    pattern: /^https?:\/\/github\.com\/([a-zA-Z0-9-_]+)\/([a-zA-Z0-9._-]+)\/?$/,
    parse: (match: RegExpMatchArray): ParsedGitHubURL => ({
      resourceType: 'repo_overview',
      owner: match[1],
      repo: match[2],
    }),
  },
];

function parseGitHubURL(url: string): ParsedGitHubURL | null {
  for (const { pattern, parse } of GITHUB_PATTERNS) {
    const match = url.match(pattern);
    if (match) {
      return parse(match);
    }
  }
  return null;
}

// Usage
const result = parseGitHubURL('https://github.com/facebook/react/tree/main/packages/react');
// Result: { resourceType: 'directory', owner: 'facebook', repo: 'react', ref: 'main', path: 'packages/react' }
```

### 4.3 API Endpoint Mapping

```typescript
function getAPIEndpoints(parsed: ParsedGitHubURL): { method: string; endpoint: string }[] {
  switch (parsed.resourceType) {
    case 'repo_overview':
      return [
        { method: 'GET', endpoint: `/repos/${parsed.owner}/${parsed.repo}` },
        { method: 'GET', endpoint: `/repos/${parsed.owner}/${parsed.repo}/readme` },
        { method: 'GET', endpoint: `/repos/${parsed.owner}/${parsed.repo}/contents` },
        { method: 'GET', endpoint: `/repos/${parsed.owner}/${parsed.repo}/languages` },
      ];
    
    case 'file':
      return [
        { method: 'GET', endpoint: `/repos/${parsed.owner}/${parsed.repo}/contents/${parsed.path}?ref=${parsed.ref}` },
      ];
    
    case 'directory':
      return [
        { method: 'GET', endpoint: `/repos/${parsed.owner}/${parsed.repo}/contents/${parsed.path}?ref=${parsed.ref}` },
      ];
    
    case 'issue':
      return [
        { method: 'GET', endpoint: `/repos/${parsed.owner}/${parsed.repo}/issues/${parsed.resourceId}` },
        { method: 'GET', endpoint: `/repos/${parsed.owner}/${parsed.repo}/issues/${parsed.resourceId}/comments` },
      ];
    
    case 'issue_list':
      return [
        { method: 'GET', endpoint: `/repos/${parsed.owner}/${parsed.repo}/issues?state=open&per_page=20` },
      ];
    
    case 'pull_request':
      return [
        { method: 'GET', endpoint: `/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.resourceId}` },
        { method: 'GET', endpoint: `/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.resourceId}/files` },
      ];
    
    case 'release_list':
      return [
        { method: 'GET', endpoint: `/repos/${parsed.owner}/${parsed.repo}/releases?per_page=10` },
      ];
    
    case 'release':
      return [
        { method: 'GET', endpoint: `/repos/${parsed.owner}/${parsed.repo}/releases/tags/${parsed.resourceId}` },
      ];
    
    case 'commit_list':
      const commitsEndpoint = parsed.ref 
        ? `/repos/${parsed.owner}/${parsed.repo}/commits?sha=${parsed.ref}&per_page=30`
        : `/repos/${parsed.owner}/${parsed.repo}/commits?per_page=30`;
      return [{ method: 'GET', endpoint: commitsEndpoint }];
    
    case 'commit':
      return [
        { method: 'GET', endpoint: `/repos/${parsed.owner}/${parsed.repo}/commits/${parsed.resourceId}` },
      ];
    
    case 'user_profile':
      return [
        { method: 'GET', endpoint: `/users/${parsed.owner}` },
        { method: 'GET', endpoint: `/users/${parsed.owner}/repos?sort=updated&per_page=10` },
      ];
    
    case 'gist':
      return [
        { method: 'GET', endpoint: `/gists/${parsed.resourceId}` },
      ];
    
    case 'raw_file':
      // Raw URLs don't need API call; return download URL
      return [];
    
    default:
      return [];
  }
}
```

---

## 5. LLM-Optimized Output Format

### 5.1 Repository Overview Template

```markdown
# {Repository Name}

> {Short description from the repo's description field}

**Type:** {Public | Private | Fork} • **Archived:** {Yes | No} • **Mirror:** {Yes | No}
**License:** {License Name} • **Default Branch:** {main|master}
**Repository:** [{full_name}]({html_url}) • **Homepage:** [{homepage}]({homepage})

## Quick Stats

| Stars | Forks | Watchers | Open Issues | Last Push |
|-------|-------|----------|-------------|-----------|
| {stargazers_count} | {forks_count} | {watchers_count} | {open_issues_count} | {pushed_at} |

## Languages

{For each language, percentage of total bytes}

| Language | Percentage | Bytes |
|----------|------------|-------|
| JavaScript | ████████░░ 62% | 128,432 |
| TypeScript | ███░░░░░░░ 24% | 49,823 |
| CSS | ██░░░░░░░░ 10% | 20,642 |
| HTML | █░░░░░░░░░ 4% | 8,257 |

## Topics

`{topic1}` `topic2` `topic3`

## Owner

**[{owner.login}]({owner.html_url})** ({owner.type})

## Forks

{If fork:}
> Forked from [{parent.full_name}]({parent.html_url})

## Directory Structure

```
/
├── README.md
├── LICENSE
├── package.json
├── src/
│   ├── index.js
│   └── utils/
│       └── helpers.js
└── tests/
    └── index.test.js
```

## README

{README.md content in full}

{If no README: _No README found_}

## Recent Commits

| Commit | Message | Author | Date |
|--------|---------|--------|------|
| [{sha_short}]({commit_url}) | {message_first_line} | {author} | {date} |
| ... | ... | ... | ... |

## Open Issues Summary

{Last 5 open issues}

| # | Title | Labels | Updated |
|---|-------|--------|---------|
| {number} | [{title}]({issue_url}) | {label1}, {label2} | {updated_at} |

{If no open issues: _No open issues_}

## Recent Releases

{Last 3 releases}

| Version | Name | Date | Draft | Pre-release |
|---------|------|------|-------|-------------|
| [{tag_name}]({release_url}) | {name} | {created_at} | {is_draft} | {is_prerelease} |

{If no releases: _No releases published_}

## Metadata

- **Created:** {created_at}
- **Last Updated:** {updated_at}
- **Size:** {size} KB
- **Topics:** {topics_array}
- **Has Issues:** {has_issues}
- **Has Projects:** {has_projects}
- **Has Wiki:** {has_wiki}
- **Has Discussions:** {has_discussions}
- **Has Pages:** {has_pages}

---

*Fetched via GitHub API at {fetch_timestamp}*
```

### 5.2 File View Template

```markdown
# {filename}

**Path:** `{path}`  
**Location:** [{owner}/{repo}]({repo_url})/{path}  
**Branch:** `{ref}`  
**Size:** {size} bytes  
**Type:** {file type/extension}

**Raw:** [{raw_url}]({raw_url}) | **Blame:** [{blame_url}]({blame_url}) | **History:** [{history_url}]({history_url})

**Last Modified:** {commit_date} by [{commit_author}]({author_url})  
**Commit:** [{commit_sha_short}]({commit_url}): {commit_message}

---

```{language}
{file_content}
```

---

*Fetched via GitHub API*
```

### 5.3 Issue Template

```markdown
# Issue #{number}: {title}

**Repository:** [{owner}/{repo}]({repo_url})  
**State:** {open | closed}  
**Labels:** {label1} `label2` `label3`

**Author:** [{user.login}]({user.html_url})  
**Created:** {created_at}  
**Updated:** {updated_at}  
**Comments:** {comments_count}

**URL:** {html_url}

---

{body}

---

## Comments ({comments_count})

{For each comment:}

### {comment.author.login} — {comment.created_at}

{comment.body}

---
```

### 5.4 Pull Request Template

```markdown
# PR #{number}: {title}

**Repository:** [{owner}/{repo}]({repo_url})  
**State:** {open | closed | merged}  
**Draft:** {true | false}

**Author:** [{user.login}]({user.html_url})  
**Created:** {created_at}  
**Updated:** {updated_at}

**Base:** `{base.ref}` ← **Head:** `{head.ref}`

### Review Status

| Review Type | Status |
|-------------|--------|
| Approvals | {approved_count} |
| Changes Requested | {changes_requested_count} |
| Pending Reviews | {pending_count} |

**Labels:** `label1` `label2`

### Change Statistics

| Metric | Value |
|--------|-------|
| Commits | {commits} |
| Files Changed | {changed_files} |
| Additions | +{additions} |
| Deletions | -{deletions} |

**URL:** {html_url}

---

{body}

---

## Changed Files ({changed_files})

{For each file:}

- [{filename}]({raw_url}) ({additions}/-{deletions})

---

*Review status and comments omitted for brevity. Fetch PR comments endpoint for full review data.*
```

### 5.5 Directory Listing Template

```markdown
# Directory: {path || '/'}

**Repository:** [{owner}/{repo}]({repo_url})  
**Branch:** `{ref}`

**Contents ({total_count} items)**

{For each item:}

{If dir:}
### 📁 {name}/

> Directory • {entry_count} items

{If file:}
### 📄 {name}

> {type} • {size_formatted}

{If symlink:}
### 🔗 {name}

> Symlink → {target}

{If submodule:}
### 📦 {name}

> Submodule • {submodule_git_url}

---

*Showing {items_shown} of {total_count} items*
```

### 5.6 User Profile Template

```markdown
# {name || login}

**@{login}** • {type}

{If bio: {bio}}

{If company:}**Company:** {company}  
{If location:}**Location:** {location}  
{If blog:}**Blog:** [{blog}]({blog})  
{If email:}**Email:** {email}  
{If twitter:}**Twitter:** [@{twitter_username}](https://twitter.com/{twitter_username})

**Profile:** [{html_url}]({html_url})

## Stats

| Metric | Value |
|--------|-------|
| Public Repos | {public_repos} |
| Public Gists | {public_gists} |
| Followers | {followers} |
| Following | {following} |

**Member Since:** {created_at}

## Top Repositories

{For each repo sorted by stars:}

### [{repo.name}]({repo.html_url})

{repo.description || '_No description_'}

⭐ {repo.stargazers_count} • 🍴 {repo.forks_count} • {repo.language || 'Unknown'}

---
```

---

## 6. LLM Context Enrichment — Structured Discovery Files

### 6.1 llms.txt Specification

**Specification:** https://llmstxt.org/

**Purpose:** A markdown file at a website's root (`/llms.txt`) providing LLM-friendly content summaries and links to detailed documentation.

**Format Structure:**
```markdown
# {Project Name}

> {Brief description of the project}

{Optional: Additional context and notes}

## {Section Name}

- [{Link Title}]({URL}): {Brief description}

## Optional

- [{Secondary Link}]({URL}): {Less critical information}
```

**Key Characteristics:**
- H1 title (required)
- Blockquote summary (required for best practices)
- Optional H2 sections with markdown link lists
- `Optional` section for secondary information (can be skipped)
- URLs can be internal or external

**Implementation for GitHub Provider:**
```typescript
const AI_CONTEXT_FILES = [
  { filename: 'llms.txt', priority: 'high', url: 'llms.txt' },
  { filename: 'llms-full.txt', priority: 'medium', url: 'llms-full.txt' },
  { filename: 'CONTEXT.md', priority: 'medium', url: 'CONTEXT.md' },
  { filename: 'AGENTS.md', priority: 'high', url: 'AGENTS.md' },
  { filename: 'CLAUDE.md', priority: 'high', url: 'CLAUDE.md' },
  { filename: '.claude.md', priority: 'high', url: '.claude.md' },
  { filename: '.cursorrules', priority: 'medium', url: '.cursorrules' },
  { filename: '.github/copilot-instructions.md', priority: 'medium', url: '.github/copilot-instructions.md' },
  { filename: 'CURSOR_RULES.md', priority: 'medium', url: 'CURSOR_RULES.md' },
  { filename: 'CONTRIBUTING.md', priority: 'low', url: 'CONTRIBUTING.md' },
  { filename: 'DEVELOPMENT.md', priority: 'low', url: 'DEVELOPMENT.md' },
  { filename: 'SETUP.md', priority: 'low', url: 'SETUP.md' },
  { filename: 'ARCHITECTURE.md', priority: 'low', url: 'ARCHITECTURE.md' },
  { filename: 'DESIGN.md', priority: 'low', url: 'DESIGN.md' },
  { filename: 'CHANGELOG.md', priority: 'low', url: 'CHANGELOG.md' },
];

async function fetchAIContextFiles(
  owner: string,
  repo: string,
  ref: string = 'HEAD'
): Promise<AIContextFile[]> {
  const results: AIContextFile[] = [];
  
  // First, get root directory to check existence efficiently
  const rootResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents?ref=${ref}`,
    { headers: API_HEADERS }
  );
  
  if (!rootResponse.ok) return results;
  
  const rootContents = await rootResponse.json();
  const rootFilenames = new Set(rootContents.map((f: any) => f.name.toLowerCase()));
  
  // Also check for .github directory
  let githubContents: any[] = [];
  if (rootFilenames.has('.github')) {
    const githubResponse = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/.github?ref=${ref}`,
      { headers: API_HEADERS }
    );
    if (githubResponse.ok) {
      githubContents = await githubResponse.json();
    }
  }
  const githubFilenames = new Set(githubContents.map((f: any) => f.name.toLowerCase()));
  
  // Fetch files that exist
  for (const file of AI_CONTEXT_FILES) {
    const shouldCheck = 
      file.url.startsWith('.github/') 
        ? githubFilenames.has(file.filename.toLowerCase())
        : rootFilenames.has(file.filename.toLowerCase());
    
    if (shouldCheck) {
      const response = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${file.url}?ref=${ref}`,
        { headers: API_HEADERS }
      );
      
      if (response.ok) {
        const content = await response.json();
        const decodedContent = Buffer.from(content.content, 'base64').toString('utf-8');
        results.push({
          filename: file.filename,
          priority: file.priority,
          content: decodedContent,
          size: content.size,
          sha: content.sha,
        });
      }
    }
  }
  
  return results.sort((a, b) => {
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    return priorityOrder[a.priority] - priorityOrder[b.priority];
  });
}
```

### 6.2 AI Tool Instruction Files

#### CLAUDE.md (Claude Code)

**Purpose:** Project-specific instructions for Claude Code ( Anthropic's CLI tool).

**Typical Contents:**
- Project overview and purpose
- Coding conventions and style guide
- Important file locations
- Build/test commands
- Common tasks and patterns
- What to avoid

**Reference:** https://docs.anthropic.com/en/docs/claude-code

#### AGENTS.md

**Purpose:** Universal, multi-agent standard for project instructions.

**Adopted By:**
- Claude Code
- GitHub Copilot
- Cursor
- Codex
- Augment Code
- Other AI coding tools

**Typical Structure:**
```markdown
# Project Name

## Overview

Brief project description.

## Tech Stack

- Language/Framework 1
- Language/Framework 2

## Project Structure

- `src/` - Source code
- `tests/` - Test files

## Development Setup

```bash
npm install
npm run dev
```

## Code Conventions

- Use TypeScript strict mode
- Format with prettier
- Lint with eslint

## Commands

- `npm run build` - Build production
- `npm run test` - Run tests
```

#### .cursorrules (Cursor IDE)

**Purpose:** Project rules for Cursor AI IDE.

**Similar to CLAUDE.md but Cursor-specific.**

#### .github/copilot-instructions.md (GitHub Copilot)

**Purpose:** Repository-level context for GitHub Copilot.

**Location:** `.github/copilot-instructions.md`

**Reference:** https://docs.github.com/en/copilot/customizing-copilot/adding-copilot-instructions

### 6.3 Strategy: Tree-First vs Individual Checks

**Option A: Individual File Checks**
```typescript
// 15+ sequential requests, most will 404
for (const file of AI_CONTEXT_FILES) {
  await fetch(`/repos/${owner}/${repo}/contents/${file.url}`);
}
```
- **Pros:** Simple implementation
- **Cons:** 15+ requests, most wasted on 404s

**Option B: Root Tree Scan (Recommended)**
```typescript
// 1 request for root, 1 for .github, then selective fetches
const root = await fetch(`/repos/${owner}/${repo}/contents?ref=${ref}`);
const files = new Set(root.map(f => f.name.toLowerCase()));

for (const file of AI_CONTEXT_FILES) {
  if (files.has(file.filename)) {
    await fetch(`/repos/${owner}/${repo}/contents/${file.url}`);
  }
}
```
- **Pros:** Minimal requests, only fetches existing files
- **Cons:** Slightly more complex implementation

**Option C: GraphQL Query**
```graphql
query {
  repository(owner: "owner", name: "repo") {
    object(expression: "HEAD:CLAUDE.md") { ... }
    object(expression: "HEAD:AGENTS.md") { ... }
    object(expression: "HEAD:.cursorrules") { ... }
  }
}
```
- **Pros:** Single request
- **Cons:** Returns nulls for missing files (no 404), still needs processing

**Recommendation:** Option B (Tree-First) for production implementation.

---

## 7. Content Assembly Strategy

### 7.1 Repository Overview Assembly

For the most common and valuable fetch (repo overview), here's the recommended strategy:

#### Batch 1: Core Data (Always Required, Parallel)

```typescript
async function fetchRepoCore(owner: string, repo: string) {
  const [repoResponse, readmeResponse, contentsResponse, languagesResponse] = await Promise.all([
    fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: API_HEADERS }),
    fetch(`https://api.github.com/repos/${owner}/${repo}/readme`, { headers: API_HEADERS }),
    fetch(`https://api.github.com/repos/${owner}/${repo}/contents`, { headers: API_HEADERS }),
    fetch(`https://api.github.com/repos/${owner}/${repo}/languages`, { headers: API_HEADERS }),
  ]);
  
  return {
    repo: await repoResponse.json(),
    readme: readmeResponse.ok ? await readmeResponse.json() : null,
    contents: contentsResponse.ok ? await contentsResponse.json() : [],
    languages: languagesResponse.ok ? await languagesResponse.json() : {},
  };
}
```

**Estimated API Calls:** 4  
**Estimated Latency:** ~200-400ms (parallel)

#### Batch 2: Enrichment Data (Parallel)

```typescript
async function fetchRepoEnrichment(owner: string, repo: string, defaultBranch: string) {
  const [commitsResponse, issuesResponse, releasesResponse] = await Promise.all([
    fetch(`https://api.github.com/repos/${owner}/${repo}/commits?sha=${defaultBranch}&per_page=10`, { headers: API_HEADERS }),
    fetch(`https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=5&sort=updated`, { headers: API_HEADERS }),
    fetch(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=3`, { headers: API_HEADERS }),
  ]);
  
  return {
    commits: commitsResponse.ok ? await commitsResponse.json() : [],
    issues: issuesResponse.ok ? await issuesResponse.json() : [],
    releases: releasesResponse.ok ? await releasesResponse.json() : [],
  };
}
```

**Estimated API Calls:** 3  
**Estimated Latency:** ~200-400ms (parallel)

#### Batch 3: AI Context Files (Optional Enhancement)

```typescript
async function fetchAIContext(owner: string, repo: string, defaultBranch: string) {
  // Use tree-first strategy
  const rootResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents?ref=${defaultBranch}`,
    { headers: API_HEADERS }
  );
  
  if (!rootResponse.ok) return [];
  
  const rootContents = await rootResponse.json();
  const existingFiles = new Set(rootContents.map(f => f.name.toLowerCase()));
  
  const aiFilesToFetch = AI_CONTEXT_FILES.filter(f => 
    !f.url.startsWith('.github/') && existingFiles.has(f.filename.toLowerCase())
  );
  
  if (aiFilesToFetch.length === 0) return [];
  
  const responses = await Promise.all(
    aiFilesToFetch.map(file =>
      fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${file.url}?ref=${defaultBranch}`, {
        headers: API_HEADERS
      })
    )
  );
  
  const results = [];
  for (let i = 0; i < responses.length; i++) {
    if (responses[i].ok) {
      const content = await responses[i].json();
      results.push({
        filename: aiFilesToFetch[i].filename,
        content: Buffer.from(content.content, 'base64').toString('utf-8'),
      });
    }
  }
  
  return results;
}
```

**Estimated API Calls:** 1 (root tree) + N (for found files)  
**Estimated Latency:** ~100-200ms base + per-file overhead

### 7.2 Complete Assembly Flow

```typescript
interface RepoOverviewResult {
  resource_type: 'repo_overview';
  metadata: RepositoryMetadata;
  readme: string | null;
  structure: DirectoryEntry[];
  languages: Record<string, number>;
  commits: Commit[];
  issues: Issue[];
  releases: Release[];
  ai_context: AIContextFile[];
  rate_limit: RateLimitInfo;
  fetched_at: string;
}

async function assembleRepoOverview(
  owner: string,
  repo: string,
  options: { includeAIContext?: boolean } = {}
): Promise<RepoOverviewResult> {
  const startTime = Date.now();
  
  // Batch 1: Core data (parallel)
  const [repoResponse, readmeResponse, contentsResponse, languagesResponse] = await Promise.all([
    fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: API_HEADERS }),
    fetch(`https://api.github.com/repos/${owner}/${repo}/readme/readme`, { headers: API_HEADERS }),
    fetch(`https://api.github.com/repos/${owner}/${repo}/contents`, { headers: API_HEADERS }),
    fetch(`https://api.github.com/repos/${owner}/${repo}/languages`, { headers: API_HEADERS }),
  ]);
  
  // Check for errors
  if (!repoResponse.ok) {
    throw new GitHubAPIError(repoResponse.status, await repoResponse.text());
  }
  
  const repoData = await repoResponse.json();
  const defaultBranch = repoData.default_branch;
  
  // Batch 2: Enrichment data (parallel, after knowing default branch)
  const [commitsResponse, issuesResponse, releasesResponse] = await Promise.all([
    fetch(`https://api.github.com/repos/${owner}/${repo}/commits?sha=${defaultBranch}&per_page=10`, { headers: API_HEADERS }),
    fetch(`https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=5&sort=updated`, { headers: API_HEADERS }),
    fetch(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=3`, { headers: API_HEADERS }),
  ]);
  
  // Optional Batch 3: AI context files
  let aiContext: AIContextFile[] = [];
  if (options.includeAIContext) {
    aiContext = await fetchAIContext(owner, repo, defaultBranch);
  }
  
  // Parse responses
  const readme = readmeResponse.ok ? await parseReadme(readmeResponse) : null;
  const contents = contentsResponse.ok ? await contentsResponse.json() : [];
  const languages = languagesResponse.ok ? await languagesResponse.json() : {};
  const commits = commitsResponse.ok ? await commitsResponse.json() : [];
  const issues = issuesResponse.ok ? await issuesResponse.json() : [];
  const releases = releasesResponse.ok ? await releasesResponse.json() : [];
  
  // Extract rate limit info from last response
  const rateLimitInfo: RateLimitInfo = {
    limit: parseInt(commitsResponse.headers.get('X-RateLimit-Limit') || '0'),
    remaining: parseInt(commitsResponse.headers.get('X-RateLimit-Remaining') || '0'),
    reset: parseInt(commitsResponse.headers.get('X-RateLimit-Reset') || '0'),
  };
  
  return {
    resource_type: 'repo_overview',
    metadata: repoData,
    readme,
    structure: contents,
    languages,
    commits,
    issues,
    releases,
    ai_context: aiContext,
    rate_limit: rateLimitInfo,
    fetched_at: new Date().toISOString(),
    _assembly_time_ms: Date.now() - startTime,
  };
}

async function parseReadme(response: Response): Promise<string | null> {
  const contentType = response.headers.get('Content-Type') || '';
  
  if (contentType.includes('application/vnd.github.raw')) {
    return await response.text();
  }
  
  const data = await response.json();
  if (data.content) {
    return Buffer.from(data.content, 'base64').toString('utf-8');
  }
  
  return null;
}
```

### 7.3 API Call and Latency Estimates

| Strategy | API Calls | Est. Latency | Notes |
|----------|-----------|--------------|-------|
| **Minimal (metadata only)** | 1 | ~100ms | Just `/repos/{owner}/{repo}` |
| **Standard (recommended)** | 7 | ~400-600ms | Core + enrichment batches |
| **Enhanced (with AI context)** | 8-15 | ~500-800ms | Standard + context files |
| **GraphQL single query** | 1 | ~300-500ms | Single GraphQL request |

### 7.4 Cost Analysis

| Metric | REST (Standard) | GraphQL |
|--------|-----------------|---------|
| API calls | 7 | 1 |
| Points used | ~7 | ~1-5 |
| Requests/hour (5k limit) | ~714 fetches | ~1000+ fetches |
| Complexity | Simple | Moderate |
| Debugging | Easy | Complex |

**Recommendation:** Use REST for simplicity and caching efficiency. Reserve GraphQL for scenarios requiring the absolute minimum request count.

---

## 8. Edge Cases & Error Handling

### 8.1 Private Repositories

**Scenario:** PAT lacks access to private repository.

```typescript
async function fetchRepo(owner: string, repo: string): Promise<RepoData> {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: API_HEADERS,
  });
  
  if (response.status === 404) {
    const error = await response.json();
    // Check if it's a private repo issue
    if (error.message?.includes('Not Found') || response.headers.get('X-Gh-Error')) {
      throw new PrivateRepositoryError(
        `Repository ${owner}/${repo} is private or not accessible with current token. ` +
        `Ensure your PAT has 'repo' scope for private repo access.`
      );
    }
    throw new NotFoundError(`Repository ${owner}/${repo} not found.`);
  }
  
  if (response.status === 403) {
    const error = await response.json();
    throw new ForbiddenError(
      `Access denied to ${owner}/${repo}. ` +
      `Error: ${error.message}`
    );
  }
  
  return response.json();
}
```

**User Feedback:**
```
⚠️ Private Repository Access Required

The repository `owner/repo` is private or you don't have access.

To fetch private repositories, you need:
1. A GitHub Personal Access Token with 'repo' scope (classic) 
   or 'Contents' + 'Metadata' permissions (fine-grained)
2. Configure the token in your Omnisearch settings

Current token status: [token has access to X repositories]
```

### 8.2 Rate Limiting

```typescript
class RateLimitError extends Error {
  constructor(
    message: string,
    public retryAfter: number,
    public resetAt: Date
  ) {
    super(message);
    this.name = 'RateLimitError';
  }
}

async function fetchWithRateLimit(
  url: string,
  options: RequestInit
): Promise<Response> {
  const response = await fetch(url, options);
  
  // Check primary rate limit
  if (response.status === 403) {
    const remaining = response.headers.get('X-RateLimit-Remaining');
    if (remaining === '0') {
      const reset = parseInt(response.headers.get('X-RateLimit-Reset') || '0');
      const retryAfter = Math.ceil((reset * 1000 - Date.now()) / 1000);
      
      throw new RateLimitError(
        `GitHub API rate limit exceeded. Resets at ${new Date(reset * 1000).toISOString()}.`,
        retryAfter,
        new Date(reset * 1000)
      );
    }
    
    // Check for secondary rate limit
    const retryAfter = response.headers.get('Retry-After');
    if (retryAfter) {
      throw new RateLimitError(
        `GitHub API secondary rate limit hit. Retry after ${retryAfter} seconds.`,
        parseInt(retryAfter),
        new Date(Date.now() + parseInt(retryAfter) * 1000)
      );
    }
  }
  
  return response;
}
```

**Graceful Degradation:**
```typescript
async function fetchWithFallback(
  url: string,
  options: RequestInit,
  alternatives: string[] = []
): Promise<Response> {
  try {
    return await fetchWithRateLimit(url, options);
  } catch (error) {
    if (error instanceof RateLimitError) {
      // Signal to caller to try next provider
      throw new ProviderExhaustedError(
        `GitHub rate limited. Try again after ${error.retryAfter}s.`,
        'github',
        error.retryAfter
      );
    }
    throw error;
  }
}
```

### 8.3 Large Files (>1MB)

```typescript
async function fetchFileContent(
  owner: string,
  repo: string,
  path: string,
  ref: string = 'HEAD'
): Promise<FileContent> {
  // Try contents API first
  const contentsResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref}`,
    { headers: API_HEADERS }
  );
  
  if (!contentsResponse.ok) {
    throw new Error(`Failed to fetch file: ${await contentsResponse.text()}`);
  }
  
  const fileData = await contentsResponse.json();
  
  // Check file size
  if (fileData.size > 100 * 1024 * 1024) {
    // > 100 MB: Not supported
    return {
      type: 'unsupported_size',
      path: fileData.path,
      size: fileData.size,
      message: 'File exceeds 100MB limit for GitHub API',
      blob_url: fileData.git_url, // Provide blob URL for manual download
    };
  }
  
  if (fileData.size > 1024 * 1024) {
    // 1-100 MB: Use raw media type
    const rawResponse = await fetch(fileData.download_url);
    const content = await rawResponse.text();
    
    return {
      type: 'file',
      path: fileData.path,
      content,
      size: fileData.size,
      sha: fileData.sha,
    };
  }
  
  // ≤1 MB: Standard response
  return {
    type: 'file',
    path: fileData.path,
    content: Buffer.from(fileData.content, 'base64').toString('utf-8'),
    size: fileData.size,
    sha: fileData.sha,
  };
}
```

### 8.4 Binary Files

```typescript
function isBinaryFile(filename: string): boolean {
  const binaryExtensions = new Set([
    // Images
    'png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'svg', 'bmp', 'tiff',
    // Audio
    'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a',
    // Video
    'mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm',
    // Archives
    'zip', 'tar', 'gz', 'rar', '7z', 'bz2',
    // Documents
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
    // Fonts
    'ttf', 'otf', 'woff', 'woff2', 'eot',
    // Executables
    'exe', 'dll', 'so', 'dylib', 'app',
    // Data
    'db', 'sqlite', 'sql', 'bin',
    // Other
    'ico', 'icns', 'psd', 'ai',
  ]);
  
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return binaryExtensions.has(ext);
}

async function fetchFile(
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<FileContent | BinaryFileContent> {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref}`,
    { headers: API_HEADERS }
  );
  
  if (!response.ok) {
    throw new Error(`Failed to fetch file`);
  }
  
  const fileData = await response.json();
  
  if (isBinaryFile(path)) {
    return {
      type: 'binary',
      path: fileData.path,
      filename: fileData.name,
      size: fileData.size,
      encoding: fileData.encoding,
      sha: fileData.sha,
      description: `Binary file (${fileData.name}) — ${formatFileSize(fileData.size)}`,
      download_url: fileData.download_url,
      raw_url: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`,
    };
  }
  
  // Return actual content for text files
  return {
    type: 'file',
    path: fileData.path,
    content: Buffer.from(fileData.content, 'base64').toString('utf-8'),
    size: fileData.size,
    sha: fileData.sha,
  };
}
```

**Binary File Output:**
```markdown
# image.png

**Type:** Binary (image/png)  
**Size:** 245.8 KB  
**SHA:** abc123def456...

This file is a binary image and cannot be displayed as text.

**Preview:** ![image.png](https://raw.githubusercontent.com/owner/repo/main/path/image.png)  
**Download:** [Open in GitHub]({html_url})
```

### 8.5 Empty Repositories

```typescript
async function fetchRepoOverview(
  owner: string,
  repo: string
): Promise<RepoOverviewResult> {
  const [repoResponse, readmeResponse] = await Promise.all([
    fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: API_HEADERS }),
    fetch(`https://api.github.com/repos/${owner}/${repo}/readme`, { headers: API_HEADERS }),
  ]);
  
  const repoData = await repoResponse.json();
  
  // Handle empty repo
  const isEmpty = repoData.size === 0 && 
                  new Date(repoData.created_at).getTime() === new Date(repoData.pushed_at).getTime();
  
  if (isEmpty) {
    return {
      resource_type: 'repo_overview',
      metadata: repoData,
      readme: null,
      structure: [],
      languages: {},
      commits: [],
      issues: [],
      releases: [],
      ai_context: [],
      is_empty: true,
      message: 'This repository has no commits yet.',
      fetched_at: new Date().toISOString(),
    };
  }
  
  // ... rest of implementation
}
```

**Empty Repo Output:**
```markdown
# {repo_name}

> _No description_

**⚠️ Empty Repository**  
This repository has been created but contains no commits.

**Created:** {created_at}  
**Default Branch:** {default_branch}

---

This repository is empty. To populate it:
- Push your first commit
- Create a file via GitHub UI
- Initialize with README

---
```

### 8.6 Renamed/Redirected Repositories

```typescript
async function fetchRepo(
  owner: string,
  repo: string
): Promise<{ data: RepoData; redirect?: { from: string; to: string } }> {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: API_HEADERS,
    redirect: 'manual', // Don't follow redirects automatically
  });
  
  if (response.status === 301) {
    const newUrl = response.headers.get('Location');
    const canonicalUrl = newUrl?.replace('https://api.github.com/repos/', '');
    
    // Fetch from canonical URL
    const canonicalResponse = await fetch(`https://api.github.com/repos/${canonicalUrl}`, {
      headers: API_HEADERS,
    });
    
    const data = await canonicalResponse.json();
    
    return {
      data,
      redirect: {
        from: `${owner}/${repo}`,
        to: canonicalUrl,
      },
    };
  }
  
  if (response.status === 200) {
    return { data: await response.json() };
  }
  
  throw new Error(`Unexpected response: ${response.status}`);
}
```

**Redirect Handling:**
```markdown
# {repo_name}

> {description}

**⚠️ Repository Redirected**  
This repository has been renamed or moved.

- **Original:** `{from}`
- **Current:** [{to}]({html_url})

The content below reflects the current repository location.

---
```

### 8.7 Archived Repositories

```typescript
// Detect archived in repo metadata
interface RepoMetadata {
  archived: boolean;
  disabled: boolean;
  // ... other fields
}

// Include in output
{
  metadata: {
    archived: true,
    archived_at: null, // GitHub doesn't provide this
    // ... rest
  },
  warnings: ['This repository is archived and read-only'],
}
```

**Archived Repo Output:**
```markdown
# {repo_name}

> {description}

**⚠️ Archived Repository**  
This repository has been archived by its owner. It is read-only.

**Archived:** Yes  
**Last Push:** {pushed_at}

---

{README content if available}

---
```

### 8.8 Forks

```typescript
interface RepoMetadata {
  fork: boolean;
  parent?: {
    full_name: string;
    html_url: string;
    description: string;
  };
  source?: {
    // For forks of forks: the root repository
    full_name: string;
    html_url: string;
  };
}
```

**Fork Output:**
```markdown
# {repo_name}

> {description}

**Type:** Fork  
**Forked from:** [{parent.full_name}]({parent.html_url})

{If source exists:}
**Root Repository:** [{source.full_name}]({source.html_url})

{parent.description ? `Original: ${parent.description}` : ''}

---

{README content}
```

### 8.9 GitHub Enterprise Support

```typescript
interface GitHubProviderConfig {
  apiBaseUrl: string; // Default: 'https://api.github.com'
  webBaseUrl: string; // Default: 'https://github.com'
  token?: string;
}

function createGitHubProvider(config: GitHubProviderConfig) {
  const apiBase = config.apiBaseUrl || 'https://api.github.com';
  
  async function fetch(endpoint: string): Promise<Response> {
    return fetch(`${apiBase}${endpoint}`, {
      headers: {
        'Authorization': `Bearer ${config.token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  }
  
  return { fetch };
}

// Usage with GitHub Enterprise
const enterpriseProvider = createGitHubProvider({
  apiBaseUrl: 'https://github.mycompany.com/api/v3',
  webBaseUrl: 'https://github.mycompany.com',
  token: process.env.GHE_TOKEN,
});
```

### 8.10 Monorepos (Large Root Directories)

```typescript
async function fetchDirectorySafely(
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<{ entries: any[]; truncated: boolean }> {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref}`,
    { headers: API_HEADERS }
  );
  
  if (!response.ok) {
    throw new Error(`Failed to fetch directory: ${response.statusText}`);
  }
  
  const entries = await response.json();
  
  // Check if response was truncated
  if (!Array.isArray(entries)) {
    return { entries: [], truncated: true };
  }
  
  if (entries.length === 1000) {
    // Likely truncated
    return {
      entries,
      truncated: true,
      warning: 'Directory contains 1000+ items. Some entries may be missing. Use Git Trees API for complete listing.',
    };
  }
  
  return { entries, truncated: false };
}
```

**Large Directory Output:**
```markdown
## Directory Structure

**⚠️ Large Directory Warning**  
This directory contains 1000+ items. Showing first 1000.

For complete listing, use the Git Trees API:
```
GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1
```

### Files and Directories

{listing}
```

---

## 9. Implementation Recommendations

### 9.1 REST vs GraphQL vs Hybrid

**Recommendation: Hybrid Approach**

**Use REST for:**
- Simple, single-resource fetches (file content, single issue, single PR)
- Caching at endpoint level
- Rate limit monitoring and management
- Binary file handling
- When debugging and error handling clarity is priority

**Use GraphQL for:**
- Repository overview (the most common fetch)
- Multi-resource queries where batching helps
- When minimizing HTTP requests is critical

**Implementation Strategy:**
1. Build robust REST implementation first
2. Add GraphQL for repo overview as optimization
3. Allow provider configuration to switch between modes

### 9.2 Parallel Batching Strategy

**Recommended for Repository Overview:**

```
┌─────────────────────────────────────────────────────────────┐
│  Batch 1: Core (parallel)                                   │
│  ┌─────────┐ ┌─────────┐ ┌──────────┐ ┌───────────┐        │
│  │ /repos  │ │ /readme │ │ /contents│ │ /languages│        │
│  └────┬────┘ └────┬────┘ └────┬─────┘ └─────┬─────┘        │
│       └───────────┴───────────┴────────────┘              │
│                        ↓                                    │
│              Get default_branch                              │
│                        ↓                                    │
│  Batch 2: Enrichment (parallel)                             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐                   │
│  │ /commits │ │ /issues  │ │ /releases │                   │
│  └──────────┘ └──────────┘ └──────────┘                   │
│                        ↓                                    │
│  (Optional) Batch 3: AI Context                             │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐                      │
│  │ Root tree│ │ Fetch   │ │ Fetch   │                      │
│  │ scan    │ │ hits    │ │ hits    │                      │
│  └─────────┘ └─────────┘ └─────────┘                       │
└─────────────────────────────────────────────────────────────┘
```

**Rationale:**
- Batch 1 is independent and provides critical data
- Batch 2 depends on knowing the default branch
- Batch 3 is optional enhancement
- Parallel execution minimizes latency

### 9.3 Estimated API Calls Per URL Type

| URL Type | REST Calls | GraphQL Queries | Notes |
|----------|------------|-----------------|-------|
| `repo_overview` | 7-10 | 1 | Including optional AI context |
| `file` | 1 | 1 | Single file fetch |
| `directory` | 1-2 | 1 | + recursive for large dirs |
| `issue` | 2 | 1 | + comments |
| `issue_list` | 1-2 | 1 | With pagination |
| `pull_request` | 2 | 1 | + files |
| `release` | 1 | 1 | Single release |
| `release_list` | 1 | 1 | With pagination |
| `commit` | 1 | 1 | Single commit |
| `commit_list` | 1-2 | 1 | With pagination |
| `user_profile` | 2 | 1 | + repos |
| `gist` | 1 | 1 | Single gist |
| `raw_file` | 0 | 0 | No API needed |

### 9.4 Recommended PAT Permissions

**For Fine-Grained PAT (Recommended):**

| Permission | Access | For |
|------------|--------|-----|
| `Contents` | Read | Files, README, directories |
| `Metadata` | Read | Repo info, issues, PRs, releases, commits |
| `Pull requests` | Read | PR data and reviews |
| `Actions` | Read | Workflow runs (optional) |

**Configuration:**
- Repository access: "All repositories" (or specific list)
- Token expiration: 90 days (recommended)
- Name: "Omnisearch GitHub Provider"

**Alternative: Classic PAT:**
- Scope: `repo` (full private repo access)
- Note: Grants write access (cannot restrict to read-only)

### 9.5 Caching Strategy

**What to Cache:**

| Resource | TTL | Reason |
|----------|-----|--------|
| Repository metadata | 5 min | Changes infrequently, expensive to fetch |
| README | 1 hour | Changes rarely |
| File content | 1 hour | Generally stable |
| Directory listings | 5 min | May change with commits |
| Issue/PR lists | 2 min | Frequently updated |
| Commit history | 10 min | Ordered by time, changes frequently |
| Releases | 30 min | Published rarely |
| User profiles | 30 min | Changes slowly |

**Cache Key Design:**
```
github:{owner}:{repo}:{resource_type}:{params}:{etag}
github:facebook:react:repo_overview::etag123
github:facebook:react:file:HEAD:src/index.ts:etag456
github:facebook:react:issue_list:state=open:page=1:etag789
```

**Implementation:**
```typescript
interface CacheConfig {
  ttl: number; // seconds
  useETag: boolean;
  useLastModified: boolean;
}

const CACHE_CONFIG: Record<string, CacheConfig> = {
  repo_metadata: { ttl: 300, useETag: true, useLastModified: true },
  readme: { ttl: 3600, useETag: true, useLastModified: false },
  file_content: { ttl: 3600, useETag: true, useLastModified: false },
  directory: { ttl: 300, useETag: true, useLastModified: true },
  issue_list: { ttl: 120, useETag: false, useLastModified: true },
  commit_list: { ttl: 600, useETag: false, useLastModified: true },
  release_list: { ttl: 1800, useETag: true, useLastModified: true },
  user_profile: { ttl: 1800, useETag: true, useLastModified: false },
};
```

### 9.6 Priority Order for Implementation

**Phase 1: Core (MVP)**

1. **Repository Overview** — Most valuable, common use case
2. **File Content** — Basic file viewing
3. **Directory Listing** — Navigation support
4. **Issue/Functions** — Issue list and detail views

**Phase 2: Enhancement**

5. **Pull Request** — PR metadata and diffs
6. **Releases** — Release notes and assets
7. **Commit History** — Recent commits and single commits
8. **User/Org Profiles** — Profile pages

**Phase 3: Advanced**

9. **GitHub Actions** — CI/CD workflow information
10. **Discussions** — GitHub Discussions support
11. **Gists** — Gist content fetching
12. **AI Context Files** — Auto-detect CLAUDE.md, AGENTS.md, etc.

**Phase 4: Optimization**

13. **GraphQL Support** — For repo overview optimization
14. **Advanced Caching** — Redis/memcached integration
15. **Rate Limit Management** — Smart throttling and queueing

### 9.7 Error Classification

```typescript
class GitHubProviderError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode?: number,
    public retryable: boolean = false,
    public retryAfter?: number
  ) {
    super(message);
    this.name = 'GitHubProviderError';
  }
}

// Error codes
const ErrorCodes = {
  // Authentication/Authorization
  UNAUTHORIZED: 'github_unauthorized',
  FORBIDDEN: 'github_forbidden',
  PRIVATE_REPO: 'github_private_repo',
  
  // Resource errors
  NOT_FOUND: 'github_not_found',
  GONE: 'github_gone', // Archived repo
  GIST_NOT_FOUND: 'github_gist_not_found',
  
  // Rate limiting
  RATE_LIMITED: 'github_rate_limited',
  SECONDARY_LIMIT: 'github_secondary_limit',
  
  // Content errors
  FILE_TOO_LARGE: 'github_file_too_large',
  UNSUPPORTED_MEDIA: 'github_unsupported_media',
  EMPTY_REPO: 'github_empty_repo',
  
  // Network/server errors
  SERVER_ERROR: 'github_server_error',
  SERVICE_UNAVAILABLE: 'github_service_unavailable',
  NETWORK_ERROR: 'github_network_error',
  
  // Redirection
  REPO_MOVED: 'github_repo_moved',
  
  // Validation
  INVALID_URL: 'github_invalid_url',
  INVALID_OWNER: 'github_invalid_owner',
  INVALID_REPO: 'github_invalid_repo',
} as const;
```

---

## Appendix A: Quick Reference — API Endpoints

| Resource | Endpoint | Method |
|----------|----------|--------|
| Repository | `/repos/{owner}/{repo}` | GET |
| README | `/repos/{owner}/{repo}/readme` | GET |
| Contents | `/repos/{owner}/{repo}/contents/{path}` | GET |
| Tree | `/repos/{owner}/{repo}/git/trees/{sha}?recursive=1` | GET |
| Blob | `/repos/{owner}/{repo}/git/blobs/{sha}` | GET |
| Issues | `/repos/{owner}/{repo}/issues` | GET |
| Issue | `/repos/{owner}/{repo}/issues/{number}` | GET |
| Issue Comments | `/repos/{owner}/{repo}/issues/{number}/comments` | GET |
| Pull Requests | `/repos/{owner}/{repo}/pulls` | GET |
| Pull Request | `/repos/{owner}/{repo}/pulls/{number}` | GET |
| PR Files | `/repos/{owner}/{repo}/pulls/{number}/files` | GET |
| Releases | `/repos/{owner}/{repo}/releases` | GET |
| Release | `/repos/{owner}/{repo}/releases/{id}` | GET |
| Commits | `/repos/{owner}/{repo}/commits` | GET |
| Commit | `/repos/{owner}/{repo}/commits/{sha}` | GET |
| Languages | `/repos/{owner}/{repo}/languages` | GET |
| User | `/users/{username}` | GET |
| Gist | `/gists/{gist_id}` | GET |
| Rate Limit | `/rate_limit` | GET |

---

## Appendix B: Response Headers Reference

```
# Authentication & Versioning
Authorization: Bearer {token}
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28

# Rate Limiting (in response)
X-RateLimit-Limit: 5000
X-RateLimit-Remaining: 4999
X-RateLimit-Used: 1
X-RateLimit-Reset: 1704067200
X-RateLimit-Resource: core

# Conditional Requests (send these)
If-None-Match: "abc123..."
If-Modified-Since: Wed, 21 Oct 2015 07:28:00 GMT

# Pagination
Link: <https://api.github.com/repos/owner/repo/issues?page=2>; rel="next",
      <https://api.github.com/repos/owner/repo/issues?page=5>; rel="last"

# Content
Content-Type: application/json; charset=utf-8
Content-Length: 1234
ETag: "abc123..."
Last-Modified: Wed, 21 Oct 2015 07:28:00 GMT
```

---

## Appendix C: Status Code Reference

| Code | Meaning | Action |
|------|---------|--------|
| 200 | OK | Process response |
| 301 | Moved Permanently | Follow redirect, update stored URL |
| 302 | Found | Follow redirect |
| 304 | Not Modified | Use cached version |
| 400 | Bad Request | Fix request parameters |
| 401 | Unauthorized | Check/reFRESH token |
| 403 | Forbidden | Check permissions, may be rate limited |
| 404 | Not Found | Resource doesn't exist |
| 409 | Conflict | Handle conflict (e.g., file exists) |
| 410 | Gone | Resource was deleted |
| 422 | Unprocessable | Validation error |
| 429 | Too Many Requests | Wait for rate limit reset |
| 451 | Unavailable For Legal Reasons | Resource blocked |
| 500 | Server Error | Retry with backoff |
| 503 | Service Unavailable | Retry later |

---

*End of Research Report*
