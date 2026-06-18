# =============================================================================
# Build y push de la imagen backend-payments a Artifact Registry (solo si no existe)
# =============================================================================
# Uso:
#   make              # muestra esta ayuda (por defecto)
#   make build-push   # build+push si no existe IMAGE:TAG
#   make force        # build+push siempre
#   make check        # solo comprobar si la imagen existe
# Copia .env.example a .env y define ARTIFACT_REGISTRY_URL (minúsculas).
# =============================================================================

MAKEFLAGS += --no-print-directory
.DEFAULT_GOAL := help

.PHONY: help build push build-push check force all _require_env setup-docker-adc

# Cargar .env (raíz del repo o esta carpeta); el resto de variables vienen de .env
-include ../.env
-include .env

# -----------------------------------------------------------------------------
# Configuración: solo valores por defecto necesarios (TAG, BUILD_CONTEXT)
# ARTIFACT_REGISTRY_URL, IMAGE_NAME, DOCKERFILE deben estar en .env
# -----------------------------------------------------------------------------
TAG           ?= $(or $(strip $(shell git rev-parse --short HEAD 2>/dev/null)),latest)
BUILD_CONTEXT ?= ../..

# Imagen completa y datos derivados (requieren ARTIFACT_REGISTRY_URL e IMAGE_NAME en .env)
# URL formato: REGION-docker.pkg.dev/PROJECT/REPO
IMAGE_FULL       := $(ARTIFACT_REGISTRY_URL)/$(IMAGE_NAME):$(TAG)
ARTIFACT_PROJECT := $(shell echo '$(ARTIFACT_REGISTRY_URL)' | cut -d/ -f2)
ARTIFACT_REGION  := $(shell echo '$(ARTIFACT_REGISTRY_URL)' | cut -d/ -f1 | sed 's/-docker.*//')
ARTIFACT_HOST    := $(shell echo '$(ARTIFACT_REGISTRY_URL)' | cut -d/ -f1)
ARTIFACT_REPO    := $(shell echo '$(ARTIFACT_REGISTRY_URL)' | cut -d/ -f3)

# Comando para comprobar si la imagen existe (una sola definición, reutilizada)
GCLOUD_DESCRIBE := gcloud artifacts docker images describe "$(IMAGE_FULL)" \
	--project="$(ARTIFACT_PROJECT)"
# API Docker Registry v2 con token ADC (funciona en no interactivo tras application-default login)
ARTIFACT_MANIFEST_URL := https://$(ARTIFACT_HOST)/v2/$(ARTIFACT_PROJECT)/$(ARTIFACT_REPO)/$(IMAGE_NAME)/manifests/$(TAG)

# -----------------------------------------------------------------------------
# Targets (help por defecto)
# -----------------------------------------------------------------------------
help:
	@echo "Uso: make [target]"
	@echo ""
	@echo "Targets:"
	@echo "  (por defecto)  Muestra esta ayuda"
	@echo "  build-push     Construye y sube la imagen si no existe en el registro"
	@echo "  force          Construye y sube siempre (sobrescribe)"
	@echo "  build          Solo construir imagen"
	@echo "  push           Solo subir imagen (debe existir localmente)"
	@echo "  check          Comprobar si la imagen existe en Artifact Registry"
	@echo "  setup-docker-adc  Configuración única: helper Docker que usa solo ADC (sin gcloud login)."
	@echo ""
	@echo "Imagen actual: $(if $(ARTIFACT_REGISTRY_URL),$(IMAGE_FULL),(definir .env))"
	@echo "Configuración: .env con ARTIFACT_REGISTRY_URL, IMAGE_NAME, DOCKERFILE (cp .env.example .env)."
	@echo "Auth: gcloud auth application-default login. Para push: make setup-docker-adc (una vez)."

all: build-push

# Configuración única: instalar docker-credential-gcr y usarlo para este registro (usa ADC, no gcloud user).
setup-docker-adc:
	@echo "Para que 'make push' use solo ADC (gcloud auth application-default login), configura el helper oficial:"
	@echo ""
	@echo "  1. Descargar docker-credential-gcr:"
	@echo "     VERSION=2.1.29"
	@echo "     curl -fsSL \"https://github.com/GoogleCloudPlatform/docker-credential-gcr/releases/download/v\$${VERSION}/docker-credential-gcr_linux_amd64-\$${VERSION}.tar.gz\" | tar xz"
	@echo "     chmod +x docker-credential-gcr && sudo mv docker-credential-gcr /usr/local/bin/"
	@echo ""
	@echo "  2. Configurar Docker para este registro (usa ADC):"
	@echo "     docker-credential-gcr configure-docker --registries=$(ARTIFACT_HOST)"
	@echo ""
	@echo "  3. Autenticar una vez: gcloud auth application-default login"
	@echo ""
	@echo "Después, make push y make check funcionan sin gcloud auth login (solo ADC)."

# Exige variables desde .env en targets que las usan
_require_env:
	@test -n "$(ARTIFACT_REGISTRY_URL)" || \
		{ echo "Error: ARTIFACT_REGISTRY_URL no definido. Definir en .env (cp .env.example .env)."; exit 1; }
	@test -n "$(IMAGE_NAME)" || \
		{ echo "Error: IMAGE_NAME no definido. Definir en .env."; exit 1; }
	@test -n "$(DOCKERFILE)" || \
		{ echo "Error: DOCKERFILE no definido. Definir en .env."; exit 1; }

# Comprueba si la imagen ya existe. Usa ADC (application-default) para no depender de gcloud user login.
check: _require_env
	@echo "Comprobando si existe $(IMAGE_FULL)..."; \
	token=$$(gcloud auth application-default print-access-token 2>&1); ret=$$?; \
	if [ $$ret -ne 0 ]; then \
		echo "Error: no se pudieron obtener credenciales (ADC). Ejecuta: gcloud auth application-default login" >&2; \
		echo "$$token" >&2; exit 1; \
	fi; \
	code=$$(curl -s -o /dev/null -w "%{http_code}" \
		-H "Authorization: Bearer $$token" \
		"$(ARTIFACT_MANIFEST_URL)"); \
	if [ "$$code" = "200" ] || [ "$$code" = "202" ]; then \
		echo "La imagen ya existe."; exit 0; \
	fi; \
	if [ "$$code" = "404" ]; then \
		echo "La imagen no existe."; exit 0; \
	fi; \
	echo "Error al conectar con Artifact Registry (HTTP $$code). Comprueba proyecto, repo y permisos." >&2; exit 1

build: _require_env
	@echo "Construyendo imagen $(IMAGE_FULL)..."
	@cd "$(BUILD_CONTEXT)" && docker build -f "$(DOCKERFILE)" -t "$(IMAGE_FULL)" \
		--build-arg VERSION="$(TAG)" \
		--build-arg GIT_COMMIT="$$(git rev-parse HEAD 2>/dev/null || echo)" \
		--build-arg GIT_BRANCH="$$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo)" \
		.

# Push usa las credenciales que Docker tenga para el registro (ADC vía docker-credential-gcr).
push: _require_env
	@echo "Subiendo $(IMAGE_FULL)..."; \
	docker push "$(IMAGE_FULL)"

# Build+push solo si la imagen no existe (usa ADC como check)
build-push: _require_env
	@token=$$(gcloud auth application-default print-access-token 2>/dev/null); \
	if [ -z "$$token" ]; then \
		echo "Error: ejecuta gcloud auth application-default login" >&2; exit 1; \
	fi; \
	code=$$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $$token" "$(ARTIFACT_MANIFEST_URL)"); \
	if [ "$$code" = "404" ]; then \
		$(MAKE) build && $(MAKE) push; \
	else \
		echo "Imagen $(IMAGE_FULL) ya existe (HTTP $$code). Usa 'make force' para forzar build+push."; \
	fi

# Siempre build y push
force: build push
