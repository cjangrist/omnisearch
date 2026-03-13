// SerpAPI YouTube Transcript fetch provider
// Uses the youtube_video_transcript engine to get full video transcripts

import { http_json } from '../../../common/http.js';
import type { FetchProvider, FetchResult } from '../../../common/types.js';
import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
import { config } from '../../../config/env.js';

interface TranscriptEntry {
	start: number;
	end: number;
	snippet: string;
}

interface SerpApiTranscriptResponse {
	transcript?: TranscriptEntry[];
	search_metadata?: { status: string };
	error?: string;
}

const extract_video_id = (url: string): string | undefined => {
	try {
		const parsed = new URL(url);
		const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');

		if (hostname === 'youtu.be') {
			return parsed.pathname.slice(1).split('/')[0] || undefined;
		}

		if (hostname === 'youtube.com' || hostname === 'm.youtube.com') {
			// /watch?v=ID
			const v = parsed.searchParams.get('v');
			if (v) return v;

			// /embed/ID, /shorts/ID, /live/ID
			const match = parsed.pathname.match(/^\/(embed|shorts|live)\/([^/?]+)/);
			if (match) return match[2];
		}

		return undefined;
	} catch {
		return undefined;
	}
};

export class SerpapiFetchProvider implements FetchProvider {
	name = 'serpapi';
	description = 'Fetch YouTube video transcripts using SerpAPI YouTube Transcript engine.';

	async fetch_url(url: string): Promise<FetchResult> {
		const api_key = validate_api_key(config.fetch.serpapi.api_key, this.name);

		const video_id = extract_video_id(url);
		if (!video_id) {
			throw new Error(`Not a YouTube video URL or could not extract video ID: ${url.slice(0, 200)}`);
		}

		try {
			const params = new URLSearchParams({
				engine: 'youtube_video_transcript',
				v: video_id,
				api_key,
			});

			const data = await http_json<SerpApiTranscriptResponse>(
				this.name,
				`${config.fetch.serpapi.base_url}?${params.toString()}`,
				{
					method: 'GET',
					signal: AbortSignal.timeout(config.fetch.serpapi.timeout),
				},
			);

			if (data.error) {
				throw new Error(`SerpAPI error: ${data.error}`);
			}

			if (!data.transcript || data.transcript.length === 0) {
				throw new Error('SerpAPI returned no transcript for this video');
			}

			const transcript_text = data.transcript.map((t) => t.snippet).join(' ');

			const title = `YouTube Transcript: ${video_id}`;

			return {
				url,
				title,
				content: `# YouTube Video Transcript\n\n${transcript_text}`,
				source_provider: this.name,
				metadata: {
					video_id,
					transcript_segments: data.transcript.length,
				},
			};
		} catch (error) {
			handle_provider_error(error, this.name, 'fetch YouTube transcript');
		}
	}
}

export const registration = {
	key: () => config.fetch.serpapi.api_key,
};
