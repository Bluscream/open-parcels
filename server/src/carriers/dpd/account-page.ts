import { textOf } from "../../plugin/api.js";
import { inputValues, Page, type Control } from "./html.js";

/*
 * What the myDPD pages look like. The recipient-postcode gate (`hidZipCode`) and every address
 * block are deliberately never read.
 */

/** A control that only a signed-in my.dpd.de page carries. */
const SIGNED_IN_MARKER = 'id="modBurgerNavi_btnLogout"';
const PORTAL_HOST = "portal.dpd.de";
/** The dashboard control that opens the parcel list; the public login page lacks it. */
const PORTAL_SIGNED_IN_MARKER = "btnHomeMyParcel";

/**
 * Whether a my.dpd.de page belongs to a signed-in session. Never decided from the parcel count:
 * a signed-out page renders the same empty inbox as an empty account.
 */
export function isSignedIn(html: string): boolean {
  return html.includes(SIGNED_IN_MARKER);
}

/** A signed-out portal redirects to the public login page, so the final host matters too. */
export function isPortalSignedIn(url: string, html: string): boolean {
  return new URL(url).hostname === PORTAL_HOST && html.includes(PORTAL_SIGNED_IN_MARKER);
}

const FORM_TAG = /<form\b[^>]*>/gi;
const SITEKEY = /data-sitekey\s*=\s*"[^"]+"/i;
const RECAPTCHA_SCRIPT = /recaptcha\/(?:api|enterprise)\.js/i;
const INLINE_MESSAGE =
  /<(\w+)\b[^>]*\bclass="[^"]*\bdgs-inline-message\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/gi;

/**
 * Whether the login page asks for a captcha. The form-class marker counts on the `<form>` tag
 * only: the same string sits in a style rule of the pristine page.
 */
export function hasCaptcha(html: string): boolean {
  for (const [tag] of html.matchAll(FORM_TAG)) {
    if (tag.includes("german-sso-login-form") && tag.includes("dgs-form-has-captcha")) {
      return true;
    }
  }
  return SITEKEY.test(html) || RECAPTCHA_SCRIPT.test(html);
}

/**
 * Whether the login form came back with an error. The message can also arrive as the username
 * field's value, so any value there other than the submitted address counts.
 */
export function loginRejected(html: string, username: string): boolean {
  if (!html.includes('name="dpg_username"')) {
    return false;
  }
  for (const match of html.matchAll(INLINE_MESSAGE)) {
    if (textOf(match[2] ?? "") !== "") {
      return true;
    }
  }
  const submitted = username.trim().toLowerCase();
  return inputValues(html, "dpg_username").some(
    (value) => value !== "" && value.toLowerCase() !== submitted,
  );
}

const PREFIX = "ContentPlaceHolder1_";
const ROW_PREFIX = `${PREFIX}repParcelList_`;
export const SLOTS = ["Start", "OnTheRoad", "DeliveryDepot", "CarLoad", "Delivered"] as const;
export type SlotName = (typeof SLOTS)[number];
export const TABS = ["incoming", "sending", "returning"] as const;
export type Tab = (typeof TABS)[number];

export interface Row {
  readonly index: number;
  readonly barcode: string;
  readonly sentence: string;
  readonly icon: number | null;
}

export interface Slot {
  readonly slot: SlotName;
  readonly text: string;
  readonly date: string;
}

export interface Detail {
  readonly barcode: string;
  readonly slots: readonly Slot[];
  readonly icon: number | null;
  readonly weightText: string;
  readonly flowType: string;
}

/** Called with the id of a control every such page should carry but this one lacks. */
export type MissingReporter = (controlId: string) => void;

function icon(control: Control | undefined): number | null {
  const match = /status_(\d+)\.svg/.exec(control?.attrs.get("src") ?? "");
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** The parcel count shown on a tab; null when it cannot be read. */
export function tabCounter(page: Page, tab: Tab, missing: MissingReporter): number | null {
  const id = `${PREFIX}counterGet${tab.charAt(0).toUpperCase()}${tab.slice(1)}Parcel`;
  const text = page.text(id);
  if (text === undefined) {
    missing(id);
  }
  return text !== undefined && /^\d+$/.test(text) ? Number(text) : null;
}

/** Rows of the current tab, numbered from 0 until the first absent one. */
export function listRows(page: Page, missing: MissingReporter): Row[] {
  const rows: Row[] = [];
  for (let index = 0; ; index += 1) {
    const number = page.control(`${ROW_PREFIX}labParcelNo_${index}`);
    if (number === undefined) {
      return rows;
    }
    const sentence = page.text(`${ROW_PREFIX}labDeliveryStatus_${index}`);
    if (sentence === undefined) {
      missing(`${ROW_PREFIX}labDeliveryStatus`);
    }
    const iconControl = page.control(`${ROW_PREFIX}imgDeliverStatus_${index}`);
    if (iconControl === undefined) {
      missing(`${ROW_PREFIX}imgDeliverStatus`);
    }
    if (number.text !== "") {
      rows.push({ index, barcode: number.text, sentence: sentence ?? "", icon: icon(iconControl) });
    }
  }
}

const PAGER_LIKE = /pager|_(?:btn|lnk)(?:next|more|loadmore|showmore)\w*$/i;

/** Whether the page offers a way to load more parcels than it shows. */
export function hasPager(page: Page): boolean {
  return page.ids.some((id) => id.startsWith(PREFIX) && PAGER_LIKE.test(id));
}

/** The selected parcel's detail panel, or null when the page has none. */
export function readDetail(page: Page, missing: MissingReporter): Detail | null {
  const barcode = page.value(`${PREFIX}hidParcelNo`);
  if (barcode === undefined) {
    missing(`${PREFIX}hidParcelNo`);
    return null;
  }
  const slots = SLOTS.map((slot): Slot => {
    const text = page.text(`${PREFIX}labStatus${slot}`);
    const date = page.text(`${PREFIX}labStatus${slot}Date`);
    if (text === undefined || date === undefined) {
      missing(`${PREFIX}labStatus${slot}`);
    }
    return { slot, text: text ?? "", date: date ?? "" };
  });
  return {
    barcode,
    slots,
    icon: icon(page.control(`${PREFIX}imgParcelStatus`)),
    weightText: page.value(`${PREFIX}hidWeight`) ?? "",
    flowType: page.value(`${PREFIX}hidParcelFlowTypeID`) ?? "",
  };
}

export { Page };
