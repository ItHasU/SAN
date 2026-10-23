# SAN

Afficheur d'état des agents : un serveur HTTP central où des agents (`curl`) publient
état et nudges, et des viewers (cartes M5Stick S3, application web) les affichent.
Construit sur le framework [Dagda](../dagda).

- Spécification fonctionnelle : [`docs/SPEC.md`](docs/SPEC.md)
- Décisions de conception (priment sur la spec) : [`docs/DESIGN.md`](docs/DESIGN.md)

## Avancement

Phase 1 sur 4 : squelette, migrations, jetons, router `/api/v1`, enrôlement des
cartes, `agent/state`, `agent/nudge`, administration (agents, groupes, viewers).
Viewers (`/viewer/*`), permissions, audio/TTS et client web : phases suivantes.

## Structure

```
shared/   contrat typé partagé (modèle Dagda volontairement vide, permissions, types)
client/   application web (page d'accueil Dagda pour l'instant)
server/
  src/app.ts            ServerApp : monte /api/v1, migrations, tâches périodiques
  src/san/              logique métier, testable sans Express
    tokens.ts ids.ts glob.ts rate-limiter.ts errors.ts validate.ts config.ts
    migrations.ts       schéma SQL (SPEC §5, sans `users`)
    agents.ts groups.ts viewers.ts events.ts permissions.ts subscriptions.ts purge.ts auth.ts
    api.ts http.ts routes/   router /api/v1, middlewares, routes
  src/test/             fixture : vraie application + schéma PostgreSQL jetable
```

## Prérequis

`dagda/` et `SAN/` sont des répertoires frères (dépendances `file:../dagda/packages/*`).
Installer Dagda aussi : `cd ../dagda && npm ci`.

PostgreSQL 17 local (DESIGN §9) :

```bash
sudo pg_ctlcluster 17 main start
# bases : postgresql://dagda:dagda@localhost:5432/dagda (tests) et .../san (dev)
```

## Développer

```bash
npm install
cp .env.example .env     # puis renseigner APP_SECRET (commande indiquée dans le fichier)
npm run dev              # compile en continu et lance le serveur
```

Sur une base vide, Dagda crée le compte administrateur `admin` / `admin` : le changer.

| Commande | Effet |
|---|---|
| `npm run build` | Compile les trois paquets |
| `npm run typecheck` | Vérifie le typage |
| `npm test` | Vitest ; les tests serveur utilisent PostgreSQL (`DAGDA_TEST_DB_URL`, défaut `postgresql://dagda:dagda@localhost:5432/dagda`), un schéma jetable par suite |

## Configuration

Variables Dagda : `APP_PORT`, `APP_BASE_URL`, `APP_DATABASE_URL`, `APP_SECRET`.
Variables SAN : `SAN_REGISTER_RATE_PER_HOUR` (5), `SAN_MAX_PENDING` (20),
`SAN_TRUST_PROXY` (1), `SAN_RATE_PER_MINUTE` (300), `SAN_AUTH_FAILURES_PER_MINUTE` (30),
`DATA_DIR` (`./data`). Voir `.env.example`.

## API (phase 1)

Préfixe `/api/v1`. Erreurs JSON `{ "error": "code", "message": "…" }`.

| Route | Auth |
|---|---|
| `POST /device/register`, `GET /device/status` | aucune / jeton `dev_` (même pending) |
| `POST /agent/state`, `POST /agent/nudge` | jeton `agt_` |
| `POST /web/register` | session Dagda |
| `/admin/agents`, `/admin/groups`, `/admin/viewers` (+ `activate`, `revoke`, `token`, `members`) | session Dagda |

Les actions d'administration sont écrites dans le journal d'audit Dagda
(`system_audit_log`, `kind = 'action'`, `name = 'admin.*'`).

## Déploiement

Images Docker (`ghcr.io/ithasu/san`, `ghcr.io/ithasu/san-tts`) publiées par la CI
(`.github/workflows/docker.yml`) ; la ref de Dagda à cloner est dans `DAGDA_REF`.

```bash
cp .env.prod.example .env      # renseigner APP_BASE_URL, DB_PASSWORD, APP_SECRET
docker compose pull && docker compose up -d
```

- `docker-compose.yml` : derrière un reverse proxy existant (réseau externe `PROXY_NETWORK`) ;
  `docker-compose.standalone.yml` : port publié directement ; `docker-compose.dev.yml` : PostgreSQL seul.
- Construction locale de l'image : depuis le dossier parent contenant `dagda/` et `SAN/` :
  `docker build -f SAN/Dockerfile -t ghcr.io/ithasu/san .`
- Sauvegarde : `deploy/backup.sh` (pg_dump) + copie de `./data`. Guide pas à pas : [`deploy/README.md`](deploy/README.md).
