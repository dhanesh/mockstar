# Satisfies U2 (Docker distribution channel) + TN4 per-channel boot SLO
# Multi-stage: builder compiles TS → ESM; runner is minimal Bun-alpine with the compiled output.

# RT-1: the default matches .bun-version; CI overrides via --build-arg to keep
# the container image and the binary build on the same pinned toolchain.
ARG BUN_VERSION=1.3.11
FROM oven/bun:${BUN_VERSION}-alpine AS builder
WORKDIR /build
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json bunfig.toml ./
COPY src ./src
RUN bun build ./src/cli.ts ./src/index.ts --outdir ./dist --target bun --format esm

FROM oven/bun:${BUN_VERSION}-alpine AS runner
WORKDIR /app

# S4 — server defaults to 127.0.0.1; operators must explicitly opt into 0.0.0.0.
# Container users almost always want 0.0.0.0, so we set it via ENV and document.
ENV MOCKSTAR_HOST=0.0.0.0
ENV MOCKSTAR_PORT=3000
ENV NODE_ENV=production

COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/dist ./dist
COPY package.json ./
# Default config path — override by mounting a volume at /config/mocks.
COPY examples /examples

EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=2s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${MOCKSTAR_PORT}/health" || exit 1

# Orchestrator is expected to set restart policy (always / on-failure) per RT-3.3.
ENTRYPOINT ["bun", "./dist/cli.js"]
CMD ["/config/mocks"]
