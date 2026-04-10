// Pure formatting utilities for the GitHub fetch provider — no API calls

import type { ReadmeTruncation } from './types.js';
import {
	BINARY_EXTENSIONS, DOCS_MD_EXTENSIONS, TRANSLATION_SUFFIX,
	README_TOKEN_CAP, README_CHAR_CAP,
} from './constants.js';

export function escape_table_cell(text: string): string {
	return text.replace(/\|/g, '\\|').replace(/\n/g, ' ').replace(/\r/g, '');
}

export function format_size(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function format_date(iso: string | null | undefined): string {
	if (!iso) return 'N/A';
	return new Date(iso).toISOString().split('T')[0];
}

export function format_star_velocity(total_stars: number, recent_timestamps: string[]): string {
	if (total_stars === 0 || recent_timestamps.length < 2) return '';
	const now = Date.now();
	const sorted = recent_timestamps.map((t) => new Date(t).getTime()).sort((a, b) => a - b);
	const oldest = sorted[0];
	const days = Math.max((now - oldest) / (1000 * 60 * 60 * 24), 0.1);
	const rate_per_day = sorted.length / days;

	if (rate_per_day >= 100) return `~${Math.round(rate_per_day)}/day (~${Math.round(rate_per_day * 30)}/month)`;
	if (rate_per_day >= 10) return `~${Math.round(rate_per_day)}/day (~${Math.round(rate_per_day * 7)}/week)`;
	if (rate_per_day >= 1) return `~${rate_per_day.toFixed(1)}/day (~${Math.round(rate_per_day * 7)}/week)`;
	if (rate_per_day >= 0.14) return `~${(rate_per_day * 7).toFixed(1)}/week (~${Math.round(rate_per_day * 30)}/month)`;
	return `~${(rate_per_day * 30).toFixed(1)}/month`;
}

export function snippet_two_sentences(text: string | null | undefined): string {
	if (!text) return '';
	const clean = text.replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '').trim();
	const sentences = clean.split(/(?<=[.!?])\s+|\n\n/).filter((s) => s.trim().length > 10);
	return sentences.slice(0, 2).join(' ').slice(0, 300).trim();
}

export function format_language_breakdown(languages: Record<string, number>): string {
	const total = Object.values(languages).reduce((sum, v) => sum + v, 0);
	if (total === 0) return '_No languages detected_';
	return Object.entries(languages)
		.sort(([, a], [, b]) => b - a)
		.map(([lang, bytes]) => {
			const pct = ((bytes / total) * 100).toFixed(1);
			return `| ${lang} | ${pct}% | ${format_size(bytes)} |`;
		})
		.join('\n');
}

export function format_tree(contents: Array<{ name: string; type: string; size: number }>): string {
	const dirs = contents.filter((c) => c.type === 'dir').sort((a, b) => a.name.localeCompare(b.name));
	const files = contents.filter((c) => c.type !== 'dir').sort((a, b) => a.name.localeCompare(b.name));
	const lines: string[] = [];
	for (const d of dirs) lines.push(`${d.name}/`);
	for (const f of files) lines.push(`${f.name} (${format_size(f.size)})`);
	return lines.join('\n');
}

export function is_binary(filename: string): boolean {
	const ext = filename.split('.').pop()?.toLowerCase() ?? '';
	return BINARY_EXTENSIONS.has(ext);
}

export function is_docs_md_file(path: string): boolean {
	const ext = path.split('.').pop()?.toLowerCase() ?? '';
	if (!DOCS_MD_EXTENSIONS.has(ext)) return false;
	if (TRANSLATION_SUFFIX.test(path)) return false;
	return true;
}

function build_readme_toc(full_readme: string): string {
	const lines = full_readme.split('\n');
	const headings: Array<{ level: number; title: string; line: number }> = [];
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(/^(#{1,3})\s+(.+)/);
		if (!m) continue;
		const title = m[2].trim();
		if (title.startsWith('![') || title.startsWith('<img')) continue;
		headings.push({ level: m[1].length, title, line: i + 1 });
	}
	if (headings.length === 0) return '';
	const toc_lines = headings.map((h) => {
		const indent = '  '.repeat(h.level - 1);
		return `${indent}- ${h.title} (L${h.line})`;
	});
	return `\n### Table of Contents (full README)\n\n${toc_lines.join('\n')}\n`;
}

export function truncate_readme(content: string): ReadmeTruncation {
	const marker = '## README\n\n';
	const start = content.indexOf(marker);
	if (start === -1) return { content, readme_truncated: false };

	const body_start = start + marker.length;

	// Find next top-level ## section or footer after README body
	let readme_end = content.length;
	const footer_pos = content.indexOf('---\n*Fetched via', body_start);
	if (footer_pos !== -1) readme_end = footer_pos;
	// Find first ## header after README that's NOT inside the README content itself
	// (README's own ## headers are part of its content)
	const lines = content.substring(body_start).split('\n');
	let fence_marker = '';
	let char_offset = body_start;
	for (const line of lines) {
		const fence_match = line.match(/^(`{3,}|~{3,})/);
		if (fence_match) {
			if (!fence_marker) fence_marker = fence_match[1];
			else if (line.startsWith(fence_marker) && line.trim() === fence_marker) fence_marker = '';
		}
		if (!fence_marker && line.startsWith('## ') && char_offset > body_start) {
			// This is a new section header — could be README's own or a provider section
			// Provider sections have specific patterns
			if (/^## (CLAUDE|AGENTS|GEMINI|AGENT|ARCHITECTURE|DEVELOPMENT|CONVENTIONS|REVIEW)\.md$/.test(line)
				|| /^## \.(cursorrules|windsurfrules|clinerules|goosehints|roorules|continuerules)$/.test(line)
				|| /^## \.(github|cursor|windsurf|roo|amazonq|augment|continue|trae|agents|junie)\//.test(line)
				|| /^## (Recent Commits|Commit Activity|Open Issues|Open Pull Requests|Recent Releases|AI Rules Files|AI Context Files|Package Manifests|llms)/.test(line)) {
				readme_end = char_offset;
				break;
			}
		}
		char_offset += line.length + 1;
	}

	const readme_text = content.substring(body_start, readme_end);
	if (readme_text.length <= README_CHAR_CAP) return { content, readme_truncated: false };

	const original_tokens = Math.ceil(readme_text.length / 4);
	let cut = readme_text.lastIndexOf('\n', README_CHAR_CAP);
	if (cut === -1) cut = README_CHAR_CAP;
	const truncated = readme_text.substring(0, cut);
	const toc = build_readme_toc(readme_text);
	const note = `\n\n*[README truncated — showing ~${README_TOKEN_CAP.toLocaleString()} of ${original_tokens.toLocaleString()} tokens]*\n`;

	return {
		content: content.substring(0, body_start) + truncated + note + toc + '\n' + content.substring(readme_end),
		readme_truncated: true,
		readme_original_tokens: original_tokens,
	};
}

export function format_docs_listing(docs_dir: string, files: string[]): string {
	if (files.length === 0) return '';
	let section = `## Documentation Files\n\n`;
	section += `\`${docs_dir}/\` — ${files.length} markdown files:\n\n`;
	section += '```\n';
	for (const f of files) section += `${f}\n`;
	section += '```\n\n';
	return section;
}

export function format_ai_rules_listing(dirs: Map<string, Array<{ name: string; size: number }>>): string {
	if (dirs.size === 0) return '';
	let section = `## AI Rules Files\n\n`;
	for (const [dir_path, files] of dirs) {
		section += `\`${dir_path}/\` — ${files.length} file${files.length > 1 ? 's' : ''}:\n\n`;
		section += '```\n';
		for (const f of files) section += `${f.name} (${format_size(f.size)})\n`;
		section += '```\n\n';
	}
	return section;
}

export function format_dep_configs(configs: Array<{ name: string; text: string }>): string {
	if (configs.length === 0) return '';
	let section = `## Package Manifests\n\n`;
	for (const { name, text } of configs) {
		const ext = name.split('.').pop()?.toLowerCase() ?? '';
		const lang = ext === 'json' ? 'json' : ext === 'toml' ? 'toml' : ext === 'yaml' ? 'yaml' : '';
		section += `### ${name}\n\n\`\`\`${lang}\n${text.trimEnd()}\n\`\`\`\n\n`;
	}
	return section;
}

export function format_commit_activity(monthly: Array<{ month: string; count: number }>): string {
	if (monthly.length === 0) return '';
	const total = monthly.reduce((s, m) => s + m.count, 0);
	const last_12 = monthly.filter((m) => {
		const now = new Date();
		const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 12, 1));
		return m.month >= `${cutoff.getUTCFullYear()}-${String(cutoff.getUTCMonth() + 1).padStart(2, '0')}`;
	});
	const last_12_total = last_12.reduce((s, m) => s + m.count, 0);
	let section = `## Commit Activity\n\n`;
	section += `**${total.toLocaleString()} commits in last 2 years** (${last_12_total.toLocaleString()} in last 12 months)\n\n`;
	section += `| Month | Commits |\n|-------|---------|\n`;
	for (const m of monthly) section += `| ${m.month} | ${m.count} |\n`;
	section += `\n`;
	return section;
}

export function format_depth2_tree(entries: Array<{ path: string; type: string; size?: number }>): string {
	const top_dirs = entries.filter((e) => !e.path.includes('/') && e.type === 'tree').sort((a, b) => a.path.localeCompare(b.path));
	const top_files = entries.filter((e) => !e.path.includes('/') && e.type !== 'tree').sort((a, b) => a.path.localeCompare(b.path));
	const lines: string[] = [];

	for (const dir of top_dirs) {
		lines.push(`${dir.path}/`);
		const children = entries.filter((e) => {
			const parts = e.path.split('/');
			return parts.length === 2 && parts[0] === dir.path;
		});
		const child_dirs = children.filter((c) => c.type === 'tree').sort((a, b) => a.path.localeCompare(b.path));
		const child_files = children.filter((c) => c.type !== 'tree').sort((a, b) => a.path.localeCompare(b.path));
		for (const d of child_dirs) lines.push(`  ${d.path.split('/').pop()!}/`);
		for (const f of child_files) {
			const name = f.path.split('/').pop()!;
			lines.push(`  ${name}${f.size ? ` (${format_size(f.size)})` : ''}`);
		}
	}
	for (const f of top_files) {
		lines.push(`${f.path}${f.size ? ` (${format_size(f.size)})` : ''}`);
	}

	return lines.join('\n');
}
