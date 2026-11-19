import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Archive, ArchiveRestore, Check, Pencil, Trash2, X } from "lucide-react";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { keys, useDeleteParcel, useUpdateParcel } from "../api/queries";
import { PARCEL_STATUSES, type ParcelDetail, type ParcelStatus } from "../api/types";
import { useSession } from "../auth/session";
import { ErrorNotice } from "../components/ui";
import { STATUS_LABELS } from "../lib/format";
import { StatusBadge } from "./badges";

/** Editing needs the write scope; read-only sessions just see the values. */
export function useCanEdit(): boolean {
  const session = useSession();
  return session.data?.scopes.includes("write") === true;
}

function PencilButton(props: { readonly label: string; readonly onClick: () => void }): ReactNode {
  return (
    <button
      type="button"
      className="icon-button pencil"
      aria-label={props.label}
      onClick={props.onClick}
    >
      <Pencil size={15} aria-hidden="true" />
    </button>
  );
}

interface InlineTitleProps {
  /** The page heading's id, for `aria-labelledby`. */
  readonly titleId: string;
  /** What the heading shows. */
  readonly shown: string;
  /** The own label, null when there is none. */
  readonly label: string | null;
  /** Shown in the empty field: the name used without a label. */
  readonly placeholder: string;
  readonly error: unknown;
  /** Called with the new label (null clears it) when it changed. */
  readonly onSave: (label: string | null) => void;
}

/** A page heading renamed in place: Enter or leaving saves, Escape cancels. */
export function InlineTitle(props: InlineTitleProps): ReactNode {
  const canEdit = useCanEdit();
  const [draft, setDraft] = useState<string | null>(null);

  const finish = (save: boolean): void => {
    if (draft === null) return;
    const next = draft.trim() === "" ? null : draft.trim();
    setDraft(null);
    if (save && next !== props.label) props.onSave(next);
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") finish(true);
    if (event.key === "Escape") finish(false);
  };

  if (draft !== null) {
    return (
      <div className="inline-edit">
        <input
          className="inline-title-input"
          aria-label="Label"
          autoFocus
          maxLength={120}
          value={draft}
          placeholder={props.placeholder}
          onChange={(e) => {
            setDraft(e.target.value);
          }}
          onKeyDown={onKey}
          onBlur={() => {
            finish(true);
          }}
        />
        <button
          type="button"
          className="icon-button"
          aria-label="Save label"
          // Before the input's blur, so the click is not lost.
          onMouseDown={(e) => {
            e.preventDefault();
            finish(true);
          }}
        >
          <Check size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Cancel"
          onMouseDown={(e) => {
            e.preventDefault();
            finish(false);
          }}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    );
  }
  return (
    <div className="inline-edit">
      <h1 id={props.titleId}>{props.shown}</h1>
      {canEdit ? (
        <PencilButton
          label="Rename"
          onClick={() => {
            setDraft(props.label ?? "");
          }}
        />
      ) : null}
      <ErrorNotice error={props.error} />
    </div>
  );
}

/** The parcel's name (label, else the tracking code), renamed in place. */
export function EditableTitle({ parcel }: { readonly parcel: ParcelDetail }): ReactNode {
  const update = useUpdateParcel(parcel.id);
  return (
    <InlineTitle
      titleId="parcel-title"
      shown={parcel.display_name}
      label={parcel.label}
      placeholder={parcel.barcode}
      error={update.error}
      onSave={(label) => {
        update.mutate({ label });
      }}
    />
  );
}

const FROM_CARRIER = "";

/** The status badge; the pencil opens a picker that saves the choice at once. */
export function EditableStatus({ parcel }: { readonly parcel: ParcelDetail }): ReactNode {
  const canEdit = useCanEdit();
  const update = useUpdateParcel(parcel.id);
  const [open, setOpen] = useState(false);

  if (open) {
    return (
      <select
        className="inline-status-select"
        aria-label="Status"
        autoFocus
        value={parcel.manual_status ?? FROM_CARRIER}
        onChange={(e) => {
          const value = e.target.value as ParcelStatus | typeof FROM_CARRIER;
          setOpen(false);
          update.mutate({ manual_status: value === FROM_CARRIER ? null : value });
        }}
        // Closing on blur waits a moment, so a choice that blurs the picker still saves.
        onBlur={() => {
          window.setTimeout(() => {
            setOpen(false);
          }, 200);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
      >
        <option value={FROM_CARRIER}>
          From the carrier ({STATUS_LABELS[parcel.carrier_status]})
        </option>
        {PARCEL_STATUSES.map((status) => (
          <option key={status} value={status}>
            {STATUS_LABELS[status]}
          </option>
        ))}
      </select>
    );
  }
  return (
    <span className="inline-edit">
      <StatusBadge status={parcel.status} manual={parcel.manual_status !== null} />
      {canEdit ? (
        <PencilButton
          label="Change status"
          onClick={() => {
            setOpen(true);
          }}
        />
      ) : null}
      <ErrorNotice error={update.error} />
    </span>
  );
}

/** Archive or restore, and delete, as small buttons in the header. */
export function ParcelActions({ parcel }: { readonly parcel: ParcelDetail }): ReactNode {
  const canEdit = useCanEdit();
  const update = useUpdateParcel(parcel.id);
  const remove = useDeleteParcel();
  const client = useQueryClient();
  const navigate = useNavigate();
  if (!canEdit) return null;
  const archived = parcel.archived_at !== null;
  return (
    <>
      <button
        type="button"
        className="button small"
        aria-pressed={archived}
        disabled={update.isPending}
        title={archived ? "Show it in the list again" : "Hide it from the list"}
        onClick={() => {
          update.mutate({ archived: !archived });
        }}
      >
        {archived ? (
          <ArchiveRestore size={14} aria-hidden="true" />
        ) : (
          <Archive size={14} aria-hidden="true" />
        )}{" "}
        {archived ? "Unarchive" : "Archive"}
      </button>
      <button
        type="button"
        className="button small danger"
        onClick={() => {
          if (!window.confirm("Stop tracking and delete this parcel? This cannot be undone.")) {
            return;
          }
          remove.mutate(parcel.id, {
            onSuccess: () => {
              void navigate({ to: "/" }).then(() => {
                // Off its page now, so the deleted parcel's cached detail can go.
                client.removeQueries({ queryKey: keys.parcel(parcel.id), exact: true });
              });
            },
          });
        }}
      >
        <Trash2 size={14} aria-hidden="true" /> Delete
      </button>
      {update.isSuccess && update.variables.archived !== undefined ? (
        <p className="notice" role="status">
          {update.variables.archived
            ? "Archived. It is hidden from the list unless “Include archived” is on."
            : "Restored from the archive."}
        </p>
      ) : null}
      <ErrorNotice error={update.error ?? remove.error} />
    </>
  );
}
