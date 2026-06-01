#!/usr/bin/env bash
# =============================================================================
# scripts/update.sh
# Builds email-parser-rules + open-parcels, redeploys via Podman, opens UI.
#
# Requirements:
#   - Distrobox container "open-parcels-dev" must exist (see CLAUDE.md)
#   - podman must be installed on the host
#   - xdg-open (or a browser fallback) for opening the web interface
# =============================================================================

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONTAINER_NAME="openparcels"
IMAGE_NAME="open-parcels:local"
PORT="${PORT:-3000}"
URL="http://localhost:${PORT}"
DISTROBOX="open-parcels-dev"
ENV_FILE="${PROJECT_DIR}/.env"
DB_PATH="${PROJECT_DIR}/data.db"

# ── Helpers ───────────────────────────────────────────────────────────────────
log()     { echo -e "\033[1;34m[update]\033[0m $*"; }
success() { echo -e "\033[1;32m[update]\033[0m $*"; }
warn()    { echo -e "\033[1;33m[update]\033[0m $*"; }
error()   { echo -e "\033[1;31m[update]\033[0m $*" >&2; exit 1; }

# Run a command inside the distrobox container
dbox() { distrobox enter "${DISTROBOX}" -- "$@"; }

# ── Preflight checks ──────────────────────────────────────────────────────────
log "Checking prerequisites..."
command -v distrobox &>/dev/null || error "distrobox not found in PATH."
command -v podman    &>/dev/null || error "podman not found in PATH."

if ! distrobox list 2>/dev/null | grep -q "${DISTROBOX}"; then
    error "Distrobox container '${DISTROBOX}' not found. Create it first (see CLAUDE.md)."
fi

# ── Step 1: Build email-parser-rules ─────────────────────────────────────────
log "Building email-parser-rules package..."
dbox bash -c "cd '${PROJECT_DIR}/packages/email-parser-rules' && npm run build"
success "email-parser-rules built successfully."

# ── Step 2: Build open-parcels (TypeScript compile) ───────────────────────────
log "Building open-parcels backend..."
dbox bash -c "cd '${PROJECT_DIR}' && npm run build"
success "open-parcels backend built successfully."

# ── Step 3: Build Podman image ────────────────────────────────────────────────
log "Building Podman image '${IMAGE_NAME}'..."
podman build \
    --file "${PROJECT_DIR}/docker/Dockerfile" \
    --tag  "${IMAGE_NAME}" \
    "${PROJECT_DIR}"
success "Podman image built: ${IMAGE_NAME}"

# ── Step 4: Stop & remove existing container ──────────────────────────────────
if podman container exists "${CONTAINER_NAME}" 2>/dev/null; then
    log "Stopping existing container '${CONTAINER_NAME}'..."
    podman stop  "${CONTAINER_NAME}" &>/dev/null || true
    podman rm    "${CONTAINER_NAME}" &>/dev/null || true
    success "Old container removed."
fi

# ── Step 5: Load env vars from .env (if present) ─────────────────────────────
ENV_ARGS=()
if [[ -f "${ENV_FILE}" ]]; then
    log "Loading environment from ${ENV_FILE}..."
    while IFS='=' read -r key value || [[ -n "${key}" ]]; do
        # Skip blank lines and comments
        [[ -z "${key}" || "${key}" =~ ^[[:space:]]*# ]] && continue
        # Strip inline comments and surrounding whitespace/quotes
        value="$(echo "${value}" | sed 's/[[:space:]]*#.*//' | xargs)"
        [[ -n "${key}" && -n "${value}" ]] && ENV_ARGS+=("--env" "${key}=${value}")
    done < "${ENV_FILE}"
fi

# ── Step 6: Run the container ─────────────────────────────────────────────────
log "Starting container '${CONTAINER_NAME}' on port ${PORT}..."
podman run \
    --detach \
    --name "${CONTAINER_NAME}" \
    --restart unless-stopped \
    --publish "${PORT}:3000" \
    --volume  "${DB_PATH}:/app/data.db:Z" \
    "${ENV_ARGS[@]}" \
    "${IMAGE_NAME}"

# Wait briefly and verify the container is still running
sleep 2
if ! podman container exists "${CONTAINER_NAME}" 2>/dev/null; then
    error "Container failed to start. Check logs with: podman logs ${CONTAINER_NAME}"
fi
if [[ "$(podman inspect -f '{{.State.Status}}' "${CONTAINER_NAME}")" != "running" ]]; then
    warn "Container may not be healthy. Logs:"
    podman logs --tail 30 "${CONTAINER_NAME}"
    error "Container is not in 'running' state."
fi

success "Container '${CONTAINER_NAME}' is running at ${URL}"
log "Tail logs with:  podman logs -f ${CONTAINER_NAME}"

# ── Step 7: Open web interface ────────────────────────────────────────────────
log "Opening web interface at ${URL}..."
if command -v xdg-open &>/dev/null; then
    xdg-open "${URL}" &
elif command -v browse &>/dev/null; then
    browse "${URL}" &
elif command -v firefox &>/dev/null; then
    firefox "${URL}" &
elif command -v chromium &>/dev/null; then
    chromium "${URL}" &
else
    warn "No browser launcher found. Please open ${URL} manually."
fi

success "Done! open-parcels is live at ${URL}"
