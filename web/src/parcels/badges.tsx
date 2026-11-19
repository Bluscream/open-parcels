import type { ReactNode } from "react";
import type { LookupState, ParcelStatus, SourceState } from "../api/types";
import { LOOKUP_LABELS, SOURCE_STATE_LABELS, STATUS_LABELS } from "../lib/format";

export function StatusBadge(props: {
  readonly status: ParcelStatus;
  readonly manual?: boolean;
}): ReactNode {
  return (
    <span className={`badge status-${props.status}`}>
      {STATUS_LABELS[props.status]}
      {props.manual === true ? <span title="Set by hand"> ✎</span> : null}
    </span>
  );
}

/** Archived parcels are kept but hidden from the default list. */
export function ArchivedBadge(): ReactNode {
  return <span className="badge archived">Archived</span>;
}

export function LookupBadge({ state }: { readonly state: LookupState }): ReactNode {
  return <span className={`badge lookup-${state}`}>{LOOKUP_LABELS[state]}</span>;
}

export function SourceStateBadge({ state }: { readonly state: SourceState }): ReactNode {
  return <span className={`badge source-${state}`}>{SOURCE_STATE_LABELS[state]}</span>;
}
