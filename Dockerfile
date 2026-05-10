# ─────────────────────────────────────────────────────────────────────────────
# Lithuanian Data Protection MCP — multi-stage Dockerfile
# ─────────────────────────────────────────────────────────────────────────────
# Build:  docker build -t lithuanian-data-protection-mcp .
# Run:    docker run --rm -p 3000:3000 lithuanian-data-protection-mcp
#
# The image expects a pre-built database at /app/data/vdai.db.
# Override with VDAI_DB_PATH for a custom location.
# ─────────────────────────────────────────────────────────────────────────────

# --- Stage 1: Build TypeScript + native modules ---
FROM node:20-slim AS builder

WORKDIR /app

# Build deps for better-sqlite3 native compile
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
# Full install (including devDependencies and postinstall scripts) so that
# better-sqlite3's native binding gets fetched/built into node_modules.
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# Prune to production-only dependencies; keep the compiled native bindings.
RUN npm prune --omit=dev

# --- Stage 2: Production ---
FROM node:20-slim AS production

WORKDIR /app
ENV NODE_ENV=production
ENV VDAI_DB_PATH=/app/data/vdai.db

# Reuse node_modules from builder (preserves better-sqlite3 native binding)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist/ dist/
COPY package.json package-lock.json* ./

# Database (workflow's "Provision database" step downloads database.db.gz from
# the GitHub Release into data/database.db before docker build runs).
COPY data/database.db data/vdai.db

# Non-root user for security
RUN addgroup --system --gid 1001 mcp && \
    adduser --system --uid 1001 --ingroup mcp mcp && \
    chown -R mcp:mcp /app
USER mcp

# Health check: verify HTTP server responds
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "dist/src/http-server.js"]
