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

# Manifold feature (override: `make manifold-verify FEATURE=tier1-https-proxy`)
FEATURE        ?= mockstar

# Tier1 proxy integration image
PROXY_IMAGE    ?= mockstar-tier1:dev

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
# Tier 1 HTTPS proxy (`mockstar proxy`)
# ============================================================================

proxy-install:  ## Install CA + DNS + port-bind for mockstar proxy (one-time, may sudo)
	bun run src/cli.ts proxy install

proxy-start:  ## Start the HTTPS transparent upstream on :443 (Ctrl+C to stop)
	bun run src/cli.ts proxy start

proxy-status:  ## Print proxy install + snapshot diagnostics
	bun run src/cli.ts proxy status

proxy-uninstall:  ## Reverse install (LIFO): removes CA, DNS, port-bind grant
	bun run src/cli.ts proxy uninstall

proxy-bench:  ## Run the TLS handshake + warm-request bench (real cert, local)
	bun run bench/proxy.bench.ts

docker-proxy-build:  ## Build the tier1 integration Docker image
	docker build -f Dockerfile.tier1-proxy -t $(PROXY_IMAGE) .

docker-proxy-smoke: docker-proxy-build  ## Run the full tier1 live-OS smoke test in Docker
	docker run --rm --cap-add=NET_BIND_SERVICE $(PROXY_IMAGE)

# ============================================================================
# Manifold (constraint workflow helpers; FEATURE=<name> to target a feature)
# ============================================================================

manifold-validate:  ## Validate manifold schema + linking (FEATURE=<name>)
	manifold validate $(FEATURE)

manifold-verify:  ## Verify generated artifacts vs declared (FEATURE=<name>)
	manifold verify $(FEATURE)

manifold-drift:  ## Check for post-baseline drift (FEATURE=<name>)
	manifold drift $(FEATURE)

# ============================================================================
# Cleanup
# ============================================================================

clean:  ## Remove dist/, coverage/, bench/results/
	rm -rf dist coverage bench/results

clean-all: clean docker-stop  ## Full cleanup: above + node_modules + Docker image
	rm -rf node_modules
	@docker rmi -f $(IMAGE) >/dev/null 2>&1 && echo "removed image $(IMAGE)" || echo "no image to remove"
	@docker rmi -f $(PROXY_IMAGE) >/dev/null 2>&1 && echo "removed image $(PROXY_IMAGE)" || echo "no proxy image to remove"

.PHONY: help install dev run test test-watch bench typecheck lint format \
        docker-build docker-run docker-stop docker-logs docker-shell \
        proxy-install proxy-start proxy-status proxy-uninstall proxy-bench \
        docker-proxy-build docker-proxy-smoke \
        manifold-validate manifold-verify manifold-drift \
        clean clean-all
