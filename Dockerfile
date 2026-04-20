# syntax=docker/dockerfile:1.7
#
# Multi-stage build for cssDOOM.
#
# Targets:
#   - `web`:    nginx serving the Vite-built static client (port 80).
#   - `server`: node multiplayer + SGNL adapter (HTTP/WS :8787, gRPC :8081).
#
# An external reverse proxy is expected in front. Suggested route map:
#   /ws         -> server:8787   (WebSocket, must enable upgrade)
#   /healthz    -> server:8787   (liveness)
#   /*          -> web:80        (everything else)
#   :8081 (gRPC) optionally exposed only to SGNL's network.
#
# Build both images with docker compose:
#   docker compose build
#

# ---------- shared install layer ----------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    if [ -f package-lock.json ]; then npm ci; else npm install --no-audit --no-fund; fi

# ---------- frontend build ----------
FROM deps AS build
WORKDIR /app
COPY index.html index.css index.js vite.config.js ./
COPY src ./src
COPY public ./public
RUN npm run build

# ---------- web image (static, fronted by external reverse proxy) ----------
FROM nginx:1.27-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1/healthz >/dev/null 2>&1 || exit 1

# ---------- server image (multiplayer + SGNL adapter) ----------
FROM node:22-alpine AS server
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    SGNL_ADAPTER_PORT=8081

COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev --no-audit --no-fund; fi

COPY server ./server
COPY src ./src
COPY public/maps ./public/maps
COPY public/sgnl ./public/sgnl

EXPOSE 8787 8081
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8787/healthz >/dev/null 2>&1 || exit 1
CMD ["node", "server/index.js"]
