// Provider initialization — derives availability from unified registries

import { UnifiedAISearchProvider, has_any_ai_provider, get_active_ai_providers } from './unified/ai_search.js';
import { UnifiedWebSearchProvider, has_any_search_provider, get_active_search_providers } from './unified/web_search.js';
import { UnifiedFetchProvider, has_any_fetch_provider, get_active_fetch_providers } from './unified/fetch.js';
import {
	active_providers,
	register_ai_search_provider,
	register_web_search_provider,
	register_fetch_provider,
} from '../server/tools.js';
import { loggers } from '../common/logger.js';

const logger = loggers.providers();

export const initialize_providers = () => {
	logger.debug('Initializing providers', { op: 'init_providers' });

	// Build new state locally first, then swap atomically — avoids a transient
	// empty-state window that could affect concurrent DO instances sharing the isolate.
	const new_search = new Set<string>();
	const new_ai = new Set<string>();
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
	} else {
		logger.warn('No web search providers available', {
			op: 'init_providers',
			category: 'search',
		});
	}

	if (has_any_ai_provider()) {
		register_ai_search_provider(new UnifiedAISearchProvider());
		for (const p of get_active_ai_providers()) {
			new_ai.add(p.name);
		}
		logger.info('AI response providers registered', {
			op: 'init_providers',
			category: 'ai_response',
			providers: Array.from(new_ai),
			count: new_ai.size,
		});
	} else {
		logger.warn('No AI response providers available', {
			op: 'init_providers',
			category: 'ai_response',
		});
	}

	if (has_any_fetch_provider()) {
		register_fetch_provider(new UnifiedFetchProvider());
		for (const p of get_active_fetch_providers()) {
			new_fetch.add(p.name);
		}
		logger.info('Fetch providers registered', {
			op: 'init_providers',
			category: 'fetch',
			providers: Array.from(new_fetch),
			count: new_fetch.size,
		});
	} else {
		logger.warn('No fetch providers available', {
			op: 'init_providers',
			category: 'fetch',
		});
	}

	// Atomic swap — readers never see an empty state
	active_providers.search = new_search;
	active_providers.ai_response = new_ai;
	active_providers.fetch = new_fetch;

	// Summary log
	const totalProviders = new_search.size + new_ai.size + new_fetch.size;
	logger.info('Provider initialization complete', {
		op: 'init_providers',
		total_providers: totalProviders,
		search_providers: new_search.size,
		ai_providers: new_ai.size,
		fetch_providers: new_fetch.size,
	});
};
