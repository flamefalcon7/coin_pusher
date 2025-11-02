# Dockerfile for Coin Pusher Server
FROM node:20-alpine AS base

# Install pnpm (use latest stable version)
RUN npm install -g pnpm@9

# Set working directory
WORKDIR /app

# Copy workspace config
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./

# ===========================
# Stage 1: Build shared package
# ===========================
FROM base AS shared-builder
COPY shared ./shared
RUN cd shared && pnpm install --frozen-lockfile && pnpm build

# ===========================
# Stage 2: Build server
# ===========================
FROM base AS server-builder
COPY shared ./shared
COPY --from=shared-builder /app/shared/dist ./shared/dist
COPY server ./server
RUN cd server && pnpm install --frozen-lockfile && pnpm build

# ===========================
# Stage 3: Production
# ===========================
FROM node:20-alpine AS production

# Install pnpm (use latest stable version)
RUN npm install -g pnpm@9

WORKDIR /app

# Copy workspace config
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./

# Copy shared package
COPY shared/package.json ./shared/
COPY --from=shared-builder /app/shared/dist ./shared/dist

# Copy server package
COPY server/package.json ./server/
COPY --from=server-builder /app/server/dist ./server/dist

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Expose port
EXPOSE 3000

# Health check (check if WebSocket port is listening)
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('net').connect(3000, 'localhost').on('connect', () => process.exit(0)).on('error', () => process.exit(1))"

# Start server
CMD ["node", "server/dist/index.js"]

