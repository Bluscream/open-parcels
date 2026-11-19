/** Small shared building blocks: buttons, fields, notices, dialogs. */
import { useEffect, useId, useRef, type ReactNode } from "react";
import { ApiError } from "../api/fetcher";

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) {
    return error.message;
  }
  return "Something went wrong.";
}

export function ErrorNotice({ error }: { readonly error: unknown }): ReactNode {
  if (error === null || error === undefined) {
    return null;
  }
  return (
    <p role="alert" className="notice notice-error">
      {errorMessage(error)}
    </p>
  );
}

export function Field(props: {
  readonly label: string;
  readonly hint?: string;
  readonly children: (id: string, describedBy: string | undefined) => ReactNode;
}): ReactNode {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="field">
      <label htmlFor={id}>{props.label}</label>
      {props.children(id, props.hint === undefined ? undefined : hintId)}
      {props.hint === undefined ? null : (
        <small id={hintId} className="hint">
          {props.hint}
        </small>
      )}
    </div>
  );
}

export function Spinner({ label = "Loading…" }: { readonly label?: string }): ReactNode {
  return (
    <p className="muted" role="status">
      {label}
    </p>
  );
}

/** A native modal dialog: focus trapping, Escape and the backdrop come from the browser. */
export function Dialog(props: {
  readonly title: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly wide?: boolean;
}): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) {
      return;
    }
    if (props.open && !dialog.open) {
      // jsdom has no showModal; fall back to the open attribute there.
      if (typeof dialog.showModal === "function") {
        dialog.showModal();
      } else {
        dialog.setAttribute("open", "");
      }
    } else if (!props.open && dialog.open) {
      dialog.close();
    }
  }, [props.open]);
  // Focus goes back to whatever opened the dialog once it closes.
  useEffect(() => {
    if (!props.open) {
      return undefined;
    }
    const opener = document.activeElement;
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus();
      }
    };
  }, [props.open]);
  if (!props.open) {
    return null;
  }
  return (
    <dialog
      ref={ref}
      className={props.wide === true ? "dialog dialog-wide" : "dialog"}
      aria-labelledby={titleId}
      // Escape fires `cancel` and then `close`; only `cancel` is handled, so onClose runs once.
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
    >
      <header className="dialog-header">
        <h2 id={titleId}>{props.title}</h2>
        <button type="button" className="icon-button" aria-label="Close" onClick={props.onClose}>
          ×
        </button>
      </header>
      {props.children}
    </dialog>
  );
}
