// TODO(rules-keys): move to carrierKey("usps", …) in open-parcels-rules once it is on master.
/** Fixed values of USPS's public Informed Delivery web client. Not secrets of any user. */
export const INFORMED = {
  am: "https://verified.usps.com/am",
  clientId: "nh0yDbmZncxiWXiGs630",
  redirectUri: "https://informeddelivery.usps.com/portal/callback",
} as const;
