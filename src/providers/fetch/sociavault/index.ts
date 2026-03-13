import { http_json } from '../../../common/http.js';
import type { FetchProvider, FetchResult } from '../../../common/types.js';
import { ErrorType, ProviderError } from '../../../common/types.js';
import { handle_provider_error, validate_api_key } from '../../../common/utils.js';
import { config } from '../../../config/env.js';

// Platform detection and endpoint mapping from URL
// SociaVault uses GET requests with query params (not POST)
interface PlatformRoute {
	hosts: string[];
	platform: string;
	endpoint: string;
	param_name: string;
}

const PLATFORM_ROUTES: PlatformRoute[] = [
	// Reddit: GET /v1/scrape/reddit/post/comments?url=...
	{ hosts: ['reddit.com', 'www.reddit.com', 'old.reddit.com'], platform: 'reddit', endpoint: '/v1/scrape/reddit/post/comments', param_name: 'url' },
	// Twitter/X: GET /v1/scrape/twitter/tweet?url=...
	{ hosts: ['twitter.com', 'www.twitter.com', 'x.com', 'www.x.com'], platform: 'twitter', endpoint: '/v1/scrape/twitter/tweet', param_name: 'url' },
	// YouTube: GET /v1/scrape/youtube/video?url=...
	{ hosts: ['youtube.com', 'www.youtube.com', 'youtu.be'], platform: 'youtube', endpoint: '/v1/scrape/youtube/video', param_name: 'url' },
	// Facebook: GET /v1/scrape/facebook/post?url=...
	{ hosts: ['facebook.com', 'www.facebook.com', 'fb.com'], platform: 'facebook', endpoint: '/v1/scrape/facebook/post', param_name: 'url' },
	// Instagram: GET /v1/scrape/instagram/post-info?url=...
	{ hosts: ['instagram.com', 'www.instagram.com'], platform: 'instagram', endpoint: '/v1/scrape/instagram/post-info', param_name: 'url' },
	// TikTok: GET /v1/scrape/tiktok/video-info?url=...
	{ hosts: ['tiktok.com', 'www.tiktok.com'], platform: 'tiktok', endpoint: '/v1/scrape/tiktok/video-info', param_name: 'url' },
	// LinkedIn: GET /v1/scrape/linkedin/post?url=...
	{ hosts: ['linkedin.com', 'www.linkedin.com'], platform: 'linkedin', endpoint: '/v1/scrape/linkedin/post', param_name: 'url' },
	// Threads: GET /v1/scrape/threads/post?url=...
	{ hosts: ['threads.net', 'www.threads.net'], platform: 'threads', endpoint: '/v1/scrape/threads/post', param_name: 'url' },
	// Pinterest: GET /v1/scrape/pinterest/pin?url=...
	{ hosts: ['pinterest.com', 'www.pinterest.com'], platform: 'pinterest', endpoint: '/v1/scrape/pinterest/pin', param_name: 'url' },
];

const detect_route = (url: string): { route: PlatformRoute; param_value: string } | undefined => {
	try {
		const hostname = new URL(url).hostname.toLowerCase();
		const route = PLATFORM_ROUTES.find((r) => r.hosts.includes(hostname));
		if (!route) return undefined;

		return { route, param_value: url };
	} catch {
		return undefined;
	}
};

interface SociaVaultResponse {
	success: boolean;
	data: Record<string, unknown>;
	creditsUsed?: number;
}

export class SociaVaultFetchProvider implements FetchProvider {
	name = 'sociavault';
	description = 'Fetch social media content using SociaVault API. Supports Reddit, Twitter/X, Instagram, TikTok, YouTube, LinkedIn, Facebook, Threads, Pinterest.';

	async fetch_url(url: string): Promise<FetchResult> {
		const api_key = validate_api_key(config.fetch.sociavault.api_key, this.name);

		const detected = detect_route(url);
		if (!detected) {
			const supported = [...new Set(PLATFORM_ROUTES.map((r) => r.platform))].join(', ');
			throw new ProviderError(
				ErrorType.INVALID_INPUT,
				`SociaVault only supports social media URLs (${supported}). Got: ${new URL(url).hostname}`,
				this.name,
			);
		}

		const { route, param_value } = detected;

		try {
			// SociaVault uses GET with query params
			const api_url = new URL(`${config.fetch.sociavault.base_url}${route.endpoint}`);
			api_url.searchParams.set(route.param_name, param_value);

			const data = await http_json<SociaVaultResponse>(
				this.name,
				api_url.toString(),
				{
					method: 'GET',
					headers: {
						'X-API-Key': api_key,
					},
					signal: AbortSignal.timeout(config.fetch.sociavault.timeout),
				},
			);

			if (!data.success) {
				throw new Error('SociaVault returned unsuccessful response');
			}

			const content = format_social_content(route.platform, data.data);

			return {
				url,
				title: `${route.platform} content`,
				content,
				source_provider: this.name,
				metadata: {
					platform: route.platform,
					credits_used: data.creditsUsed,
				},
			};
		} catch (error) {
			handle_provider_error(error, this.name, 'fetch social media content');
		}
	}
}

const format_social_content = (platform: string, data: Record<string, unknown>): string => {
	const lines: string[] = [`# ${platform} content\n`];

	const stringify_value = (value: unknown): string => {
		if (typeof value === 'string') return value;
		if (typeof value === 'number' || typeof value === 'boolean') return String(value);
		if (Array.isArray(value)) return value.map(stringify_value).join(', ');
		if (value && typeof value === 'object') return JSON.stringify(value, null, 2);
		return '';
	};

	for (const [key, value] of Object.entries(data)) {
		if (value === null || value === undefined) continue;
		const label = key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
		lines.push(`**${label}:** ${stringify_value(value)}\n`);
	}

	return lines.join('\n');
};

export const registration = {
	key: () => config.fetch.sociavault.api_key,
};
