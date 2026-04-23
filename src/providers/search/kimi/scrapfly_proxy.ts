// Forward an arbitrary HTTP POST through Scrapfly (residential / browser-fingerprint).
//
// Why this exists: api.kimi.com is Cloudflare-fronted with a WAF rule that
// blocks Cloudflare-Workers ASN egress (TLS fingerprint + IP reputation).
// Scrapfly forwards the same request from a real-browser fingerprint — bypassing it.
// Verified: same key + headers from this Worker → 403 direct, → 200 via Scrapfly.
//
// Reference: https://scrapfly.io/docs/scrape-api/custom

import { ErrorType, ProviderError } from '../../../common/types.js';
import { http_json } from '../../../common/http.js';
import { validate_api_key } from '../../../common/utils.js';
import { config } from '../../../config/env.js';

const SCRAPFLY_SCRAPE_PATH = '/scrape';
const SCRAPFLY_COUNTRY = 'us';

interface ScrapflyResponse {
	result?: {
		status_code?: number;
		content?: string;
		response_headers?: Record<string, string>;
	};
}

const build_scrapfly_url = (
	target_url: string,
	target_headers: Record<string, string>,
	api_key: string,
): string => {
	const url = new URL(`${config.fetch.scrapfly.base_url}${SCRAPFLY_SCRAPE_PATH}`);
	url.searchParams.set('key', api_key);
	url.searchParams.set('url', target_url);
	url.searchParams.set('method', 'POST');
	url.searchParams.set('country', SCRAPFLY_COUNTRY);
	for (const [name, value] of Object.entries(target_headers)) {
		url.searchParams.set(`headers[${name}]`, value);
	}
	return url.toString();
};

export const proxy_post_via_scrapfly = async (
	provider_name: string,
	target_url: string,
	target_headers: Record<string, string>,
	target_body: string,
	timeout_ms: number,
): Promise<{ status: number; body: string; headers: Record<string, string> }> => {
	const sf_key = validate_api_key(config.fetch.scrapfly.api_key, provider_name);
	const sf_url = build_scrapfly_url(target_url, target_headers, sf_key);

	const data = await http_json<ScrapflyResponse>(provider_name, sf_url, {
		method: 'POST',
		headers: {
			'Content-Type': target_headers['Content-Type'] ?? 'application/json',
		},
		body: target_body,
		signal: AbortSignal.timeout(timeout_ms),
	});

	const upstream = data.result;
	if (!upstream || typeof upstream.status_code !== 'number' || upstream.content == null) {
		throw new ProviderError(
			ErrorType.PROVIDER_ERROR,
			`Scrapfly proxy returned no upstream response (status_code=${upstream?.status_code})`,
			provider_name,
		);
	}

	return {
		status: upstream.status_code,
		body: upstream.content,
		headers: upstream.response_headers ?? {},
	};
};
