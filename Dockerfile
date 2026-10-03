# Redline audit server (packages/server).
#   docker build -t redline .
#   docker run --rm -p 8080:8080 --shm-size=1g redline
# Then open http://localhost:8080
#
# Public mode refuses private/internal URLs. For a public deployment, also run the container on a
# network that cannot reach internal services or cloud metadata (see README "Hosting").
FROM node:22-bookworm-slim

# Debian's Chromium plus fonts so text renders (and is measured) realistically.
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-color-emoji ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV CHROME_PATH=/usr/bin/chromium \
    # Containers usually lack the user namespaces Chrome's sandbox needs; /dev/shm is small by default.
    REDLINE_CHROME_FLAGS="--no-sandbox --disable-dev-shm-usage" \
    PORT=8080

RUN corepack enable
WORKDIR /app

# Manifests first so dependency installs are cached across source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
COPY packages/mcp/package.json packages/mcp/
COPY packages/agent/package.json packages/agent/
COPY fixtures/demo-app/package.json fixtures/demo-app/
RUN pnpm install --frozen-lockfile --filter "@redline/server..."

COPY packages/core packages/core
COPY packages/server packages/server
RUN pnpm --filter "@redline/server..." build

# Set only after the build: with NODE_ENV=production, pnpm install would skip TypeScript.
ENV NODE_ENV=production
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "packages/server/dist/bin.js"]
