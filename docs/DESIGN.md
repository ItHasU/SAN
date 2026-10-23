# SAN — Décisions de conception

Complète `docs/SPEC.md` (la référence fonctionnelle). Ce document fixe les points
que la spec laisse ouverts ou que le framework Dagda impose différemment. En cas de
contradiction, **ce document l'emporte** sur la spec. Toute nouvelle décision
structurante doit y être ajoutée.

## 1. Dépôts

| Dépôt | Contenu |
|---|---|
| `SAN` | Serveur (API + app web admin/tableau de bord), image Docker, compose, image TTS |
| `SAN_viewer-M5StickS3` | Firmware PlatformIO de la carte |
| `SAN_agent-claude_code` | Configuration Claude Code (hooks + skill + script `bin/san`) pour qu'une session Claude Code soit un agent SAN, et faux agent de démo (`tools/fake-agent.sh`) |
| `dagda` | Framework. Modifications éventuelles sur la branche `feat/san-support` |

`SAN` dépend de Dagda via `file:../dagda/packages/*` (même disposition que
`MQTTToolbox2`) : `dagda/` et `SAN/` sont des répertoires frères.

## 2. Écarts assumés avec la spec

- **Build client** : la chaîne Dagda (webpack) remplace Vite.
- **Administrateurs** : comptes locaux Dagda (`system_users`, scrypt) au lieu de la
  table `users` + argon2id. Tout utilisateur connecté est administrateur (spec §16).
  Les sessions sont celles de Dagda. Pas de table `users` dans le schéma SAN.
- **Journal d'administration** : journal d'audit Dagda (`registerAction` journalise
  automatiquement). Les actions admin qui modifient des données passent par des
  actions Dagda quand c'est possible.
- **Schéma** : les tables de la spec §5 sont créées par des migrations SQL brutes
  (`tools.run(...)`) et non via le modèle d'entités Dagda (identifiants texte,
  `bytea`, contraintes `CHECK`, index partiels). Les noms de tables sont ceux de la
  spec, sans préfixe `data_`. La table `users` est omise. Le modèle d'entités Dagda
  reste vide ou minimal.
- **Temps réel web** : le flux `/viewer/events` est au format SSE mais le client web
  le lit avec `fetch()` + `ReadableStream` (pas `EventSource`), pour pouvoir envoyer
  `Authorization: Bearer web_…`. Pas de jeton dans l'URL.

## 3. Organisation du serveur

- L'API `/api/v1/*` (agents, cartes, viewers) est un `express.Router` monté sur
  `this._publicRouter` (ajout Dagda, branche `feat/san-support` : routeur placé avant
  les parseurs de corps globaux et la porte de session), avec ses
  propres middlewares : authentification Bearer, limites de taille (JSON 64 Ko,
  audio 2 Mo, `express.raw`), limite de débit en mémoire. Elle n'utilise pas la
  session Dagda, sauf :
  - `POST /api/v1/web/register` (session admin Dagda requise) → crée un viewer `web`
    actif et renvoie `{viewer_id, token}`. Corps : `{capabilities, label?}`.
  - `/api/v1/admin/*` (spec §10.5) : session Dagda requise ; `401` sinon.
- Logique métier dans des modules testables indépendamment d'Express
  (`server/src/san/*.ts` : tokens, glob, permissions, config, sync, events, audio, tts…).
- Accès SQL : `this._db` (runner PG Dagda), requêtes **toujours paramétrées**.
- `NOTIFY san_events` après chaque insertion d'événement / changement d'état ; un
  `LISTEN` dédié (client `pg` séparé) réveille SSE et long-polls. En test, un bus
  en mémoire équivalent est acceptable derrière la même interface.
- Tâches périodiques (purge événements expirés / acquittés, clips orphelins,
  viewers pending > 7 j) : `setInterval` dans le process (toutes les 10 min), et
  fonction exportée appelable par les tests.

## 4. Conventions de protocole

- **Jetons** : `agt_` / `dev_` / `web_` + 32 octets aléatoires en base64url. Stocké :
  `sha256(token)` (bytea). Recherche par hash puis comparaison `timingSafeEqual`.
- **Code d'appairage** : `[A-Z]{1}[0-9A-Z]{1}-[0-9]{2}` lisible, sans `0/O/1/I`
  (ex. `K7-42`). Unique parmi les pending.
- **Identifiant de viewer** : `v_` + 10 caractères base32 minuscules.
- **Identifiant de clip** : `c_` + ULID-like (base32 Crockford, 26 caractères).
- **`caps_hash`** : 16 premiers caractères hex de `sha256(corps brut tel que reçu
  par PUT /viewer/capabilities)`. Le client calcule le même hash sur la chaîne qu'il
  envoie. Le serveur stocke le hash ET le JSON parsé.
- **`config_hash`** : 16 premiers caractères hex de `sha256(JSON canonique de la
  config effective)` (clés triées). Opaque pour le client.
- **Config effective** (`GET /viewer/config`, champ `config` de sync) :
  ```json
  { "mode": "manual",
    "agents": [ { "agent": "build-1", "name": "Build", "subscribed": true,
                  "new": false, "position": 0, "muted": false, "can_send_voice": true } ] }
  ```
  Triée par `position` (null en dernier), puis `name`. En mode `auto`, `subscribed`
  vaut toujours `true` et `new` toujours `false`.
- **`protocol_version`** supportée : `1`. Toute autre → `426`.
- **Pagination sync** : 50 événements ; `has_more`.
- **`next_sync_s`** : 60 par défaut ; 15 s s'il y a `has_more` ; `register`/pending : 60.
- **Stale** : `stale = ttl_s != null && now > updated_at + ttl_s`.
- **Erreurs JSON** : `{ "error": "code_court", "message": "texte" }`.

## 5. Audio

- Pivot : WAV PCM s16le mono 16 kHz (`original_path` = fichier tel que reçu ;
  une rendition `wav/16000` est produite immédiatement à la réception).
- Formats viewer (`audio_out.formats`) : `pcm_s16le` (WAV PCM 16 bits) et
  `ima_adpcm` (WAV `adpcm_ima_wav`). Toujours dans un conteneur **RIFF/WAV** pour être
  auto-descriptif. Préférence serveur : `ima_adpcm` si déclaré, sinon `pcm_s16le` ;
  fréquence : la plus haute déclarée ≤ 16000. Viewer web : `audio_out.formats =
  ["mp3","ogg","pcm_s16le"]` → servi en `mp3` (le serveur sait aussi servir `mp3`/`ogg`).
- Envoi viewer → agent : corps `audio/wav` (PCM ou IMA ADPCM) ou, pour le web,
  `audio/webm`/`audio/ogg` (MediaRecorder). Le serveur stocke l'original et transcode
  en pivot. Durée max vérifiée après décodage (`ffprobe`).
- Formats agent : `wav` (16 kHz), `mp3`, `ogg` (Opus).
- Cache : `voice_renditions`, fichiers sous `DATA_DIR/clips/<clip>/<format>-<rate>.<ext>`.
- **TTS** : interface `TtsEngine { synthesize(text): Promise<Buffer /* wav */> }`.
  Implémentations : `PiperHttpTts` (`TTS_URL`, `POST /` JSON `{"text": …}` → WAV PCM
  mono à la fréquence de la voix, 22 050 Hz pour `fr_FR-siwis-medium` ; serveur maison
  `tts/server.py` autour de `piper-tts==1.8.0`, voir `tts/README.md`) et `FakeTts` (bip ffmpeg de
  durée ∝ texte) sélectionnée par `TTS_ENGINE=fake` (tests, dev sans Piper).
  File de jobs en mémoire, concurrence 1, reprise des clips `pending` au démarrage.

## 6. Variables d'environnement

Celles de Dagda (`APP_PORT`, `APP_BASE_URL`, `APP_DATABASE_URL`, `APP_SECRET`) plus :
`DATA_DIR` (défaut `./data`), `TTS_URL`, `TTS_ENGINE` (`piper`|`fake`, défaut
`piper` si `TTS_URL` défini sinon `fake`), `FFMPEG_PATH`/`FFPROBE_PATH` (optionnels),
`SAN_REGISTER_RATE_PER_HOUR` (5), `SAN_MAX_PENDING` (20), `SAN_TRUST_PROXY` (1).

## 7. Firmware — capacités déclarées (M5StickS3, à confirmer)

```json
{ "protocol_version": 1, "firmware": "san-m5sticks3 0.1.0",
  "display": { "width": 135, "height": 240, "color": true, "max_detail_chars": 80 },
  "audio_out": { "formats": ["ima_adpcm", "pcm_s16le"], "sample_rates": [8000, 16000] },
  "audio_in": { "formats": ["pcm_s16le"], "sample_rate": 16000, "max_duration_s": 10 },
  "nudge": ["sound", "screen"], "input": ["buttons"], "battery": true }
```

## 8. Vérification

- `SAN` : Vitest (unitaires `shared`/`server`, intégration contre un vrai
  PostgreSQL local via `DAGDA_TEST_DB_URL`), tests d'API HTTP (supertest ou `fetch`
  sur un serveur démarré), Playwright (viewport mobile Pixel 7 / iPhone 13 en
  priorité + desktop) sur le tableau de bord et l'administration, script
  `tools/e2e-smoke.sh` (curl) qui joue le parcours complet agent → viewer.
- Firmware : `pio run` (compilation) + `pio test -e native` sur la logique pure
  (parsing JSON de sync, machine à états, hash).
- Agent Claude Code : `shellcheck` + test des scripts contre un serveur local.

## 9. Environnement de dev local (container)

PostgreSQL 17 local (pas de Docker) : `sudo pg_ctlcluster 17 main start`.
Bases : `postgresql://dagda:dagda@localhost:5432/dagda` (tests, `DAGDA_TEST_DB_URL`)
et `postgresql://dagda:dagda@localhost:5432/san` (serveur de dev). ffmpeg dans `/usr/bin`.

## 10. Précisions de la phase 2 (permissions, sync, SSE)

- **Aperçu d'impact** : toute route d'administration qui peut modifier la couverture
  s'exécute dans une transaction (`withImpact`). `?dry_run=1` annule la transaction et
  répond `{dry_run: true, gained, lost}` ; sinon la réponse normale porte `impact:
  {gained, lost}`. Un élément est `{viewer, viewer_name, agent}`, calculé entre viewers
  `active` et agents non révoqués. Les suppressions (`DELETE /admin/agents/:slug?purge=true`,
  `DELETE /admin/groups/:slug`, `DELETE /admin/rules/:id`) répondent `200 {deleted: true,
  impact}` et non plus `204`.
- **Hash de config et marqueur `new`** : `GET /viewer/config` crée les lignes manquantes
  (`subscribed=false`) mais renvoie les marqueurs `new` de cette consultation ; son
  `config_hash` est celui de l'état persisté (où `new` vaut false), le même que verra la
  synchronisation suivante et que le viewer renverra en `base_hash`. `sync` ne crée jamais de ligne.
- **`PUT /viewer/config`** : `base_hash` obligatoire ; `409 config_conflict` avec
  `{config_hash, config}` à la racine ; un agent non visible ou inconnu → `403
  agent_not_visible` (l'admin reçoit `400`). Les champs absents d'une entrée ne sont pas touchés.
- **Curseurs** : un `ack` supérieur au dernier identifiant attribué est ramené à celui-ci
  (on n'acquitte pas d'événements futurs). Pas de curseur initial à l'activation : un viewer
  qui commence à suivre un agent reçoit les événements non expirés de celui-ci (6 h / 7 j),
  ce qui déroge à « pas l'historique » de la spec §9.2.
- **SSE** : au départ `hello {config_hash}` ; les événements repartent de `Last-Event-ID`,
  à défaut du curseur acquitté du viewer ; `event: config {config_hash}` quand la config
  change, suivi de l'état des agents nouvellement suivis ; le flux se ferme si le viewer
  n'est plus actif. Heartbeat `:` toutes les 25 s (`sseHeartbeatMs`), qui relit aussi
  la base par sécurité.
- **Bus** : le message `NOTIFY` porte le schéma courant (`current_schema()`), le bus ignore
  ceux d'un autre schéma. Types : `event`, `state`, `config` (`viewer: id | null`),
  `reconnect` (émis localement après une reconnexion du `LISTEN`).
- **`inbox`** : `from.viewer` est l'identifiant du viewer ; `clip` vaut `null` tant que le
  clip n'est pas `ready`.
- **Purge** : en plus de la spec §9.3, les curseurs de viewers/agents disparus sont
  supprimés ; un clip orphelin n'est supprimé qu'après 1 h (il peut précéder son événement).
