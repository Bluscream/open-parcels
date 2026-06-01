# OpenParcels Developer Instructions (CLAUDE.md)

This file contains guidelines, build instructions, and testing rules for development in the `open-parcels` workspace.

---

## 🛠️ Mandatory Environment Rule (Distrobox)

Because this project resides on a Network Attached Storage (NAS) mount under an immutable OS (Universal Blue / Fedora Silverblue), performing builds, typescript compilations, or running node scripts directly on the host shell will fail due to:
1. NFS stale file handles (`ESTALE`).
2. Execution permissions restrictions (`noexec` blocks).
3. Platform binary mismatches for native modules (e.g. `esbuild` compiled for Windows instead of Linux).

> [!IMPORTANT]
> **Always execute all build, install, test, and run commands inside the `open-parcels-dev` Distrobox container.**
> This container runs a native Linux Node.js v20 environment that mounts your home and project folder with matched user permissions, fully resolving all NFS, permissions, and platform-native binary bugs.

---

## 🚀 Development Commands

### 1. Running the Dev Server
To start the `open-parcels` local development server:
```bash
distrobox enter open-parcels-dev -- npm run dev
```

### 2. Building the Email Parsing Rules
To rebuild, merge, and minify the outsourced parsing rules in `packages/email-parser-rules`:
```bash
distrobox enter open-parcels-dev -- npm --prefix packages/email-parser-rules run build
```

### 3. Running Integration Tests
To execute the parser integration test suite:
```bash
distrobox enter open-parcels-dev -- node src/tests/test-dynamic-parser.js
```

---

## 📦 Project Architecture

*   `open-parcels/`: The main self-hostable server application.
    *   `src/services/ingest/rules-loader.ts`: Dynamically loads and caches the rules from remote URLs defined in the `OPENPARCELS_RULES` environment variable.
    *   `packages/mail-parser-ts/`: Standardized email-parsing engine running prefix string matches and named capture group extractions.
*   `packages/email-parser-rules/`: Separated parsing rules repository.
    *   `src/parcel/`, `src/order/`, `src/return/`: Modular categories — one TypeScript file per service (e.g. `src/parcel/amazon.ts`). Each file exports a single `CourierRule` object.
    *   `dist/`: Single-file minified rulesets (`parcel.js`, `order.js`, `return.js`) uploaded to your GitHub Release assets.
