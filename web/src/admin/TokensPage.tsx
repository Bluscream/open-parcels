import { useState, type SyntheticEvent, type ReactNode } from "react";
import { useCreateToken, useRevokeToken, useTokens } from "../api/queries";
import type { ApiToken } from "../api/types";
import { ErrorNotice, Field, Spinner } from "../components/ui";
import { formatDateTime, formatRelative } from "../lib/format";

type Scope = ApiToken["scopes"][number];
const SCOPES: readonly Scope[] = ["read", "write", "admin"];

function CreateToken(): ReactNode {
  const create = useCreateToken();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Scope[]>(["read"]);

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    create.mutate(
      { name: name.trim(), scopes },
      {
        onSuccess: () => {
          setName("");
        },
      },
    );
  };

  const toggle = (scope: Scope, on: boolean): void => {
    setScopes((current) => (on ? [...current, scope] : current.filter((s) => s !== scope)));
  };

  return (
    <section className="card" aria-labelledby="new-token-title">
      <h2 id="new-token-title">New token</h2>
      <form onSubmit={submit} className="stack">
        <Field label="Name" hint="What uses it, for example “Home Assistant”.">
          {(id, hint) => (
            <input
              id={id}
              aria-describedby={hint}
              required
              maxLength={80}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
            />
          )}
        </Field>
        <fieldset className="inline">
          <legend>Scopes</legend>
          {SCOPES.map((scope) => (
            <label key={scope} className="checkbox">
              <input
                type="checkbox"
                checked={scopes.includes(scope)}
                onChange={(e) => {
                  toggle(scope, e.target.checked);
                }}
              />
              {scope}
            </label>
          ))}
        </fieldset>
        <ErrorNotice error={create.error} />
        <div className="actions">
          <button
            type="submit"
            className="button primary"
            disabled={create.isPending || scopes.length === 0}
          >
            Create token
          </button>
        </div>
      </form>
      {create.data === undefined ? null : (
        <div className="notice token-value" role="status">
          <p>
            Copy the token now. It is shown <strong>only once</strong>.
          </p>
          <code className="mono">{create.data.token}</code>
          <div className="actions">
            <button
              type="button"
              className="button"
              onClick={() => {
                void navigator.clipboard.writeText(create.data.token);
              }}
            >
              Copy
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                create.reset();
              }}
            >
              Done
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

export function TokensPage(): ReactNode {
  const tokens = useTokens();
  const revoke = useRevokeToken();

  return (
    <section aria-labelledby="tokens-title">
      <div className="page-header">
        <h1 id="tokens-title">API tokens</h1>
      </div>
      <CreateToken />
      <ErrorNotice error={tokens.error ?? revoke.error} />
      {tokens.data === undefined ? (
        <Spinner />
      ) : (
        <div className="table-scroll card">
          <table>
            <caption className="visually-hidden">API tokens</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Scopes</th>
                <th scope="col">Created</th>
                <th scope="col">Last used</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {tokens.data.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted empty">
                    No tokens yet.
                  </td>
                </tr>
              ) : null}
              {tokens.data.map((token) => (
                <tr key={token.id}>
                  <td>{token.name}</td>
                  <td>{token.scopes.join(", ")}</td>
                  <td>{formatDateTime(token.created_at)}</td>
                  <td>{formatRelative(token.last_used_at)}</td>
                  <td>
                    <button
                      type="button"
                      className="button danger"
                      onClick={() => {
                        if (window.confirm(`Revoke the token “${token.name}”?`)) {
                          revoke.mutate(token.id);
                        }
                      }}
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
