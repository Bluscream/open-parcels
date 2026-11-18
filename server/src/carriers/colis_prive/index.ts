import { z } from "zod";
import {
  carrierPattern,
  defineCarrier,
  rulesStatus,
  snapshot,
  trackEach,
  TransientError,
  unknownReporter,
  zonedIso,
  type ParcelSnapshot,
  type ParcelStatus,
  type PluginContext,
  type PluginHttp,
  type SnapshotEvent,
} from "../../plugin/api.js";
import { parseResultPage, type ResultPage, type Row } from "./page.js";

const CARRIER_ID = "colis_prive";
const HOST = "colisprive.com";
const PAGE_URL = `https://${HOST}/moncolis/pages/detailColis.aspx`;
const ZONE = "Europe/Paris";
const PLAUSIBLE = carrierPattern("colis_prive");
type Lang = "fr" | "nl" | "en";

function fold(text: string): string {
  return text.replace(/[‘’ʼ]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The status and its stage rank (higher is later), or null. The shared table holds one sentence
 * set per page language and only matches a sentence against the language it was requested in.
 */
function match(text: string, lang: Lang): { status: ParcelStatus; rank: number } | null {
  const hit = rulesStatus(CARRIER_ID, { text: fold(text), fields: { lang } });
  return hit === null ? null : { status: hit.status, rank: hit.stage ?? 0 };
}

function rowTime(row: Row): string | null {
  const [day, month, year] = row.date.split("/").map(Number);
  return zonedIso({ year: year ?? 0, month: month ?? 0, day: day ?? 0 }, ZONE);
}

/** Dates carry no time and same-day rows are not in order, so events sort by day, then stage. */
function history(rows: readonly Row[], lang: Lang): SnapshotEvent[] {
  let previousRank = 0;
  const ranked = [...rows].reverse().flatMap((row) => {
    const at = rowTime(row);
    const hit = match(row.text, lang);
    previousRank = hit?.rank ?? previousRank;
    return at === null
      ? []
      : [{ at, rank: previousRank, status: hit?.status ?? null, text: row.text }];
  });
  ranked.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.rank - a.rank);
  return ranked.map((e) => ({ at: e.at, status: e.status, rawStatus: e.text, location: null }));
}

/** The newest day on which a row reached `status`. */
function stageDay(rows: readonly Row[], lang: Lang, status: ParcelStatus): string | null {
  const days = rows
    .filter((row) => match(row.text, lang)?.status === status)
    .map(rowTime)
    .filter((at) => at !== null);
  return days.sort().at(-1) ?? null;
}

export function toSnapshot(
  page: ResultPage,
  code: string,
  postal: string,
  lang: Lang,
  report: (c: string) => void,
): ParcelSnapshot {
  let status = match(page.statusText, lang)?.status ?? null;
  if (status === null) {
    report(`${lang}:${fold(page.statusText).slice(0, 80)}`);
    // The furthest stage the history reached; page order is not reliable within a day.
    const hits = page.rows.map((row) => match(row.text, lang)).filter((hit) => hit !== null);
    status = hits.sort((a, b) => b.rank - a.rank)[0]?.status ?? null;
  }
  const delivered = status === "delivered";
  const outDay = status === "out_for_delivery" ? stageDay(page.rows, lang, status) : null;
  return snapshot({
    carrier: CARRIER_ID,
    barcode: code,
    status,
    rawStatus: page.statusText,
    delivered,
    deliveredAt: delivered ? stageDay(page.rows, lang, "delivered") : null,
    plannedFrom: outDay,
    plannedTo: outDay === null ? null : new Date(Date.parse(outDay) + 86_399_000).toISOString(),
    url: `${PAGE_URL}?numColis=${encodeURIComponent(code + postal)}&lang=${lang}`,
    sender: page.sender,
    history: history(page.rows, lang),
    // Only what was read; never the page or the recipient block.
    raw: { ...page, lang },
  });
}

async function lookUp(
  http: PluginHttp,
  code: string,
  postal: string,
  lang: Lang,
): Promise<ResultPage | null> {
  const url = new URL(PAGE_URL);
  url.searchParams.set("numColis", `${code}${postal}`);
  url.searchParams.set("lang", lang);
  // Redirects stay off: a miss is a redirect to the start page.
  const response = await http.request(url, {
    headers: { accept: "text/html" },
    redirect: "manual",
  });
  if (response.status >= 300 && response.status < 400) {
    if ((response.headers.get("location") ?? "").toLowerCase().includes("default.aspx")) {
      return null;
    }
    throw new TransientError(`Colis Privé redirected unexpectedly (HTTP ${response.status}).`);
  }
  if (response.status !== 200) {
    throw new TransientError(`Colis Privé answered HTTP ${response.status}.`);
  }
  return parseResultPage(response.body);
}

const configSchema = z.looseObject({
  /** The recipient's postal code; the page only answers for code plus postal code. */
  postalCode: z.string().regex(/^[A-Z0-9 -]{3,10}$/i),
  language: z.enum(["fr", "nl", "en"]).optional(),
});
type Config = z.infer<typeof configSchema>;
const secretSchema = z.null();
type Secret = z.infer<typeof secretSchema>;

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const postal = context.config.postalCode.replace(/[\s-]/g, "");
  const lang = context.config.language ?? "fr";
  const report = unknownReporter(context, "status_code", { once: false });
  return trackEach(barcodes, PLAUSIBLE, async (code) => {
    const page = await lookUp(context.http, code, postal, lang);
    return page === null ? null : toSnapshot(page, code, postal, lang, report);
  });
}

export const colisPrive = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "Colis Privé",
  countries: ["FR", "BE", "NL"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: { [HOST]: { intervalMs: 6_000, burst: 2 }, "*": { intervalMs: 10_000, burst: 1 } },
  },
  track,
});
