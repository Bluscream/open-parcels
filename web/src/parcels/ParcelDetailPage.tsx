import { Link } from "@tanstack/react-router";
import { ArrowLeft, Calendar, CheckCircle2, ExternalLink, MapPin, PackageOpen } from "lucide-react";
import { lazy, Suspense, type ReactNode } from "react";
import { useParcel, useUpdateParcel } from "../api/queries";
import type { ParcelDetail } from "../api/types";
import { CarrierLogo, useCarrierName } from "../components/CarrierLogo";
import { SplitContainer } from "../components/SplitContainer";
import { ErrorNotice, Spinner } from "../components/ui";
import {
  describeLookup,
  formatDateTime,
  formatRelative,
  formatWindow,
  SOURCE_KIND_LABELS,
  STATUS_LABELS,
} from "../lib/format";
import { ArchivedBadge, LookupBadge } from "./badges";
import { EditableStatus, EditableTitle, ParcelActions, useCanEdit } from "./InlineEdit";

const LocationMap = lazy(() => import("../map/LocationMap"));

function Facts({ parcel }: { readonly parcel: ParcelDetail }): ReactNode {
  const rows: [string, ReactNode][] = [
    ["Tracking code", <span className="mono">{parcel.barcode}</span>],
    ["Carrier says", parcel.raw_status ?? "—"],
    [
      "Carrier lookup",
      <>
        <LookupBadge state={parcel.lookup.state} />{" "}
        <span className="muted">{describeLookup(parcel.lookup)}</span>
      </>,
    ],
    ["Pickup point", parcel.pickup_point ?? (parcel.pickup ? "Yes" : "—")],
    ["Sender", parcel.sender ?? "—"],
    ["Direction", parcel.direction === "incoming" ? "Incoming" : "Outgoing"],
    ["Order", parcel.order === null ? "—" : `${parcel.order.shop} ${parcel.order.order_number}`],
    ["Last update", formatDateTime(parcel.updated_at)],
  ];
  return (
    <section className="detail-section" aria-labelledby="facts-title">
      <h2 id="facts-title">Details</h2>
      <dl className="facts">
        {rows.map(([term, value]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
        {parcel.url === null ? null : (
          <div>
            <dt>Carrier page</dt>
            <dd>
              <a href={parcel.url} target="_blank" rel="noreferrer noopener">
                Open on the carrier’s site <ExternalLink size={12} aria-hidden="true" />
              </a>
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}

function EtaCard({ parcel }: { readonly parcel: ParcelDetail }): ReactNode {
  const done = parcel.delivered;
  const when = done
    ? `${formatDateTime(parcel.delivered_at)} (${formatRelative(parcel.delivered_at)})`
    : parcel.planned_from === null && parcel.planned_to === null
      ? "Pending information"
      : `${formatWindow(parcel.planned_from, parcel.planned_to)} (${formatRelative(parcel.planned_from ?? parcel.planned_to)})`;
  return (
    <div className={done ? "eta-card done" : "eta-card"}>
      {done ? (
        <CheckCircle2 size={20} aria-hidden="true" />
      ) : (
        <Calendar size={20} aria-hidden="true" />
      )}
      <div>
        <div className="eta-label">{done ? "Delivery date" : "Estimated delivery"}</div>
        <div className="eta-value">{when}</div>
      </div>
    </div>
  );
}

function History({ parcel }: { readonly parcel: ParcelDetail }): ReactNode {
  const events = [...parcel.history].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return (
    <section className="detail-section" aria-labelledby="history-title">
      <h2 id="history-title">Tracking history</h2>
      {events.length === 0 ? (
        <div className="empty-state">
          <PackageOpen size={32} aria-hidden="true" />
          <p>No tracking updates yet.</p>
        </div>
      ) : (
        <ol className="timeline">
          {events.map((event, index) => (
            <li key={`${event.timestamp}-${index}`}>
              <div className="timeline-row">
                <div className="timeline-text">
                  {event.raw_status}
                  {event.status === null ? null : (
                    <span className="chip">{STATUS_LABELS[event.status]}</span>
                  )}
                </div>
                <time dateTime={event.timestamp}>{formatDateTime(event.timestamp)}</time>
              </div>
              {event.location === null ? null : (
                <div className="timeline-location">
                  <MapPin size={12} aria-hidden="true" />
                  {event.location}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Items({ parcel }: { readonly parcel: ParcelDetail }): ReactNode {
  return (
    <section className="detail-section" aria-labelledby="items-title">
      <h2 id="items-title">Items</h2>
      {parcel.items.length === 0 ? (
        <p className="muted">No items known.</p>
      ) : (
        <ul className="items">
          {parcel.items.map((item, index) => (
            <li key={`${item.title}-${index}`}>
              {item.image_url === null ? (
                <span className="item-thumb" aria-hidden="true" />
              ) : (
                <img src={item.image_url} alt="" width={48} height={48} loading="lazy" />
              )}
              <span>
                {item.quantity !== null && item.quantity > 1 ? `${item.quantity} × ` : ""}
                {item.url === null ? (
                  item.title
                ) : (
                  <a href={item.url} target="_blank" rel="noreferrer noopener">
                    {item.title}
                  </a>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <h2>Sources</h2>
      {parcel.sources.length === 0 ? (
        <p className="muted">No source follows this parcel.</p>
      ) : (
        <ul>
          {parcel.sources.map((source) => (
            <li key={`${source.source_id}-${source.role}`}>
              {source.label}{" "}
              <span className="muted">
                ({SOURCE_KIND_LABELS[source.kind]}, {source.role})
              </span>
              , seen {formatRelative(source.last_seen_at)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Header({ parcel }: { readonly parcel: ParcelDetail }): ReactNode {
  const carrierName = useCarrierName(parcel.carrier);
  const update = useUpdateParcel(parcel.id);
  const canEdit = useCanEdit();
  const markedDelivered = parcel.manual_status === "delivered";
  return (
    <div className="detail-head">
      <CarrierLogo carrier={parcel.carrier} size={52} />
      <div className="detail-head-text">
        <div className="muted">{carrierName}</div>
        <EditableTitle parcel={parcel} />
      </div>
      <div className="detail-head-tags">
        {canEdit ? (
          <button
            type="button"
            className="button small"
            aria-pressed={markedDelivered}
            disabled={update.isPending}
            onClick={() => {
              update.mutate({ manual_status: markedDelivered ? null : "delivered" });
            }}
          >
            {markedDelivered ? "Mark not delivered" : "Mark delivered"}
          </button>
        ) : null}
        {parcel.archived_at === null ? null : <ArchivedBadge />}
        <EditableStatus parcel={parcel} />
      </div>
      <div className="detail-head-actions">
        <ParcelActions parcel={parcel} />
      </div>
    </div>
  );
}

function Overview({ parcel }: { readonly parcel: ParcelDetail }): ReactNode {
  return (
    <div className="glass-panel panel">
      <div className="panel-scroll">
        <Header parcel={parcel} />
        <EtaCard parcel={parcel} />
        <History parcel={parcel} />
        <Items parcel={parcel} />
        <Facts parcel={parcel} />
      </div>
    </div>
  );
}

export function ParcelDetailPage({ parcelId }: { readonly parcelId: string }): ReactNode {
  const query = useParcel(parcelId);
  const parcel = query.data;

  return (
    <section aria-labelledby="parcel-title" className="stack">
      <div className="detail-bar">
        <Link to="/" className="back-link">
          <ArrowLeft size={20} aria-hidden="true" /> All parcels
        </Link>
      </div>
      <ErrorNotice error={query.error} />
      {parcel === undefined ? (
        query.isPending ? (
          <Spinner />
        ) : null
      ) : (
        <div className="split-page with-bar">
          <SplitContainer
            leftPanel={<Overview parcel={parcel} />}
            rightPanel={
              <div className="glass-panel map-panel">
                <Suspense fallback={<Spinner label="Loading map…" />}>
                  <LocationMap parcel={parcel} />
                </Suspense>
              </div>
            }
          />
        </div>
      )}
    </section>
  );
}
