// Intelligent snippet selection: given multiple provider snippets for the same URL,
// select or merge into ONE optimal snippet maximizing information density and query relevance.

const MERGE_CHAR_BUDGET = 500;
const DIVERSITY_THRESHOLD = 0.3; // Jaccard below this triggers merge

// --- Normalization ---

const normalize_snippet = (s: string): string =>
	s
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#?\w+;/g, '')
		.replace(/\s+/g, ' ')
		.replace(/\.{3,}$/, '')
		.trim();

// --- N-gram utilities ---

const word_tokenize = (text: string): string[] =>
	text
		.toLowerCase()
		.split(/\s+/)
		.filter((w) => w.length > 1);

const build_bigrams = (words: string[]): Set<string> => {
	const bigrams = new Set<string>();
	for (let i = 0; i < words.length - 1; i++) {
		bigrams.add(`${words[i]} ${words[i + 1]}`);
	}
	return bigrams;
};

const jaccard = (a: Set<string>, b: Set<string>): number => {
	if (a.size === 0 && b.size === 0) return 1;
	let intersection = 0;
	for (const item of a) {
		if (b.has(item)) intersection++;
	}
	const union = a.size + b.size - intersection;
	return union === 0 ? 1 : intersection / union;
};

// --- Scoring ---

const score_snippet = (
	normalized: string,
	query_terms: string[],
): number => {
	const words = word_tokenize(normalized);
	if (words.length < 2) return 0;

	const bigrams = build_bigrams(words);
	// Trigrams for extra signal
	const trigrams = new Set<string>();
	for (let i = 0; i < words.length - 2; i++) {
		trigrams.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
	}

	const unique_ngrams = bigrams.size + trigrams.size;
	const density = unique_ngrams / normalized.length;

	// Query relevance: fraction of query terms present
	const snippet_lower = normalized.toLowerCase();
	const query_hits = query_terms.filter((t) =>
		snippet_lower.includes(t),
	).length;
	const relevance =
		query_terms.length > 0 ? query_hits / query_terms.length : 0;

	// Length factor: prefer longer snippets (log scale, capped)
	const length_factor = Math.min(
		1,
		Math.log(normalized.length + 1) / Math.log(600),
	);

	return density * (1 + 0.3 * relevance) * (0.7 + 0.3 * length_factor);
};

// --- Sentence splitting ---

const split_sentences = (text: string): string[] => {
	// Split on sentence boundaries: period/exclamation/question followed by space+uppercase, or newlines
	const raw = text.split(/(?<=[.!?])\s+(?=[A-Z])|[\n\r]+/);
	return raw.map((s) => s.trim()).filter((s) => s.length > 15);
};

// --- Sentence-level greedy merge ---

const sentence_merge = (
	snippets: string[],
	budget: number,
): string => {
	const all_sentences: Array<{
		text: string;
		bigrams: Set<string>;
		order: number;
	}> = [];
	let order = 0;

	for (const snippet of snippets) {
		const sentences = split_sentences(snippet);
		for (const sent of sentences) {
			const words = word_tokenize(sent);
			const bigrams = build_bigrams(words);
			all_sentences.push({ text: sent, bigrams, order: order++ });
		}
	}

	// Deduplicate near-identical sentences (Jaccard > 0.7)
	const deduped: typeof all_sentences = [];
	for (const sent of all_sentences) {
		const is_dupe = deduped.some(
			(d) => jaccard(d.bigrams, sent.bigrams) > 0.7,
		);
		if (!is_dupe) {
			deduped.push(sent);
		}
	}

	// Greedy set-cover
	const covered = new Set<string>();
	const selected: typeof all_sentences = [];
	let remaining = budget;

	while (remaining > 0 && deduped.length > 0) {
		let best_idx = -1;
		let best_new_count = 0;

		for (let i = 0; i < deduped.length; i++) {
			let new_count = 0;
			for (const bg of deduped[i].bigrams) {
				if (!covered.has(bg)) new_count++;
			}
			if (new_count > best_new_count) {
				best_new_count = new_count;
				best_idx = i;
			}
		}

		if (best_idx === -1 || best_new_count === 0) break;

		const best = deduped[best_idx];
		if (best.text.length > remaining) {
			deduped.splice(best_idx, 1);
			continue;
		}

		selected.push(best);
		for (const bg of best.bigrams) covered.add(bg);
		remaining -= best.text.length;
		deduped.splice(best_idx, 1);
	}

	// Re-order by original appearance for reading flow
	selected.sort((a, b) => a.order - b.order);
	return selected.map((s) => s.text).join(' ');
};

// --- Main entry point ---

/**
 * Given multiple raw snippets for the same URL (from different providers),
 * select or merge into ONE optimal snippet.
 *
 * @param snippets - Raw snippet strings from different providers
 * @param query - The original search query (for relevance scoring)
 * @returns A single best snippet string
 */
const select_best_snippet = (
	snippets: string[],
	query: string,
): string => {
	if (snippets.length === 0) return '';
	if (snippets.length === 1) return snippets[0];

	const query_terms = word_tokenize(query);

	// Normalize all candidates
	const normalized = snippets.map((s) => ({
		original: s,
		norm: normalize_snippet(s),
	}));

	// Score and rank
	const scored = normalized
		.map((s) => ({
			...s,
			score: score_snippet(s.norm, query_terms),
		}))
		.sort((a, b) => b.score - a.score);

	const primary = scored[0];
	const runner_up = scored[1];

	// If runner-up is very low quality, just return primary
	if (!runner_up || runner_up.score < primary.score * 0.3) {
		return primary.original;
	}

	// Diversity check: are top two about different parts of the page?
	const primary_bigrams = build_bigrams(word_tokenize(primary.norm));
	const runner_up_bigrams = build_bigrams(
		word_tokenize(runner_up.norm),
	);
	const similarity = jaccard(primary_bigrams, runner_up_bigrams);

	if (similarity < DIVERSITY_THRESHOLD) {
		// Diverse enough to merge — use sentence-level greedy cover on top 2
		const merged = sentence_merge(
			[primary.original, runner_up.original],
			MERGE_CHAR_BUDGET,
		);
		return merged || primary.original;
	}

	// Not diverse — just return the best one
	return primary.original;
};

/**
 * Process an array of web search results, collapsing each result's snippets[]
 * into a single best snippet using intelligent selection/merge.
 *
 * @param results - Array of results with snippets arrays
 * @param query - The original search query
 * @returns Same array with each result's snippets reduced to a single entry
 */
export const collapse_snippets = <
	T extends { snippets: string[] },
>(
	results: T[],
	query: string,
): T[] =>
	results.map((r) => ({
		...r,
		snippets:
			r.snippets.length <= 1
				? r.snippets
				: [select_best_snippet(r.snippets, query)],
	}));
