# SAN

Afficheur d'état des agents : un serveur HTTP central où des agents (`curl`) publient
état et nudges, et des viewers (cartes M5Stick S3, application web) les affichent.
Construit sur le framework [Dagda](../dagda).

- Spécification fonctionnelle : [`docs/SPEC.md`](docs/SPEC.md)
- Décisions de conception (priment sur la spec) : [`docs/DESIGN.md`](docs/DESIGN.md)

## Avancement

Fonctionnalités : enrôlement, `agent/state|nudge`, administration, permissions à motifs
avec aperçu d'impact, abonnements et configuration, capacités, `viewer/sync`, flux SSE,
`agent/inbox` en long-poll, bus `LISTEN/NOTIFY`, purge, audio (TTS Piper ou bip de test,
envoi de fichiers, messages vocaux viewer → agent, transcodage ffmpeg en cache), route
`/health`, et client web (tableau de bord mobile + administration, voir « Client web »).

## Structure

```
shared/   contrat typé partagé (modèle Dagda volontairement vide, permissions, types)
client/   application web (tableau de bord, administration) — voir « Client web »
e2e/      tests Playwright (serveur réel, base `san_e2e`, mobile d'abord)
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
| `npm run test:smoke` | Test de bout en bout (`tools/e2e-smoke.sh [--piper]`) : vrai serveur, base `san_smoke` recréée, vrai `bin/san` de `SAN_agent-claude_code`, carte simulée `tools/device-sim.py` (reproduit le protocole du firmware) |
| `npm test` | Vitest ; les tests serveur utilisent PostgreSQL (`DAGDA_TEST_DB_URL`, défaut `postgresql://dagda:dagda@localhost:5432/dagda`), un schéma jetable par suite |

## Client web

Application Dagda (`client/src`), **pensée pour le téléphone** (une main, réseau instable) et
utilisable sur desktop. Toutes les classes, thèmes et icônes viennent du design system de Dagda ;
`client/src/styles/san.css` n'ajoute que des règles en `var(--…)`. `npm run lint` (oxlint, plugin
d'adhérence de Dagda) refuse hex, px et polices en dur dans le TypeScript.

| Page (menu) | Rôle |
|---|---|
| Tableau de bord (accueil) | Viewer `web` en mode `auto` : agents suivis en temps réel (statut, detail, progression, « mis à jour il y a »), historique des nudges et messages vocaux (priorité `high` en évidence, lecteur audio via blob + Bearer, acquittement `POST /viewer/ack`), notifications système et vibration optionnelles, enregistrement vocal (`can_send_voice`), réglages d'ordre et de mise en sourdine (`PUT /viewer/config`, 409 géré) |
| Administration › Demandes en attente | Code d'appairage, modèle, matériel, IP, ancienneté ; activer (nom) / refuser |
| Administration › Viewers | Liste, puis fiche : capacités, mode, règles de permission (motif validé avec la liste blanche, couverture, `can_send_voice` grisé sans micro), diagnostic d'accès, abonnements ordonnables |
| Administration › Agents | Création (jeton affiché **une seule fois** + exemple curl), régénération, révocation, groupes, état, viewers ayant accès |
| Administration › Groupes | Création, membres, viewers concernés |

Toute action qui modifie la couverture appelle d'abord la route avec `?dry_run=1`, affiche les viewers
qui gagnent ou perdent l'accès, puis applique (`ui/dialogs.ts`, `confirmImpact`).

Organisation : `client/src/lib/` (logique sans Dagda, testée sous jsdom : `sse.ts` parseur SSE,
`api.ts` clients viewer/admin, `session.ts` SSE + reconnexion, `store.ts`, `glob.ts`, `time.ts`, `dom.ts`),
`ui/` (composants et dialogues), `pages/`. Le jeton `web_` est en `localStorage` (`san.web.token`) ; il est
redemandé par `POST /web/register` s'il manque ou sur `401`. Un viewer web neuf ne voit aucun agent : l'état
vide propose « M'accorder l'accès » (règle `*` avec aperçu).

## Tests

| Commande | Contenu |
|---|---|
| `npm test` | Vitest : shared, client (jsdom), serveur (PostgreSQL) |
| `npm run test:e2e` | Build puis Playwright : serveur réel (`node server/dist/main.js`) sur la base `san_e2e` **recréée à chaque exécution**, `TTS_ENGINE=fake`. Projets `pixel-7`, `iphone-13` (Chromium) et `desktop`. Captures mobiles dans `e2e/screenshots/` |
| `npm run lint` | Lint d'adhérence au design system |

Prérequis e2e : `sudo -u postgres createdb -O dagda san_e2e` (une fois), un Chromium installé (aucun
`playwright install` n'est lancé ; l'exécutable est cherché dans `SAN_E2E_CHROMIUM`,
`PLAYWRIGHT_BROWSERS_PATH`, `/opt/pw-browsers`, `~/.cache/ms-playwright`) et, si le conteneur n'a pas libnss,
`SAN_E2E_LIBS` (défaut `~/.cache/pw-libs/root/usr/lib/x86_64-linux-gnu`). Le parcours « lecture d'un clip `say` »
n'est exécuté que si `GET /api/v1/health` répond (routes audio fusionnées).

## Configuration

Variables Dagda : `APP_PORT`, `APP_BASE_URL`, `APP_DATABASE_URL`, `APP_SECRET`.
Variables SAN : `SAN_REGISTER_RATE_PER_HOUR` (5), `SAN_MAX_PENDING` (20), `SAN_AGENT_REGISTER_RATE_PER_HOUR` (5),
`SAN_AGENT_ENROLL_RATE_PER_HOUR` (60), `SAN_MAX_PENDING_AGENTS` (20),
`SAN_TRUST_PROXY` (1), `SAN_RATE_PER_MINUTE` (300), `SAN_AUTH_FAILURES_PER_MINUTE` (30),
`DATA_DIR` (`./data`), `TTS_ENGINE` (`piper` si `TTS_URL` défini, sinon `fake`), `TTS_URL`,
`FFMPEG_PATH` / `FFPROBE_PATH`. Voir `.env.example`.

## API (phases 1 à 3)

Préfixe `/api/v1`. Erreurs JSON `{ "error": "code", "message": "…" }`.

| Route | Auth |
|---|---|
| `POST /device/register`, `GET /device/status` | aucune / jeton `dev_` (même pending) |
| `POST /agent/register` `{slug, name?, enrollment_token?}` | aucune : `201 {slug, status:"active"\|"pending", token, group?}` (jeton d'enrôlement valide → actif dans le groupe ; sans jeton → `pending` ; jeton invalide → `401`, slug pris → `409`) |
| `GET /agent/status` | jeton `agt_` (même pending) : `{slug, status}` |
| `POST /agent/state`, `POST /agent/nudge` | jeton `agt_` actif |
| `POST /web/register` | session Dagda |
| `GET /agent/inbox?ack=&wait=` | jeton `agt_` |
| `GET /viewer/sync`, `POST /viewer/ack`, `PUT /viewer/capabilities`, `GET/PUT /viewer/config`, `GET /viewer/events` (SSE) | jeton `dev_` / `web_` actif |
| `GET /health` | aucune : `200 {ok:true}` après `SELECT 1`, `503` sinon |
| `POST /agent/say` `{text≤500, priority?, ttl_s?}` | jeton `agt_` : `202 {clip_id, status:"pending"}` (TTS, l'événement n'est inscrit qu'une fois le clip prêt) |
| `POST /agent/voice?priority=&ttl_s=&text=` | jeton `agt_` : corps binaire `audio/wav\|mpeg\|ogg` ≤ 2 Mo, ≤ 30 s : `201 {clip_id, event_id}` |
| `GET /agent/voice/:clip?format=wav\|mp3\|ogg` | jeton `agt_` : message vocal reçu d'un viewer (WAV 16 kHz par défaut) |
| `GET /viewer/voice/:clip` | jeton `dev_` / `web_` : clip dans le format choisi selon les capacités (`Range` géré) |
| `POST /viewer/voice?to=<agent>` | jeton `dev_` / `web_` avec `can_send_voice` et `audio_in` : corps `audio/wav` (PCM ou IMA ADPCM), `audio/webm`, `audio/ogg`, `audio/mp4` (Safari) : `201 {clip_id, event_id}` |
| `/admin/agents`, `/admin/groups`, `/admin/viewers` (+ `activate`, `revoke`, `token`, `members`) | session Dagda |
| `/admin/agents/:slug/approve`, `/admin/groups/:slug/enrollment-tokens[/:id]` | session Dagda |
| `/admin/viewers/:id/rules`, `/admin/rules/:id` (+ `coverage`), `/admin/viewers/:id/access/:agent`, `/admin/viewers/:id/subscriptions` | session Dagda |

Codes audio : `413` corps > 2 Mo ou clip trop long (`audio_too_long`), `415` type refusé,
`400 invalid_audio` fichier illisible, `403 voice_not_allowed`, `404`/`410` clip inconnu/expiré,
`406 no_audio_output`. Détails des formats et en-têtes : [`docs/DESIGN.md`](docs/DESIGN.md) §5 et §11.

Les routes d'administration qui modifient la couverture acceptent `?dry_run=1`
(`{dry_run, gained, lost}`, rien n'est modifié) ; sinon la réponse inclut `impact`.

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
