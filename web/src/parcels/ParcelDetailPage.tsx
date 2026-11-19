import { Link } from "@tanstack/react-router";
import { lazy, Suspense, type ReactNode } from "react";
import { useParcel } from "../api/queries";
import type { ParcelDetail } from "../api/types";
import { ErrorNotice, Spinner } from "../components/ui";
import { formatDateTime, formatRelative, formatWindow, STATUS_LABELS } from "../lib/format";
import { LookupBadge, StatusBadge } from "./badges";
import { ParcelEditor } from "./ParcelEditor";

const LocationMap = lazy(() => import("../map/LocationMap"));

function Facts({ parcel }: { readonly parcel: ParcelDetail }): ReactNode {
  const rows: [string, ReactNode][] = [
    ["Carrier", parcel.carrier],
    ["Tracking code", <span className="mono">{parcel.barcode}</span>],
    ["Status", <StatusBadge status={parcel.status} manual={parcel.manual_status !== null} />],
    ["Carrier says", parcel.raw_status ?? "—"],
    [
      "Carrier lookup",
      <>
        <LookupBadge state={parcel.lookup.state} />{" "}
        <span className="muted">
          since {formatRelative(parcel.lookup.since)}, asked{" "}
          {formatRelative(parcel.lookup.checked_at)}
        </span>
      </>,
    ],
    ["Expected", formatWindow(parcel.planned_from, parcel.planned_to)],
    ["Delivered", parcel.delivered ? formatDateTime(parcel.delivered_at) : "Not yet"],
    ["Pickup point", parcel.pickup_point ?? (parcel.pickup ? "Yes" : "—")],
    ["Sender", parcel.sender ?? "—"],
    ["Direction", parcel.direction === "incoming" ? "Incoming" : "Outgoing"],
    ["Order", parcel.order === null ? "—" : `${parcel.order.shop} ${parcel.order.order_number}`],
    ["Last update", formatDateTime(parcel.updated_at)],
  ];
  return (
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
              Open on the carrier’s site
            </a>
          </dd>
        </div>
      )}
    </dl>
  );
}

function History({ parcel }: { readonly parcel: ParcelDetail }): ReactNode {
  const events = [...parcel.history].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return (
    <section className="card" aria-labelledby="history-title">
      <h2 id="history-title">History</h2>
      {events.length === 0 ? (
        <p className="muted">No events yet.</p>
      ) : (
        <ol className="timeline">
          {events.map((event, index) => (
            <li key={`${event.timestamp}-${index}`}>
              <time dateTime={event.timestamp}>{formatDateTime(event.timestamp)}</time>
              <div>
                <strong>{event.raw_status}</strong>
                {event.status === null ? null : (
                  <span className="muted"> · {STATUS_LABELS[event.status]}</span>
                )}
                {event.location === null ? null : <div className="muted">{event.location}</div>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function ItemsAndSources({ parcel }: { readonly parcel: ParcelDetail }): ReactNode {
  return (
    <section className="card" aria-labelledby="items-title">
      <h2 id="items-title">Items</h2>
      {parcel.items.length === 0 ? (
        <p className="muted">No items known.</p>
      ) : (
        <ul className="items">
          {parcel.items.map((item, index) => (
            <li key={`${item.title}-${index}`}>
              {item.image_url === null ? null : (
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
              {source.plugin} <span className="muted">({source.role})</span>, seen{" "}
              {formatRelative(source.last_seen_at)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ParcelDetailPage({ parcelId }: { readonly parcelId: string }): ReactNode {
  const query = useParcel(parcelId);
  const parcel = query.data;

  return (
    <section aria-labelledby="parcel-title">
      <p>
        <Link to="/">← All parcels</Link>
      </p>
      <ErrorNotice error={query.error} />
      {parcel === undefined ? (
        query.isPending ? (
          <Spinner />
        ) : null
      ) : (
        <>
          <h1 id="parcel-title">{parcel.label ?? parcel.barcode}</h1>
          <div className="detail-grid">
            <section className="card" aria-label="Overview">
              <Facts parcel={parcel} />
            </section>
            {parcel.location === null ? null : (
              <section className="card map-card" aria-label="Location">
                <Suspense fallback={<Spinner label="Loading map…" />}>
                  <LocationMap location={parcel.location} />
                </Suspense>
              </section>
            )}
            <History parcel={parcel} />
            <ItemsAndSources parcel={parcel} />
            <ParcelEditor key={parcel.updated_at} parcel={parcel} />
          </div>
        </>
      )}
    </section>
  );
}
