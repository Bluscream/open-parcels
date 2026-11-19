import { Package, Plus } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useParcels } from "../api/queries";
import { ErrorNotice, Spinner } from "../components/ui";
import { AddParcelDialog } from "./AddParcelDialog";
import { ParcelTable, type ParcelFilter } from "./ParcelTable";

export function ParcelsPage(): ReactNode {
  const [archived, setArchived] = useState(false);
  const [filter, setFilter] = useState<ParcelFilter>("active");
  const [adding, setAdding] = useState(false);
  const parcels = useParcels(archived);

  return (
    <section aria-labelledby="parcels-title" className="stack">
      <div className="page-header glass-panel">
        <div className="page-title-row">
          <Package size={22} className="page-icon" aria-hidden="true" />
          <h1 id="parcels-title">Parcels</h1>
          {parcels.data === undefined ? null : (
            <span className="page-count">{parcels.data.length}</span>
          )}
        </div>
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
          <Plus size={16} aria-hidden="true" />
          Track a parcel
        </button>
      </div>
      <ErrorNotice error={parcels.error} />
      {parcels.data === undefined ? (
        <Spinner />
      ) : (
        <ParcelTable parcels={parcels.data} filter={filter} onFilterChange={setFilter} />
      )}
      <AddParcelDialog
        open={adding}
        onClose={() => {
          setAdding(false);
        }}
      />
    </section>
  );
}
