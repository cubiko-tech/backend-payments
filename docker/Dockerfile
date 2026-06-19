# ==========================================================================
# backend-payments — Imagen autocontenida para deploy
# ==========================================================================
# Build: docker build -f docker/Dockerfile -t backend-payments .
# Run:   docker run --env-file .env backend-payments
# ==========================================================================

FROM node:22.16-alpine AS builder

RUN apk add --no-cache bash

WORKDIR /code

# Dependencias (cache layer)
COPY package.json package-lock.json* .npmrc ./
RUN npm install

# Codigo fuente
COPY . .

# Build
RUN npm run build

# --- Runtime ---
FROM node:22.16-alpine

RUN apk add --no-cache bash wget

WORKDIR /code

# Dependencias de produccion
COPY package.json package-lock.json* .npmrc ./
RUN npm install --omit=dev

# Config files (TypeORM migrations need these)
COPY --from=builder /code/tsconfig.json ./
COPY --from=builder /code/nest-cli.json ./

# Codigo compilado + assets
COPY --from=builder /code/dist ./dist
COPY --from=builder /code/migrations ./migrations

# Entrypoint para imagen (no el de desarrollo)
COPY docker/entrypoint.sh ./entrypoint.sh
RUN chmod +x entrypoint.sh

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=60s \
  CMD wget --no-verbose --tries=1 --spider http://localhost/health/ready || exit 1

CMD ["./entrypoint.sh"]
