#!/usr/bin/env bash
# ==========================================================================
# refresh-env-remote.sh — corre EN LA VM, lo invoca .github/workflows/refresh-env.yml
# ==========================================================================
# Reemplaza el `.env` del servicio por el de Infisical CONSERVANDO las cuatro
# variables que son del despliegue vivo y no de Infisical, y recrea el
# contenedor en su MISMO slot.
#
# Por qué existe como archivo y no como un `sudo bash -c '…'` incrustado en el
# YAML: la versión incrustada acumuló cuatro bugs que ningún reviewer vio,
# porque leer bash con tres niveles de comillas dentro de un `--command=` de
# gcloud dentro de un `run: |` de GitHub no es leer. Acá se puede correr con
# `bash -n`, se puede leer, y el shellcheck lo alcanza.
#
# Uso: refresh-env-remote.sh <deploy_path> <env_nuevo> <var_de_imagen>
# ==========================================================================
set -euo pipefail

DEPLOY_PATH="${1:?falta el directorio del servicio}"
ENV_NUEVO="${2:?falta el .env descargado de Infisical}"
IMAGE_VAR="${3:?falta el nombre de la variable de imagen}"

ENV_ACTUAL="${DEPLOY_PATH}/.env"

# Las cuatro que NO vienen de Infisical y sin las cuales el servicio no vuelve
# a levantar igual:
#
#   - la variable de imagen no está en Infisical en NINGÚN ambiente (verificado
#     el 2026-09-07 contra `development` y `production`): la escribe el deploy.
#     Sin ella `image:` queda vacío y el compose ni arranca.
#   - CONTAINER_IP/NUMBER/SLUG en Infisical son el valor BASE
#     (`roax-payments` / `4` / `192.160.4.2`), no el del slot vivo, que lo
#     calcula `deploy.yml` escaneando IPs libres. Tomarlos de Infisical recrea
#     un contenedor con otro nombre y otra IP mientras el upstream del gateway
#     sigue apuntando al que estaba: ruteo roto y el viejo todavía corriendo.
CLAVES_DEL_DESPLIEGUE=("$IMAGE_VAR" CONTAINER_IP CONTAINER_NUMBER CONTAINER_SLUG)

if [ ! -f "$ENV_ACTUAL" ]; then
  echo "::error::No hay ${ENV_ACTUAL}. Este workflow REFRESCA un servicio ya desplegado; el primer deploy lo hace deploy.yml" >&2
  exit 1
fi

# Se leen del `.env` vivo ANTES de tocar nada. `cut -d= -f2-` y no `-f2`: un
# valor con `=` adentro se truncaría.
declare -A PRESERVADAS=()
for clave in "${CLAVES_DEL_DESPLIEGUE[@]}"; do
  valor="$(grep -m1 "^${clave}=" "$ENV_ACTUAL" | cut -d= -f2- || true)"
  if [ -z "$valor" ]; then
    echo "::error::${clave} no está en ${ENV_ACTUAL}. Sin ese valor el servicio no vuelve a levantar en su slot, así que no se escribe nada" >&2
    exit 1
  fi
  PRESERVADAS["$clave"]="$valor"
done

SLUG="${PRESERVADAS[CONTAINER_SLUG]}"
IMAGEN="${PRESERVADAS[$IMAGE_VAR]}"

# El `.env` nuevo se arma COMPLETO en un temporal y recién al final reemplaza al
# vivo. Un fallo a mitad no puede dejar el archivo a medio escribir.
TMP_ENV="$(mktemp)"
trap 'rm -f "$TMP_ENV"' EXIT

# Las claves preservadas se filtran del volcado de Infisical y se reescriben
# abajo: si quedaran las dos, `source` tomaría la ÚLTIMA, y depender del orden
# de un archivo generado es justo lo que rompe en producción y no en dev.
grep -vE "^($(IFS='|'; echo "${CLAVES_DEL_DESPLIEGUE[*]}"))=" "$ENV_NUEVO" > "$TMP_ENV"

{
  echo ""
  echo "# Del despliegue vivo, NO de Infisical — ver refresh-env-remote.sh"
  for clave in "${CLAVES_DEL_DESPLIEGUE[@]}"; do
    echo "${clave}=${PRESERVADAS[$clave]}"
  done
} >> "$TMP_ENV"

# Copia de seguridad con marca de tiempo: si el refresco deja el servicio mal,
# el archivo anterior sigue ahí para volver.
cp "$ENV_ACTUAL" "${ENV_ACTUAL}.bak-$(date -u '+%Y%m%d%H%M%S')"
cp "$TMP_ENV" "$ENV_ACTUAL"
rm -f "$ENV_NUEVO"

cd "$DEPLOY_PATH"

# El registro sale de la imagen PRESERVADA, no de un grep sobre el `.env` recién
# escrito: la versión anterior grepeaba después de sobreescribir, así que leía
# justo el archivo donde la variable ya no estaba.
REGISTRY="$(echo "$IMAGEN" | cut -d/ -f1)"
gcloud auth configure-docker "$REGISTRY" --quiet 2>/dev/null || true

# `-p "$SLUG"` es obligatorio: sin él compose usa el nombre del directorio como
# proyecto, no reconoce al contenedor vivo como suyo y levanta uno AL LADO en
# vez de recrearlo.
docker compose --env-file .env \
  -f docker/docker-compose.image.yml \
  -p "$SLUG" up -d --force-recreate

echo "Recreado ${SLUG} con el .env nuevo"
docker ps --filter "name=${SLUG}"
