// Identity headers that mimic the Kimi CLI on the wire.
// Reference: tmp/kimi_search_fetch_demo.py (collect_device_identity, build_*_headers)
//
// We're in Cloudflare Workers — no `platform.node()`, no `~/.kimi/device_id`.
// Use stable hardcoded values so Kimi sees us as one consistent installation.

const KIMI_PLATFORM = 'kimi_cli';
const KIMI_CLI_VERSION = '1.37.0';
const KIMI_DEVICE_NAME = 'gus-01.angrist.net';
const KIMI_DEVICE_MODEL = 'Linux 6.17.0-1009-gcp x86_64';
const KIMI_OS_VERSION = '#9-Ubuntu SMP Fri Mar  6 21:21:14 UTC 2026';
const KIMI_DEVICE_ID = 'babf43cbff8d4c789b8a8fabc85b0490';

const build_common_msh_headers = (): Record<string, string> => ({
	'X-Msh-Platform': KIMI_PLATFORM,
	'X-Msh-Version': KIMI_CLI_VERSION,
	'X-Msh-Device-Name': KIMI_DEVICE_NAME,
	'X-Msh-Device-Model': KIMI_DEVICE_MODEL,
	'X-Msh-Os-Version': KIMI_OS_VERSION,
	'X-Msh-Device-Id': KIMI_DEVICE_ID,
});

const new_tool_call_id = (prefix: string): string =>
	`${prefix}-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

export const build_kimi_search_headers = (api_key: string): Record<string, string> => ({
	'User-Agent': `KimiCLI/${KIMI_CLI_VERSION}`,
	Authorization: `Bearer ${api_key}`,
	'Content-Type': 'application/json',
	'X-Msh-Tool-Call-Id': new_tool_call_id('search'),
	...build_common_msh_headers(),
});

export const build_kimi_fetch_headers = (api_key: string): Record<string, string> => ({
	'User-Agent': `KimiCLI/${KIMI_CLI_VERSION}`,
	Authorization: `Bearer ${api_key}`,
	'Content-Type': 'application/json',
	Accept: 'application/json',
	'X-Msh-Tool-Call-Id': new_tool_call_id('fetch'),
	...build_common_msh_headers(),
});
