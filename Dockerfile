FROM oven/bun:1.4.4-slim AS base

ARG DO_NOT_TRACK=1
ENV DO_NOT_TRACK=$DO_NOT_TRACK

# openssl + ca-certificates for TLS to outbound HTTP (Stalwart) at runtime
RUN apt-get update -y && apt-get install -y openssl ca-certificates

WORKDIR /app

# Create non-root user for security
RUN useradd -m -u 1001 appuser

# Copy pruned workspace (expects: turbo prune --scope=@langmail/mcp --docker)
COPY --chown=appuser:appuser out/json/ ./

# Install dependencies (skip prepare script - lefthook needs .git)
# Note: includes devDependencies needed for build (TypeScript, etc)
RUN bun install --ci --ignore-scripts

COPY --chown=appuser:appuser out/full/ ./

# Type-check mcp and build its workspace dependencies using Turborepo
RUN bunx turbo build --filter=@langmail/mcp

# Set working directory to the mcp service
WORKDIR /app/services/mcp

# Switch to non-root user
USER appuser

# Last in the final stage on purpose: COMMIT changes on every deploy, and an
# ARG's value invalidates every layer below it. Kept here, the apt/install/build
# layers above stay cache-valid and only this metadata layer is rewritten.
ARG COMMIT
ENV APP_REVISION=$COMMIT

CMD ["bun", "start"]
