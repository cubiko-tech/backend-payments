#!/usr/bin/env bash
set -eo pipefail

# Load .env if exists
if [[ -f .env ]]; then
  set -a
  source ".env"
  set +a
fi

echo "${0}: Install dependencies."
if [[ $ENV == "development" ]]; then
  npm run create-db || true
  npm install
else
  npm install --omit=dev
fi

echo "${0}: Compiling code."
rm -rf ./dist
npm run build

echo "${0}: Running migrations."
npm run migration:run

echo "${0}: Loading core fixtures (idempotent upsert; no-op si core/ vacío)."
npm run fixtures:core || true

# Dev fixtures. No generamos migraciones automáticamente: hacerlo en cada
# restart crea archivos cruft cuando entities y BD divergen por nombres
# hash-generated de TypeORM. Para generar una migración el dev corre a mano:
#   npm run migration:generate --name=Feature
if [[ $ENV == "development" ]]; then
  npm run fixtures:dev || true
fi

echo "${0}: Starting server."
if [[ $ENV == "development" ]]; then
  npm run start:dev
else
  if [[ $RUN == "stag" ]]; then
    npm run start:stag
  else
    npm run start:prod
  fi
fi
