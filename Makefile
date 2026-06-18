# backend-payments — Makefile
MAKEFLAGS += --no-print-directory
.DEFAULT_GOAL := help

ifneq (,$(wildcard .env))
	include .env
	export $(shell sed 's/=.*//' .env)
endif

ENV_FILE ?= .env
DOCKER_COMPOSE := $(shell docker compose version >/dev/null 2>&1 && echo "docker compose" || echo "docker-compose")
COMPOSE_CMD := $(DOCKER_COMPOSE) --env-file $(ENV_FILE)

# === Docker ===
up: ## Levantar servicio
	@$(COMPOSE_CMD) up -d --build

down: ## Detener servicio
	@$(COMPOSE_CMD) down

restart: down up ## Reiniciar

logs: ## Ver logs
	@$(COMPOSE_CMD) logs -f

ps: ## Estado
	@$(COMPOSE_CMD) ps

build: ## Rebuild sin cache
	@$(COMPOSE_CMD) build --no-cache

shell: ## Shell en contenedor
	@$(COMPOSE_CMD) exec $(CONTAINER_SLUG) bash

health: ## Health check
	@curl -sf http://$(CONTAINER_IP)/health/ready && echo " OK" || echo " FAIL"

# === Desarrollo ===
dev: ## Desarrollo local (sin Docker)
	@npm run start:dev

install: ## Instalar dependencias
	@npm install

# === Base de datos ===
migrate: ## Correr migraciones
	@$(COMPOSE_CMD) exec $(CONTAINER_SLUG) npm run migration:run

migrate-generate: ## Generar migracion desde cambios de entidad
	@$(COMPOSE_CMD) exec $(CONTAINER_SLUG) npm run migration:generate --name=$(name)

migrate-revert: ## Revertir ultima migracion
	@$(COMPOSE_CMD) exec $(CONTAINER_SLUG) npm run migration:revert

migrate-show: ## Mostrar estado de migraciones
	@$(COMPOSE_CMD) exec $(CONTAINER_SLUG) npm run migration:show

# === Tests ===
test: ## Correr tests
	@npx jest --passWithNoTests

verify: ## Lint + tests con cobertura
	@npm run verify

# === Docker produccion ===
build-image: ## Construir imagen de produccion
	@docker build -f docker/Dockerfile -t backend-payments:latest .

test-image: ## Probar imagen de produccion (requiere .env)
	@$(DOCKER_COMPOSE) --env-file $(ENV_FILE) -f docker/docker-compose.image.yml up -d

teardown-image: ## Detener imagen de produccion
	@$(DOCKER_COMPOSE) --env-file $(ENV_FILE) -f docker/docker-compose.image.yml down

# === Ayuda ===
help: ## Ayuda
	@awk 'BEGIN {FS = ":.*##"; printf "\n\033[1mbackend-payments:\033[0m\n\n"} /^[a-zA-Z_-]+:.*?##/ {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2} END {printf "\n"}' $(MAKEFILE_LIST)

.PHONY: up down restart logs ps build shell health dev install migrate migrate-generate migrate-revert migrate-show test verify build-image test-image teardown-image help
