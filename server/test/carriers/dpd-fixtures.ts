/*
 * Made-up myDPD pages and tracking responses. Every number, name and date here is invented; the
 * pages keep only the element ids and structure the plug-in reads.
 */

export const BARCODE_IN = "01234567890123";
export const BARCODE_IN2 = "01234567890124";
export const BARCODE_OUT = "09876543210987";

const formState = `
  <input type="hidden" name="__VIEWSTATE" value="vs-1" />
  <input type="hidden" name="__EVENTVALIDATION" value="ev-1" />`;

export const PORTAL_DASHBOARD = `<html><body><form>${formState}
  <a id="cphBody_ctl00_btnHomeMyParcel">Meine Pakete</a></form></body></html>`;

export const LOGIN_PAGE_PRISTINE = `<html><form class="german-sso-login-form">
  <input name="dpg_username" value="" /><input type="password" name="dpg_password" />
  <style>.dgs-form-has-captcha {}</style></form></html>`;

export const LOGIN_PAGE_REJECTED = `<html><form class="german-sso-login-form">
  <input name="dpg_username" value="nobody@example.invalid" />
  <div class="dgs-inline-message">Benutzername oder Passwort falsch</div></form></html>`;

export const LOGIN_PAGE_CAPTCHA = `<html><form class="german-sso-login-form dgs-form-has-captcha">
  <input name="dpg_username" value="" /><div data-sitekey="made-up-key"></div></form></html>`;

export interface FakeRow {
  readonly barcode: string;
  readonly sentence: string;
  readonly icon?: number;
}

function rows(list: readonly FakeRow[]): string {
  return list
    .map(
      (row, index) => `
  <span id="ContentPlaceHolder1_repParcelList_labParcelNo_${index}">${row.barcode}</span>
  <span id="ContentPlaceHolder1_repParcelList_labDeliveryStatus_${index}">${row.sentence}</span>
  <img id="ContentPlaceHolder1_repParcelList_imgDeliverStatus_${index}" src="images/status_${row.icon ?? 2}.svg" />`,
    )
    .join("");
}

export interface FakeDetail {
  readonly barcode: string;
  /** Text and `DD.MM.` day per milestone, in slot order; missing entries are unreached. */
  readonly slots: readonly (readonly [string, string])[];
  readonly weight?: string;
}

const SLOT_NAMES = ["Start", "OnTheRoad", "DeliveryDepot", "CarLoad", "Delivered"];

function detail(panel: FakeDetail | undefined): string {
  if (panel === undefined) {
    return "";
  }
  const slots = SLOT_NAMES.map((name, index) => {
    const [text, day] = panel.slots[index] ?? ["-", "-"];
    return `<span id="ContentPlaceHolder1_labStatus${name}">${text}</span>
      <span id="ContentPlaceHolder1_labStatus${name}Date">${day}</span>`;
  }).join("");
  return `<input type="hidden" id="ContentPlaceHolder1_hidParcelNo" value="${panel.barcode}" />
    <input type="hidden" id="ContentPlaceHolder1_hidZipCode" value="00000" />
    <input type="hidden" id="ContentPlaceHolder1_hidWeight" value="${panel.weight ?? ""}" />
    <input type="hidden" id="ContentPlaceHolder1_hidParcelFlowTypeID" value="0" />
    ${slots}`;
}

export function inboxPage(options: {
  rows: readonly FakeRow[];
  counters?: { sending?: number; returning?: number };
  detail?: FakeDetail;
  signedIn?: boolean;
}): string {
  const counters = options.counters ?? {};
  return `<html><head><title>myDPD</title></head><body><form>${formState}
  ${options.signedIn === false ? "" : '<a id="modBurgerNavi_btnLogout">Abmelden</a>'}
  <span id="ContentPlaceHolder1_counterGetIncomingParcel">${options.rows.length}</span>
  <span id="ContentPlaceHolder1_counterGetSendingParcel">${counters.sending ?? 0}</span>
  <span id="ContentPlaceHolder1_counterGetReturningParcel">${counters.returning ?? 0}</span>
  ${rows(options.rows)}
  ${detail(options.detail)}
  </form></body></html>`;
}

/** A public tracking response in the shape of the page's JSON endpoint. */
export function lifeCycle(
  steps: readonly { status: string; reached: boolean; current?: boolean }[],
  scans: readonly { date: string; code?: string; text: string; location?: string }[],
): unknown {
  return {
    parcellifecycleResponse: {
      parcelLifeCycleData: {
        statusInfo: steps.map((step) => ({
          status: step.status,
          statusHasBeenReached: step.reached,
          isCurrentStatus: step.current ?? false,
          description: { content: ["made-up description"] },
        })),
        scanInfo: {
          scan: scans.map((scan) => ({
            date: scan.date,
            scanData: {
              location: scan.location ?? "Musterstadt (DE)",
              scanType: { code: scan.code ?? null },
            },
            scanDescription: { content: [scan.text] },
          })),
        },
      },
    },
  };
}
