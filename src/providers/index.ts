// Provider initialization — derives availability from unified registries.
//
// Only web_search has a provider registry now. URL fetching is delegated to the
// external omnifetch service (no internal fetch providers), so `fetch` just
// tracks whether OMNIFETCH_ENDPOINT is configured.

import { UnifiedWebSearchProvider, has_any_search_provider, get_active_search_providers } from './unified/web_search.js';
import {
	active_providers,
	register_web_search_provider,
} from '../server/tools.js';
import { OMNIFETCH_ENDPOINT } from '../config/env.js';
import { omnifetch_available } from '../server/omnifetch_client.js';
import { loggers } from '../common/logger.js';

const logger = loggers.providers();

// Isolate-level idempotency gate. Both REST init (ensure_rest_initialized) and
// per-DO init (_do_init) call initialize_providers(); without this gate the
// SECOND call would create fresh Unified* instances and overwrite the singleton
// registry mid-flight, racing in-flight tool handlers in the FIRST DO that
// already captured the previous instance. Once any caller has initialized the
// providers, subsequent callers are no-ops.
let _providers_initialized = false;

export const initialize_providers = () => {
	if (_providers_initialized) {
		logger.debug('Provider initialization skipped (already initialized)', { op: 'init_providers_skip' });
		return;
	}
	logger.debug('Initializing providers', { op: 'init_providers' });

	// Build new state locally first, then swap atomically — avoids a transient
	// empty-state window that could affect concurrent DO instances sharing the isolate.
	const new_search = new Set<string>();
	const new_fetch = new Set<string>();

	if (has_any_search_provider()) {
		register_web_search_provider(new UnifiedWebSearchProvider());
		for (const p of get_active_search_providers()) {
			new_search.add(p.name);
		}
		logger.info('Web search providers registered', {
			op: 'init_providers',
			category: 'search',
			providers: Array.from(new_search),
			count: new_search.size,
		});
	} else if (!has_any_search_provider()) {
		logger.warn('No web search providers available', {
			op: 'init_providers',
			category: 'search',
		});
	}

	// Fetch is a single external service — no provider registry. Track availability
	// so /health and the provider-status resource reflect it.
	if (omnifetch_available()) {
		new_fetch.add('omnifetch');
		logger.info('Fetch service configured', {
			op: 'init_providers',
			category: 'fetch',
			endpoint: OMNIFETCH_ENDPOINT,
		});
	} else {
		logger.warn('OMNIFETCH_ENDPOINT not configured — fetch tool unavailable', {
			op: 'init_providers',
			category: 'fetch',
		});
	}

	// Atomic swap — readers never see an empty state
	active_providers.search = new_search;
	active_providers.fetch = new_fetch;

	_providers_initialized = true;

	// Summary log
	const totalProviders = new_search.size + new_fetch.size;
	logger.info('Provider initialization complete', {
		op: 'init_providers',
		total_providers: totalProviders,
		search_providers: new_search.size,
		fetch_providers: new_fetch.size,
	});
};
