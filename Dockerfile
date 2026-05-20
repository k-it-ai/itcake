# Multi-stage Dockerfile for ITCake.
#
# Stage 1: build the SvelteKit app + agent binaries.
# Stage 2: minimal runtime — node + chromium for puppeteer.
#
# Chromium is installed via the OS package manager (faster + smaller than
# letting puppeteer download its own bundled Chrome). PUPPETEER_NO_SANDBOX
# defaults to true in containers because the recommended fix (run as
# non-root with /dev/shm tmpfs) is sufficient isolation here.

# ---------- builder ----------
FROM node:22-bookworm AS builder

WORKDIR /app

# Native deps for better-sqlite3 + puppeteer + lean-qr build.
RUN apt-get update && apt-get install -y --no-install-recommends \
		python3 build-essential ca-certificates curl \
	&& rm -rf /var/lib/apt/lists/*

# Go toolchain for the agent build. Version derived from agent/go.mod
# so the Dockerfile can't drift behind the agent's `go` directive.
COPY agent/go.mod /tmp/agent-go.mod
RUN GO_VERSION="$(awk '/^go [0-9]/ {print $2; exit}' /tmp/agent-go.mod)" \
	&& curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" \
		| tar -C /usr/local -xzf - \
	&& rm /tmp/agent-go.mod
ENV PATH=/usr/local/go/bin:$PATH

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

RUN npm run build && npm run build:agent:all

# Prune devDeps for the runtime stage.
RUN npm prune --omit=dev

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime

# Chromium + minimal X libs for puppeteer. Tools needed at runtime:
# - ca-certificates: outgoing HTTPS (Anthropic, SMTP, Telegram, off-site backup)
# - tini: PID-1 signal forwarding so SIGTERM reaches the SvelteKit handler
# - chromium: PDF rendering
RUN apt-get update && apt-get install -y --no-install-recommends \
		ca-certificates tini chromium \
		fonts-liberation fonts-noto-core fonts-noto-cjk \
	&& rm -rf /var/lib/apt/lists/*

# Non-root user owns /app and /data. /data is a volume mount in compose.
RUN useradd --system --create-home --uid 10001 --shell /usr/sbin/nologin itcake

WORKDIR /app
COPY --from=builder --chown=itcake:itcake /app/build ./build
COPY --from=builder --chown=itcake:itcake /app/node_modules ./node_modules
COPY --from=builder --chown=itcake:itcake /app/package.json ./
COPY --from=builder --chown=itcake:itcake /app/assets ./assets
COPY --from=builder --chown=itcake:itcake /app/data/agent-binaries /opt/itcake/agent-binaries

# Puppeteer: use system Chromium, skip its download.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
	PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
	PUPPETEER_NO_SANDBOX=true \
	HOST=0.0.0.0 \
	PORT=3000 \
	NODE_ENV=production \
	DATA_DIR=/data \
	DATABASE_PATH=/data/itcake.db

USER itcake

VOLUME ["/data"]
EXPOSE 3000

# tini reaps zombies + forwards SIGTERM cleanly so our shutdown
# coordinator (see src/lib/server/shutdown.ts) gets to run.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "build/index.js"]

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
