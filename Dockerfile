# Satisfies U2 (Docker distribution channel) + TN4 per-channel boot SLO
# Multi-stage: builder installs deps + compiles TS → ESM; runner is a minimal,
# non-root Bun-alpine that carries only the compiled bundle + production deps.

# RT-1: the default matches .bun-version; CI overrides via --build-arg to keep
# the container image and the binary build on the same pinned toolchain.
# Pinned to a concrete patch tag (>=1.3.0 per engines) for reproducible builds.
ARG BUN_VERSION=1.3.14

# ---------------------------------------------------------------------------
# Stage 1 — builder: install all deps, bundle the CLI + library to ESM.
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-alpine AS builder
WORKDIR /build

# Lockfile is bun.lock (text format). Copy manifests first for layer caching.
COPY package.json bun.lock ./
# Full install (incl. dev deps) so the bundler can resolve every import.
RUN bun install --frozen-lockfile

COPY tsconfig.json bunfig.toml ./
COPY src ./src
RUN bun build ./src/cli.ts ./src/index.ts --outdir ./dist --target bun --format esm

# ---------------------------------------------------------------------------
# Stage 2 — production deps only: a clean, dev-dep-free node_modules.
# Bundling with --target bun can leave dynamic/optional requires unresolved,
# so we ship the runtime dependency tree alongside the bundle.
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-alpine AS deps
WORKDIR /build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---------------------------------------------------------------------------
# Stage 3 — runner: minimal, non-root, read-only-root-FS friendly.
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-alpine AS runner
WORKDIR /app

# Non-root identity with uid/gid > 10000 (avoids host-uid collisions; K8s
# runAsNonRoot friendly). alpine ships adduser/addgroup via busybox.
RUN addgroup -g 10001 -S mockstar \
  && adduser -u 10001 -G mockstar -S -H -h /app mockstar

# S4 — server defaults to 127.0.0.1; container users want 0.0.0.0.
ENV MOCKSTAR_HOST=0.0.0.0
ENV MOCKSTAR_PORT=3000
ENV NODE_ENV=production
# Read-only root FS: keep all writable scratch under /tmp (the chart mounts an
# emptyDir there). HOME/caches point at /tmp so nothing writes into /app.
ENV HOME=/tmp \
    TMPDIR=/tmp \
    XDG_CACHE_HOME=/tmp \
    BUN_INSTALL_CACHE_DIR=/tmp/.bun-cache

# Copy only what the runtime needs; owned by the non-root user.
COPY --from=deps    --chown=10001:10001 /build/node_modules ./node_modules
COPY --from=builder --chown=10001:10001 /build/dist        ./dist
COPY                --chown=10001:10001 package.json        ./

USER 10001:10001

EXPOSE 3000

# HEALTHCHECK uses bun's built-in fetch (no curl/wget dependency). Non-200
# or a fetch error exits non-zero and marks the container unhealthy.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD bun --eval "fetch('http://127.0.0.1:'+(process.env.MOCKSTAR_PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Orchestrator is expected to set restart policy (always / on-failure) per RT-3.3.
# Default config path — the chart mounts the mocks dir at /config/mocks (ro).
# Override the positional arg to serve a different directory.
ENTRYPOINT ["bun", "./dist/cli.js"]
CMD ["/config/mocks"]
