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
RUN --mount=type=cache,target=/root/.npm \
    cd dagda && npm ci

# Le typecheck de Dagda (`tsc -b`) émet les .d.ts/.tsbuildinfo que les projets
# composites de SAN référencent ; sans lui le build de SAN ne résout pas @dagda/*.
RUN cd dagda && npm run typecheck

COPY SAN ./SAN
RUN --mount=type=cache,target=/root/.npm \
    cd SAN && npm ci
RUN cd SAN && npm run build

# Webpack embarque Dagda dans dist/main.js ; seules les dépendances directes de
# SAN (express, pg...) restent externes. On retire l'outillage de build.
RUN cd SAN && npm prune --omit=dev

# ---- Runtime ----
FROM node:24-alpine AS runtime
# ffmpeg : transcodage audio (SPEC §2)
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
# SAN_* (voir .env.prod.example). Il n'y a pas encore de route /health publique :
# /api/v1/device/status sans jeton répond 401 JSON, ce qui prouve que Node, le
# routeur et Express tournent ; toute réponse < 500 est considérée saine.
ENV NODE_ENV=production \
    APP_PORT=3000 \
    DATA_DIR=/data
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.APP_PORT||3000)+'/api/v1/device/status').then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"]

CMD ["node", "dist/main.js"]
