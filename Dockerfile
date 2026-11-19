# The hosted server's image: runs src/index.ts from source under Bun. The
# self-hosted server ships as the npm package instead (docs/self-hosted.md).
FROM oven/bun:1.4.4-slim

ARG DO_NOT_TRACK=1
ENV DO_NOT_TRACK=$DO_NOT_TRACK

# openssl + ca-certificates for TLS to outbound HTTP (Stalwart) at runtime
RUN apt-get update -y && apt-get install -y openssl ca-certificates

WORKDIR /app

# Create non-root user for security
RUN useradd -m -u 1001 appuser

COPY --chown=appuser:appuser package.json bun.lock ./

# --ignore-scripts: no lifecycle script is needed in the image. Includes the
# devDependencies, because the build step below type-checks with TypeScript.
RUN bun install --frozen-lockfile --ignore-scripts

COPY --chown=appuser:appuser tsconfig.json ./
COPY --chown=appuser:appuser src ./src

# Type-check, as the monorepo's turbo build did before the move
RUN bun run build

# Switch to non-root user
USER appuser

# Last on purpose: COMMIT changes on every release, and an ARG's value
# invalidates every layer below it. Kept here, the layers above stay
# cache-valid and only this metadata layer is rewritten.
ARG COMMIT
ENV APP_REVISION=$COMMIT

CMD ["bun", "start"]
