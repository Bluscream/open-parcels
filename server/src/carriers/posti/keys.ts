import { carrierKey } from "../../plugin/api.js";

/**
 * Posti's own app: its hosts, and the fixed values its login and device service insist on (from
 * the shared rules). They identify the app, not any user; Posti's login only accepts requests
 * that carry them.
 */
export const POSTI_APP = {
  authService: "https://auth-service.posti.fi/api/v1",
  mfa: "https://mfa.posti.fi/api/v1",
  uasHost: "todentaminen.posti.fi",
  bankHost: "tunnistus.telia.fi",
  loginRedirect: "https://oma.posti.fi/app/login",
  appUserAgent: carrierKey("posti", "app_user_agent"),
  webViewUserAgent: carrierKey("posti", "web_view_user_agent"),
  appPackage: carrierKey("posti", "app_package"),
} as const;

/** How this service's trusted device shows in the account's device list. */
export const DEVICE_MODEL = "open-parcels";
