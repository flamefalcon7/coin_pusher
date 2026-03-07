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
COPY game/shared/package.json ./game/shared/
COPY game/shared/tsconfig.json ./game/shared/
COPY game/shared/buf.yaml game/shared/buf.gen.yaml ./game/shared/
COPY game/shared/proto ./game/shared/proto
COPY game/shared/src ./game/shared/src
RUN cd game/shared && pnpm install --frozen-lockfile && pnpm build

# ===========================
# Stage 2: Build game server
# ===========================
FROM base AS game-builder
COPY game/shared ./game/shared
COPY --from=shared-builder /app/game/shared/dist ./game/shared/dist
COPY game/server ./game/server
RUN cd game/server && pnpm install --frozen-lockfile && pnpm build

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
COPY game/shared/package.json ./game/shared/
COPY --from=shared-builder /app/game/shared/dist ./game/shared/dist

# Copy game server package
COPY game/server/package.json ./game/server/
COPY --from=game-builder /app/game/server/dist ./game/server/dist

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Run as non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

# Start game server (NATS worker, no exposed ports)
CMD ["node", "game/server/dist/index.js"]
