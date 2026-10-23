# syntax=docker/dockerfile:1.7
#
# Contexte de build = le dossier PARENT qui contient `dagda/` et `SAN/` côte à
# côte (les package.json de SAN dépendent de Dagda via file:../dagda/packages/*).
# Voir .github/workflows/docker.yml (ref de Dagda lue dans DAGDA_REF).
#
#   docker build -f SAN/Dockerfile -t ghcr.io/ithasu/san .
#   (depuis le dossier contenant `dagda/` et `SAN/`)

FROM node:24-alpine AS builder
WORKDIR /workspace

COPY dagda ./dagda
WORKDIR /workspace/dagda
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# Le typecheck de Dagda (`tsc -b`) émet les .d.ts/.tsbuildinfo que les projets
# composites de SAN référencent ; sans lui le build de SAN ne résout pas @dagda/*.
RUN npm run typecheck

COPY SAN /workspace/SAN
WORKDIR /workspace/SAN
RUN --mount=type=cache,target=/root/.npm \
    npm ci
# hadolint ignore=DL3059
RUN npm run build

# Webpack embarque Dagda dans dist/main.js ; seules les dépendances directes de
# SAN (express, pg...) restent externes. On retire l'outillage de build.
# hadolint ignore=DL3059
RUN npm prune --omit=dev

# ---- Runtime ----
FROM node:24-alpine AS runtime
# ffmpeg : transcodage audio (SPEC §2)
# hadolint ignore=DL3018
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY --from=builder /workspace/SAN/server/dist ./server/dist
COPY --from=builder /workspace/SAN/client/dist ./client/dist
COPY --from=builder /workspace/SAN/node_modules ./node_modules

# staticFolder vaut "../client/dist", résolu depuis le cwd du processus.
WORKDIR /app/server

# Fichiers audio : volume, propriété de l'utilisateur non root `node` (uid 1000).
RUN mkdir /data && chown node:node /data
VOLUME ["/data"]

# Configuration d'amorçage : APP_PORT, APP_BASE_URL, APP_DATABASE_URL, APP_SECRET,
# SAN_* (voir .env.prod.example). La sonde interroge GET /api/v1/health, publique,
# qui exécute un `SELECT 1` : 200 {"ok":true}, 503 si la base est injoignable.
ENV NODE_ENV=production \
    APP_PORT=3000 \
    DATA_DIR=/data
USER 1000:1000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.APP_PORT||3000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "dist/main.js"]
