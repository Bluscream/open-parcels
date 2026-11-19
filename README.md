<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/open-parcels/open-parcels/master/docs/branding/banner-on-dark.png">
    <img alt="Open Parcels" src="https://raw.githubusercontent.com/open-parcels/open-parcels/master/docs/branding/banner-on-light.png" width="640">
  </picture>
</p>
<p align="center">
  <a href="https://hub.docker.com/r/bluscream1/open-parcels"><img alt="Docker Hub pulls" src="https://img.shields.io/docker/pulls/bluscream1/open-parcels?logo=docker&label=pulls"></a>
  <a href="https://github.com/open-parcels/open-parcels/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/open-parcels/open-parcels?include_prereleases&sort=semver"></a>
  <a href="https://github.com/open-parcels/open-parcels/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/open-parcels/open-parcels?style=flat"></a>
  <a href="https://github.com/open-parcels/open-parcels/issues"><img alt="Open issues" src="https://img.shields.io/github/issues/open-parcels/open-parcels"></a>
  <a href="https://github.com/open-parcels/open-parcels/commits"><img alt="Last commit" src="https://img.shields.io/github/last-commit/open-parcels/open-parcels"></a>
</p>

# Open Parcels

**Self-hosted parcel and order tracking.** One service on your own hardware follows about 95
carriers, signs in to carrier and shop accounts, reads shipping mails, shows the courier live on a
map and keeps a delivery calendar (also as an ICS feed).

> **Status:** early development, `2.0.0-dev`. Expect breaking changes.

This repository holds the server and the web UI: carrier plug-ins, mail parsing, the scheduler,
the REST API with its event stream, the Docker image and the Unraid template.

- Website, install guides and the carrier list: <https://open-parcels.github.io>
- Home Assistant integration: [open-parcels-ha](https://github.com/open-parcels/open-parcels-ha)
- Home Assistant app (runs the server inside Home Assistant, in the sidebar): [open-parcels-ha-apps](https://github.com/open-parcels/open-parcels-ha-apps)
- Shared carrier and mail rules: [open-parcels-rules](https://github.com/open-parcels/open-parcels-rules)
- Browser extension for app-only carrier sign-ins: [open-parcels-extension](https://github.com/open-parcels/open-parcels-extension)

## Quick start

```sh
docker compose up -d   # uses docker-compose.yml from this repository
```

Then open <http://localhost:3000> and finish the setup with the code from `docker compose logs open-parcels`. The website has guides for Unraid and Home Assistant. For something to look at before
you add real accounts, add the **Demo shop** and **Demo courier** sources: three made-up parcels
in two orders, with a live courier on the map.

## Access

Two passwords, both optional settings (environment, or **Settings → Security**):

| Setting | Allows | Unset |
| :--- | :--- | :--- |
| `OPENPARCELS_PASSWORD` | Reading: the web UI, the API, live updates, maps, images. | Anyone who can reach the server reads everything. |
| `OPENPARCELS_ADMIN_PASSWORD` | Everything that changes something (every non-GET request): sources, sign-ins, sync, parcel and order edits, settings, tokens. | First start prints a setup code to the log; entering it in the web UI chooses the admin password. |

The admin password may also be changed in the UI (it needs the current one). It is then stored
scrypt-hashed and wins over the environment until **Reset to environment**; changing or resetting
it signs every session out. Changing the reader password signs readers out. Home Assistant ingress
counts as the admin. API tokens keep their scopes: `read` reads, `write` or `admin` may change
things, and only `admin` manages tokens and server settings.

**Upgrading** from a version with a single owner password: nothing to do. The owner password
becomes the admin password (still hashed, shown as "saved in UI"), open sessions stay signed in as
admin, and reading is open until `OPENPARCELS_PASSWORD` is set. To keep reading private as before,
set `OPENPARCELS_PASSWORD` (or set it on the Security card right after upgrading).

## Development

```sh
npm install
npm run gate   # format check, lint, type check, tests, build
```

API reference: [`docs/openapi.json`](docs/openapi.json). Branding assets: [`docs/branding`](docs/branding).

## License

See the repository's license file.