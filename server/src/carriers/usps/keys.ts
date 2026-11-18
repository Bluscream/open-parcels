import { carrierKey } from "../../plugin/api.js";

/** USPS's public Informed Delivery web client; its client id comes from the shared rules. */
export const INFORMED = {
  am: "https://verified.usps.com/am",
  clientId: carrierKey("usps", "informed_client_id"),
  redirectUri: "https://informeddelivery.usps.com/portal/callback",
} as const;
