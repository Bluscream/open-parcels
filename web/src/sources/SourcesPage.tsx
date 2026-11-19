import { useMemo, useState, type ReactNode } from "react";
import {
  useCarriers,
  useDeleteSource,
  useParcels,
  useSources,
  useSyncSource,
  useUpdateSource,
} from "../api/queries";
import type { Carrier, Parcel, Source } from "../api/types";
import { CarrierLogo } from "../components/CarrierLogo";
import { ErrorNotice, Spinner } from "../components/ui";
import { formatRelative } from "../lib/format";
import { SourceStateBadge } from "../parcels/badges";
import { MAIL_PLUGIN } from "./mail";
import { SignInDialog } from "./SignInDialog";
import { SourceDialog } from "./SourceDialog";

type Editing = { readonly mode: "add" } | { readonly mode: "edit"; readonly source: Source } | null;

/**
 * False when every sign-in flow the source's plug-in offers for its kind needs nothing (type
 * `none`), so a "Sign in" button would lead nowhere. Mailboxes always sign in; unknown plug-ins
 * and a source the server says needs a sign-in keep the button.
 */
export function canSignIn(source: Source, carriers: readonly Carrier[] | undefined): boolean {
  if (source.plugin === MAIL_PLUGIN || source.state === "needs_sign_in") return true;
  const carrier = carriers?.find((c) => c.id === source.plugin);
  if (carrier === undefined) return true;
  return carrier.sign_in_flows.some(
    (flow) => flow.type !== "none" && (flow.kinds as readonly string[]).includes(source.kind),
  );
}

export interface SourceStats {
  readonly active: number;
  readonly delivered: number;
  readonly total: number;
}

const NO_STATS: SourceStats = { active: 0, delivered: 0, total: 0 };

/** Parcels per source (archived included): on the way, delivered, and all it has found. */
export function statsBySource(parcels: readonly Parcel[]): ReadonlyMap<string, SourceStats> {
  const stats = new Map<string, SourceStats>();
  for (const parcel of parcels) {
    for (const ref of new Set(parcel.sources.map((entry) => entry.source_id))) {
      const current = stats.get(ref) ?? NO_STATS;
      stats.set(ref, {
        active: current.active + (parcel.delivered || parcel.archived_at !== null ? 0 : 1),
        delivered: current.delivered + (parcel.delivered ? 1 : 0),
        total: current.total + 1,
      });
    }
  }
  return stats;
}

function Stat(props: { readonly label: string; readonly value: number | string }): ReactNode {
  return (
    <div className="source-stat">
      <span className="source-stat-value">{props.value}</span>
      <span className="source-stat-label">{props.label}</span>
    </div>
  );
}

function SourceRow(props: {
  readonly source: Source;
  readonly stats: SourceStats | undefined;
  readonly signIn: boolean;
  readonly onEdit: () => void;
  readonly onSignIn: () => void;
}): ReactNode {
  const { source } = props;
  const sync = useSyncSource();
  const update = useUpdateSource();
  const remove = useDeleteSource();
  const enabled = source.state !== "disabled";
  const stats = props.stats ?? NO_STATS;
  return (
    <li className="card source-card">
      <div className="source-head">
        <CarrierLogo carrier={source.plugin} size={32} />
        <div className="source-title">
          <h2 title={source.label}>{source.label}</h2>
          <span className="muted">
            {source.plugin} · {source.kind}
          </span>
        </div>
        <SourceStateBadge state={source.state} lastOkAt={source.last_ok_at} />
      </div>
      {source.state_detail === null ? null : (
        <p className="muted source-detail">{source.state_detail}</p>
      )}
      <div className="source-stats">
        <Stat label="on the way" value={stats.active} />
        <Stat label="delivered" value={stats.delivered} />
        <Stat label="parcels found" value={stats.total} />
      </div>
      <dl className="source-times">
        <dt>Last run</dt>
        <dd>{formatRelative(source.last_run_at)}</dd>
        <dt>Last success</dt>
        <dd>{formatRelative(source.last_ok_at)}</dd>
        <dt>Next run</dt>
        <dd>{source.next_run_at === null ? "—" : formatRelative(source.next_run_at)}</dd>
      </dl>
      <ErrorNotice error={sync.error ?? update.error ?? remove.error} />
      <div className="actions">
        {/* A disabled source neither runs nor signs in; enabling it comes first. */}
        {enabled && props.signIn ? (
          <button
            type="button"
            className={source.state === "needs_sign_in" ? "button primary" : "button"}
            onClick={props.onSignIn}
          >
            {source.has_secret ? "Sign in again" : "Sign in"}
          </button>
        ) : null}
        {enabled ? (
          <button
            type="button"
            className="button"
            disabled={sync.isPending}
            onClick={() => {
              sync.mutate(source.id);
            }}
          >
            {sync.isPending ? "Syncing…" : "Sync now"}
          </button>
        ) : null}
        <button type="button" className="button" onClick={props.onEdit}>
          Edit
        </button>
        <button
          type="button"
          className="button"
          aria-pressed={!enabled}
          onClick={() => {
            update.mutate({ id: source.id, body: { enabled: !enabled } });
          }}
        >
          {enabled ? "Disable" : "Enable"}
        </button>
        <button
          type="button"
          className="button danger"
          onClick={() => {
            if (window.confirm(`Remove “${source.label}” and its stored sign-in?`)) {
              remove.mutate(source.id);
            }
          }}
        >
          Remove
        </button>
      </div>
    </li>
  );
}

export function SourcesPage(): ReactNode {
  const sources = useSources();
  const carriers = useCarriers();
  const parcels = useParcels(true);
  const stats = useMemo(() => statsBySource(parcels.data ?? []), [parcels.data]);
  const list = sources.data ?? [];
  const working = list.filter((source) => source.state === "ok" || source.state === "idle").length;
  const attention = list.filter(
    (source) => source.state !== "ok" && source.state !== "idle" && source.state !== "disabled",
  ).length;
  const [editing, setEditing] = useState<Editing>(null);
  const [signingIn, setSigningIn] = useState<Source | null>(null);

  return (
    <section aria-labelledby="sources-title">
      <div className="page-header">
        <h1 id="sources-title">Sources</h1>
        <button
          type="button"
          className="button primary"
          onClick={() => {
            setEditing({ mode: "add" });
          }}
        >
          Add a source
        </button>
      </div>
      <ErrorNotice error={sources.error} />
      {list.length === 0 ? null : (
        <div className="source-summary glass-panel">
          <Stat label="sources" value={list.length} />
          <Stat label="working" value={working} />
          <Stat label="need attention" value={attention} />
          <Stat
            label="parcels on the way"
            value={
              parcels.data?.filter((p) => !p.delivered && p.archived_at === null).length ?? "…"
            }
          />
        </div>
      )}
      {sources.data === undefined ? (
        sources.isPending ? (
          <Spinner />
        ) : null
      ) : sources.data.length === 0 ? (
        <p className="muted">No sources yet. Add a carrier account, a shop or a mailbox.</p>
      ) : (
        <ul className="plain-list source-grid">
          {sources.data.map((source) => (
            <SourceRow
              key={source.id}
              source={source}
              stats={stats.get(source.id)}
              signIn={canSignIn(source, carriers.data)}
              onEdit={() => {
                setEditing({ mode: "edit", source });
              }}
              onSignIn={() => {
                setSigningIn(source);
              }}
            />
          ))}
        </ul>
      )}
      {editing === null ? null : (
        <SourceDialog
          key={editing.mode === "edit" ? editing.source.id : "add"}
          open
          editing={editing.mode === "edit" ? editing.source : null}
          onClose={() => {
            setEditing(null);
          }}
          onCreated={(source) => {
            setEditing(null);
            // A new source that signs in and has nothing stored goes straight to its sign-in.
            if (!source.has_secret && canSignIn(source, carriers.data)) {
              setSigningIn(source);
            }
          }}
        />
      )}
      <SignInDialog
        key={signingIn?.id ?? "none"}
        source={signingIn}
        onClose={() => {
          setSigningIn(null);
        }}
      />
    </section>
  );
}
