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

# RUN_MIGRATIONS and RUN_FIXTURES default to on; a second container on a shared base (a work line) turns them off so
# it neither migrates that base nor rewrites its seeded data.
run_migrations=${RUN_MIGRATIONS:-true}
run_fixtures=${RUN_FIXTURES:-true}

if [[ $run_migrations != "false" ]]; then
  echo "${0}: Running migrations."
  npm run migration:run
fi

if [[ $run_fixtures != "false" ]]; then
  echo "${0}: Loading core fixtures (idempotent upsert; no-op si core/ vacío)."
  npm run fixtures:core || true
fi

# Dev fixtures. No generamos migraciones automáticamente: hacerlo en cada
# restart crea archivos cruft cuando entities y BD divergen por nombres
# hash-generated de TypeORM. Para generar una migración el dev corre a mano:
#   npm run migration:generate --name=Feature
if [[ $ENV == "development" && $run_fixtures != "false" ]]; then
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
