import { useState, type ReactNode } from "react";
import { useParcels } from "../api/queries";
import { ErrorNotice, Spinner } from "../components/ui";
import { AddParcelDialog } from "./AddParcelDialog";
import { ParcelTable } from "./ParcelTable";

export function ParcelsPage(): ReactNode {
  const [archived, setArchived] = useState(false);
  const [adding, setAdding] = useState(false);
  const parcels = useParcels(archived);

  return (
    <section aria-labelledby="parcels-title">
      <div className="page-header">
        <h1 id="parcels-title">Parcels</h1>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => {
              setArchived(e.target.checked);
            }}
          />
          Include archived
        </label>
        <button
          type="button"
          className="button primary"
          onClick={() => {
            setAdding(true);
          }}
        >
          Track a parcel
        </button>
      </div>
      <ErrorNotice error={parcels.error} />
      {parcels.data === undefined ? <Spinner /> : <ParcelTable parcels={parcels.data} />}
      <AddParcelDialog
        open={adding}
        onClose={() => {
          setAdding(false);
        }}
      />
    </section>
  );
}
