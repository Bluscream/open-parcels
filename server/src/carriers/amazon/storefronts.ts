/**
 * The storefronts this plug-in reads. Only storefronts whose order pages are in English or German
 * are listed, because the status and date wording comes from the en/de locale tables of
 * open-parcels-rules; other languages are added once their tables exist there.
 */
export interface Storefront {
  /** Registrable domain, e.g. `amazon.de`. Pages live on `www.<domain>`, the device API on `api.<domain>`. */
  readonly domain: string;
  /** Language of the sign-in page the user opens. */
  readonly signInLanguage: string;
  /** Zone used when a page does not declare one. */
  readonly timeZone: string;
}

export const STOREFRONTS = {
  "amazon.de": { domain: "amazon.de", signInLanguage: "de_DE", timeZone: "Europe/Berlin" },
  "amazon.co.uk": { domain: "amazon.co.uk", signInLanguage: "en_GB", timeZone: "Europe/London" },
  "amazon.com": { domain: "amazon.com", signInLanguage: "en_US", timeZone: "America/New_York" },
  "amazon.ie": { domain: "amazon.ie", signInLanguage: "en_GB", timeZone: "Europe/Dublin" },
  "amazon.ca": { domain: "amazon.ca", signInLanguage: "en_CA", timeZone: "America/Toronto" },
  "amazon.com.au": {
    domain: "amazon.com.au",
    signInLanguage: "en_AU",
    timeZone: "Australia/Sydney",
  },
  "amazon.in": { domain: "amazon.in", signInLanguage: "en_IN", timeZone: "Asia/Kolkata" },
} as const satisfies Record<string, Storefront>;

export type StorefrontId = keyof typeof STOREFRONTS;
export const STOREFRONT_IDS = Object.keys(STOREFRONTS) as [StorefrontId, ...StorefrontId[]];

/** Countries the listed storefronts deliver to as their home market (amazon.de also serves AT). */
export const STOREFRONT_COUNTRIES = ["DE", "AT", "GB", "US", "IE", "CA", "AU", "IN"] as const;

export function storefrontOrigin(storefront: Storefront): URL {
  return new URL(`https://www.${storefront.domain}/`);
}

/** HTTPS on the storefront's own domain or a subdomain of it; nothing else may be visited. */
export function onStorefront(storefront: Storefront): (target: URL) => boolean {
  return (target) =>
    target.protocol === "https:" &&
    (target.hostname === storefront.domain || target.hostname.endsWith(`.${storefront.domain}`));
}
