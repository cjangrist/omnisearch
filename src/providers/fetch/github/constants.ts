// Configuration constants for the GitHub fetch provider

export const BINARY_EXTENSIONS = new Set([
	'png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'svg', 'bmp', 'tiff',
	'mp3', 'wav', 'ogg', 'flac', 'mp4', 'avi', 'mkv', 'mov', 'webm',
	'zip', 'tar', 'gz', 'rar', '7z', 'bz2', 'xz',
	'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
	'ttf', 'otf', 'woff', 'woff2', 'eot',
	'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a',
	'db', 'sqlite', 'psd', 'ai', 'sketch',
]);

// ── Context file inlining config ────────────────────────────────

export const CONTEXT_FILE_LIMITS: Record<string, number> = {
	// Claude Code
	'CLAUDE.md': 100_000,
	'AGENTS.md': 100_000,
	// Google Gemini CLI
	'GEMINI.md': 100_000,
	// Amp (Sourcegraph) / Roo Code
	'AGENT.md': 100_000,
	// Cross-tool
	'ARCHITECTURE.md': 100_000,
	'DEVELOPMENT.md': 100_000,
	'CONVENTIONS.md': 100_000,
	// Devin
	'REVIEW.md': 100_000,
	// Cursor (legacy)
	'.cursorrules': 50_000,
	// Windsurf (legacy)
	'.windsurfrules': 50_000,
	// Cline / Roo Code (legacy)
	'.clinerules': 50_000,
	// Goose (Block)
	'.goosehints': 50_000,
	// Roo Code (legacy)
	'.roorules': 50_000,
	// Continue.dev (legacy)
	'.continuerules': 50_000,
	// GitHub Copilot
	'.github/copilot-instructions.md': 50_000,
	// JetBrains Junie
	'.junie/guidelines.md': 50_000,
	// LLM docs standard
	'llms.txt': 50_000,
	'llms-full.txt': 30_000,
};

// Directory-based AI rules (each tool stores rules as multiple files in a dir)
export const AI_RULES_DIRS: Record<string, { gql_alias: string; max_bytes_per_file: number }> = {
	'.cursor/rules':          { gql_alias: 'cursor_rules_dir',          max_bytes_per_file: 50_000 },
	'.windsurf/rules':        { gql_alias: 'windsurf_rules_dir',        max_bytes_per_file: 50_000 },
	'.roo/rules':             { gql_alias: 'roo_rules_dir',             max_bytes_per_file: 50_000 },
	'.amazonq/rules':         { gql_alias: 'amazonq_rules_dir',         max_bytes_per_file: 50_000 },
	'.augment/rules':         { gql_alias: 'augment_rules_dir',         max_bytes_per_file: 50_000 },
	'.continue/rules':        { gql_alias: 'continue_rules_dir',        max_bytes_per_file: 50_000 },
	'.trae/rules':            { gql_alias: 'trae_rules_dir',            max_bytes_per_file: 50_000 },
	'.github/instructions':   { gql_alias: 'github_instructions_dir',   max_bytes_per_file: 50_000 },
	'.agents/skills':         { gql_alias: 'agents_skills_dir',         max_bytes_per_file: 50_000 },
};

export const CONTEXT_FILE_NAMES = Object.keys(CONTEXT_FILE_LIMITS);

// ── README truncation ───────────────────────────────────────────

export const README_TOKEN_CAP = 5_000;
export const README_CHAR_CAP = README_TOKEN_CAP * 4; // ~4 chars per token

// ── Dependency config files ─────────────────────────────────────

export const DEP_CONFIG_ALLOWLIST: Record<string, { gql_alias: string; max_bytes: number }> = {
	'package.json':        { gql_alias: 'dep_package_json',        max_bytes: 10_000 },
	'pyproject.toml':      { gql_alias: 'dep_pyproject_toml',      max_bytes: 5_000 },
	'Cargo.toml':          { gql_alias: 'dep_cargo_toml',          max_bytes: 4_000 },
	'go.mod':              { gql_alias: 'dep_go_mod',              max_bytes: 5_000 },
	'Gemfile':             { gql_alias: 'dep_gemfile',             max_bytes: 4_000 },
	'requirements.txt':    { gql_alias: 'dep_requirements_txt',    max_bytes: 2_000 },
	'pnpm-workspace.yaml': { gql_alias: 'dep_pnpm_workspace_yaml', max_bytes: 1_000 },
	'.nvmrc':              { gql_alias: 'dep_nvmrc',               max_bytes: 100 },
	'.npmrc':              { gql_alias: 'dep_npmrc',               max_bytes: 1_000 },
	'lerna.json':          { gql_alias: 'dep_lerna_json',          max_bytes: 1_000 },
};

// ── Documentation ───────────────────────────────────────────────

export const DOCS_DIR_NAMES = new Set(['docs', 'doc', 'documentation']);
export const DOCS_MD_EXTENSIONS = new Set(['md', 'mdx', 'rst']);
export const TRANSLATION_SUFFIX = /-(AR|CS|DA|DE|EO|ES|FA|FI|FR|GR|HU|ID|IT|JP|KR|ML|NL|NO|PL|PTBR|RO|RU|TR|UA|VN|ZH)\.(md|mdx)$/i;

// ── AI rules inlining ──────────────────────────────────────────

export const AI_RULES_INLINE_MAX_BYTES = 20_000; // ~5K tokens — only inline if dir has exactly 1 file under this

// ── Truncation limits ───────────────────────────────────────────

export const README_MAX_BYTES = 500_000;
export const COMMIT_MESSAGE_MAX_CHARS = 80;
export const ISSUE_BODY_MAX_CHARS = 500;
export const RELEASE_BODY_MAX_CHARS = 1000;
export const PATCH_MAX_CHARS = 3000;
export const SNIPPET_MAX_CHARS = 300;

// ── Pagination ──────────────────────────────────────────────────

export const LIST_PER_PAGE = 100;
export const OVERVIEW_COMMITS_PER_PAGE = 10;
export const OVERVIEW_ISSUES_PER_PAGE = 5;
export const OVERVIEW_PRS_PER_PAGE = 5;
export const OVERVIEW_RELEASES_PER_PAGE = 3;
export const COMMENTS_PER_PAGE = 50;
export const STARGAZER_MAX_PAGE = 400;

// ── Tree structure ──────────────────────────────────────────────

export const TREE_CHILD_FRAGMENT = `... on Tree { entries { name type object { ... on Blob { byteSize } } } }`;
export const MAX_TREE_CHILDREN_DIRS = 25;
export const NOISY_DIR_NAMES = new Set([
	'test', 'tests', 'spec', 'specs', '__tests__', '__mocks__',
	'docs', 'doc', 'documentation',
	'vendor', 'node_modules', 'third_party', 'third-party', 'thirdparty',
	'fixtures', 'testdata', 'test_data', 'test-data',
	'examples', 'example', 'samples', 'sample', 'demo', 'demos',
	'build', 'dist', 'out', 'output', '.build',
	'scripts', 'tools', 'hack', 'misc',
	'packages', 'plugins',
	'assets', 'static', 'public', 'images', 'img', 'icons', 'fonts',
	'locales', 'translations', 'i18n', 'l10n',
]);
