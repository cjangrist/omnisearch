// Provider initialization — derives availability from unified registries

import { UnifiedAISearchProvider, has_any_ai_provider, get_active_ai_providers } from './unified/ai_search.js';
import { UnifiedWebSearchProvider, has_any_search_provider, get_active_search_providers } from './unified/web_search.js';
import {
	active_providers,
	reset_registry,
	register_ai_search_provider,
	register_web_search_provider,
} from '../server/tools.js';
import { loggers } from '../common/logger.js';

const logger = loggers.providers();

export const initialize_providers = () => {
	logger.debug('Initializing providers', { op: 'init_providers' });

	reset_registry();

	if (has_any_search_provider()) {
		register_web_search_provider(new UnifiedWebSearchProvider());
		for (const p of get_active_search_providers()) {
			active_providers.search.add(p.name);
		}
		logger.info('Web search providers registered', {
			op: 'init_providers',
			category: 'search',
			providers: Array.from(active_providers.search),
			count: active_providers.search.size,
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
			active_providers.ai_response.add(p.name);
		}
		logger.info('AI response providers registered', {
			op: 'init_providers',
			category: 'ai_response',
			providers: Array.from(active_providers.ai_response),
			count: active_providers.ai_response.size,
		});
	} else {
		logger.warn('No AI response providers available', {
			op: 'init_providers',
			category: 'ai_response',
		});
	}

	// Summary log
	const totalProviders = active_providers.search.size + active_providers.ai_response.size;
	logger.info('Provider initialization complete', {
		op: 'init_providers',
		total_providers: totalProviders,
		search_providers: active_providers.search.size,
		ai_providers: active_providers.ai_response.size,
	});
};
