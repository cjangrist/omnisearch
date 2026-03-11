// Provider initialization — derives availability from unified registries

import { UnifiedAISearchProvider, has_any_ai_provider, get_active_ai_providers } from './unified/ai_search.js';
import { UnifiedWebSearchProvider, has_any_search_provider, get_active_search_providers } from './unified/web_search.js';
import {
	active_providers,
	reset_registry,
	register_ai_search_provider,
	register_web_search_provider,
} from '../server/tools.js';

export const initialize_providers = () => {
	reset_registry();

	if (has_any_search_provider()) {
		register_web_search_provider(new UnifiedWebSearchProvider());
		for (const p of get_active_search_providers()) {
			active_providers.search.add(p.name);
		}
	}

	if (has_any_ai_provider()) {
		register_ai_search_provider(new UnifiedAISearchProvider());
		for (const p of get_active_ai_providers()) {
			active_providers.ai_response.add(p.name);
		}
	}

	console.error('Active providers:');
	for (const [category, providers] of Object.entries(active_providers)) {
		if (providers.size > 0) {
			console.error(`- ${category}: ${Array.from(providers).join(', ')}`);
		} else {
			console.error(`- ${category}: None available (missing API keys)`);
		}
	}
};
