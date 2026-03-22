// MCP resource handlers for provider status and provider info

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { active_providers } from './tools.js';

export const setup_handlers = (server: McpServer) => {
	// Provider Status Resource
	server.resource(
		'provider-status',
		'omnisearch://providers/status',
		{
			description: 'Current status of all providers (search, AI response, fetch)',
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
									fetch: Array.from(active_providers.fetch),
								},
								available_count: {
									search: active_providers.search.size,
									ai_response: active_providers.ai_response.size,
									fetch: active_providers.fetch.size,
									total:
										active_providers.search.size +
										active_providers.ai_response.size +
										active_providers.fetch.size,
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
				active_providers.ai_response.has(providerName) ||
				active_providers.fetch.has(providerName);

			if (!isAvailable) {
				throw new Error(
					`Provider not available: ${providerName} (missing API key)`,
				);
			}

			// Derive capabilities from which category the provider belongs to
			const capabilities: string[] = [];
			if (active_providers.search.has(providerName)) capabilities.push('web_search');
			if (active_providers.ai_response.has(providerName)) capabilities.push('ai_response');
			if (active_providers.fetch.has(providerName)) capabilities.push('fetch');

			return {
				contents: [
					{
						uri: uri.href,
						mimeType: 'application/json',
						text: JSON.stringify(
							{
								name: providerName,
								status: 'active',
								capabilities,
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
