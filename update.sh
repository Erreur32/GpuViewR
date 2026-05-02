#!/usr/bin/env bash
# ============================================================
# GpuViewR: auto-update script
# Usage:
#   ./update.sh             pull latest image, backup data, restart
#   ./update.sh --check     check whether a newer image is available
#   ./update.sh --rollback  restore the previous image + data backup
# ============================================================
set -euo pipefail

cd "$(dirname "$0")"

IMAGE="${GPUVIEWR_IMAGE:-ghcr.io/erreur32/gpuviewr:latest}"
PREV_TAG="ghcr.io/erreur32/gpuviewr:previous"
DATA_DIR="./data"
BACKUP_ROOT="./backups"
COMPOSE="docker compose"

color() { printf "\033[%sm%s\033[0m" "$1" "$2"; }
info()  { echo "$(color '1;34' '→') $*"; }
ok()    { echo "$(color '1;32' '✓') $*"; }
warn()  { echo "$(color '1;33' '!') $*"; }
err()   { echo "$(color '1;31' '✗') $*" >&2; }

require_compose() {
  if ! command -v docker >/dev/null 2>&1; then
    err "docker not found"; exit 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    err "docker compose plugin not found"; exit 1
  fi
}

cmd_check() {
  info "Checking for updates..."
  local local_digest remote_digest
  local_digest="$(docker image inspect "${IMAGE}" --format '{{.Id}}' 2>/dev/null || echo 'none')"
  docker pull "${IMAGE}" >/dev/null
  remote_digest="$(docker image inspect "${IMAGE}" --format '{{.Id}}' 2>/dev/null || echo 'none')"
  if [ "${local_digest}" = "${remote_digest}" ]; then
    ok "Already on the latest version (${remote_digest:0:19})"
    exit 0
  fi
  warn "Update available"
  echo "  current : ${local_digest}"
  echo "  latest  : ${remote_digest}"
  echo "Run './update.sh' to apply."
}

cmd_rollback() {
  info "Rolling back to previous image..."
  if ! docker image inspect "${PREV_TAG}" >/dev/null 2>&1; then
    err "No previous image found (${PREV_TAG})"
    exit 1
  fi
  local last_backup
  last_backup="$(ls -1t "${BACKUP_ROOT}"/data-*.tar.gz 2>/dev/null | head -n1 || true)"
  if [ -z "${last_backup}" ]; then
    warn "No data backup found: rolling back image only"
  else
    info "Restoring data from ${last_backup}"
    rm -rf "${DATA_DIR}"
    mkdir -p "${DATA_DIR}"
    tar -xzf "${last_backup}" -C "${DATA_DIR}" --strip-components=1
  fi
  docker tag "${PREV_TAG}" "${IMAGE}"
  ${COMPOSE} up -d --force-recreate
  ok "Rollback complete"
}

cmd_update() {
  info "Backing up data..."
  mkdir -p "${BACKUP_ROOT}"
  local stamp ts
  ts="$(date +%Y%m%d-%H%M%S)"
  stamp="${BACKUP_ROOT}/data-${ts}.tar.gz"
  if [ -d "${DATA_DIR}" ] && [ "$(ls -A "${DATA_DIR}" 2>/dev/null || true)" ]; then
    tar -czf "${stamp}" "${DATA_DIR}"
    ok "Backup written to ${stamp}"
  else
    warn "Data dir empty: no backup needed"
  fi

  if docker image inspect "${IMAGE}" >/dev/null 2>&1; then
    info "Tagging current image as previous"
    docker tag "${IMAGE}" "${PREV_TAG}"
  fi

  info "Pulling latest image..."
  ${COMPOSE} pull

  info "Restarting service..."
  ${COMPOSE} up -d --force-recreate

  info "Pruning dangling images..."
  docker image prune -f >/dev/null

  # Trim old backups (keep last 10)
  ls -1t "${BACKUP_ROOT}"/data-*.tar.gz 2>/dev/null | tail -n +11 | xargs -r rm -f

  ok "Update complete"
  echo
  ${COMPOSE} ps
}

main() {
  require_compose
  case "${1:-update}" in
    --check|-c|check)        cmd_check ;;
    --rollback|-r|rollback)  cmd_rollback ;;
    --help|-h|help)
      sed -n '3,9p' "$0" ;;
    update|"")               cmd_update ;;
    *)
      err "Unknown option: $1"
      sed -n '3,9p' "$0"
      exit 2 ;;
  esac
}

main "$@"
