Be extra careful when talking to real-world services like Amazon: conservative rate limits, generous
delays, backoff, many failsafes, and stop fast when a response looks wrong. A network error must
never trigger a new sign-in.

# open-parcels: notes for agents

Read [`docs/decisions/0001-architecture.md`](docs/decisions/0001-architecture.md) first. It explains
what this service is, the stack, the data model, the API and event contract, and the roadmap.

## Layout

| Path | What |
|---|---|
| `server/` | The backend: Fastify API, engine, carrier plug-ins (TypeScript, Node 26) |
| `server/src/carriers/` | Carrier plug-ins. They may import only the plug-in API; ESLint enforces it |
| `server/test/` | vitest suites: `unit/`, `api/`, and recorded made-up fixtures |
| `web/` | The web UI (React + Vite). Still the pre-rewrite frontend until phase 6 |
| `docs/decisions/` | Decision records |
| `Dockerfile`, `docker-compose.yml`, `unraid/` | Packaging |

The TypeScript implementation from before the rewrite is on branch `legacy-ts` (tag `v1-final`).

## The gate

Run it before every commit; it must pass with zero warnings:

```sh
npm run gate   # prettier check, eslint (strict type-checked + size limits), tsc, vitest, build
```

- **Build on NTFS (`G:\_TEMP\...`), never on the Btrfs drives** `D:`, `E:` or `F:` from Windows.
- **npm 11 runs install scripts only for packages listed in `allowScripts`** in the root
  `package.json`. Add a package there deliberately, never blanket-allow.
- **The repository's pre-commit hook rejects literal strings assigned to `password` or `secret`
  keys, even in tests.** Build made-up test values from parts, as `server/test/helpers.ts` does.
  Never bypass it with `--no-verify`.

## Rules that matter here

- **Test fixtures contain made-up values only.** Never commit real tracking numbers, order numbers,
  names, addresses, emails or coordinates. History was rewritten once to remove such data.
- **No secrets in logs or events.** Use the logger, which redacts. Event payloads go through
  `parcelForEvent`, which strips courier coordinates.
- **Carrier knowledge that other projects could reuse goes to `open-parcels-rules`, not here.**
  That covers regexes, status tables, locale tables and mail rules.
- **Don't name the projects an endpoint was learned from** in code, docs or commit messages.
- **GitHub Actions never run under this account.** Workflows keep only `workflow_dispatch` active;
  automatic triggers stay commented out, with the reason written above them.
