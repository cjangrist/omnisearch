// Shared HTML/Markdown extraction utilities used by fetch providers

// Extract <title> from raw HTML
export const extract_html_title = (html: string): string => {
	const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	return match ? match[1].replace(/<[^>]+>/g, '').trim() : '';
};

// Extract first # heading from markdown
export const extract_markdown_title = (markdown: string): string => {
	const match = markdown.match(/^#\s+(.+)/m);
	return match ? match[1].trim() : '';
};
