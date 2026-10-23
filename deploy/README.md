# Déploiement de SAN sur un NAS (VM Docker)

Architecture : `api` (+ application web, ffmpeg), `db` (PostgreSQL 17), `tts` (Piper),
derrière votre reverse proxy existant (TLS). Seul `api` est joignable ; `db` et `tts`
vivent sur un réseau Docker `internal` sans accès extérieur.

## 1. Prérequis

- Une VM (Debian/Ubuntu) sur le NAS avec Docker Engine et le plugin Compose (`docker compose version`).
- Un reverse proxy existant sur la même VM, dans un réseau Docker (ex. `proxy`), avec un
  certificat Let's Encrypt pour `agents.example.org`.
- Accès à `ghcr.io` (images publiques ; sinon `docker login ghcr.io` avec un jeton `read:packages`).
- Architecture CPU : la CI publie `linux/amd64`. NAS ARM : voir « Image ARM » plus bas.

## 2. Installation

```sh
sudo mkdir -p /opt/san && sudo chown "$USER" /opt/san && cd /opt/san
git clone https://github.com/ItHasU/SAN.git .      # compose + scripts (pas besoin de dagda)
cp .env.prod.example .env && chmod 600 .env
```

Éditer `.env` :

- `APP_BASE_URL` : l'URL publique HTTPS ;
- `DB_PASSWORD` : `openssl rand -base64 24 | tr -d '/+='` ;
- `APP_SECRET` : `openssl rand -base64 32` (le sauvegarder ailleurs) ;
- `PROXY_NETWORK` : nom du réseau du reverse proxy (`docker network ls`) ;
- `SAN_IMAGE_TAG` : `latest` (branche main) ou un tag précis.

Dossiers de données (créés au premier lancement) : `./data` (audio), `./pgdata`
(base), `./voices` (voix Piper supplémentaires, optionnel : une voix française est
déjà dans l'image `tts`).

```sh
sudo chown 1000:1000 data 2>/dev/null || { mkdir -p data && sudo chown 1000:1000 data; }   # l'API tourne en uid 1000
docker compose pull
docker compose up -d
docker compose ps          # api, db, tts doivent être « healthy »
docker compose logs -f api
```

## 3. Reverse proxy

Faire pointer le reverse proxy vers `http://api:3000` (même réseau Docker `proxy`),
avec les en-têtes `X-Forwarded-For` / `X-Forwarded-Proto`. `SAN_TRUST_PROXY=1` (défaut) les
prend en compte pour la limitation de débit par IP. Activer WebSocket/SSE sans
tampon (`proxy_buffering off` pour nginx) pour le temps réel de l'application web.

Sans reverse proxy : `docker compose -f docker-compose.standalone.yml up -d` publie `PUBLISHED_PORT`
directement (mettre `SAN_TRUST_PROXY=0` et un TLS devant dès que c'est exposé sur internet).

Test : `curl -i https://agents.example.org/api/v1/device/status` doit renvoyer `401` JSON.

## 4. Premier login

Sur base vide, Dagda crée le compte `admin` / `admin`. Ouvrir `APP_BASE_URL/login`,
se connecter, **changer immédiatement le mot de passe**.

## 5. Créer un agent

Dans l'administration (ou via l'API, session admin), créer un agent : le jeton `agt_...`
n'est affiché qu'une fois. L'agent publie ensuite son état :

```sh
curl -X POST https://agents.example.org/api/v1/agent/state \
  -H "Authorization: Bearer agt_..." -H "Content-Type: application/json" \
  -d '{"state":"working"}'
```

(corps exact : voir `docs/SPEC.md` §10.)

## 6. Enrôler une carte (M5Stick S3)

1. La carte appelle `POST /api/v1/device/register` ; elle reçoit un jeton `dev_...` et reste « en attente »
   (max `SAN_MAX_PENDING`, limité par `SAN_REGISTER_RATE_PER_HOUR` et par IP).
2. Dans l'administration, onglet viewers : repérer la carte en attente (code affiché sur son écran), l'**activer**
   et lui assigner groupes/abonnements.
3. `GET /api/v1/device/status` avec le jeton `dev_` reflète l'activation.

## 7. Mise à jour

```sh
cd /opt/san
git pull                      # compose / scripts
deploy/backup.sh              # toujours sauvegarder avant
docker compose pull && docker compose up -d
docker image prune -f
```

Les migrations SQL s'appliquent au démarrage. Retour arrière : repasser `SAN_IMAGE_TAG` à
l'ancien tag (sha-xxxxxxx), puis restaurer le dump si le schéma a changé.

## 8. Sauvegarde et restauration

| Quoi | Comment |
|---|---|
| Base | `deploy/backup.sh` (pg_dump à chaud, rotation `KEEP_DAYS`), à planifier par cron |
| Audio | copier `./data` (rsync, snapshot VM, Hyper Backup...) |
| Secrets | `.env` (en particulier `APP_SECRET`) |
| `./pgdata` | **ne pas** copier à chaud : seul le dump est cohérent |

Cron : `0 3 * * * cd /opt/san && deploy/backup.sh /srv/backups/san`

Restauration (sur une pile à l'arrêt sauf `db`) :

```sh
docker compose stop api
docker compose exec -T db psql -U san -d postgres -c 'DROP DATABASE IF EXISTS san' -c 'CREATE DATABASE san OWNER san'
gunzip -c backups/san-AAAAMMJJ-HHMMSS.sql.gz | docker compose exec -T db psql -U san -d san
# restaurer ./data si besoin, puis :
docker compose up -d
```

(Adapter `san` si `DB_USER`/`DB_NAME` ont été changés.)

## 9. Image ARM

Si le NAS est ARM : dans `.github/workflows/docker.yml`, décommenter `linux/arm64`
(et l'étape QEMU), ou construire sur place : `docker compose build` depuis un dossier
contenant `dagda/` et `SAN/` côte à côte.

## 10. Dépannage

- `docker compose logs api db tts`.
- `api` « unhealthy » : vérifier `APP_SECRET` (32 octets base64) et `DB_PASSWORD`.
- Mot de passe DB changé après le premier lancement : il ne s'applique qu'à un `pgdata` vide.
