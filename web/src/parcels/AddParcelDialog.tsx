import { useNavigate } from "@tanstack/react-router";
import { useState, type SyntheticEvent, type ReactNode } from "react";
import { useAddParcel, useCarriers } from "../api/queries";
import { Dialog, ErrorNotice, Field } from "../components/ui";

const AUTO = "";

export function AddParcelDialog(props: {
  readonly open: boolean;
  readonly onClose: () => void;
}): ReactNode {
  const carriers = useCarriers();
  const add = useAddParcel();
  const navigate = useNavigate();
  const [barcode, setBarcode] = useState("");
  const [carrier, setCarrier] = useState(AUTO);
  const [label, setLabel] = useState("");

  const close = (): void => {
    add.reset();
    props.onClose();
  };

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    add.mutate(
      {
        barcode: barcode.trim(),
        ...(carrier === AUTO ? {} : { carrier }),
        label: label.trim() === "" ? null : label.trim(),
      },
      {
        onSuccess: (parcel) => {
          setBarcode("");
          setLabel("");
          setCarrier(AUTO);
          props.onClose();
          void navigate({ to: "/parcels/$parcelId", params: { parcelId: parcel.id } });
        },
      },
    );
  };

  const trackable = (carriers.data ?? []).filter((c) => c.source_kinds.includes("tracking"));

  return (
    <Dialog title="Track a parcel" open={props.open} onClose={close}>
      <form onSubmit={submit} className="stack">
        <Field label="Tracking code">
          {(id) => (
            <input
              id={id}
              required
              minLength={4}
              maxLength={64}
              autoFocus
              className="mono"
              value={barcode}
              onChange={(e) => {
                setBarcode(e.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Carrier" hint="Leave on “Detect” to recognise the carrier from the code.">
          {(id, hint) => (
            <select
              id={id}
              aria-describedby={hint}
              value={carrier}
              onChange={(e) => {
                setCarrier(e.target.value);
              }}
            >
              <option value={AUTO}>Detect from the code</option>
              {trackable.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Label (optional)">
          {(id) => (
            <input
              id={id}
              maxLength={120}
              value={label}
              onChange={(e) => {
                setLabel(e.target.value);
              }}
            />
          )}
        </Field>
        <ErrorNotice error={add.error} />
        <div className="actions">
          <button type="button" className="button" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={add.isPending}>
            {add.isPending ? "Adding…" : "Track"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
