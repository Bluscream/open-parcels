import { UnexpectedResponseError } from "../../plugin/api.js";
import { asObject, type Json } from "./shared.js";

const MARKER = "window.__remixContext = ";

/** Returns the end index (exclusive) of the JSON object that starts at `start`, or -1. */
function objectEnd(body: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let index = start; index < body.length; index += 1) {
    const char = body[index];
    if (inString) {
      if (char === "\\") {
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return -1;
}

/**
 * The tracking page is server-rendered; the order sits in the route data embedded as a script.
 * Returns null when the page says the order is unknown; anything else unreadable throws.
 */
export function readOrder(body: string): Json | null {
  const position = body.indexOf(MARKER);
  if (position < 0) {
    if (body.includes("Order not found") || body.includes("Incorrect order number")) {
      return null;
    }
    throw new UnexpectedResponseError("Paack tracking page has no route data.");
  }
  const start = body.indexOf("{", position + MARKER.length);
  const end = start < 0 ? -1 : objectEnd(body, start);
  if (end < 0) {
    throw new UnexpectedResponseError("Paack route data is cut off.");
  }
  let context: unknown;
  try {
    context = JSON.parse(body.slice(start, end));
  } catch {
    throw new UnexpectedResponseError("Paack route data is not JSON.");
  }
  const loaderData = asObject(asObject(asObject(context)["state"])["loaderData"]);
  const order: unknown = loaderData["routes/tracking.order"];
  if (typeof order !== "object" || order === null || Array.isArray(order)) {
    throw new UnexpectedResponseError("Paack route data has no order.");
  }
  const track: unknown = (order as Json)["orderTrackData"];
  return typeof track === "object" && track !== null ? (order as Json) : null;
}
