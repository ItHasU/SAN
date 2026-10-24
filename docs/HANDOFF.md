# Reprise — finalisation sur une machine avec Docker (et une M5StickS3)

> Écrit le 24/10/2026 à la fin de la session de développement initiale. À lire en entier
> avant d'agir. Ce document est aussi copié dans le workspace (`SAN_workspace/HANDOFF.md`).

## 1. Contexte

Projet SAN : afficheur d'état d'agents. Spec : `SAN/docs/SPEC.md` ; décisions qui priment
sur la spec : `SAN/docs/DESIGN.md` (§2 écarts, §10-12 précisions par phase).
Rôle attendu : **orchestrateur**. Les tâches de développement sont confiées à des
sous-agents Sonnet ; l'orchestrateur coordonne, vérifie lui-même les résultats et fusionne.
Règles utilisateur (CLAUDE.md global) : branche dédiée par tâche, commits fréquents en
français à l'impératif, **pas de push ni de PR sans demande explicite**, confirmation avant
toute action destructrice, réponses concises (lecture sur mobile).

## 2. État au moment de la reprise (tout est poussé)

Les 4 dépôts sont frères dans un même dossier de workspace (obligatoire : `SAN` dépend de
`file:../dagda/packages/*`).

| Dépôt (GitHub `ItHasU/…`) | Branche | État vérifié |
|---|---|---|
| `dagda` | `feat/san-support` | 1 commit : `_publicRouter` (routeur monté avant parseurs et porte de session). 533 tests OK |
| `SAN` | `feat/initial-implementation` | Serveur + client web + Docker + TTS. 253 tests Vitest, 32 Playwright (Pixel 7, iPhone 13, desktop), smoke 39 OK (TTS fake et vrai Piper) |
| `SAN_viewer-M5StickS3` | `feat/initial-implementation` | Firmware : `pio run -e m5sticks3` OK, 31 tests natifs. **Jamais flashé** |
| `SAN_agent-claude_code` | `feat/initial-implementation` | `bin/san`, hooks, skill, installeur, faux agent. 86 tests, shellcheck OK |

Jamais fait faute de moyens : build Docker réel, `docker compose up`, CI GitHub observée
(`gh` non authentifié), carte réelle, vrai Safari iOS.

## 3. Mise en place de l'environnement

```bash
mkdir -p ~/SAN_workspace && cd ~/SAN_workspace
git clone -b feat/san-support git@github.com:ItHasU/dagda.git
for r in SAN SAN_viewer-M5StickS3 SAN_agent-claude_code; do
  git clone -b feat/initial-implementation git@github.com:ItHasU/$r.git; done
(cd dagda && npm ci && npm run typecheck)
(cd SAN && npm ci)
```
Besoins : Node 24, Docker + compose v2, ffmpeg, PostgreSQL pour les tests (`docker compose
-f SAN/docker-compose.dev.yml up -d` : postgres sur 5432, utilisateur/mot de passe/base
`dagda`), créer aussi la base `san` si besoin. Variables de test :
`DAGDA_TEST_DB_URL=postgresql://dagda:dagda@localhost:5432/dagda DAGDA_REQUIRE_DB=1`.
PlatformIO : `python3 -m venv ~/.venvs/pio && ~/.venvs/pio/bin/pip install platformio`.
`jq`, `shellcheck` pour l'agent. Note : `tools/e2e-smoke.sh` crée ses bases via
`sudo -u postgres createdb` (PG local) — à adapter (`psql`/`docker exec`) si PG tourne en conteneur.

Re-vérifier d'abord que tout est vert sur la nouvelle machine :
`cd SAN && npm run typecheck && npm run lint && npm test && npm run test:e2e && npm run test:smoke`.

## 4. Tâches restantes, par priorité

### 4.1 CI GitHub
- `gh auth status` ; `gh run list -R ItHasU/SAN` : workflows `CI` et `Docker` sur
  `feat/initial-implementation`. Corriger les échecs (sur une branche `fix/…` issue de
  `feat/initial-implementation`, ou directement dessus si l'utilisateur le dit).
- Vérifier aussi la CI de `SAN_viewer-M5StickS3` et `SAN_agent-claude_code`.

### 4.2 Docker (la raison du changement de machine)
Contexte de build = le **dossier parent** contenant `dagda/` et `SAN/` (voir l'en-tête du `Dockerfile`).
1. `docker build -f SAN/Dockerfile -t san:local .` ; `docker build -t san-tts:local SAN/tts`
   (télécharge la voix `fr_FR-siwis-medium` au build). Noter tailles d'images et durées.
2. Stack complète avec `SAN/docker-compose.yml` (ou `docker-compose.standalone.yml` sans
   reverse proxy) et un `.env` tiré de `.env.prod.example`, dans un dossier jetable.
   Vérifier : les 3 services `healthy` ; migrations au 1er démarrage ; `/api/v1/health` ;
   login admin/admin ; `db` et `tts` **inaccessibles** depuis l'extérieur (réseau `internal`) ;
   droits d'écriture de l'uid 1000 sur `./data` ; ffmpeg présent dans l'image (transcodage
   mp3/ogg/ima_adpcm) ; TTS Piper réel via `POST /agent/say`.
3. Faire tourner le parcours de bout en bout **contre la stack conteneurisée** : adapter
   `tools/e2e-smoke.sh` (option `--url` pour viser un serveur existant au lieu d'en
   démarrer un) ou enchaîner à la main `tools/device-sim.py` + `SAN_agent-claude_code/bin/san`.
4. Redémarrer `api` : les jobs TTS `pending` doivent reprendre, les sessions admin tombent
   (attendu si `APP_SECRET` vide). Tester `deploy/backup.sh` et une restauration.
5. Corriger Dockerfile/compose/guide (`deploy/README.md`) selon les constats.

### 4.3 M5StickS3 réelle (si branchée)
Le conteneur doit voir le port série (`/dev/ttyACM0` ou `/dev/ttyUSB0` : `--device`), et
le serveur SAN doit être joignable **depuis le Wi-Fi de la carte** (IP LAN de la machine,
pas `localhost` ; HTTP simple accepté en LAN ? vérifier le code `src/` du firmware).
Procédure : `pio run -e m5sticks3 -t upload`, `pio device monitor -b 115200`.
Checklist (consigner chaque résultat dans `SAN_viewer-M5StickS3/docs/HARDWARE.md`) :
1. Portail Wi-Fi au premier boot (B maintenu 3 s pour le rouvrir) : saisie SSID, URL serveur.
2. Register → code d'appairage affiché → visible dans l'admin web → activation → la carte passe en RUN.
3. `capabilities_required` → PUT caps → hash identique côté serveur.
4. Règle `*` + `can_send_voice` ; agent publie état/nudge/`say` (`bin/san`) → écran, son, lecture du clip ADPCM 16 kHz (qualité audible, pas de clic final).
5. Enregistrement (A maintenu) → `bin/san inbox` + `fetch-voice` : le son est-il intelligible, gain micro ?
6. Menu abonnements (B maintenu), 409 si modifié depuis l'admin entre-temps.
7. Deep sleep : réveil timer (`next_sync_s`) et bouton (ext1 sur G11/G12 — non vérifié) ; consommation si mesurable ; écran éteint sur réveil sans nouveauté.
8. Révocation dans l'admin → 401 → la carte efface son jeton et se ré-enregistre.
9. Batterie remontée dans l'admin.
Doutes matériels listés dans `docs/HARDWARE.md` et `README.md` (« Limites connues ») du firmware.

### 4.4 Points ouverts connus (à arbitrer avec l'utilisateur, pas bloquants)
- Hooks Claude Code : champs JSON des hooks `UserPromptSubmit`/`Notification`/`Stop`/`SessionEnd`
  supposés de mémoire → tester dans une vraie session (`install.sh` sur un projet jetable) ;
  le nudge à chaque `Stop` peut être verbeux.
- Serveur : pas de route de statut d'un clip TTS `pending/failed` pour l'agent ; un texte
  de 500 caractères peut dépasser 30 s avec Piper (clip `failed`) ; élargir une règle par
  `PATCH` peut livrer des événements non expirés antérieurs (DESIGN §11).
- Client web : ordre par boutons (pas de glisser-déposer), enregistrement en deux appuis,
  iPhone seulement émulé (tester le vrai Safari : lecture mp3, MediaRecorder `audio/mp4`).
- Firmware : pas de reprise de session TLS, NVS non chiffrée, pas d'IP statique.
- Admin : comptes Dagda (scrypt) au lieu d'argon2id — écart accepté (DESIGN §2).

### 4.5 Fusion finale (sur demande de l'utilisateur uniquement)
Ordre : `dagda` `feat/san-support` → `main` ; puis dans `SAN`, remettre le fichier
`DAGDA_REF` à `main` ; puis PR/merge des 3 autres dépôts. Proposer titres et descriptions de PR.

## 5. Méthode de travail conseillée
- Tenir un journal `SAN_workspace/ORCHESTRATION.md` (cases à cocher par tâche, état, reprise).
- Sous-agents Sonnet en arrière-plan, un par sujet ; worktrees git séparés si deux agents
  touchent le même dépôt. Prompt d'agent : contexte à lire, périmètre, fichiers interdits,
  vérifications obligatoires avec nombres exacts, règles git, rapport court.
- Toujours relancer soi-même les tests après un rapport d'agent.
- En cas de coupure (limite de session) : `SendMessage` à l'agent coupé pour qu'il reprenne ;
  l'utilisateur a demandé une reprise automatique horaire (CronCreate) si les jetons s'épuisent.
