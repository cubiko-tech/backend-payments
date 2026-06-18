#!/usr/bin/env bash
# ==========================================================================
# sync-env.sh — Sincronizar .env local a Infisical
# ==========================================================================
# Sube las variables de un .env local a la carpeta del servicio en
# Infisical. Crea variables nuevas y actualiza existentes.
#
# Uso:
#   ./scripts/sync-env.sh                          # development
#   ./scripts/sync-env.sh --env staging             # otro ambiente
#   ./scripts/sync-env.sh --path /shared --file .env.shared
#   ./scripts/sync-env.sh --dry-run                 # ver sin ejecutar
#
# Configuracion (en .env.infisical o variables de entorno):
#   INFISICAL_URL        — URL de Infisical (requerido)
#   INFISICAL_TOKEN      — Token de acceso (requerido)
#   INFISICAL_PROJECT_ID — ID del proyecto (requerido)
# ==========================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_FILE="${SERVICE_DIR}/.env.infisical"

# --- Cargar config --------------------------------------------------------

if [ -f "$CONFIG_FILE" ]; then
  # shellcheck disable=SC1090
  set -a && source "$CONFIG_FILE" && set +a
fi

INFISICAL_URL="${INFISICAL_URL:?Falta INFISICAL_URL (en .env.infisical o variable de entorno)}"
TOKEN="${INFISICAL_TOKEN:?Falta INFISICAL_TOKEN (en .env.infisical o variable de entorno)}"
PROJECT_ID="${INFISICAL_PROJECT_ID:?Falta INFISICAL_PROJECT_ID (en .env.infisical o variable de entorno)}"

# --- Defaults -------------------------------------------------------------

ENV_FILE=".env"
INFISICAL_ENV="local"
SECRET_PATH=""
DRY_RUN=false

# --- Parse args -----------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case $1 in
    --env)     INFISICAL_ENV="$2"; shift 2 ;;
    --path)    SECRET_PATH="$2"; shift 2 ;;
    --file)    ENV_FILE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --help|-h)
      echo "Uso: sync-env.sh [opciones]"
      echo ""
      echo "  --env ENV       Ambiente (default: development)"
      echo "  --path /folder  Carpeta en Infisical (default: /<servicio>)"
      echo "  --file .env     Archivo a leer (default: .env)"
      echo "  --dry-run       Ver sin ejecutar"
      exit 0
      ;;
    *) echo "Opcion desconocida: $1"; exit 1 ;;
  esac
done

# --- Detectar path --------------------------------------------------------

if [ -z "$SECRET_PATH" ]; then
  if [ -f "${SERVICE_DIR}/.env.schema" ]; then
    SERVICE=$(grep '^service:' "${SERVICE_DIR}/.env.schema" \
      | awk '{print $2}')
    SECRET_PATH="/${SERVICE}"
  else
    SECRET_PATH="/$(basename "$SERVICE_DIR")"
  fi
fi

# --- Validar .env ---------------------------------------------------------

ENV_PATH="${SERVICE_DIR}/${ENV_FILE}"
if [ ! -f "$ENV_PATH" ]; then
  echo "ERROR: ${ENV_FILE} no encontrado en ${SERVICE_DIR}"
  exit 1
fi

# --- Helpers --------------------------------------------------------------

api() {
  local method="$1" endpoint="$2"
  shift 2
  curl -sf -X "$method" \
    "${INFISICAL_URL}${endpoint}" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    "$@" 2>/dev/null
}

# --- Obtener secretos existentes ------------------------------------------

echo "Sync: ${ENV_FILE} -> ${SECRET_PATH} (${INFISICAL_ENV})"
echo ""

EXISTING=$(api GET \
  "/api/v3/secrets/raw?environment=${INFISICAL_ENV}&workspaceId=${PROJECT_ID}&secretPath=${SECRET_PATH}") || true
EXISTING_KEYS=$(echo "$EXISTING" \
  | jq -r '.secrets[].secretKey // empty' 2>/dev/null || echo "")

CREATED=0
UPDATED=0

# Parsea el .env source-eandolo en un subshell limpio (env -i) y enumera las
# vars que el archivo realmente define (diff before/after). Esto maneja
# valores multi-linea entre comillas (ej. JSON de service-account keys que
# emite pull-env via @sh) que el cut -d= -f2- linea-por-linea destrozaba.
# Emite parejas KEY\0VALUE\0 separadas por NUL para preservar newlines.
emit_env_pairs() {
  env -i ENV_PATH="$1" bash <<'INNER'
declare -A _before
for _v in $(compgen -e); do _before[$_v]=1; done
set -a
# shellcheck disable=SC1090
source "$ENV_PATH" 2>/dev/null || true
set +a
for _v in $(compgen -e); do
  if [[ -z "${_before[$_v]:-}" ]]; then
    printf '%s\0%s\0' "$_v" "${!_v}"
  fi
done
INNER
}

while IFS= read -r -d '' KEY && IFS= read -r -d '' VALUE; do
  [ -z "$KEY" ] && continue

  if echo "$EXISTING_KEYS" | grep -qx "$KEY"; then
    if [ "$DRY_RUN" = true ]; then
      echo "  [actualizar] $KEY"
    else
      api PATCH "/api/v3/secrets/raw/${KEY}" \
        -d "$(jq -n \
          --arg env "$INFISICAL_ENV" \
          --arg ws "$PROJECT_ID" \
          --arg path "$SECRET_PATH" \
          --arg val "$VALUE" \
          '{environment:$env,workspaceId:$ws,
            secretPath:$path,secretValue:$val}')" \
        >/dev/null 2>&1 \
        && UPDATED=$((UPDATED + 1)) \
        || echo "  ERROR: $KEY"
    fi
  else
    if [ "$DRY_RUN" = true ]; then
      echo "  [crear] $KEY"
    else
      api POST "/api/v3/secrets/raw/${KEY}" \
        -d "$(jq -n \
          --arg env "$INFISICAL_ENV" \
          --arg ws "$PROJECT_ID" \
          --arg path "$SECRET_PATH" \
          --arg val "$VALUE" \
          --arg key "$KEY" \
          '{environment:$env,workspaceId:$ws,
            secretPath:$path,secretValue:$val,
            secretKey:$key}')" \
        >/dev/null 2>&1 \
        && CREATED=$((CREATED + 1)) \
        || echo "  ERROR: $KEY"
    fi
  fi
done < <(emit_env_pairs "$ENV_PATH")

echo ""
if [ "$DRY_RUN" = true ]; then
  echo "Dry run (sin cambios)"
else
  echo "Listo: $CREATED creados, $UPDATED actualizados"
fi
