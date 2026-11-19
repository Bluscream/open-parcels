import { useState, type ReactNode } from "react";
import {
  useCarriers,
  useDeleteSource,
  useSources,
  useSyncSource,
  useUpdateSource,
} from "../api/queries";
import type { Carrier, Source } from "../api/types";
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

function SourceRow(props: {
  readonly source: Source;
  readonly signIn: boolean;
  readonly onEdit: () => void;
  readonly onSignIn: () => void;
}): ReactNode {
  const { source } = props;
  const sync = useSyncSource();
  const update = useUpdateSource();
  const remove = useDeleteSource();
  const enabled = source.state !== "disabled";
  return (
    <li className="card source-row">
      <div className="source-head">
        <h2>{source.label}</h2>
        <SourceStateBadge state={source.state} lastOkAt={source.last_ok_at} />
        <span className="muted">
          {source.plugin} · {source.kind}
        </span>
      </div>
      {source.state_detail === null ? null : <p className="muted">{source.state_detail}</p>}
      <p className="muted">
        Last run {formatRelative(source.last_run_at)} · last success{" "}
        {formatRelative(source.last_ok_at)}
        {source.next_run_at === null ? "" : ` · next ${formatRelative(source.next_run_at)}`}
      </p>
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
      {sources.data === undefined ? (
        sources.isPending ? (
          <Spinner />
        ) : null
      ) : sources.data.length === 0 ? (
        <p className="muted">No sources yet. Add a carrier account, a shop or a mailbox.</p>
      ) : (
        <ul className="plain-list source-list">
          {sources.data.map((source) => (
            <SourceRow
              key={source.id}
              source={source}
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
