#!/usr/bin/env bash
#
# update-containers.sh — Blue-green container swap with upstream registration
#
# Usage:
#   ./update-containers.sh <container-slug>
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
readonly ENV_FILE=".env"
readonly HEALTH_MAX_ATTEMPTS=20
readonly HEALTH_INTERVAL=30
readonly GATEWAY_API_PORT="10341"
readonly UPSTREAM_CONF="platform"
readonly UPSTREAM_STREAM="payments"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log()   { printf '[INFO]  %s\n' "$*"; }
warn()  { printf '[WARN]  %s\n' "$*" >&2; }
die()   { printf '[ERROR] %s\n' "$*" >&2; exit 1; }

# Load .env
load_env() {
  [[ -f "$ENV_FILE" ]] || die "$ENV_FILE not found"
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
}

# Require a variable to be set and non-empty
require_var() {
  local name="$1"
  [[ -n "${!name:-}" ]] || die "Variable $name is not defined in $ENV_FILE"
}

# ---------------------------------------------------------------------------
# Resolve gateway path (sibling or deps/)
# ---------------------------------------------------------------------------
resolve_gateway_dir() {
  local candidates=("../gateway" "deps/gateway")
  for dir in "${candidates[@]}"; do
    if [[ -d "$dir" ]]; then
      echo "$dir"
      return 0
    fi
  done
  return 1
}

# ---------------------------------------------------------------------------
# Upstream management (add/rm)
# ---------------------------------------------------------------------------
manage_upstream() {
  local action="$1" ip="$2"
  local gateway_dir

  # Prefer local script if gateway repo is available
  if gateway_dir=$(resolve_gateway_dir) && [[ -f "${gateway_dir}/task/upstream.sh" ]]; then
    log "Using local upstream script: ${gateway_dir}/task/upstream.sh ${action} ${ip}"
    bash "${gateway_dir}/task/upstream.sh" "$action" "$ip" "$UPSTREAM_STREAM"
    return
  fi

  # Fallback: call gateway Lua API directly
  log "Using gateway API: ${action} ${ip}"
  require_var SECURE_TOKEN
  require_var IP_NGINX
  local gateway_url="http://${IP_NGINX}:${GATEWAY_API_PORT}/lua/upstream"
  curl -s -X POST "$gateway_url" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${SECURE_TOKEN}" \
    -d "{
      \"action\": \"${action}\",
      \"ip\": \"${ip}\",
      \"conf\": \"${UPSTREAM_CONF}\",
      \"stream\": \"${UPSTREAM_STREAM}\"
    }" || warn "Upstream ${action} failed for ${ip}"
}

# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------
wait_healthy() {
  local slug="$1"
  log "Waiting for ${slug} to become healthy..."

  for i in $(seq 1 "$HEALTH_MAX_ATTEMPTS"); do
    local status
    status=$(docker inspect --format='{{.State.Health.Status}}' "$slug" 2>/dev/null || echo "not_found")

    case "$status" in
      healthy)
        log "Container ${slug} is healthy (attempt ${i})"
        return 0
        ;;
      unhealthy)
        die "Container ${slug} is unhealthy"
        ;;
      *)
        log "Health check attempt ${i}/${HEALTH_MAX_ATTEMPTS}: ${status}"
        sleep "$HEALTH_INTERVAL"
        ;;
    esac
  done

  die "Timeout waiting for ${slug} to become healthy"
}

# ---------------------------------------------------------------------------
# Reload gateway
# ---------------------------------------------------------------------------
# Recarga nginx via SIGHUP al master (zero-downtime). docker exec corre
# como root dentro del contenedor, único contexto privilegiado que puede
# signalar al master desde fuera del worker (nobody). Usamos pkill directo
# en vez de `sh -c 'kill -HUP $(pgrep ...)'` porque el subshell recibía el
# propio SIGHUP del reload y retornaba 129 aunque la señal llegaba.
reload_gateway() {
  local gateway
  gateway=$(docker ps --filter "network=cubiko" --format '{{.Names}}\t{{.Image}}' \
    | awk -F'\t' '$2 ~ /openresty|nginx|gateway/ {print $1; exit}')

  if [[ -z "$gateway" ]]; then
    warn "No gateway container found on cubiko network. Skipping reload."
    return
  fi

  log "Reloading gateway ($gateway) ..."
  if docker exec "$gateway" pkill -HUP -f "nginx: master" 2>/dev/null; then
    log "Gateway reloaded (SIGHUP)."
  else
    warn "SIGHUP failed; falling back to restart."
    docker restart "$gateway"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  local new_slug="${1:-}"
  [[ -n "$new_slug" ]] || die "Usage: $0 <container-slug>"

  load_env
  require_var CONTAINER_NAME
  require_var CONTAINER_IP

  local new_ip="$CONTAINER_IP"

  # Wait for new container to be healthy
  wait_healthy "$new_slug"

  # Register new upstream
  manage_upstream "add" "$new_ip"

  # Find and stop old containers (same CONTAINER_NAME, different slug)
  # Use exact name match to avoid catching unrelated services.
  log "Looking for old containers (${CONTAINER_NAME}-[0-9]+)..."
  for cid in $(docker ps --format '{{.ID}} {{.Names}}' | grep -E " ${CONTAINER_NAME}-[0-9]+$" | awk '{print $1}'); do
    local name
    name=$(docker inspect --format='{{.Name}}' "$cid" | sed 's|^/||')
    if [[ "$name" != "$new_slug" ]]; then
      local old_ip
      old_ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$cid")
      log "Removing old container: ${name} (${old_ip})"
      manage_upstream "rm" "$old_ip"
      docker stop "$cid" --time 30 >/dev/null 2>&1 || true
      docker rm "$cid" >/dev/null 2>&1 || true
    fi
  done

  reload_gateway

  log "Blue-green swap complete for ${UPSTREAM_CONF}"
}

main "$@"
