import { useEffect, useState } from "react";

/**
 * The page side of the companion extension protocol (docs/extension-protocol.md, v1): the
 * extension opens a carrier's sign-in in its own window and hands back the final address, which
 * the page then submits like a pasted one. The server still checks it belongs to the sign-in.
 */

export const EXTENSION_URL = "https://github.com/open-parcels/open-parcels-extension";

const PAGE = "open-parcels-page";
const EXTENSION = "open-parcels-extension";
const HELLO_TIMEOUT_MS = 500;

interface ExtensionMessage {
  readonly source: typeof EXTENSION;
  readonly type: "hello" | "captured" | "cancelled";
  readonly requestId?: string;
  readonly url?: string;
  readonly reason?: string;
  readonly version?: string;
}

function isExtensionMessage(event: MessageEvent): event is MessageEvent<ExtensionMessage> {
  const data: unknown = event.data;
  return (
    event.source === window &&
    event.origin === window.location.origin &&
    typeof data === "object" &&
    data !== null &&
    (data as { source?: unknown }).source === EXTENSION
  );
}

function post(message: Record<string, unknown>): void {
  window.postMessage({ source: PAGE, ...message }, window.location.origin);
}

/** The installed extension's version, or null when none answers (checked once per mount). */
export function useCompanionExtension(): {
  readonly checked: boolean;
  readonly version: string | null;
} {
  const [state, setState] = useState<{ checked: boolean; version: string | null }>({
    checked: false,
    version: null,
  });
  useEffect(() => {
    const listener = (event: MessageEvent): void => {
      if (isExtensionMessage(event) && event.data.type === "hello") {
        setState({ checked: true, version: event.data.version ?? "unknown" });
      }
    };
    window.addEventListener("message", listener);
    post({ type: "hello" });
    const timer = window.setTimeout(() => {
      setState((current) => (current.checked ? current : { checked: true, version: null }));
    }, HELLO_TIMEOUT_MS);
    return () => {
      window.removeEventListener("message", listener);
      window.clearTimeout(timer);
    };
  }, []);
  return state;
}

export type CaptureOutcome =
  | { readonly status: "captured"; readonly url: string }
  | { readonly status: "cancelled"; readonly reason: string };

/** Asks the extension to run one sign-in; `cancel` withdraws the request. */
export function captureSignIn(request: {
  readonly url: string;
  readonly redirectPrefix: string;
  readonly resumeUrl: string | null;
}): { readonly result: Promise<CaptureOutcome>; readonly cancel: () => void } {
  const requestId = crypto.randomUUID();
  let listener: ((event: MessageEvent) => void) | null = null;
  const result = new Promise<CaptureOutcome>((resolve) => {
    listener = (event: MessageEvent): void => {
      if (!isExtensionMessage(event) || event.data.requestId !== requestId) return;
      if (event.data.type === "captured" && typeof event.data.url === "string") {
        resolve({ status: "captured", url: event.data.url });
      } else if (event.data.type === "cancelled") {
        resolve({ status: "cancelled", reason: event.data.reason ?? "closed" });
      }
    };
    window.addEventListener("message", listener);
  }).finally(() => {
    if (listener !== null) window.removeEventListener("message", listener);
  });
  post({ type: "capture", requestId, ...request });
  return {
    result,
    cancel: () => {
      post({ type: "cancel", requestId });
    },
  };
}
