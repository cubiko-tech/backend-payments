#!/bin/bash
set -e

# Load .env if exists
if [ -f ".env" ]; then
  set -a && source .env && set +a
fi

echo "Running migrations..."
./node_modules/.bin/typeorm migration:run -d ./dist/src/orm/write.js

echo "Starting server..."
if [ "$RUN" = "stag" ]; then
  npm run start:stag
else
  npm run start:prod
fi
