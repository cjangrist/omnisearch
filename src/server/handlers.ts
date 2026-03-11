// MCP resource handlers for provider status and provider info

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { active_providers } from './tools.js';

export const setup_handlers = (server: McpServer) => {
	// Provider Status Resource
	server.resource(
		'provider-status',
		'omnisearch://providers/status',
		{
			description: 'Current status of all search providers',
			mimeType: 'application/json',
		},
		async (uri) => {
			return {
				contents: [
					{
						uri: uri.href,
						mimeType: 'application/json',
						text: JSON.stringify(
							{
								status: 'operational',
								providers: {
									search: Array.from(active_providers.search),
									ai_response: Array.from(
										active_providers.ai_response,
									),
								},
								available_count: {
									search: active_providers.search.size,
									ai_response: active_providers.ai_response.size,
									total:
										active_providers.search.size +
										active_providers.ai_response.size,
								},
							},
							null,
							2,
						),
					},
				],
			};
		},
	);

	// Provider Info Resource Template
	server.resource(
		'provider-info',
		new ResourceTemplate('omnisearch://search/{provider}/info', { list: undefined }),
		{
			description: 'Information about a specific search provider',
			mimeType: 'application/json',
		},
		async (uri, { provider }) => {
			const providerName = provider as string;

			// Check if provider is available
			const isAvailable =
				active_providers.search.has(providerName) ||
				active_providers.ai_response.has(providerName);

			if (!isAvailable) {
				throw new Error(
					`Provider not available: ${providerName} (missing API key)`,
				);
			}

			return {
				contents: [
					{
						uri: uri.href,
						mimeType: 'application/json',
						text: JSON.stringify(
							{
								name: providerName,
								status: 'active',
								capabilities: ['web_search', 'news_search'],
								rate_limits: {
									requests_per_minute: 60,
									requests_per_day: 1000,
								},
							},
							null,
							2,
						),
					},
				],
			};
		},
	);
};
