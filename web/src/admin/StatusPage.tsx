import type { ReactNode } from "react";
import { useDiagnostics, useHealth, useSources } from "../api/queries";
import { useIsAdmin } from "../auth/session";
import { ErrorNotice, ReadOnlyHint, Spinner } from "../components/ui";
import { formatRelative } from "../lib/format";
import { SourceStateBadge } from "../parcels/badges";

function download(data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `open-parcels-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

export function StatusPage(): ReactNode {
  const health = useHealth();
  const sources = useSources();
  const admin = useIsAdmin();
  const ready = health.data?.status === "ok";

  return (
    <section aria-labelledby="status-title">
      <div className="page-header">
        <h1 id="status-title">Status</h1>
      </div>
      <section className="card" aria-labelledby="health-title">
        <h2 id="health-title">Service</h2>
        {health.isPending ? (
          <Spinner />
        ) : (
          <p role="status">
            <span className={`badge ${ready ? "source-ok" : "source-error"}`}>
              {ready ? "Ready" : "Not ready"}
            </span>
          </p>
        )}
        <ErrorNotice error={health.error} />
      </section>
      <section className="card" aria-labelledby="sources-status-title">
        <h2 id="sources-status-title">Sources</h2>
        <ErrorNotice error={sources.error} />
        <ul className="plain-list">
          {(sources.data ?? []).map((source) => (
            <li key={source.id}>
              <SourceStateBadge state={source.state} lastOkAt={source.last_ok_at} />{" "}
              <strong>{source.label}</strong>{" "}
              <span className="muted">
                last run {formatRelative(source.last_run_at)}, last success{" "}
                {formatRelative(source.last_ok_at)}
              </span>
              {source.state_detail === null ? null : (
                <div className="muted">{source.state_detail}</div>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section className="card" aria-labelledby="diag-title">
        <h2 id="diag-title">Diagnostics</h2>
        {admin ? <Diagnostics /> : <ReadOnlyHint>Diagnostics are for the admin only.</ReadOnlyHint>}
      </section>
    </section>
  );
}

/** Only mounted for the admin, so readers do not ask for what they may not see. */
function Diagnostics(): ReactNode {
  const diagnostics = useDiagnostics();
  return (
    <>
      <p className="muted">Redacted on the server: no codes, addresses or sign-in data.</p>
      <ErrorNotice error={diagnostics.error} />
      <div className="actions">
        <button
          type="button"
          className="button"
          disabled={diagnostics.data === undefined}
          onClick={() => {
            download(diagnostics.data);
          }}
        >
          Download diagnostics
        </button>
      </div>
      {diagnostics.data === undefined ? null : (
        <details>
          <summary>Show</summary>
          <pre className="diagnostics">{JSON.stringify(diagnostics.data, null, 2)}</pre>
        </details>
      )}
    </>
  );
}
