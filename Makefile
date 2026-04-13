# Mockstar — local development convenience targets.
# Run `make` (or `make help`) for a list. Uses bash for pipefail.

SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c

# --- Configurable variables (override on CLI: `make docker-run HOST_PORT=4000`) ---
IMAGE_NAME     ?= mockstar
IMAGE_TAG      ?= dev
IMAGE          := $(IMAGE_NAME):$(IMAGE_TAG)
CONTAINER_NAME ?= mockstar-dev
HOST_PORT      ?= 3000
CONTAINER_PORT ?= 3000
MOCKS_DIR      ?= ./examples/mocks
HANDLERS_DIR   ?= ./examples/handlers

.DEFAULT_GOAL := help

# ============================================================================
# Help
# ============================================================================

help:  ## Show this help
	@awk 'BEGIN { FS = ":.*?##"; printf "Usage: make <target> [VAR=value]\n\nTargets:\n" } /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@echo ""
	@echo "Variables (override on CLI):"
	@echo "  IMAGE_NAME=$(IMAGE_NAME) IMAGE_TAG=$(IMAGE_TAG)"
	@echo "  CONTAINER_NAME=$(CONTAINER_NAME) HOST_PORT=$(HOST_PORT) CONTAINER_PORT=$(CONTAINER_PORT)"
	@echo "  MOCKS_DIR=$(MOCKS_DIR) HANDLERS_DIR=$(HANDLERS_DIR)"

# ============================================================================
# Local development
# ============================================================================

install:  ## Install dependencies (frozen lockfile)
	bun install --frozen-lockfile

dev: install  ## Run mockstar locally with file-watch hot reload (Ctrl+C to stop)
	bun run src/cli.ts $(MOCKS_DIR) --handlers $(HANDLERS_DIR) --port $(HOST_PORT)

run: install  ## Run mockstar locally without file-watch (CI-shaped)
	bun run src/cli.ts $(MOCKS_DIR) --handlers $(HANDLERS_DIR) --port $(HOST_PORT) --no-watch

test:  ## Run the full test suite
	bun test

test-watch:  ## Run tests in watch mode
	bun test --watch

bench:  ## Run the perf benchmark (10s @ 500 RPS, library channel)
	bun run bench/harness.ts --duration=10 --rps=500 --channel=library

typecheck:  ## Run TypeScript typecheck
	bun run typecheck

lint:  ## Run biome lint check
	bun run lint

format:  ## Run biome format (writes changes)
	bun run format

# ============================================================================
# Docker
# ============================================================================

docker-build:  ## Build the Docker image as $(IMAGE)
	docker build -t $(IMAGE) .

docker-run: docker-build  ## Build and run the Docker image with bundled examples on :$(HOST_PORT)
	@docker rm -f $(CONTAINER_NAME) >/dev/null 2>&1 || true
	docker run -d --name $(CONTAINER_NAME) -p $(HOST_PORT):$(CONTAINER_PORT) $(IMAGE) /examples/mocks
	@echo ""
	@echo "Mockstar running:"
	@echo "  health:   curl http://127.0.0.1:$(HOST_PORT)/health"
	@echo "  example:  curl http://127.0.0.1:$(HOST_PORT)/users/42 -H 'x-mockstar-tenant: default'"
	@echo "  logs:     make docker-logs"
	@echo "  stop:     make docker-stop"

docker-stop:  ## Stop and remove the running container (if any)
	@docker rm -f $(CONTAINER_NAME) >/dev/null 2>&1 && echo "stopped $(CONTAINER_NAME)" || echo "no container to stop"

docker-logs:  ## Tail logs from the running container
	docker logs -f $(CONTAINER_NAME)

docker-shell:  ## Open a shell inside the running container
	docker exec -it $(CONTAINER_NAME) sh

# ============================================================================
# Manifold (constraint workflow helpers)
# ============================================================================

manifold-validate:  ## Validate manifold schema + linking
	manifold validate mockstar

manifold-verify:  ## Verify generated artifacts vs declared
	manifold verify mockstar

manifold-drift:  ## Check for post-baseline drift
	manifold drift mockstar

# ============================================================================
# Cleanup
# ============================================================================

clean:  ## Remove dist/, coverage/, bench/results/
	rm -rf dist coverage bench/results

clean-all: clean docker-stop  ## Full cleanup: above + node_modules + Docker image
	rm -rf node_modules
	@docker rmi -f $(IMAGE) >/dev/null 2>&1 && echo "removed image $(IMAGE)" || echo "no image to remove"

.PHONY: help install dev run test test-watch bench typecheck lint format \
        docker-build docker-run docker-stop docker-logs docker-shell \
        manifold-validate manifold-verify manifold-drift \
        clean clean-all
