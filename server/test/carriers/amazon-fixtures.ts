/**
 * Made-up Amazon pages. Only the structure mirrors the storefront; every id, title, place and
 * coordinate is invented.
 */

export interface TileSpec {
  readonly orderId: string;
  readonly shipmentId?: string;
  readonly lineItemId?: string;
  readonly title: string;
  readonly status: string;
  /** Links straight to the package page instead of the order line. */
  readonly direct?: boolean;
}

const attr = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

export function tilePath(tile: TileSpec): string {
  const query = new URLSearchParams({ orderId: tile.orderId });
  if (tile.shipmentId !== undefined) {
    query.set("shipmentId", tile.shipmentId);
  }
  if (tile.lineItemId !== undefined) {
    query.set("lineItemId", tile.lineItemId);
  }
  const path =
    tile.direct === true ? "/progress-tracker/package" : "/gp/your-account/order-details";
  return `${path}?${query.toString()}`;
}

export function ordersPage(tiles: readonly TileSpec[]): string {
  const cards = tiles
    .map(
      (tile) =>
        `<div class="item-card"><a class="item-card__link" href="${attr(tilePath(tile))}" ` +
        `aria-label="${attr(`${tile.title}, Order placed 10 November 2026, ${tile.status}`)}">` +
        `<img src="https://img.example.invalid/1.jpg"></a></div>`,
    )
    .join("\n");
  return `<html><body><h1>Your Orders</h1>${cards}</body></html>`;
}

export function trackPath(orderId: string, shipmentId: string): string {
  return `/progress-tracker/package?orderId=${orderId}&shipmentId=${shipmentId}&packageIndex=0`;
}

export function linePage(orderId: string, shipmentId: string): string {
  return `<html><body><a href="${attr(trackPath(orderId, shipmentId))}">Track package</a></body></html>`;
}

export interface TrackSpec {
  readonly trackingId: string;
  readonly shortStatus: string;
  readonly milestone?: string;
  readonly carrierLine?: string;
  readonly promiseMessage?: string;
  readonly windowEndsInMs?: number;
  readonly callout?: string;
  readonly events?: readonly { date: string; time: string; message: string; location?: string }[];
}

/** A package page: page-state JSON plus the carrier block and the server-rendered timeline. */
export function trackPage(spec: TrackSpec): string {
  const state = {
    shortStatus: spec.shortStatus,
    orderId: "000-0000000-0000000",
    trackingId: spec.trackingId,
    timezone: "Europe/Berlin",
    locale: "de-DE",
    customerId: "AEXAMPLECUSTOMER",
    hereMapsApiKey: "made-up-map-key",
    promise: { promiseMessage: spec.promiseMessage ?? "" },
    ...(spec.windowEndsInMs === undefined
      ? {}
      : { timeUntilPredictedDeliveryWindowEnd: spec.windowEndsInMs }),
    progressTracker: {
      lastReachedMilestone: spec.milestone ?? spec.shortStatus,
      numberOfReachedMilestones: 2,
    },
    ...(spec.callout === undefined
      ? {}
      : {
          mapTracking: {
            calloutMessage: spec.callout,
            destinationLatitude: 11.111,
            destinationLongitude: 22.222,
            url: "/progress-tracker/package/actions/map-tracking",
          },
        }),
  };
  const events = (spec.events ?? [])
    .map(
      (event) =>
        `<div class="tracking-event-date-header"><span class="tracking-event-date">${event.date}</span></div>` +
        `<div class="tracking-event-row"><span class="tracking-event-time">${event.time}</span>` +
        `<span class="tracking-event-message">${event.message}</span>` +
        `<span class="tracking-event-location">${event.location ?? ""}</span></div>`,
    )
    .join("");
  return (
    `<html><head><script type="a-state" data-a-state='{"key":"page-state"}'>` +
    `${JSON.stringify(state)}</script></head><body>` +
    `<input type="hidden" name="csrfToken" value="made-up-csrf-token">` +
    `<div id="carrierRelatedInfo-container"><span>${spec.carrierLine ?? "Delivery by Amazon"}</span>` +
    `<span>Tracking ID: ${spec.trackingId}</span></div>` +
    `<div id="tracking-events-container">${events}</div></body></html>`
  );
}

export const SIGN_IN_PAGE =
  '<html><body><form action="/ap/signin"><input type="email"><input type="password"></form></body></html>';

export const CAPTCHA_PAGE =
  '<html><body><form action="/errors/validateCaptcha"><input id="captchacharacters"></form></body></html>';

export function cookieExchange(domain: string): unknown {
  return {
    response: {
      tokens: {
        cookies: {
          [`.${domain}`]: [
            { Name: "session-id", Value: "000-0000000-0000000", Path: "/" },
            { Name: "at-acbde", Value: '"made-up-cookie"', Path: "/" },
          ],
        },
      },
    },
  };
}
