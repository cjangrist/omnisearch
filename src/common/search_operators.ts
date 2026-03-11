// Search operator parsing: converts advanced query syntax (site:, filetype:, etc.)
// into structured params consumed by Brave, Kagi, and Tavily providers.

interface SearchOperator {
	type: string;
	value: string;
	original_text: string;
}

interface ParsedQuery {
	base_query: string;
	operators: SearchOperator[];
}

export interface SearchParams {
	query: string;
	include_domains?: string[];
	exclude_domains?: string[];
	file_type?: string;
	title_filter?: string;
	url_filter?: string;
	body_filter?: string;
	page_filter?: string;
	language?: string;
	location?: string;
	date_before?: string;
	date_after?: string;
	exact_phrases?: string[];
	force_include_terms?: string[];
	exclude_terms?: string[];
}

const OPERATOR_PATTERNS: Record<string, RegExp> = {
	exclude_site: /-site:([^\s]+)/g,
	site: /(?<!-)site:([^\s]+)/g,
	filetype: /filetype:([^\s]+)/g,
	ext: /ext:([^\s]+)/g,
	intitle: /intitle:([^\s]+)/g,
	inurl: /inurl:([^\s]+)/g,
	inbody: /inbody:"?([^"\s]+)"?/g,
	inpage: /inpage:"?([^"\s]+)"?/g,
	language: /(?:lang|language):([^\s]+)/g,
	location: /(?:loc|location):([^\s]+)/g,
	before: /before:(\d{4}(?:-\d{2}(?:-\d{2})?)?)/g,
	after: /after:(\d{4}(?:-\d{2}(?:-\d{2})?)?)/g,
	exact: /"([^"]+)"/g,
	force_include: /(?<=^|\s)\+([^\s]+)/g,
	exclude_term: /(?<=^|\s)-([^\s:]+)/g,
};

export const parse_search_operators = (query: string): ParsedQuery => {
	const operators: SearchOperator[] = [];
	let modified_query = query;

	for (const [type, pattern] of Object.entries(OPERATOR_PATTERNS)) {
		modified_query = modified_query.replace(pattern, (match, value) => {
			operators.push({ type, value, original_text: match });
			return '';
		});
	}

	return {
		base_query: modified_query.replace(/\s+/g, ' ').trim(),
		operators,
	};
};

const SINGLE_VALUE_FIELDS: Record<string, keyof SearchParams> = {
	filetype: 'file_type', ext: 'file_type',
	intitle: 'title_filter', inurl: 'url_filter',
	inbody: 'body_filter', inpage: 'page_filter',
	language: 'language', location: 'location',
	before: 'date_before', after: 'date_after',
};

const ARRAY_FIELDS: Record<string, keyof SearchParams> = {
	site: 'include_domains', exclude_site: 'exclude_domains',
	exact: 'exact_phrases', force_include: 'force_include_terms',
	exclude_term: 'exclude_terms',
};

export const apply_search_operators = (parsed: ParsedQuery): SearchParams => {
	const params: Record<string, unknown> = { query: parsed.base_query };

	for (const op of parsed.operators) {
		const single_field = SINGLE_VALUE_FIELDS[op.type];
		if (single_field) {
			params[single_field] = op.value;
			continue;
		}

		const array_field = ARRAY_FIELDS[op.type];
		if (array_field) {
			const arr = (params[array_field] as string[] | undefined) ?? [];
			arr.push(op.value);
			params[array_field] = arr;
			continue;
		}

		// Unknown operator types are silently ignored
	}

	return params as unknown as SearchParams;
};

export const build_query_with_operators = (
	search_params: SearchParams,
	additional_include_domains?: string[],
	additional_exclude_domains?: string[],
	options?: { exclude_file_type?: boolean; exclude_dates?: boolean },
): string => {
	const filters: string[] = [];

	const includes = [...(additional_include_domains ?? []), ...(search_params.include_domains ?? [])];
	if (includes.length) filters.push(includes.map((d) => `site:${d}`).join(' OR '));

	const excludes = [...(additional_exclude_domains ?? []), ...(search_params.exclude_domains ?? [])];
	if (excludes.length) filters.push(...excludes.map((d) => `-site:${d}`));

	if (search_params.file_type && !options?.exclude_file_type) filters.push(`filetype:${search_params.file_type}`);
	if (search_params.title_filter) filters.push(`intitle:${search_params.title_filter}`);
	if (search_params.url_filter) filters.push(`inurl:${search_params.url_filter}`);
	if (search_params.body_filter) filters.push(`inbody:${search_params.body_filter}`);
	if (search_params.page_filter) filters.push(`inpage:${search_params.page_filter}`);
	if (search_params.language) filters.push(`lang:${search_params.language}`);
	if (search_params.location) filters.push(`loc:${search_params.location}`);
	if (search_params.date_before && !options?.exclude_dates) filters.push(`before:${search_params.date_before}`);
	if (search_params.date_after && !options?.exclude_dates) filters.push(`after:${search_params.date_after}`);
	if (search_params.exact_phrases?.length) filters.push(...search_params.exact_phrases.map((p) => `"${p}"`));
	if (search_params.force_include_terms?.length) filters.push(...search_params.force_include_terms.map((t) => `+${t}`));
	if (search_params.exclude_terms?.length) filters.push(...search_params.exclude_terms.map((t) => `-${t}`));

	return filters.length > 0 ? `${search_params.query} ${filters.join(' ')}` : search_params.query;
};
