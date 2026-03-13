// Supadata YouTube Transcript fetch provider
// Uses mode=auto: tries native captions first, falls back to AI-generated transcripts

import { http_json } from '../../../common/http.js';
import type { FetchProvider, FetchResult } from '../../../common/types.js';
import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
import { config } from '../../../config/env.js';

interface TranscriptResponse {
	content: string;
	lang?: string;
	availableLangs?: string[];
}

interface AsyncJobResponse {
	jobId: string;
}

interface JobStatusResponse {
	status: 'queued' | 'active' | 'completed' | 'failed';
	content?: string;
	lang?: string;
	availableLangs?: string[];
}

const extract_video_id = (url: string): string | undefined => {
	try {
		const parsed = new URL(url);
		const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');

		if (hostname === 'youtu.be') {
			return parsed.pathname.slice(1).split('/')[0] || undefined;
		}

		if (hostname === 'youtube.com' || hostname === 'm.youtube.com') {
			const v = parsed.searchParams.get('v');
			if (v) return v;

			const match = parsed.pathname.match(/^\/(embed|shorts|live)\/([^/?]+)/);
			if (match) return match[2];
		}

		return undefined;
	} catch {
		return undefined;
	}
};

const poll_job = async (api_key: string, job_id: string, timeout_ms: number): Promise<string> => {
	const deadline = Date.now() + timeout_ms;
	const poll_url = `${config.fetch.supadata.base_url}/youtube/transcript/${job_id}`;

	while (Date.now() < deadline) {
		const status = await http_json<JobStatusResponse>(
			'supadata',
			poll_url,
			{
				method: 'GET',
				headers: { 'x-api-key': api_key },
				signal: AbortSignal.timeout(10000),
			},
		);

		if (status.status === 'completed' && status.content) {
			return status.content;
		}
		if (status.status === 'failed') {
			throw new Error('Supadata transcript job failed');
		}

		await new Promise((r) => setTimeout(r, 1500));
	}

	throw new Error('Supadata transcript job timed out');
};

export class SupadataFetchProvider implements FetchProvider {
	name = 'supadata';
	description = 'Fetch YouTube video transcripts using Supadata API with AI-generated fallback.';

	async fetch_url(url: string): Promise<FetchResult> {
		const api_key = validate_api_key(config.fetch.supadata.api_key, this.name);

		const video_id = extract_video_id(url);
		if (!video_id) {
			throw new Error(`Not a YouTube video URL or could not extract video ID: ${url.slice(0, 200)}`);
		}

		try {
			const params = new URLSearchParams({
				url,
				text: 'true',
				mode: 'auto',
				lang: 'en',
			});

			const response = await fetch(
				`${config.fetch.supadata.base_url}/youtube/transcript?${params.toString()}`,
				{
					method: 'GET',
					headers: { 'x-api-key': api_key },
					signal: AbortSignal.timeout(config.fetch.supadata.timeout),
				},
			);

			// Async job for long videos (>20 min)
			if (response.status === 202) {
				const job = (await response.json()) as AsyncJobResponse;
				const content = await poll_job(api_key, job.jobId, config.fetch.supadata.timeout);
				return {
					url,
					title: `YouTube Transcript: ${video_id}`,
					content: `# YouTube Video Transcript\n\n${content}`,
					source_provider: this.name,
				};
			}

			if (!response.ok) {
				const body = await response.text();
				throw new Error(`Supadata API error ${response.status}: ${body.slice(0, 200)}`);
			}

			const data = (await response.json()) as TranscriptResponse;

			if (!data.content || data.content.length === 0) {
				throw new Error('Supadata returned no transcript for this video');
			}

			return {
				url,
				title: `YouTube Transcript: ${video_id}`,
				content: `# YouTube Video Transcript\n\n${data.content}`,
				source_provider: this.name,
			};
		} catch (error) {
			handle_provider_error(error, this.name, 'fetch YouTube transcript');
		}
	}
}

export const registration = {
	key: () => config.fetch.supadata.api_key,
};
