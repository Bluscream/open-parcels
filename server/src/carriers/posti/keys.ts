// TODO(rules-keys): move to carrierKey("posti", …) in open-parcels-rules once it is on master.
/**
 * Fixed values of Posti's own app that its login and device service insist on. They identify the
 * app, not any user; Posti's login only accepts requests that carry them.
 */
export const POSTI_APP = {
  authService: "https://auth-service.posti.fi/api/v1",
  mfa: "https://mfa.posti.fi/api/v1",
  uasHost: "todentaminen.posti.fi",
  bankHost: "tunnistus.telia.fi",
  loginRedirect: "https://oma.posti.fi/app/login",
  appUserAgent: "okhttp/4.12.0",
  webViewUserAgent:
    "Mozilla/5.0 (Linux; Android 16; sdk_gphone64_x86_64 Build/BE2A.250530.026.F3; wv) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/133.0.6943.137 Mobile Safari/537.36 " +
    "OmaPostiAndroid/6.5.1+7713/WebView(133.0.6943.137)",
  appPackage: "fi.itella.posti.android",
} as const;

/** How this service's trusted device shows in the account's device list. */
export const DEVICE_MODEL = "open-parcels";
