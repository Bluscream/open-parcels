import { useNavigate } from "@tanstack/react-router";
import { useState, type SyntheticEvent, type ReactNode } from "react";
import { useDeleteParcel, useUpdateParcel } from "../api/queries";
import { PARCEL_STATUSES, type ParcelDetail, type ParcelStatus } from "../api/types";
import { ErrorNotice, Field } from "../components/ui";
import { STATUS_LABELS } from "../lib/format";

const CARRIER_STATUS = "";

/** Label, manual status, archive and delete for one parcel. */
export function ParcelEditor({ parcel }: { readonly parcel: ParcelDetail }): ReactNode {
  const update = useUpdateParcel(parcel.id);
  const remove = useDeleteParcel();
  const navigate = useNavigate();
  const [label, setLabel] = useState(parcel.label ?? "");
  const [manual, setManual] = useState<ParcelStatus | "">(parcel.manual_status ?? CARRIER_STATUS);

  const save = (event: SyntheticEvent): void => {
    event.preventDefault();
    update.mutate({
      label: label.trim() === "" ? null : label.trim(),
      manual_status: manual === CARRIER_STATUS ? null : manual,
    });
  };

  const archive = (): void => {
    update.mutate({ archived: true });
  };

  const destroy = (): void => {
    if (!window.confirm("Stop tracking and delete this parcel? This cannot be undone.")) {
      return;
    }
    remove.mutate(parcel.id, {
      onSuccess: () => {
        void navigate({ to: "/" });
      },
    });
  };

  return (
    <section className="card" aria-labelledby="edit-title">
      <h2 id="edit-title">Edit</h2>
      <form onSubmit={save} className="stack">
        <Field label="Label">
          {(id) => (
            <input
              id={id}
              maxLength={120}
              value={label}
              placeholder={parcel.barcode}
              onChange={(e) => {
                setLabel(e.target.value);
              }}
            />
          )}
        </Field>
        <Field
          label="Status"
          hint="A status set by hand is kept; carrier updates no longer change it."
        >
          {(id, hint) => (
            <select
              id={id}
              aria-describedby={hint}
              value={manual}
              onChange={(e) => {
                setManual(e.target.value as ParcelStatus | "");
              }}
            >
              <option value={CARRIER_STATUS}>From the carrier</option>
              {PARCEL_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <ErrorNotice error={update.error ?? remove.error} />
        {update.isSuccess ? (
          <p className="notice" role="status">
            Saved.
          </p>
        ) : null}
        <div className="actions">
          <button type="button" className="button" onClick={archive} disabled={update.isPending}>
            Archive
          </button>
          <button type="button" className="button danger" onClick={destroy}>
            Delete
          </button>
          <button type="submit" className="button primary" disabled={update.isPending}>
            Save
          </button>
        </div>
      </form>
    </section>
  );
}
