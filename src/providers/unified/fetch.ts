// Unified fetch dispatcher — auto-built from provider registrations.
// To add a provider: create its file + add config entry. That's it.

import {
	ErrorType,
	ProviderError,
	type FetchProvider,
	type FetchResult,
} from '../../common/types.js';

import { TavilyFetchProvider, registration as tavily_reg } from '../fetch/tavily/index.js';
import { FirecrawlFetchProvider, registration as firecrawl_reg } from '../fetch/firecrawl/index.js';
import { JinaFetchProvider, registration as jina_reg } from '../fetch/jina/index.js';
import { YouFetchProvider, registration as you_reg } from '../fetch/you/index.js';
import { BrightDataFetchProvider, registration as brightdata_reg } from '../fetch/brightdata/index.js';
import { LinkupFetchProvider, registration as linkup_reg } from '../fetch/linkup/index.js';
import { DiffbotFetchProvider, registration as diffbot_reg } from '../fetch/diffbot/index.js';
import { SociaVaultFetchProvider, registration as sociavault_reg } from '../fetch/sociavault/index.js';
import { SpiderFetchProvider, registration as spider_reg } from '../fetch/spider/index.js';
import { ScrapflyFetchProvider, registration as scrapfly_reg } from '../fetch/scrapfly/index.js';
import { ScrapeGraphAIFetchProvider, registration as scrapegraphai_reg } from '../fetch/scrapegraphai/index.js';
import { ScrapeDoFetchProvider, registration as scrapedo_reg } from '../fetch/scrapedo/index.js';
import { ScrapelessFetchProvider, registration as scrapeless_reg } from '../fetch/scrapeless/index.js';
import { OpenGraphFetchProvider, registration as opengraph_reg } from '../fetch/opengraph/index.js';
import { ScrapingBeeFetchProvider, registration as scrapingbee_reg } from '../fetch/scrapingbee/index.js';
import { ScraperAPIFetchProvider, registration as scraperapi_reg } from '../fetch/scraperapi/index.js';
import { ZyteFetchProvider, registration as zyte_reg } from '../fetch/zyte/index.js';
import { ScrapingAntFetchProvider, registration as scrapingant_reg } from '../fetch/scrapingant/index.js';
import { OxylabsFetchProvider, registration as oxylabs_reg } from '../fetch/oxylabs/index.js';
import { OlostepFetchProvider, registration as olostep_reg } from '../fetch/olostep/index.js';
import { DecodoFetchProvider, registration as decodo_reg } from '../fetch/decodo/index.js';
import { ScrappeyFetchProvider, registration as scrappey_reg } from '../fetch/scrappey/index.js';
import { LeadMagicFetchProvider, registration as leadmagic_reg } from '../fetch/leadmagic/index.js';
import { CloudflareBrowserFetchProvider, registration as cloudflare_browser_reg } from '../fetch/cloudflare_browser/index.js';
import { SerpapiFetchProvider, registration as serpapi_reg } from '../fetch/serpapi/index.js';
import { SupadataFetchProvider, registration as supadata_reg } from '../fetch/supadata/index.js';
import { GitHubFetchProvider, registration as github_reg } from '../fetch/github/index.js';

// ─── ADD ONE LINE HERE TO REGISTER A NEW FETCH PROVIDER ─────────────
const PROVIDERS = [
	{ name: 'tavily', ...tavily_reg, factory: () => new TavilyFetchProvider() },
	{ name: 'firecrawl', ...firecrawl_reg, factory: () => new FirecrawlFetchProvider() },
	{ name: 'jina', ...jina_reg, factory: () => new JinaFetchProvider() },
	{ name: 'you', ...you_reg, factory: () => new YouFetchProvider() },
	{ name: 'brightdata', ...brightdata_reg, factory: () => new BrightDataFetchProvider() },
	{ name: 'linkup', ...linkup_reg, factory: () => new LinkupFetchProvider() },
	{ name: 'diffbot', ...diffbot_reg, factory: () => new DiffbotFetchProvider() },
	{ name: 'sociavault', ...sociavault_reg, factory: () => new SociaVaultFetchProvider() },
	{ name: 'spider', ...spider_reg, factory: () => new SpiderFetchProvider() },
	{ name: 'scrapfly', ...scrapfly_reg, factory: () => new ScrapflyFetchProvider() },
	{ name: 'scrapegraphai', ...scrapegraphai_reg, factory: () => new ScrapeGraphAIFetchProvider() },
	{ name: 'scrapedo', ...scrapedo_reg, factory: () => new ScrapeDoFetchProvider() },
	{ name: 'scrapeless', ...scrapeless_reg, factory: () => new ScrapelessFetchProvider() },
	{ name: 'opengraph', ...opengraph_reg, factory: () => new OpenGraphFetchProvider() },
	{ name: 'scrapingbee', ...scrapingbee_reg, factory: () => new ScrapingBeeFetchProvider() },
	{ name: 'scraperapi', ...scraperapi_reg, factory: () => new ScraperAPIFetchProvider() },
	{ name: 'zyte', ...zyte_reg, factory: () => new ZyteFetchProvider() },
	{ name: 'scrapingant', ...scrapingant_reg, factory: () => new ScrapingAntFetchProvider() },
	{ name: 'oxylabs', ...oxylabs_reg, factory: () => new OxylabsFetchProvider() },
	{ name: 'olostep', ...olostep_reg, factory: () => new OlostepFetchProvider() },
	{ name: 'decodo', ...decodo_reg, factory: () => new DecodoFetchProvider() },
	{ name: 'scrappey', ...scrappey_reg, factory: () => new ScrappeyFetchProvider() },
	{ name: 'leadmagic', ...leadmagic_reg, factory: () => new LeadMagicFetchProvider() },
	{ name: 'cloudflare_browser', ...cloudflare_browser_reg, factory: () => new CloudflareBrowserFetchProvider() },
	{ name: 'serpapi', ...serpapi_reg, factory: () => new SerpapiFetchProvider() },
	{ name: 'supadata', ...supadata_reg, factory: () => new SupadataFetchProvider() },
	{ name: 'github', ...github_reg, factory: () => new GitHubFetchProvider() },
] as const;
// ─────────────────────────────────────────────────────────────────────

export type FetchProviderName = (typeof PROVIDERS)[number]['name'];

export const get_active_fetch_providers = (): Array<{ name: string; key: () => string | undefined }> =>
	PROVIDERS.filter((p) => p.key()?.trim()).map((p) => ({ name: p.name, key: p.key }));

export const has_any_fetch_provider = (): boolean =>
	PROVIDERS.some((p) => p.key()?.trim());

export class UnifiedFetchProvider implements FetchProvider {
	name = 'fetch';
	description = `Fetch URL content as markdown. Providers: ${PROVIDERS.map((p) => p.name).join(', ')}.`;

	private providers: Map<string, FetchProvider>;

	constructor() {
		this.providers = new Map(
			PROVIDERS.filter((p) => p.key()?.trim()).map((p) => [p.name, p.factory()]),
		);
	}

	async fetch_url(url: string, provider?: FetchProviderName): Promise<FetchResult> {
		if (!provider) {
			throw new ProviderError(ErrorType.INVALID_INPUT, 'Provider parameter is required for dispatch', this.name);
		}
		const selected = this.providers.get(provider);
		if (!selected) {
			throw new ProviderError(
				ErrorType.INVALID_INPUT,
				`Invalid provider: ${provider}. Valid: ${Array.from(this.providers.keys()).join(', ')}`,
				this.name,
			);
		}
		return selected.fetch_url(url);
	}
}
