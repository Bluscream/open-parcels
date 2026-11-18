import { z } from "zod";
import {
  CaptchaError,
  restoreJar,
  serializeJar,
  SignInRejectedError,
  TransientError,
  UnexpectedResponseError,
  type CookieJar,
  type FetchResult,
  type HttpResponse,
  type PluginContext,
} from "../../plugin/api.js";
import {
  hasCaptcha,
  hasPager,
  isPortalSignedIn,
  isSignedIn,
  listRows,
  loginRejected,
  Page,
  readDetail,
  tabCounter,
  TABS,
  type Detail,
  type Row,
  type Tab,
} from "./account-page.js";
import { accountSnapshot, type AccountParcel } from "./account-normalize.js";
import { formFields } from "./html.js";
import { todayIn } from "./time.js";

export const LOGIN_URL = "https://www.dpd.com/de/de/mydpd-anmelden-und-registrieren/?lng=DEU";
export const PORTAL_URL = "https://portal.dpd.de/home_pn.aspx";
export const INBOX_URL = "https://my.dpd.de/myParcel.aspx";

const HOP_TARGET = "ctl00$cphBody$ctl00$btnHomeMyParcel";
const TAB_TARGETS: Readonly<Record<Tab, string>> = {
  incoming: "ctl00$ContentPlaceHolder1$btnGetIncomingParcel",
  sending: "ctl00$ContentPlaceHolder1$btnGetSendingParcel",
  returning: "ctl00$ContentPlaceHolder1$btnGetReturningParcel",
};
const rowTarget = (index: number): string =>
  `ctl00$ContentPlaceHolder1$repParcelList$ctl${String(index).padStart(2, "0")}$btnSelectParcel`;

/**
 * A sign-in that succeeded but did not open the parcel list is held off this long, so a changed
 * page never turns into a sign-in on every poll.
 */
const UNOPENED_BACKOFF_MS = 60 * 60_000;

export interface Credentials {
  readonly username: string;
  readonly password: string;
}

const slotSchema = z.object({
  slot: z.enum(["Start", "OnTheRoad", "DeliveryDepot", "CarLoad", "Delivered"]),
  text: z.string(),
  date: z.string(),
});
const detailSchema = z.object({
  barcode: z.string(),
  slots: z.array(slotSchema).readonly(),
  icon: z.number().nullable(),
  weightText: z.string(),
  flowType: z.string(),
});
const sessionSchema = z.object({
  jar: z.unknown(),
  signInBlockedUntil: z.number().nullable(),
  /** Detail panels by `tab:barcode`, reused while the row's sentence and icon are unchanged. */
  details: z.record(z.string(), z.object({ fingerprint: z.string(), detail: detailSchema })),
});
type SessionState = z.infer<typeof sessionSchema>;

function loadState(saved: unknown): SessionState {
  const parsed = sessionSchema.safeParse(saved);
  return parsed.success ? parsed.data : { jar: null, signInBlockedUntil: null, details: {} };
}

function isAllowedHost(target: URL): boolean {
  const host = target.hostname;
  return (
    target.protocol === "https:" &&
    (host === "dpd.com" || host.endsWith(".dpd.com") || host.endsWith(".dpd.de"))
  );
}

const PAGE_HEADERS = {
  accept: "text/html,application/xhtml+xml,*/*;q=0.8",
  "accept-language": "de-DE,de;q=0.9",
};

type Context = PluginContext<unknown, Credentials | null>;

/** One poll of the myDPD account. Postbacks chain on the previous page and never overlap. */
class AccountRun {
  readonly #jar: CookieJar;
  readonly #state: SessionState;
  readonly #missing = new Set<string>();

  constructor(
    private readonly context: Context,
    private readonly credentials: Credentials,
  ) {
    this.#state = loadState(context.session.load());
    this.#jar = restoreJar(this.#state.jar);
  }

  async #page(url: string, init: { form?: URLSearchParams; referer?: string } = {}) {
    const response = await this.context.http.request(new URL(url), {
      ...(init.form === undefined ? {} : { method: "POST", body: init.form }),
      headers: {
        ...PAGE_HEADERS,
        ...(init.referer === undefined
          ? {}
          : { referer: init.referer, origin: new URL(init.referer).origin }),
      },
      jar: this.#jar,
      allowRedirect: isAllowedHost,
    });
    return checkPage(response);
  }

  async #postback(url: string, html: string, target: string): Promise<HttpResponse> {
    const fields = formFields(html);
    if (fields === null) {
      throw new UnexpectedResponseError("A myDPD page did not carry its form state.");
    }
    fields.set("__EVENTTARGET", target);
    fields.set("__EVENTARGUMENT", "");
    return this.#page(url, { form: new URLSearchParams([...fields]), referer: url });
  }

  /** Rungs 1 and 2: the parcel list from the stored cookies, or through the portal hop. */
  async #reuseSession(): Promise<string | null> {
    const inbox = await this.#page(INBOX_URL);
    if (isSignedIn(inbox.body)) {
      return inbox.body;
    }
    const portal = await this.#page(PORTAL_URL);
    if (!isPortalSignedIn(portal.url, portal.body)) {
      return null;
    }
    const hopped = await this.#postback(PORTAL_URL, portal.body, HOP_TARGET);
    return isSignedIn(hopped.body) ? hopped.body : null;
  }

  /** Rung 3: sign in, at most once per poll, and open the parcel list. */
  async #signInAndOpen(): Promise<string> {
    const now = this.context.clock.now().getTime();
    if (this.#state.signInBlockedUntil !== null && this.#state.signInBlockedUntil > now) {
      throw new TransientError("The last myDPD sign-in did not open the parcel list; waiting.");
    }
    const portal = await this.#signIn();
    const hopped = await this.#postback(PORTAL_URL, portal.body, HOP_TARGET);
    if (!isSignedIn(hopped.body)) {
      this.#state.signInBlockedUntil = now + UNOPENED_BACKOFF_MS;
      await this.#save();
      throw new UnexpectedResponseError("Signed in to myDPD, but the parcel list did not open.");
    }
    this.#state.signInBlockedUntil = null;
    return hopped.body;
  }

  async #signIn(): Promise<HttpResponse> {
    const response = await this.context.http.request(new URL(LOGIN_URL), {
      method: "POST",
      body: new URLSearchParams({
        dpg_username: this.credentials.username,
        dpg_password: this.credentials.password,
      }),
      headers: { ...PAGE_HEADERS, origin: "https://www.dpd.com", referer: LOGIN_URL },
      jar: this.#jar,
      redirect: "manual",
      allowRedirect: isAllowedHost,
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location !== null) {
      const target = new URL(location, LOGIN_URL);
      if (target.hostname !== "portal.dpd.de" || !target.search.includes("dpd_token=")) {
        throw new UnexpectedResponseError("myDPD sign-in redirected somewhere unexpected.");
      }
      return this.#page(target.toString());
    }
    if (response.status !== 200) {
      throw new TransientError(`myDPD sign-in answered HTTP ${response.status}.`);
    }
    if (hasCaptcha(response.body)) {
      throw new CaptchaError("myDPD asks for a captcha at sign-in; sign in once in a browser.");
    }
    if (loginRejected(response.body, this.credentials.username)) {
      throw new SignInRejectedError("myDPD rejected the username or password.");
    }
    throw new UnexpectedResponseError("myDPD sign-in returned an unexpected page.");
  }

  async #save(): Promise<void> {
    this.#state.jar = serializeJar(this.#jar);
    await this.context.session.save(this.#state);
  }

  #reportMissing = (controlId: string): void => {
    if (!this.#missing.has(controlId)) {
      this.#missing.add(controlId);
      this.context.reportUnknown("missing_control", controlId);
    }
  };

  async run(): Promise<FetchResult> {
    const html = (await this.#reuseSession()) ?? (await this.#signInAndOpen());
    await this.#save();
    const { parcels, complete } = await this.#readTabs(html);
    const seen = new Set(parcels.map((parcel) => `${parcel.tab}:${parcel.row.barcode}`));
    this.#state.details = Object.fromEntries(
      Object.entries(this.#state.details).filter(([key]) => seen.has(key)),
    );
    await this.#save();
    const today = todayIn(this.context.clock.now());
    const report = (kind: string, key: string): void => {
      this.context.reportUnknown(kind, key);
    };
    return {
      snapshots: parcels.map((parcel) => accountSnapshot(parcel, today, report)),
      complete,
    };
  }

  async #readTabs(first: string): Promise<{ parcels: AccountParcel[]; complete: boolean }> {
    const firstPage = new Page(first);
    const parcels: AccountParcel[] = [];
    let complete = true;
    let html = first;
    for (const tab of TABS) {
      if (tab !== "incoming") {
        // Zero means the tab is empty; an unreadable counter means "look anyway".
        if (tabCounter(firstPage, tab, this.#reportMissing) === 0) {
          continue;
        }
        html = await this.#requireSignedIn(this.#postback(INBOX_URL, html, TAB_TARGETS[tab]));
      }
      const page = new Page(html);
      if (hasPager(page)) {
        this.context.reportUnknown("pager", tab);
        complete = false;
      }
      for (const row of listRows(page, this.#reportMissing)) {
        const read = await this.#readRow(html, tab, row);
        html = read.html;
        parcels.push(read.parcel);
      }
    }
    return { parcels, complete };
  }

  async #requireSignedIn(pending: Promise<HttpResponse>): Promise<string> {
    const response = await pending;
    if (!isSignedIn(response.body)) {
      throw new UnexpectedResponseError("The myDPD session ended in the middle of a poll.");
    }
    return response.body;
  }

  /** Attaches a row's detail panel; returns the page the next postback chains from. */
  async #readRow(
    html: string,
    tab: Tab,
    row: Row,
  ): Promise<{ html: string; parcel: AccountParcel }> {
    const key = `${tab}:${row.barcode}`;
    const fingerprint = `${row.sentence}|${row.icon ?? ""}`;
    const cached = this.#state.details[key];
    const base = { tab, row, staleDetail: cached?.detail ?? null };
    if (cached?.fingerprint === fingerprint) {
      return { html, parcel: { ...base, detail: cached.detail } };
    }
    let fresh: string;
    try {
      fresh = await this.#requireSignedIn(this.#postback(INBOX_URL, html, rowTarget(row.index)));
    } catch (error) {
      if (!(error instanceof TransientError)) {
        throw error;
      }
      // A detail panel that does not open leaves the row as listed; the next poll tries again.
      this.context.logger.debug({ tab }, "A myDPD parcel detail was unavailable.");
      return { html, parcel: { ...base, detail: null } };
    }
    const detail: Detail | null = readDetail(new Page(fresh), this.#reportMissing);
    if (detail?.barcode !== row.barcode) {
      return { html: fresh, parcel: { ...base, detail: null } };
    }
    this.#state.details[key] = { fingerprint, detail };
    return { html: fresh, parcel: { ...base, detail } };
  }
}

const ERROR_TITLE = /<title>[^<]*runtime error/i;

/** Anything but a plain HTML page is a transient failure, never a reason to sign in. */
function checkPage(response: HttpResponse): HttpResponse {
  if (response.status !== 200) {
    throw new TransientError(`myDPD answered HTTP ${response.status}.`);
  }
  if (/\/error\.aspx|showerror/i.test(response.url) || ERROR_TITLE.test(response.body)) {
    throw new TransientError("myDPD showed its error page.");
  }
  if (!(response.headers.get("content-type") ?? "").includes("html")) {
    throw new UnexpectedResponseError("myDPD returned something other than a page.");
  }
  return response;
}

/** Reads the whole myDPD DE account: the incoming tab, and the sent and returned tabs. */
export async function fetchDeAccount(context: Context): Promise<FetchResult> {
  if (context.secret === null) {
    throw new SignInRejectedError("Enter the myDPD username and password for this source.");
  }
  return new AccountRun(context, context.secret).run();
}
