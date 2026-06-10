make sure youre extra careful when scraping real world services like amazon, use plenty of failsafes, spoofs and delays and interject fast when something goes wrong

# OpenParcels Developer Instructions (CLAUDE.md)

This file contains guidelines, build instructions, and testing rules for development in the `open-parcels` workspace.

---

## 🛠️ Mandatory Environment Rule (Distrobox)

Because this project resides on a local/NFS mount under an immutable OS (Universal Blue / Fedora Silverblue), performing builds, typescript compilations, or running node scripts directly on the host shell will fail due to filesystem and binary mismatches.

> [!IMPORTANT]
> **Always execute all build, install, test, and run commands inside the `open-parcels-dev` Distrobox container.**
> This container runs a native Linux Node.js environment that mounts your home and project folder with matched user permissions, fully resolving all permissions and platform-native binary bugs.

---

## ⚡ Quick Testing (Distrobox Setup)

To avoid container build overhead during rapid local testing and debugging, you can run both `universal-lookup` and `open-parcels` directly inside the Distrobox container.

### 1. Run Universal Lookup in Distrobox
1. Open a terminal and run the backend dev server:
   ```bash
   distrobox enter open-parcels-dev -- bash -c "cd .references/universal-lookup && npm install && npm run build && npm run dev"
   ```
   *(Backend runs on `http://localhost:24011`)*

2. (Optional) Run the frontend dev server:
   ```bash
   distrobox enter open-parcels-dev -- bash -c "cd .references/universal-lookup && npm run dev:frontend"
   ```
   *(Frontend runs on `http://localhost:24010`)*

### 2. Run OpenParcels in Distrobox
1. Configure your `.env` file in the root of `open-parcels` to point `LOOKUP_URL` to the local backend:
   ```env
   LOOKUP_URL=http://localhost:24011
   ```
2. Start the dev server:
   ```bash
   distrobox enter open-parcels-dev -- npm run dev
   ```
   *(OpenParcels runs on `http://localhost:3000`)*

### 3. Run Live Tracking Verification Tests
Run the test suite inside the distrobox container:
```bash
distrobox enter open-parcels-dev -- npx -y tsx tests/resolve_tracking.test.ts
```

---

## 📦 Container Deployment (Podman / Docker)

Once your tests succeed in Distrobox, you should build and run both projects via Podman to verify container deployment and networking.

### 1. Configure networking
Inside containers, `localhost` resolves to the container loopback. To allow `open-parcels` to communicate with the host-bound `universal-lookup-backend` port, edit the root `.env` file:
```env
LOOKUP_URL=http://host.containers.internal:24011
```

### 2. Deploy Universal Lookup
From the root of `open-parcels`, build and start the containers using `podman-compose`:
```bash
podman-compose -f .references/universal-lookup/docker/docker-compose.yml up -d --build --force-recreate
```

### 3. Deploy OpenParcels
Run the update and redeploy script:
```bash
bash scripts/update.sh
```

---

## 📂 Project Architecture

*   `open-parcels/`: The main self-hostable server application.
    *   `src/services/ingest/rules-loader.ts`: Dynamically loads and caches the rules from remote URLs defined in the `OPENPARCELS_RULES` environment variable.
    *   `packages/mail-parser-ts/`: Standardized email-parsing engine running prefix string matches and named capture group extractions.
*   `packages/email-parser-rules/`: Separated parsing rules repository.
    *   `src/parcel/`, `src/order/`, `src/return/`: Modular categories — one TypeScript file per service (e.g. `src/parcel/amazon.ts`). Each file exports a single `CourierRule` object.
    *   `dist/`: Single-file minified rulesets (`parcel.js`, `order.js`, `return.js`) uploaded to your GitHub Release assets.

