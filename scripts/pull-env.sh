#!/usr/bin/env bash
# ==========================================================================
# pull-env.sh — Descargar variables de Infisical a .env local
# ==========================================================================
# Descarga los secretos de la carpeta del servicio en Infisical
# y genera el archivo .env local.
#
# Uso:
#   ./scripts/pull-env.sh                          # development
#   ./scripts/pull-env.sh --env staging             # otro ambiente
#   ./scripts/pull-env.sh --path /shared            # otra carpeta
#   ./scripts/pull-env.sh --out .env.staging        # otro archivo destino
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

INFISICAL_ENV="local"
SECRET_PATH=""
OUT_FILE=".env"

# --- Parse args -----------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case $1 in
    --env)  INFISICAL_ENV="$2"; shift 2 ;;
    --path) SECRET_PATH="$2"; shift 2 ;;
    --out)  OUT_FILE="$2"; shift 2 ;;
    --help|-h)
      echo "Uso: pull-env.sh [opciones]"
      echo ""
      echo "  --env ENV       Ambiente (default: development)"
      echo "  --path /folder  Carpeta en Infisical (default: /<servicio>)"
      echo "  --out .env      Archivo destino (default: .env)"
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

OUT_PATH="${SERVICE_DIR}/${OUT_FILE}"

# --- Funcion para descargar secretos de un path --------------------------

fetch_secrets() {
  local path="$1"
  curl -sf -X GET \
    "${INFISICAL_URL}/api/v3/secrets/raw?environment=${INFISICAL_ENV}&workspaceId=${PROJECT_ID}&secretPath=${path}&expandSecretReferences=true" \
    -H "Authorization: Bearer ${TOKEN}" \
    2>/dev/null || echo '{"secrets":[]}'
}

# --- Descargar secretos ---------------------------------------------------

echo "Pull: /shared + ${SECRET_PATH} (${INFISICAL_ENV}) -> ${OUT_FILE}"
echo ""

SHARED=$(fetch_secrets "/shared")
SERVICE=$(fetch_secrets "${SECRET_PATH}")

SHARED_COUNT=$(echo "$SHARED" | jq '.secrets | length' 2>/dev/null || echo "0")
SERVICE_COUNT=$(echo "$SERVICE" | jq '.secrets | length' 2>/dev/null || echo "0")
TOTAL=$((SHARED_COUNT + SERVICE_COUNT))

if [ "$TOTAL" = "0" ]; then
  echo "No hay secretos en /shared ni ${SECRET_PATH} (${INFISICAL_ENV})"
  exit 0
fi

# --- Generar .env ---------------------------------------------------------
# Shared first, then service (service overrides shared if duplicated)

{
  echo "# Generado desde Infisical (${INFISICAL_ENV})"
  echo "# /shared ($SHARED_COUNT) + ${SECRET_PATH} ($SERVICE_COUNT)"
  echo "# $(date '+%Y-%m-%d %H:%M:%S')"
  echo ""
  JQ_FILTER='.secrets[] | if ((.secretValue // "") | tostring | contains("\n")) then "\(.secretKey)=\(.secretValue|@sh)" else "\(.secretKey)=\(.secretValue)" end'
  echo "$SHARED" | jq -r "$JQ_FILTER" 2>/dev/null
  echo "$SERVICE" | jq -r "$JQ_FILTER" 2>/dev/null
} > "$OUT_PATH"

echo "Listo: $TOTAL variables descargadas a ${OUT_FILE} ($SHARED_COUNT shared + $SERVICE_COUNT service)"
