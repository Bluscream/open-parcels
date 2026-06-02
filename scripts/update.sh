#!/usr/bin/env bash
# =============================================================================
# scripts/update.sh
# Manages the open-parcels + universal-lookup dev/deployment lifecycle.
#
# Usage:
#   update.sh [OPTIONS]
#
# Options:
#   --setup              One-time setup: create Distrobox container, install apt
#                        deps (Chromium, ping, etc.) and npm dependencies for
#                        both open-parcels and universal-lookup
#   --build              Build email-parser-rules, open-parcels, and
#                        universal-lookup (TypeScript compile)
#   --test               Run the open-parcels live tracking verification tests
#   --deploy [TARGET]    Deploy both services. TARGET: distrobox (default),
#                        podman, docker
#   --open               Open the web UI after deploy (implied by --deploy)
#   -h, --help           Show this help message
#
# Examples:
#   update.sh --setup
#   update.sh --build --test
#   update.sh --build --deploy
#   update.sh --deploy podman
#   update.sh --setup --build --test --deploy docker
# =============================================================================

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOOKUP_DIR="$(cd "${PROJECT_DIR}/../universal-lookup" 2>/dev/null && pwd || echo "")"

# open-parcels
CONTAINER_NAME="openparcels"
IMAGE_NAME="open-parcels:local"
PORT="${PORT:-3000}"
URL="http://localhost:${PORT}"
ENV_FILE="${PROJECT_DIR}/.env"
DB_PATH="${PROJECT_DIR}/data.db"

# universal-lookup
LOOKUP_CONTAINER_NAME="universal-lookup"
LOOKUP_IMAGE_NAME="universal-lookup:local"
LOOKUP_PORT="24011"
LOOKUP_URL="http://localhost:${LOOKUP_PORT}"

# distrobox
DISTROBOX_NAME="open-parcels-dev"
DISTROBOX_IMAGE="node:20-bullseye"

# apt packages installed in the dev Distrobox container only (NOT the Docker image)
DISTROBOX_APT_PKGS=(
    chromium
    traceroute
    iputils-ping
    ca-certificates
    fonts-liberation
    sqlite3          # dev-only: inspect data.db from the command line
)

# ── Flags (defaults) ──────────────────────────────────────────────────────────
DO_SETUP=false
DO_BUILD=false
DO_TEST=false
DO_DEPLOY=false
DO_OPEN=false
DEPLOY_TARGET="distrobox"

# ── Helpers ───────────────────────────────────────────────────────────────────
log()     { echo -e "\033[1;34m[update]\033[0m $*"; }
success() { echo -e "\033[1;32m[update]\033[0m $*"; }
warn()    { echo -e "\033[1;33m[update]\033[0m $*"; }
error()   { echo -e "\033[1;31m[update]\033[0m $*" >&2; exit 1; }
header()  { echo -e "\n\033[1;35m━━━ $* ━━━\033[0m"; }

usage() {
    sed -n '/^# Usage:/,/^# =====/{ /^# =====/d; s/^# \{0,3\}//; p }' "$0"
    exit 0
}

# Run a command inside the shared distrobox container
dbox() { distrobox enter "${DISTROBOX_NAME}" -- "$@"; }

# ── Argument parsing ──────────────────────────────────────────────────────────
if [[ $# -eq 0 ]]; then
    usage
fi

while [[ $# -gt 0 ]]; do
    case "$1" in
        --setup)   DO_SETUP=true;  shift ;;
        --build)   DO_BUILD=true;  shift ;;
        --test)    DO_TEST=true;   shift ;;
        --open)    DO_OPEN=true;   shift ;;
        --deploy)
            DO_DEPLOY=true
            DO_OPEN=true
            shift
            # Optional positional value after --deploy
            if [[ $# -gt 0 && "$1" != --* ]]; then
                DEPLOY_TARGET="$1"
                shift
            fi
            ;;
        -h|--help) usage ;;
        *)
            error "Unknown option: $1  (run with --help for usage)"
            ;;
    esac
done

# Validate deploy target
case "${DEPLOY_TARGET}" in
    distrobox|podman|docker) ;;
    *) error "Invalid deploy target '${DEPLOY_TARGET}'. Must be one of: distrobox, podman, docker" ;;
esac

# ── Preflight checks ──────────────────────────────────────────────────────────
header "Preflight checks"

command -v distrobox &>/dev/null || error "distrobox not found in PATH."

if ${DO_DEPLOY} && [[ "${DEPLOY_TARGET}" != "distrobox" ]]; then
    command -v "${DEPLOY_TARGET}" &>/dev/null \
        || error "'${DEPLOY_TARGET}' not found in PATH."
fi

if ${DO_BUILD} || ${DO_TEST} || ( ${DO_DEPLOY} && [[ "${DEPLOY_TARGET}" == "distrobox" ]] ); then
    if ! distrobox list 2>/dev/null | grep -q "${DISTROBOX_NAME}"; then
        error "Distrobox container '${DISTROBOX_NAME}' not found. Run with --setup first."
    fi
fi

if [[ -n "${LOOKUP_DIR}" ]]; then
    log "universal-lookup found at: ${LOOKUP_DIR}"
else
    warn "universal-lookup not found at ../universal-lookup — lookup features will be skipped."
fi

success "Preflight OK"

# ══════════════════════════════════════════════════════════════════════════════
# SETUP
# ══════════════════════════════════════════════════════════════════════════════
if ${DO_SETUP}; then
    header "Setup — Distrobox container"

    # ── Create Distrobox container if needed ─────────────────────────────────
    if distrobox list 2>/dev/null | grep -q "${DISTROBOX_NAME}"; then
        warn "Container '${DISTROBOX_NAME}' already exists — skipping creation."
    else
        log "Creating Distrobox container '${DISTROBOX_NAME}' (image: ${DISTROBOX_IMAGE})..."
        distrobox create \
            --name  "${DISTROBOX_NAME}" \
            --image "${DISTROBOX_IMAGE}" \
            --yes
        success "Container '${DISTROBOX_NAME}' created."
    fi

    # ── Install system dependencies (for Puppeteer / universal-lookup) ───────
    header "Setup — System dependencies"
    log "Installing apt packages: ${DISTROBOX_APT_PKGS[*]}"
    dbox bash -c "
        export DEBIAN_FRONTEND=noninteractive
        sudo apt-get update -qq
        sudo apt-get install -y --no-install-recommends ${DISTROBOX_APT_PKGS[*]}
        sudo rm -rf /var/lib/apt/lists/*
    "
    success "System dependencies installed."

    # ── Point Puppeteer at system Chromium ───────────────────────────────────
    CHROMIUM_PATH="$(dbox which chromium 2>/dev/null || dbox which chromium-browser 2>/dev/null || echo "")"
    if [[ -n "${CHROMIUM_PATH}" ]]; then
        log "System Chromium found at: ${CHROMIUM_PATH}"
        # Persist PUPPETEER_EXECUTABLE_PATH in the container's profile
        dbox bash -c "
            echo 'export PUPPETEER_EXECUTABLE_PATH=${CHROMIUM_PATH}' \
                | sudo tee /etc/profile.d/puppeteer.sh > /dev/null
            echo 'export PUPPETEER_SKIP_DOWNLOAD=true' \
                | sudo tee -a /etc/profile.d/puppeteer.sh > /dev/null
        "
        success "Puppeteer configured to use system Chromium."
    else
        warn "Chromium not found after install — Puppeteer scraping will be unavailable."
    fi

    # ── Install npm deps for open-parcels ────────────────────────────────────
    header "Setup — open-parcels npm install"
    log "Installing open-parcels npm dependencies..."
    dbox bash -c "cd '${PROJECT_DIR}' && npm install"
    success "open-parcels npm dependencies installed."

    # ── Install npm deps for universal-lookup ────────────────────────────────
    if [[ -n "${LOOKUP_DIR}" ]]; then
        header "Setup — universal-lookup npm install"
        log "Installing universal-lookup npm dependencies..."
        dbox bash -c "
            cd '${LOOKUP_DIR}'
            # Ensure request-promise-core is present (needed by cloudscraper)
            npm install
            npm install request request-promise request-promise-core 2>/dev/null || true
        "
        success "universal-lookup npm dependencies installed."
    fi

    success "Setup complete. You can now run: $0 --build --deploy"
fi

# ══════════════════════════════════════════════════════════════════════════════
# BUILD
# ══════════════════════════════════════════════════════════════════════════════
if ${DO_BUILD}; then
    header "Build — open-parcels"

    if [[ -d "${PROJECT_DIR}/packages/email-parser-rules" ]]; then
        log "Building email-parser-rules..."
        dbox bash -c "cd '${PROJECT_DIR}/packages/email-parser-rules' && npm run build"
        success "email-parser-rules built."
    else
        warn "packages/email-parser-rules not found — skipping."
    fi

    log "Building open-parcels backend (TypeScript)..."
    dbox bash -c "cd '${PROJECT_DIR}' && npm run build"
    success "open-parcels backend built."

    if [[ -n "${LOOKUP_DIR}" ]]; then
        header "Build — universal-lookup"
        log "Building universal-lookup (common → frontend → backend)..."
        dbox bash -c "cd '${LOOKUP_DIR}' && npm run build"
        success "universal-lookup built."
    fi
fi

# ══════════════════════════════════════════════════════════════════════════════
# TEST
# ══════════════════════════════════════════════════════════════════════════════
if ${DO_TEST}; then
    header "Test"
    log "Running open-parcels live tracking verification tests..."
    dbox bash -c "cd '${PROJECT_DIR}' && npx -y tsx tests/resolve_tracking.test.ts"
    success "Tests passed."
fi

# ══════════════════════════════════════════════════════════════════════════════
# DEPLOY
# ══════════════════════════════════════════════════════════════════════════════
if ${DO_DEPLOY}; then
    header "Deploy → ${DEPLOY_TARGET}"

    case "${DEPLOY_TARGET}" in

        # ── Distrobox (local dev) ────────────────────────────────────────────
        distrobox)
            # Start universal-lookup first (open-parcels depends on it)
            if [[ -n "${LOOKUP_DIR}" ]]; then
                log "Starting universal-lookup backend in Distrobox (port ${LOOKUP_PORT})..."
                if lsof -i ":${LOOKUP_PORT}" &>/dev/null 2>&1; then
                    warn "Port ${LOOKUP_PORT} already in use — universal-lookup may already be running."
                else
                    dbox bash -c "
                        export PUPPETEER_SKIP_DOWNLOAD=true
                        export PUPPETEER_EXECUTABLE_PATH=\$(which chromium 2>/dev/null || which chromium-browser 2>/dev/null || echo '')
                        cd '${LOOKUP_DIR}' && npm run dev
                    " &
                    LOOKUP_PID=$!
                    log "Waiting for universal-lookup to bind port ${LOOKUP_PORT}..."
                    for i in $(seq 1 15); do
                        sleep 1
                        if lsof -i ":${LOOKUP_PORT}" &>/dev/null 2>&1 || \
                           curl -sf "${LOOKUP_URL}" &>/dev/null; then
                            break
                        fi
                        [[ $i -eq 15 ]] && warn "universal-lookup may not have started yet."
                    done
                    success "universal-lookup started (PID ${LOOKUP_PID}) at ${LOOKUP_URL}"
                fi
            fi

            # Start open-parcels
            log "Starting open-parcels dev server in Distrobox (port ${PORT})..."
            if lsof -i ":${PORT}" &>/dev/null 2>&1; then
                warn "Port ${PORT} already in use — open-parcels may already be running."
            else
                dbox bash -c "cd '${PROJECT_DIR}' && npm run dev" &
                DEVPID=$!
                sleep 3
                if ! kill -0 "${DEVPID}" 2>/dev/null; then
                    error "open-parcels dev server failed to start. Check output above."
                fi
                success "open-parcels started (PID ${DEVPID}) at ${URL}"
                log "Stop services with: kill ${LOOKUP_PID:-} ${DEVPID}"
            fi
            ;;

        # ── Podman ──────────────────────────────────────────────────────────
        podman)
            # universal-lookup
            if [[ -n "${LOOKUP_DIR}" ]]; then
                log "Building Podman image '${LOOKUP_IMAGE_NAME}'..."
                podman build \
                    --file "${LOOKUP_DIR}/Dockerfile" \
                    --tag  "${LOOKUP_IMAGE_NAME}" \
                    "${LOOKUP_DIR}"
                success "Image built: ${LOOKUP_IMAGE_NAME}"

                if podman container exists "${LOOKUP_CONTAINER_NAME}" 2>/dev/null; then
                    log "Removing existing container '${LOOKUP_CONTAINER_NAME}'..."
                    podman stop "${LOOKUP_CONTAINER_NAME}" &>/dev/null || true
                    podman rm   "${LOOKUP_CONTAINER_NAME}" &>/dev/null || true
                fi

                log "Starting '${LOOKUP_CONTAINER_NAME}' on port ${LOOKUP_PORT}..."
                podman run \
                    --detach \
                    --name "${LOOKUP_CONTAINER_NAME}" \
                    --restart unless-stopped \
                    --publish "${LOOKUP_PORT}:24011" \
                    --env-file "${LOOKUP_DIR}/.env" \
                    "${LOOKUP_IMAGE_NAME}"
                _wait_for_container podman "${LOOKUP_CONTAINER_NAME}" "${LOOKUP_URL}"
            fi

            # open-parcels
            log "Building Podman image '${IMAGE_NAME}'..."
            podman build \
                --file "${PROJECT_DIR}/docker/Dockerfile" \
                --tag  "${IMAGE_NAME}" \
                "${PROJECT_DIR}"
            success "Image built: ${IMAGE_NAME}"

            if podman container exists "${CONTAINER_NAME}" 2>/dev/null; then
                log "Removing existing container '${CONTAINER_NAME}'..."
                podman stop "${CONTAINER_NAME}" &>/dev/null || true
                podman rm   "${CONTAINER_NAME}" &>/dev/null || true
            fi

            _load_env_args "${ENV_FILE}"
            log "Starting '${CONTAINER_NAME}' on port ${PORT}..."
            podman run \
                --detach \
                --name "${CONTAINER_NAME}" \
                --restart unless-stopped \
                --publish "${PORT}:3000" \
                --volume  "${DB_PATH}:/app/data.db:Z" \
                "${ENV_ARGS[@]}" \
                "${IMAGE_NAME}"
            _wait_for_container podman "${CONTAINER_NAME}" "${URL}"
            ;;

        # ── Docker ──────────────────────────────────────────────────────────
        docker)
            # universal-lookup
            if [[ -n "${LOOKUP_DIR}" ]]; then
                log "Building Docker image '${LOOKUP_IMAGE_NAME}'..."
                docker build \
                    --file "${LOOKUP_DIR}/Dockerfile" \
                    --tag  "${LOOKUP_IMAGE_NAME}" \
                    "${LOOKUP_DIR}"
                success "Image built: ${LOOKUP_IMAGE_NAME}"

                if docker container inspect "${LOOKUP_CONTAINER_NAME}" &>/dev/null; then
                    log "Removing existing container '${LOOKUP_CONTAINER_NAME}'..."
                    docker stop "${LOOKUP_CONTAINER_NAME}" &>/dev/null || true
                    docker rm   "${LOOKUP_CONTAINER_NAME}" &>/dev/null || true
                fi

                log "Starting '${LOOKUP_CONTAINER_NAME}' on port ${LOOKUP_PORT}..."
                docker run \
                    --detach \
                    --name "${LOOKUP_CONTAINER_NAME}" \
                    --restart unless-stopped \
                    --publish "${LOOKUP_PORT}:24011" \
                    --env-file "${LOOKUP_DIR}/.env" \
                    "${LOOKUP_IMAGE_NAME}"
                _wait_for_container docker "${LOOKUP_CONTAINER_NAME}" "${LOOKUP_URL}"
            fi

            # open-parcels
            log "Building Docker image '${IMAGE_NAME}'..."
            docker build \
                --file "${PROJECT_DIR}/docker/Dockerfile" \
                --tag  "${IMAGE_NAME}" \
                "${PROJECT_DIR}"
            success "Image built: ${IMAGE_NAME}"

            if docker container inspect "${CONTAINER_NAME}" &>/dev/null; then
                log "Removing existing container '${CONTAINER_NAME}'..."
                docker stop "${CONTAINER_NAME}" &>/dev/null || true
                docker rm   "${CONTAINER_NAME}" &>/dev/null || true
            fi

            _load_env_args "${ENV_FILE}"
            log "Starting '${CONTAINER_NAME}' on port ${PORT}..."
            docker run \
                --detach \
                --name "${CONTAINER_NAME}" \
                --restart unless-stopped \
                --publish "${PORT}:3000" \
                --volume  "${DB_PATH}:/app/data.db" \
                "${ENV_ARGS[@]}" \
                "${IMAGE_NAME}"
            _wait_for_container docker "${CONTAINER_NAME}" "${URL}"
            ;;
    esac
fi

# ══════════════════════════════════════════════════════════════════════════════
# OPEN BROWSER
# ══════════════════════════════════════════════════════════════════════════════
if ${DO_OPEN}; then
    log "Opening ${URL} ..."
    if   command -v xdg-open  &>/dev/null; then xdg-open  "${URL}" &
    elif command -v browse     &>/dev/null; then browse     "${URL}" &
    elif command -v firefox    &>/dev/null; then firefox    "${URL}" &
    elif command -v chromium   &>/dev/null; then chromium   "${URL}" &
    else warn "No browser launcher found — open ${URL} manually."
    fi
fi

success "All done!"

# ══════════════════════════════════════════════════════════════════════════════
# HELPER FUNCTIONS (defined after main flow so they read cleanly at the top)
# ══════════════════════════════════════════════════════════════════════════════

# _load_env_args <env-file>
# Populates ENV_ARGS array with --env KEY=VALUE pairs from the given file.
_load_env_args() {
    local file="$1"
    ENV_ARGS=()
    if [[ -f "${file}" ]]; then
        log "Loading environment from ${file}..."
        while IFS='=' read -r key value || [[ -n "${key}" ]]; do
            [[ -z "${key}" || "${key}" =~ ^[[:space:]]*# ]] && continue
            value="$(echo "${value}" | sed 's/[[:space:]]*#.*//' | xargs)"
            [[ -n "${key}" && -n "${value}" ]] && ENV_ARGS+=("--env" "${key}=${value}")
        done < "${file}"
    fi
}

# _wait_for_container <runtime> <container-name> <url>
_wait_for_container() {
    local runtime="$1"
    local name="$2"
    local url="$3"
    sleep 2
    local status
    status="$("${runtime}" inspect -f '{{.State.Status}}' "${name}" 2>/dev/null || echo "missing")"
    if [[ "${status}" != "running" ]]; then
        warn "Container may not be healthy (status: ${status}). Logs:"
        "${runtime}" logs --tail 30 "${name}" || true
        error "Container '${name}' is not running."
    fi
    success "Container '${name}' is running at ${url}"
    log "Tail logs with:  ${runtime} logs -f ${name}"
}
