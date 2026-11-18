/**
 * Reads TIPSA's shipment page, failing closed. The page masks the recipient in one place and
 * shows the same data unmasked in another, so a mask is no privacy boundary: only the fields on
 * the allow-list below are read, and the recipient's name, address, contact and notes never are.
 */
import {
  cleanText,
  UnexpectedResponseError,
  walkHtml,
  zonedIso,
  type HtmlHandler,
} from "../../plugin/api.js";

/** Upper-case, accent-free, whitespace-collapsed form of a TIPSA wording, for table lookups. */
export function foldWording(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").trim().toUpperCase();
}

export const ZONE = "Europe/Madrid";

const SECTION_GENERAL = "DATOS GENERALES";
const SECTION_DELIVERY = "DATOS DE LA ENTREGA";
const READ_GENERAL: Readonly<Record<string, string>> = {
  remitente: "sender",
  "estado actual": "currentStatus",
  bultos: "pieces",
  kilos: "weightKg",
};
const READ_DELIVERY: Readonly<Record<string, string>> = {
  fecha: "deliveredDate",
  hora: "deliveredTime",
};
const IDENTITY_INPUTS = [
  "envio-localizado",
  "estado-localizado",
  "CodAgeCargo",
  "CodAgeOri",
  "Albaran",
];
const VALUE_CELL = /^mdl-cell--[3468]-col$/;
const HISTORY_HEADER = ["FECHA/HORA", "ESTADO", "POBLACION"];

export interface PageEvent {
  readonly at: string;
  readonly status: string | null;
  readonly location: string | null;
}

export interface TipsaPage {
  readonly status: string | null;
  readonly fields: Readonly<Record<string, string>>;
  /** Newest first. */
  readonly events: readonly PageEvent[];
}

interface Div {
  readonly classes: Set<string>;
  readonly parts: string[];
  hasChildDiv: boolean;
}

/** Collects the identity inputs, labelled leaf cells and the history table. */
class PageReader implements HtmlHandler {
  readonly inputs = new Map<string, string>();
  readonly fields: Record<string, string> = {};
  historyRows: string[][] | null = null;
  #section = "";
  #pending: string | null = null;
  readonly #divs: Div[] = [];
  #tableDepth = 0;
  #header: string[] = [];
  #rows: string[][] = [];
  #row: string[] | null = null;
  #cell: string[] | null = null;
  #cellIsHeader = false;
  readonly #tooltips: boolean[] = [];

  start(tag: string, attrs: Map<string, string>): void {
    const classes = (attrs.get("class") ?? "").split(/\s+/);
    if (tag === "input") {
      const id = attrs.get("id");
      if (id !== undefined && IDENTITY_INPUTS.includes(id) && !this.inputs.has(id)) {
        this.inputs.set(id, attrs.get("value") ?? "");
      }
    } else if (tag === "div") {
      const parent = this.#divs.at(-1);
      if (parent !== undefined) {
        parent.hasChildDiv = true;
      }
      this.#divs.push({ classes: new Set(classes), parts: [], hasChildDiv: false });
    } else if (tag === "table") {
      this.#tableDepth += 1;
      if (this.#tableDepth === 1) {
        this.#header = [];
        this.#rows = [];
      }
    } else if (tag === "tr" && this.#tableDepth > 0) {
      this.#row = [];
    } else if ((tag === "td" || tag === "th") && this.#row !== null) {
      this.#cell = [];
      this.#cellIsHeader = tag === "th";
      this.#tooltips.length = 0;
    } else if (tag === "span" && this.#cell !== null) {
      this.#tooltips.push(classes.includes("mdl-tooltip"));
    }
  }

  end(tag: string): void {
    if (tag === "span" && this.#tooltips.length > 0) {
      this.#tooltips.pop();
    } else if ((tag === "td" || tag === "th") && this.#cell !== null) {
      const value = cleanText(this.#cell.join(""));
      (this.#cellIsHeader ? this.#header : (this.#row ?? [])).push(value);
      this.#cell = null;
    } else if (tag === "tr" && this.#row !== null) {
      if (this.#row.length > 0) {
        this.#rows.push(this.#row);
      }
      this.#row = null;
    } else if (tag === "table" && this.#tableDepth > 0) {
      this.#tableDepth -= 1;
      const header = this.#header.map(foldWording);
      if (
        this.#tableDepth === 0 &&
        this.historyRows === null &&
        header.join("|") === HISTORY_HEADER.join("|")
      ) {
        this.historyRows = this.#rows;
      }
    } else if (tag === "div") {
      const div = this.#divs.pop();
      if (div !== undefined && !div.hasChildDiv) {
        this.#leaf(div.classes, cleanText(div.parts.join("")));
      }
    }
  }

  data(text: string): void {
    if (this.#cell !== null) {
      // Each history cell repeats its text in a tooltip; only the visible text counts.
      if (!this.#tooltips.includes(true)) {
        this.#cell.push(text);
      }
    } else if (this.#tableDepth === 0) {
      this.#divs.at(-1)?.parts.push(text);
    }
  }

  #leaf(classes: Set<string>, value: string): void {
    if (classes.has("panel-datos")) {
      this.#section = foldWording(value);
      this.#pending = null;
      return;
    }
    if (classes.has("color-accent")) {
      this.#pending = value.toLowerCase();
      return;
    }
    // A value belongs to the label right before it; any other leaf disarms that label, so a
    // forbidden value can never slide into an allowed key.
    const label = this.#pending;
    this.#pending = null;
    if (label === null || ![...classes].some((name) => VALUE_CELL.test(name))) {
      return;
    }
    const table =
      this.#section === SECTION_GENERAL
        ? READ_GENERAL
        : this.#section === SECTION_DELIVERY
          ? READ_DELIVERY
          : {};
    const key = table[label];
    if (key !== undefined && !(key in this.fields)) {
      this.fields[key] = value;
    }
  }
}

/** `dd/mm/yy HH:MM` (Madrid time) as an ISO instant. */
export function madridTime(day: string, time = "00:00"): string | null {
  const dayMatch = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(day);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time);
  if (dayMatch === null || timeMatch === null) {
    return null;
  }
  return zonedIso(
    {
      year: 2000 + Number(dayMatch[3]),
      month: Number(dayMatch[2]),
      day: Number(dayMatch[1]),
      hour: Number(timeMatch[1]),
      minute: Number(timeMatch[2]),
    },
    ZONE,
  );
}

function events(rows: readonly string[][]): PageEvent[] {
  const parsed = rows.map((row) => {
    const [when, status, location] = row;
    const [day, time] = (when ?? "").split(" ");
    const at = row.length === 3 ? madridTime(day ?? "", time ?? "") : null;
    if (at === null) {
      throw new UnexpectedResponseError("TIPSA history has a row of an unexpected shape.");
    }
    return {
      at,
      status: status === "" ? null : (status ?? null),
      location: location === "" ? null : (location ?? null),
    };
  });
  // The page lists newest first; a stable sort keeps its order for rows within the same minute.
  return parsed.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** Parses the shipment page; anything that is not the expected page for `barcode` fails. */
export function readPage(html: string, barcode: string): TipsaPage {
  const reader = new PageReader();
  walkHtml(html, reader);
  const input = (id: string): string => reader.inputs.get(id) ?? "";
  if (IDENTITY_INPUTS.some((id) => !reader.inputs.has(id)) || reader.historyRows === null) {
    throw new UnexpectedResponseError("TIPSA shipment page is missing expected elements.");
  }
  const rebuilt = `${input("CodAgeCargo")}${input("CodAgeOri")}${input("Albaran")}`;
  if (input("envio-localizado") !== barcode || rebuilt !== barcode) {
    throw new UnexpectedResponseError("TIPSA shipment page describes another shipment.");
  }
  const status = cleanText(input("estado-localizado"));
  return {
    status: status === "" ? null : status,
    fields: reader.fields,
    events: events(reader.historyRows),
  };
}
