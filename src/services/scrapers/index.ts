import type { TrackingData } from "../ingest/parser";

export interface ScraperConfig {
	serviceName: string;
	url: string;
}

export interface ScraperResult {
	success: boolean;
	trackingData?: TrackingData[];
	error?: string;
	needsReauth?: boolean;
}

export abstract class BaseScraper<CredentialsType = unknown> {
	public config: ScraperConfig;

	constructor(config: ScraperConfig) {
		this.config = config;
	}

	/**
	 * Initializes the scraper, logs in using decrypted credentials, etc.
	 */
	abstract authenticate(credentials: CredentialsType): Promise<boolean>;

	/**
	 * Performs the scraping and returns structured tracking data.
	 */
	abstract scrape(): Promise<ScraperResult>;

	/**
	 * Closes any open browser contexts or connections.
	 */
	abstract close(): Promise<void>;
}
