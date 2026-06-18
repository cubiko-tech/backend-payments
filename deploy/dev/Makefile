# ==========================================================================
# Makefile — backend-payments en VM dev
# ==========================================================================
# Despliega backend-payments a la VM dev creada por gateway.
# Requiere que local-deps (PG + Redis) ya esten corriendo.
#
# Uso rapido:
#   make deploy        # Primer deploy (pull imagen + levantar)
#   make redeploy      # Re-pull imagen + recrear
#   make update-env    # Subir nuevo .env + recrear
#   make refresh-env   # Pull Infisical dev + subir + recrear
#   make logs          # Ver logs
# ==========================================================================

MAKEFLAGS += --no-print-directory
.DEFAULT_GOAL := help

VM_NAME    ?= roax-dev
VM_ZONE    ?= us-central1-a
SERVICE    := backend-payments
ENV_FILE   := envs/backend-payments.env
VM_DIR     := /opt/$(SERVICE)
IMAGE_TAG  ?= develop
IMAGE_REPO ?= us-central1-docker.pkg.dev/core-plate-443813-d1/roax
IMAGE_REF  := $(IMAGE_REPO)/$(SERVICE):$(IMAGE_TAG)
IMAGE_VAR  := BACKEND_PAYMENTS_IMAGE

COMPOSE_CMD = sudo docker compose --env-file .env \
              -f docker/docker-compose.image.yml

define GCLOUD_SSH
gcloud compute ssh "$(VM_NAME)" \
  --zone="$(VM_ZONE)" --tunnel-through-iap
endef

define GCLOUD_SCP
gcloud compute scp $(1) $(2) \
  --zone="$(VM_ZONE)" --tunnel-through-iap
endef

.PHONY: help deploy ship redeploy update-env refresh-env \
        logs shell status restart stop \
        migrate

help: ## Mostrar esta ayuda
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' Makefile \
		| sort \
		| awk 'BEGIN {FS = ":.*?## "}; \
		  {printf "\033[36m%-18s\033[0m %s\n", $$1, $$2}'

# --- Deploy -----------------------------------------------------------

ship: ## Build+push imagen local y desplegar blue-green (todo-en-uno)
	@../../scripts/pull-env.sh --env development --out deploy/dev/$(ENV_FILE)
	@$(MAKE) -C ../artifact-build force
	@$(MAKE) deploy

deploy: ## Deploy blue-green (usa imagen YA existente en Artifact Registry)
	@echo "==> Desplegando $(SERVICE):$(IMAGE_TAG) en $(VM_NAME)..."
	@$(GCLOUD_SSH) --command="\
		sudo mkdir -p $(VM_DIR)/docker \
		&& sudo chown -R \$$(whoami):\$$(whoami) $(VM_DIR)"
	@$(call GCLOUD_SCP,\
		../../docker/docker-compose.image.yml,\
		"$(VM_NAME)":$(VM_DIR)/docker/docker-compose.image.yml)
	@$(call GCLOUD_SCP,\
		../../update-containers.sh,\
		"$(VM_NAME)":$(VM_DIR)/update-containers.sh)
	@$(call GCLOUD_SCP,\
		$(ENV_FILE),\
		"$(VM_NAME)":/tmp/$(SERVICE).env)
	@$(GCLOUD_SSH) --command="\
		echo '' >> /tmp/$(SERVICE).env && \
		echo '$(IMAGE_VAR)=$(IMAGE_REF)' >> /tmp/$(SERVICE).env && \
		sudo cp /tmp/$(SERVICE).env $(VM_DIR)/.env && \
		rm /tmp/$(SERVICE).env && \
		cd $(VM_DIR) && \
		sudo chmod +x update-containers.sh && \
		gcloud auth configure-docker \
		   \$$(echo $(IMAGE_REF) | cut -d/ -f1) --quiet 2>/dev/null || true && \
		sudo docker compose --env-file .env \
		   -f docker/docker-compose.image.yml pull && \
		set -a && source .env && set +a && \
		IP_BASE=\$$(echo \$$CONTAINER_IP | cut -d. -f1-3). && \
		for i in \$$(seq 2 254); do \
			IP=\"\$${IP_BASE}\$$i\"; TAKEN=false; \
			for cid in \$$(sudo docker ps -q); do \
				if sudo docker inspect -f \
				   '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' \
				   \"\$$cid\" | grep -q \"\$$IP\"; then \
					TAKEN=true; break; \
				fi; \
			done; \
			if [ \"\$$TAKEN\" = \"false\" ]; then \
				sudo sed -i \"s|^CONTAINER_IP=.*|CONTAINER_IP=\$$IP|\" .env && \
				sudo sed -i \"s|^CONTAINER_NUMBER=.*|CONTAINER_NUMBER=\$$i|\" .env && \
				sudo sed -i \"s|^CONTAINER_SLUG=.*|CONTAINER_SLUG=\$${CONTAINER_NAME}-\$$i|\" .env && \
				echo \"Slot libre: IP=\$$IP slug=\$${CONTAINER_NAME}-\$$i\"; \
				break; \
			fi; \
		done && \
		set -a && source .env && set +a && \
		sudo docker compose --env-file .env \
		   -f docker/docker-compose.image.yml \
		   -p \"\$$CONTAINER_SLUG\" up -d && \
		echo 'Blue-green swap (update-containers.sh)...' && \
		sudo bash update-containers.sh \"\$$CONTAINER_SLUG\" && \
		echo \"$(SERVICE) desplegado como \$$CONTAINER_SLUG\" && \
		sudo docker ps --filter name=\$$CONTAINER_SLUG"

redeploy: ## Re-pull imagen in-place y recrear (rapido, con breve downtime)
	@echo "==> Re-desplegando $(SERVICE) in-place..."
	@$(GCLOUD_SSH) --command="\
		RUNNING=\$$($(RUNNING_CMD)) && \
		if [ -z \"\$$RUNNING\" ]; then \
			echo 'ERROR: $(SERVICE) no esta corriendo. Usa make deploy.'; \
			exit 1; \
		fi && \
		IMG=\$$(sudo docker inspect --format '{{.Config.Image}}' \"\$$RUNNING\") && \
		echo \"Re-pull de \$$IMG en \$$RUNNING...\" && \
		cd $(VM_DIR) && \
		sudo sed -i \"s|^CONTAINER_SLUG=.*|CONTAINER_SLUG=\$$RUNNING|\" .env && \
		gcloud auth configure-docker \
		   \$$(echo \$$IMG | cut -d/ -f1) --quiet 2>/dev/null || true && \
		sudo docker pull \$$IMG && \
		sudo docker compose --env-file .env \
		   -f docker/docker-compose.image.yml \
		   -p \"\$$RUNNING\" up -d --force-recreate && \
		echo \"$(SERVICE) (\$$RUNNING) re-desplegado\" && \
		sudo docker ps --filter name=\$$RUNNING"

update-env: ## Subir nuevo .env y recrear (conserva image/CONTAINER del contenedor corriendo)
	@echo "==> Actualizando .env de $(SERVICE)..."
	@$(call GCLOUD_SCP,\
		$(ENV_FILE),\
		"$(VM_NAME)":/tmp/$(SERVICE).env)
	@$(GCLOUD_SSH) --command="\
		RUNNING=\$$(sudo docker ps --format '{{.Names}} {{.Image}}' \
			| grep '/$(SERVICE):' | awk '{print \$$1}' | head -1) && \
		if [ -n \"\$$RUNNING\" ]; then \
			IMG=\$$(sudo docker inspect --format '{{.Config.Image}}' \
				\"\$$RUNNING\"); \
			IP=\$$(sudo docker inspect --format \
				'{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' \
				\"\$$RUNNING\"); \
			NUM=\$$(echo \"\$$RUNNING\" | awk -F- '{print \$$NF}'); \
			echo \"\" >> /tmp/$(SERVICE).env; \
			echo \"# Preservado del contenedor corriendo\" \
				>> /tmp/$(SERVICE).env; \
			echo \"BACKEND_PAYMENTS_IMAGE=\$$IMG\" >> /tmp/$(SERVICE).env; \
			echo \"CONTAINER_IP=\$$IP\" >> /tmp/$(SERVICE).env; \
			echo \"CONTAINER_NUMBER=\$$NUM\" >> /tmp/$(SERVICE).env; \
			echo \"CONTAINER_SLUG=\$$RUNNING\" >> /tmp/$(SERVICE).env; \
		fi \
		&& sudo cp /tmp/$(SERVICE).env $(VM_DIR)/.env \
		&& rm /tmp/$(SERVICE).env \
		&& cd $(VM_DIR) \
		&& sudo docker compose --env-file .env \
		   -f docker/docker-compose.image.yml \
		   -p \"\$${RUNNING:-$(SERVICE)}\" \
		   up -d --force-recreate \
		&& echo '$(SERVICE) re-desplegado' \
		&& sudo docker ps --filter name=\$$RUNNING"

refresh-env: ## Pull Infisical (dev) + update-env en un solo paso
	@echo "==> Pull Infisical development -> $(ENV_FILE)"
	@../../scripts/pull-env.sh --env development \
		--out deploy/dev/$(ENV_FILE)
	@$(MAKE) update-env

# --- Operaciones -------------------------------------------------------
# Todos los targets operativos resuelven el nombre del contenedor
# corriendo en la VM via docker ps (filtrando por imagen /$(SERVICE):),
# porque blue-green usa sufijos como roax-auth-4 que no estan en el .env local.

RUNNING_CMD := sudo docker ps --format '{{.Names}} {{.Image}}' \
	| grep '/$(SERVICE):' | awk '{print \$$1}' | head -1

logs: ## Ver logs (LINES=200, FOLLOW=true)
	@$(GCLOUD_SSH) --command="\
		RUNNING=\$$($(RUNNING_CMD)) && \
		sudo docker logs \$$RUNNING \
		--tail=$(or $(LINES),200) \
		$(if $(FOLLOW),--follow,)"

shell: ## Abrir shell en el contenedor
	@$(GCLOUD_SSH) -- -t \
		"RUNNING=\$$($(RUNNING_CMD)) && \
		sudo docker exec -it \$$RUNNING sh"

status: ## Ver estado del contenedor
	@$(GCLOUD_SSH) --command="\
		RUNNING=\$$($(RUNNING_CMD)) && \
		sudo docker ps --filter name=\$$RUNNING \
		--format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'"

restart: ## Reiniciar contenedor
	@$(GCLOUD_SSH) --command="\
		RUNNING=\$$($(RUNNING_CMD)) && \
		sudo docker restart \$$RUNNING \
		&& echo '$(SERVICE) (\$$RUNNING) reiniciado'"

stop: ## Detener contenedor
	@$(GCLOUD_SSH) --command="\
		RUNNING=\$$($(RUNNING_CMD)) && \
		sudo docker stop \$$RUNNING \
		&& echo '$(SERVICE) (\$$RUNNING) detenido'"

migrate: ## Ejecutar migraciones en la VM (sobre dist/ compilado)
	@$(GCLOUD_SSH) -- -t \
		"RUNNING=\$$($(RUNNING_CMD)) && \
		sudo docker exec -it \$$RUNNING \
		node node_modules/typeorm/cli.js migration:run \
		-d dist/src/orm/write.js"
