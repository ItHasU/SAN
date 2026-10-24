# Spécification — Afficheur d'état des agents

> Document de référence pour la construction du serveur, de l'application web et du firmware M5Stick S3.
> Version 0.2 — 23 octobre 2026.

## 1. Contexte et objectifs

Le projet permet de suivre l'état de travail de plusieurs agents logiciels sur des interfaces de visualisation (*viewers*) : une ou plusieurs cartes M5Stick S3 et une application web. Les agents publient leur état, envoient des *nudges* (demandes d'attention) et des messages vocaux ; les viewers les affichent, et une carte peut répondre par un message vocal à un agent.

Les principes directeurs sont les suivants. Un serveur HTTP central, auto-hébergé, est la source de vérité. Les agents ne disposent que de `curl`, donc toute leur interaction passe par une API HTTP simple. La carte fonctionne sur batterie et passe l'essentiel de son temps en deep sleep ; une latence d'environ une minute est acceptable pour la livraison des notifications. Chaque client est authentifié individuellement, et le serveur conserve pour chaque viewer les notifications non encore livrées.

## 2. Architecture

```
 agents (curl)  ──HTTPS──┐
                         ▼
                 ┌──────────────────┐        ┌───────────┐
 navigateur ◄─SSE─┤  api (Dagda)     │──HTTP──►│ tts (Piper)│
                 │  + web app       │        └───────────┘
 M5Stick S3 ◄────┤  + ffmpeg        │──SQL───►┌───────────┐
     (sync HTTPS)│                  │        │ PostgreSQL │
                 └──────────────────┘        └───────────┘
                   VM Docker sur NAS, derrière reverse proxy (TLS)
```

Le service `api` regroupe l'API, la diffusion SSE (*Server-Sent Events* : flux HTTP unidirectionnel du serveur vers le navigateur, utilisé pour le temps réel de l'application web), l'application web (fichiers statiques), la file de jobs TTS et le transcodage audio. Le service `db` est une base PostgreSQL, accessible uniquement depuis le réseau Docker interne. Les fichiers audio restent sur un volume disque ; la base ne contient que leurs métadonnées. Le service `tts` est un moteur Piper exposant une API HTTP, sur un réseau Docker interne non exposé. Il n'y a **pas de STT** (voir §9.4), ni de broker MQTT.

### 2.1 Choix techniques recommandés

Côté serveur : Node.js LTS et TypeScript avec le framework **Dagda** pour l'API, PostgreSQL (version 16 ou ultérieure) comme base de données, ffmpeg pour les conversions audio. Le schéma est versionné par des migrations SQL appliquées au démarrage du service. L'application web est en TypeScript vanilla, construite avec Vite et servie par le service `api`.

Côté firmware : PlatformIO avec le framework Arduino-ESP32 et M5Unified pour l'écran, l'audio, les boutons et l'alimentation. Les API ESP-IDF restent appelables directement pour le deep sleep, `esp_http_client`, `esp-tls` (reprise de session) et la NVS.

## 3. Acteurs et authentification

### 3.1 Types de principaux

| Principal | Rôle | Création |
|---|---|---|
| **Agent** | Publie état, nudges, voix ; reçoit les messages vocaux des viewers | Par un administrateur dans l'interface web |
| **Viewer** `device` | Carte M5 : affiche, joue les notifications, enregistre la voix | Auto-enrôlement puis activation par un administrateur (§4) |
| **Viewer** `web` | Instance de l'application web dans un navigateur | À la connexion d'un utilisateur authentifié (§4.4) |
| **Administrateur** | Gère agents, groupes, viewers, permissions | Utilisateur local (login / mot de passe) |

### 3.2 Jetons

Les agents et les viewers s'authentifient par un jeton opaque envoyé dans `Authorization: Bearer <token>`. Le jeton est une valeur aléatoire de 32 octets encodée en base64url, préfixée par son type pour faciliter le diagnostic (`agt_…`, `dev_…`, `web_…`). Le serveur ne stocke que son empreinte SHA-256. Un jeton n'est affiché qu'une seule fois, à sa création ; il peut être régénéré, ce qui invalide l'ancien.

Les administrateurs s'authentifient par login et mot de passe (hash argon2id). La session est portée par un cookie `HttpOnly`, `Secure`, `SameSite=Strict`.

### 3.3 Codes de réponse communs

| Code | Signification |
|---|---|
| `401` | Jeton inconnu, expiré ou révoqué. Une carte qui le reçoit efface son jeton et se réenregistre. |
| `403` | Jeton valide mais action non permise (viewer `pending`, permission absente). |
| `409` | Conflit de configuration (§8.3). |
| `413` | Charge utile trop volumineuse. |
| `429` | Limite de débit atteinte. |

## 4. Enrôlement des viewers

### 4.1 Cycle de vie

```
            register                 activation admin
 (aucun) ───────────► pending ─────────────────────────► active
                         │                                  │
                         │ 7 jours sans activation          │ révocation admin
                         ▼                                  ▼
                     (supprimé)                          revoked
```

### 4.2 Flux d'une carte

1. La carte n'a pas de jeton en NVS : elle appelle `POST /api/v1/device/register` avec son identifiant matériel, son modèle et ses capacités (§7).
2. Le serveur crée un viewer `pending` et renvoie un jeton et un **code d'appairage** court (ex. `K7-42`).
3. La carte enregistre le jeton en NVS et affiche le code d'appairage à l'écran.
4. Dans l'interface web, l'administrateur voit la demande en attente (code, modèle, identifiant matériel, IP, date), vérifie que le code correspond à la carte qu'il a sous les yeux, lui donne un nom et l'active.
5. À chaque réveil, la carte appelle `GET /api/v1/device/status`. Tant que la réponse est `pending`, elle reste en écran d'appairage. Dès qu'elle reçoit `active`, elle passe en fonctionnement normal.

Tant qu'un viewer est `pending`, son jeton ne donne accès qu'à `GET /api/v1/device/status` ; toute autre route renvoie `403`.

### 4.3 Règles

Une demande non activée au bout de **7 jours** est supprimée par une tâche périodique, avec son jeton ; la carte reçoit alors `401` et recommence l'enrôlement. Si une carte se réenregistre avec un identifiant matériel pour lequel une demande `pending` existe déjà, celle-ci est remplacée (nouveau jeton, nouveau code). Un viewer `active` dont l'identifiant matériel réapparaît dans une nouvelle demande n'est pas modifié : l'administrateur voit la demande et décide.

La route d'enregistrement est publique : elle est limitée en débit (par défaut 5 demandes par heure et par IP) et le nombre total de demandes en attente est plafonné (par défaut 20).

### 4.4 Viewers web

Un utilisateur se connecte à l'application web ; le navigateur s'enregistre alors comme viewer `web`, directement `active` puisque l'utilisateur est authentifié. Chaque navigateur a ainsi sa propre file et son propre curseur. Les viewers web apparaissent dans la liste des viewers et peuvent être révoqués comme les cartes.

## 5. Modèle de données

Les identifiants d'agents et de groupes sont des **slugs** (`[a-z0-9-]+`, éventuellement hiérarchiques avec `/`), immuables une fois créés. Ce sont eux que ciblent les motifs de permission (§6). Le nom d'affichage, lui, est libre et modifiable.

```sql
CREATE TABLE agents (
  slug        text PRIMARY KEY,
  name        text NOT NULL,
  description text,
  token_hash  bytea NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);

CREATE TABLE agent_groups (
  slug text PRIMARY KEY, name text NOT NULL, description text
);

-- un agent peut appartenir à plusieurs groupes
CREATE TABLE agent_group_members (
  group_slug text REFERENCES agent_groups ON DELETE CASCADE,
  agent_slug text REFERENCES agents       ON DELETE CASCADE,
  PRIMARY KEY (group_slug, agent_slug)
);

CREATE TABLE viewers (
  id                text PRIMARY KEY,
  kind              text NOT NULL CHECK (kind IN ('device','web')),
  name              text,
  status            text NOT NULL CHECK (status IN ('pending','active','revoked')),
  token_hash        bytea NOT NULL UNIQUE,
  hardware_id       text,
  pairing_code      text,
  subscription_mode text NOT NULL CHECK (subscription_mode IN ('auto','manual')),
  capabilities      jsonb,
  capabilities_hash text,
  battery_pct       smallint,
  next_wake_at      timestamptz,
  last_seen_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  pending_since     timestamptz,
  activated_at      timestamptz,
  revoked_at        timestamptz
);
CREATE UNIQUE INDEX viewers_pending_hw ON viewers (hardware_id) WHERE status = 'pending';

CREATE TABLE permission_rules (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  viewer_id          text NOT NULL REFERENCES viewers ON DELETE CASCADE,
  scope              text NOT NULL CHECK (scope IN ('agent','group')),
  pattern            text NOT NULL,          -- glob saisi par l'administrateur
  like_pattern       text NOT NULL,          -- traduction LIKE (§6.1)
  can_send_voice     boolean NOT NULL DEFAULT false
);

CREATE TABLE subscriptions (
  viewer_id     text REFERENCES viewers ON DELETE CASCADE,
  agent_slug    text REFERENCES agents  ON DELETE CASCADE,
  subscribed    boolean NOT NULL DEFAULT false,
  position      integer,
  muted         boolean NOT NULL DEFAULT false,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (viewer_id, agent_slug)
);

CREATE TABLE agent_state (
  agent_slug text PRIMARY KEY REFERENCES agents ON DELETE CASCADE,
  status     text NOT NULL CHECK (status IN ('idle','working','waiting','error','done')),
  detail     text,
  progress   smallint CHECK (progress BETWEEN 0 AND 100),
  ttl_s      integer,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE voice_clips (
  id            text PRIMARY KEY,
  source        text NOT NULL CHECK (source IN ('tts','agent_upload','viewer_upload')),
  status        text NOT NULL CHECK (status IN ('pending','ready','failed')),
  duration_ms   integer,
  original_path text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- cache de transcodage
CREATE TABLE voice_renditions (
  clip_id     text REFERENCES voice_clips ON DELETE CASCADE,
  format      text,
  sample_rate integer,
  path        text NOT NULL,
  size        integer NOT NULL,
  PRIMARY KEY (clip_id, format, sample_rate)
);

CREATE TABLE events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- sert de curseur (§9.2)
  direction      text NOT NULL CHECK (direction IN ('to_viewers','to_agent')),
  agent_slug     text NOT NULL REFERENCES agents ON DELETE CASCADE, -- émetteur ou destinataire
  from_viewer_id text REFERENCES viewers ON DELETE SET NULL,        -- émetteur si to_agent
  kind           text NOT NULL CHECK (kind IN ('nudge','voice')),
  text           text,
  priority       text,
  clip_id        text REFERENCES voice_clips,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL
);
CREATE INDEX events_agent_id ON events (agent_slug, id);
CREATE INDEX events_expires  ON events (expires_at);

CREATE TABLE cursors (
  principal_type      text,
  principal_id        text,
  last_acked_event_id bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (principal_type, principal_id)
);

-- administrateurs
CREATE TABLE users (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  login         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

Les sessions administrateur et les compteurs de limite de débit peuvent rester en mémoire dans le processus `api` (une seule instance) ; ils n'ont pas besoin de survivre à un redémarrage.

## 6. Permissions

### 6.1 Règles à motifs

Les permissions d'un viewer sont des règles qui ciblent soit des agents (`scope=agent`), soit des groupes d'agents (`scope=group`), par un **motif glob** appliqué au slug : `*` correspond à n'importe quelle suite de caractères, `?` à un caractère. Il n'y a pas d'expressions régulières exposées à l'administrateur. PostgreSQL n'ayant pas d'opérateur glob, le serveur traduit le motif en motif `LIKE`, en trois couches de protection contre les injections.

D'abord, une **liste blanche stricte** à la saisie : un motif ne peut contenir que `[a-z0-9/*?-]`, sur 128 caractères au plus, et tout autre caractère (guillemets, `%`, `_`, `\`, espaces, `;`…) est refusé avec une erreur `400`. La traduction ne fait ensuite que remplacer `*` par `%` et `?` par `_` ; elle échappe tout de même `%`, `_` et `\` par défense en profondeur, même si la liste blanche les exclut déjà. Le résultat est stocké dans la colonne dérivée `like_pattern`.

Ensuite, des **requêtes paramétrées** uniquement : le motif n'est jamais concaténé dans une requête SQL. Il est stocké et comparé comme une valeur liée (`$1`), et la comparaison s'écrit `agents.slug LIKE permission_rules.like_pattern ESCAPE '\'`, entre deux colonnes, avec le caractère d'échappement déclaré explicitement. Un motif, même malveillant, reste donc une donnée et ne peut pas modifier la structure de la requête ; au pire, il correspondrait à trop d'agents, ce que la liste blanche et l'aperçu de couverture (§6.2) empêchent.

Enfin, l'évaluation est sensible à la casse et la même liste blanche s'applique aux slugs d'agents et de groupes (§5), si bien que motifs et slugs partagent exactement le même alphabet.

Exemples : `scope=agent, pattern="*"` couvre tous les agents. `scope=group, pattern="perso-*"` couvre tous les agents membres d'un groupe dont le slug commence par `perso-`. `scope=agent, pattern="travail/ci/*"` couvre une branche de la hiérarchie de nommage.

Une règle donne **accès** aux agents qu'elle couvre. Un viewer qui a accès à un agent le voit dans son menu et reçoit tout ce que cet agent publie : état, nudges et messages vocaux, rendus selon ses capacités (§7). Il n'y a pas de droit de réception séparé par type de contenu.

Le seul droit supplémentaire est `can_send_voice`, porté par la règle : il autorise le viewer à envoyer un message vocal aux agents couverts. Il reste distinct de l'accès parce qu'il ouvre un canal entrant vers l'agent (§9.4).

### 6.2 Calcul de l'accès effectif

Les règles sont uniquement permissives (pas de règle d'interdiction). Un viewer a accès à un agent dès qu'au moins une règle le couvre, directement ou via l'un quelconque de ses groupes. Il peut envoyer de la voix à cet agent si au moins une de ces règles porte `can_send_voice` et si ses capacités le permettent (§7.3). Les agents révoqués sont exclus.

Une règle à wildcard couvre aussi les agents et groupes créés ultérieurement. L'interface d'administration doit donc afficher, pour chaque règle, les agents qu'elle couvre actuellement, et, à la création d'un agent ou d'un groupe ou à la modification d'une appartenance, les viewers qui y gagnent ou y perdent un accès. Pour un couple (viewer, agent), elle doit pouvoir indiquer par quelles règles l'accès est accordé.

## 7. Capacités des viewers

### 7.1 Déclaration

Chaque viewer déclare ses capacités dans un document JSON. Le hash de ce document (SHA-256 tronqué) est envoyé à chaque synchronisation ; si le serveur constate un hash différent de celui stocké, il demande l'envoi complet (§8.2).

```json
{
  "protocol_version": 1,
  "firmware": "m5-agents 0.1.0",
  "display": { "width": 135, "height": 240, "color": true, "max_detail_chars": 80 },
  "audio_out": { "formats": ["ima_adpcm", "pcm_s16le"], "sample_rates": [8000, 16000] },
  "audio_in": { "formats": ["ima_adpcm"], "sample_rate": 8000, "max_duration_s": 10 },
  "nudge": ["sound", "led"],
  "input": ["buttons"],
  "battery": true
}
```

Les valeurs ci-dessus sont indicatives et doivent être ajustées aux caractéristiques réelles de la carte. Un viewer web déclare ses capacités à chaque ouverture (lecture audio, micro selon la permission accordée par le navigateur, notifications système).

### 7.2 Adaptation des envois

Le serveur choisit pour chaque viewer le meilleur format audio parmi ceux déclarés, transcode à la demande et met le résultat en cache dans `voice_renditions`. Un viewer sans `audio_out` reçoit les messages vocaux sous forme de texte seul lorsque celui-ci existe (texte source du TTS). Les nudges sont signalés avec les modes déclarés dans `nudge`. Le champ `detail` d'un état est tronqué à `max_detail_chars`.

### 7.3 Restriction des droits

Les capacités étant auto-déclarées, elles ne peuvent que **restreindre** ce que reçoit ou envoie un viewer, jamais élargir son accès. Un viewer sans `audio_out` reçoit les messages vocaux sous forme de texte seul, un viewer sans écran ne reçoit pas de `detail`, et `can_send_voice` est sans effet sans `audio_in`. L'interface d'administration grise `can_send_voice` pour un viewer qui ne déclare pas de micro et en indique la raison.

### 7.4 Versions de protocole

`protocol_version` permet au serveur de continuer à servir un viewer ancien dans le format qu'il comprend lorsque l'API évolue. Le serveur rejette avec `426` une version qu'il ne prend plus en charge.

## 8. Configuration et abonnements

### 8.1 Modes d'abonnement

Chaque viewer déclare son `subscription_mode` à l'enregistrement : `manual` pour une carte, `auto` pour l'application web. L'administrateur peut le modifier.

Ce qui s'affiche sur un viewer, ce sont toujours des **agents**, jamais des groupes. Les groupes ne servent qu'à l'administration des permissions.

En mode **`manual`**, les agents suivis sont ceux pour lesquels une ligne `subscriptions` a `subscribed=1`, parmi les agents visibles, c'est-à-dire ceux auxquels il a accès (§6.2). Un agent visible sans ligne d'abonnement est présenté comme **nouveau** dans le menu, non coché. La première consultation du menu crée la ligne (`subscribed=0`, `first_seen_at`).

En mode **`auto`**, les agents suivis sont tous les agents visibles, recalculés à chaque synchronisation. Les lignes `subscriptions` ne portent que des préférences (`position`, `muted`) ; le champ `subscribed` est ignoré. Un agent sans ligne prend une position par défaut (ordre alphabétique du nom) et n'est pas muet.

Lors d'un passage de `auto` à `manual`, le serveur crée ou met à jour une ligne `subscribed=1` pour chaque agent actuellement visible, afin que rien ne disparaisse de l'affichage. Lors d'un passage de `manual` à `auto`, les lignes existantes sont conservées comme préférences.

Lorsqu'un droit est retiré, la ligne d'abonnement est conservée mais devient inactive ; si le droit revient, la configuration du viewer est restaurée telle quelle.

### 8.2 Hash de configuration

La **configuration effective** d'un viewer comprend son mode, la liste ordonnée des agents visibles avec, pour chacun, l'indication `can_send_voice` effective, leur état d'abonnement, leur position et leur drapeau `muted`. Le serveur en calcule un hash à chaque synchronisation ; le viewer envoie le hash de la configuration qu'il détient. S'ils diffèrent, la réponse de synchronisation inclut la configuration complète. Aucun compteur n'est maintenu à la main : tout changement (règle, groupe, agent, abonnement, mode, capacités) se répercute par construction.

### 8.3 Modification depuis un viewer

Un viewer modifie ses abonnements avec `PUT /api/v1/viewer/config`, en envoyant le hash de la configuration sur laquelle il s'est basé. Si la configuration a changé côté serveur entre-temps, le serveur répond `409` avec la configuration courante, que le viewer adopte. Les modifications depuis l'interface d'administration sont appliquées immédiatement côté serveur et atteignent la carte à son réveil suivant, via le hash.

Un viewer ne peut s'abonner qu'à des agents visibles ; les entrées non autorisées sont rejetées.

## 9. Événements, livraison et audio

### 9.1 État et événements

L'**état** d'un agent est une valeur courante : seule la dernière est conservée, et un viewer reçoit à chaque synchronisation un instantané des états des agents qu'il suit. Le statut prend l'une des valeurs `idle`, `working`, `waiting`, `error`, `done`, accompagnée d'un `detail` libre et d'un `progress` optionnel (0–100). Si l'agent fournit `ttl_s`, l'état est présenté comme périmé (`stale`) une fois ce délai dépassé sans mise à jour.

Les **nudges** et **messages vocaux** sont des événements, inscrits dans le journal `events` avec un identifiant croissant.

| Direction | Émetteur | Destinataires |
|---|---|---|
| `to_viewers` | un agent | tous les viewers actifs qui ont accès à l'agent et le suivent ; le contenu est adapté à leurs capacités |
| `to_agent` | un viewer | l'agent désigné, si le viewer a `can_send_voice` sur lui |

### 9.2 Curseurs et acquittement

Chaque principal (viewer ou agent) a un curseur `last_acked_event_id` stocké côté serveur. Une synchronisation renvoie les événements d'identifiant supérieur au curseur, **filtrés au moment de la lecture** selon les abonnements et droits courants. Une modification d'abonnement s'applique donc aussi aux événements pas encore livrés : un viewer désabonné d'un agent pendant son sommeil ne reçoit pas les anciens nudges de cet agent ; un viewer nouvellement abonné reçoit l'état courant, mais pas l'historique.

Avec PostgreSQL, les identifiants d'une séquence sont attribués à l'insertion mais visibles au commit : deux transactions concurrentes peuvent rendre visible l'événement 42 après l'événement 43, et un client qui aurait déjà acquitté 43 manquerait le 42. Pour l'éviter, toute insertion dans `events` se fait dans une transaction qui prend d'abord un verrou consultatif (`pg_advisory_xact_lock`) dédié : les insertions sont ainsi sérialisées et les identifiants deviennent visibles dans l'ordre. Le volume d'événements est faible, ce verrou n'a pas de coût notable. La même transaction émet un `NOTIFY` qui réveille la diffusion SSE et les long-polls des agents en attente.

L'acquittement est explicite : le client indique le dernier identifiant qu'il a entièrement traité (clip téléchargé et joué ou stocké). Un événement non acquitté est renvoyé à la synchronisation suivante, ce qui rend sans conséquence un endormissement en cours de téléchargement. Le curseur ne peut qu'avancer.

### 9.3 Expiration et purge

Chaque événement a une date d'expiration. Par défaut, un nudge expire au bout de 6 heures et un message vocal au bout de 7 jours ; l'émetteur peut fournir une valeur plus courte. Une tâche périodique supprime les événements expirés, ainsi que les événements `to_viewers` dont l'identifiant est inférieur ou égal au plus petit curseur des viewers actifs, et les événements `to_agent` acquittés par leur agent. Les clips audio qui ne sont plus référencés sont supprimés avec leurs conversions.

### 9.4 Audio

**Agent vers viewers.** Un agent peut envoyer du texte, synthétisé par le serveur (TTS), ou un fichier audio. Le texte est enfilé comme job TTS ; l'événement n'est inscrit au journal qu'une fois le clip prêt. Le texte source est conservé avec l'événement : il est affiché à l'écran et sert de repli pour les viewers sans sortie audio. Durée maximale d'un clip : 30 s ; longueur maximale d'un texte TTS : 500 caractères.

**Viewer vers agent.** La carte enregistre un message de quelques secondes (au plus `audio_in.max_duration_s`) et l'envoie au serveur, qui le stocke tel quel et l'expose à l'agent dans le format demandé.

**Pas de transcription.** Le serveur ne fait volontairement **pas** de STT. Une transcription injectée dans un agent constituerait une entrée texte non maîtrisée dans un prompt (risque d'injection), et ne s'intègre pas simplement dans un usage par `curl`. L'agent reçoit le fichier audio et le traite s'il en est capable. La permission `can_send_voice` limite quels viewers peuvent parler à quels agents.

**Formats.** Formats pivots côté serveur : WAV PCM 16 bits mono. Formats servis aux cartes : IMA ADPCM ou PCM brut à la fréquence déclarée (8 kHz par défaut pour la voix). Formats servis aux agents : `wav` (16 kHz mono, par défaut), `mp3`, `ogg` (Opus). Toutes les conversions passent par ffmpeg et sont mises en cache.

## 10. API

Toutes les routes sont préfixées par `/api/v1`. Les corps sont en JSON, sauf les envois audio (corps binaire avec le `Content-Type` approprié). Les dates sont en ISO 8601 UTC.

### 10.1 Agents

L'identité de l'agent est déduite de son jeton : aucune route ne prend son slug en paramètre.

| Méthode | Route | Description |
|---|---|---|
| `POST` | `/agent/state` | Met à jour l'état. Corps : `{status, detail?, progress?, ttl_s?}` |
| `POST` | `/agent/nudge` | Émet un nudge. Corps : `{text?, priority?: "normal"\|"high", type?: "start"\|"notification"\|"question"\|"done"\|"error", ttl_s?}`. `type` (défaut `notification`) qualifie le nudge ; valeur inconnue : 400. Il est renvoyé sous la clé `type` dans les événements `nudge` de la synchronisation et du flux SSE |
| `POST` | `/agent/say` | Message vocal par TTS. Corps : `{text, priority?, ttl_s?}`. Réponse `202` avec l'id du clip |
| `POST` | `/agent/voice` | Message vocal à partir d'un fichier (`audio/wav`, `audio/mpeg`, `audio/ogg`) |
| `GET` | `/agent/inbox?ack=<id>&wait=<s>` | Messages reçus des viewers, en long-poll (`wait` ≤ 60). `ack` acquitte avant lecture |
| `GET` | `/agent/voice/:clip?format=wav\|mp3\|ogg` | Télécharge un message vocal reçu |

Exemples :

```sh
TOKEN=agt_xxx; API=https://agents.example.org/api/v1

curl -sX POST $API/agent/state -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"status":"working","detail":"Analyse du dépôt","progress":40,"ttl_s":900}'

curl -sX POST $API/agent/say -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"text":"J’ai besoin de ta validation."}'

curl -s "$API/agent/inbox?wait=30" -H "Authorization: Bearer $TOKEN"
```

Réponse de `/agent/inbox` :

```json
{
  "events": [
    { "id": 812, "kind": "voice", "from": { "viewer": "m5-bureau", "name": "Carte bureau" },
      "created_at": "2026-10-23T15:04:12Z",
      "clip": { "id": "c_01J…", "duration_ms": 4200, "url": "/api/v1/agent/voice/c_01J…" } }
  ],
  "has_more": false
}
```

### 10.2 Enrôlement des cartes

| Méthode | Route | Auth | Description |
|---|---|---|---|
| `POST` | `/device/register` | aucune | Corps : `{hardware_id, model, capabilities}`. Réponse : `{token, pairing_code, status:"pending"}` |
| `GET` | `/device/status` | jeton | `{status:"pending"\|"active"}` ; `401` si purgé ou révoqué |

### 10.3 Viewers

| Méthode | Route | Description |
|---|---|---|
| `GET` | `/viewer/sync` | Synchronisation (§10.4). Paramètres : `ack`, `config_hash`, `caps_hash`, `battery` |
| `POST` | `/viewer/ack` | Corps `{up_to}` ; acquittement isolé (utile au web) |
| `PUT` | `/viewer/capabilities` | Envoi du document de capacités |
| `GET` | `/viewer/config` | Configuration effective, avec agents visibles et marqueurs `new` |
| `PUT` | `/viewer/config` | Corps `{base_hash, subscriptions:[{agent, subscribed, position, muted}]}` ; `409` si conflit |
| `GET` | `/viewer/voice/:clip` | Clip dans le format adapté aux capacités du viewer |
| `POST` | `/viewer/voice?to=<agent>` | Envoi d'un message vocal à un agent (corps audio au format déclaré) |
| `GET` | `/viewer/events` | Flux SSE pour le web ; reprise par `Last-Event-ID` |

### 10.4 Contrat de synchronisation

Requête typique d'une carte à son réveil :

```
GET /api/v1/viewer/sync?ack=807&config_hash=3f9a1c&caps_hash=b71e02&battery=82
Authorization: Bearer dev_xxx
```

Le serveur applique d'abord l'acquittement, met à jour `last_seen_at` et `battery_pct`, puis répond :

```json
{
  "server_time": "2026-10-23T15:05:00Z",
  "capabilities_required": false,
  "config_hash": "3f9a1c",
  "config": null,
  "states": [
    { "agent": "build-1", "name": "Build", "status": "working",
      "detail": "Compilation firmware", "progress": 40, "stale": false,
      "updated_at": "2026-10-23T15:03:10Z" }
  ],
  "events": [
    { "id": 808, "agent": "build-1", "kind": "nudge", "priority": "high", "type": "error",
      "text": "Échec des tests", "created_at": "2026-10-23T15:04:40Z" },
    { "id": 809, "agent": "veille", "kind": "voice", "text": "Trois nouveaux articles.",
      "clip": { "id": "c_01J…", "format": "ima_adpcm", "sample_rate": 8000,
                "size": 17600, "duration_ms": 4400 },
      "created_at": "2026-10-23T15:04:55Z" }
  ],
  "has_more": false,
  "next_sync_s": 60
}
```

`config` n'est renseigné que si `config_hash` diffère. Si `capabilities_required` vaut `true`, le viewer envoie ses capacités puis refait une synchronisation. `has_more` indique qu'une page supplémentaire est disponible (50 événements par page). `next_sync_s` est une indication du serveur pour le prochain réveil.

### 10.5 Administration

Routes protégées par la session administrateur :

| Ressource | Routes |
|---|---|
| Agents | `GET/POST /admin/agents`, `GET/PATCH/DELETE /admin/agents/:slug`, `POST /admin/agents/:slug/token` (régénération) |
| Groupes | `GET/POST /admin/groups`, `GET/PATCH/DELETE /admin/groups/:slug`, `PUT /admin/groups/:slug/members` |
| Viewers | `GET /admin/viewers?status=`, `GET/PATCH /admin/viewers/:id`, `POST /admin/viewers/:id/activate`, `POST /admin/viewers/:id/revoke` |
| Permissions | `GET/POST /admin/viewers/:id/rules`, `PATCH/DELETE /admin/rules/:id`, `GET /admin/rules/:id/coverage` |
| Abonnements | `GET/PUT /admin/viewers/:id/subscriptions` |
| Diagnostic | `GET /admin/viewers/:id/access/:agent` (règles accordant l'accès) |

## 11. Application web

L'application web a deux facettes, servies par le même code et le même serveur.

**Tableau de bord** (viewer `web`, mode `auto`) : liste des agents visibles avec leur état en temps réel via SSE, historique récent des nudges et messages vocaux avec lecteur audio, et, si le navigateur le permet, enregistrement d'un message vocal vers un agent.

**Administration** :

- *Demandes en attente* : code d'appairage, modèle, identifiant matériel, IP, ancienneté ; actions activer (avec saisie du nom) et refuser.
- *Viewers* : nom, type, statut, mode d'abonnement, capacités, version de firmware, dernière connexion, prochain réveil prévu, batterie ; édition des règles de permission avec aperçu de couverture et des abonnements, ordonnables par glisser-déposer.
- *Agents* : création (le jeton n'est affiché qu'une fois), régénération de jeton, révocation, groupes d'appartenance, état courant, viewers qui y ont accès.
- *Groupes* : création, membres, viewers concernés par les règles qui ciblent le groupe.

Toute action qui modifie la couverture des permissions affiche, avant validation, les viewers qui gagnent ou perdent l'accès.

## 12. Firmware M5Stick S3

### 12.1 Machine à états

```
 BOOT ─► pas de jeton ─► REGISTER ─► PAIRING (affiche le code, réveil périodique sur /device/status)
            │                                   │ active
            └─ jeton présent ───────────────────┴─► RUN (cycle de synchronisation)
 401 dans n'importe quel état ─► efface le jeton ─► REGISTER
```

### 12.2 Cycle de fonctionnement

La carte reste en deep sleep et se réveille sur deux sources : un timer RTC (par défaut 60 s, ajusté selon `next_sync_s`) et le bouton principal. À chaque réveil, elle se connecte au Wi-Fi, appelle `/viewer/sync` en acquittant les événements traités au cycle précédent, télécharge et joue les clips, met à jour l'écran si nécessaire, puis se rendort.

Pour minimiser la consommation, la reconnexion est accélérée par une IP statique optionnelle et par la mémorisation, en RTC memory, du canal et du BSSID du point d'accès. La reprise de session TLS (session ou ticket conservé en RTC memory) évite un handshake complet à chaque réveil. Si la carte reconnaît le réseau domestique (SSID configuré), elle peut utiliser l'URL LAN du serveur ; sinon, elle utilise l'URL publique.

### 12.3 Affichage et interactions

L'écran est éteint pendant le sommeil. Sur réveil timer, il ne s'allume que s'il y a un nudge, un message vocal ou un changement d'état notable sur un agent non muet. Un appui sur le bouton allume l'écran et affiche les états des agents suivis pendant quelques secondes. Le rétroéclairage s'éteint après un délai configurable.

Les interactions par boutons comprennent la navigation entre agents, la réécoute du dernier message, l'enregistrement d'un message vocal vers l'agent sélectionné (bouton maintenu ; le Wi-Fi s'associe pendant l'enregistrement) et un menu de configuration qui liste les agents visibles, signale les nouveaux et permet de cocher ou décocher les abonnements.

### 12.4 Stockage

En NVS (chiffrée si possible) : jeton, URL du serveur, identifiants Wi-Fi, SSID du réseau domestique. En RTC memory : dernier événement traité, hash de configuration, hash de capacités, configuration effective, informations de reconnexion Wi-Fi et session TLS. Un premier démarrage sans configuration Wi-Fi ouvre un portail de configuration (point d'accès temporaire).

## 13. Déploiement

Déploiement par Docker Compose dans une VM du NAS :

```yaml
services:
  api:
    build: ./server
    environment:
      PUBLIC_URL: https://agents.example.org
      TTS_URL: http://tts:5000
      DATA_DIR: /data
      DATABASE_URL: postgres://agents:${DB_PASSWORD}@db:5432/agents
    depends_on:
      db: { condition: service_healthy }
    volumes: [./data:/data]       # fichiers audio
    networks: [proxy, internal]
    restart: unless-stopped
  db:
    image: postgres:16
    environment:
      POSTGRES_DB: agents
      POSTGRES_USER: agents
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes: [./pgdata:/var/lib/postgresql/data]
    networks: [internal]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U agents"]
      interval: 10s
    restart: unless-stopped
  tts:
    image: <image Piper avec API HTTP>
    volumes: [./voices:/voices]   # voix françaises
    networks: [internal]
    restart: unless-stopped
networks:
  proxy: { external: true }
  internal: { internal: true }
```

Seul `api` est exposé, derrière le reverse proxy existant avec un certificat Let's Encrypt. `db` et `tts` n'ont aucun accès extérieur ; le mot de passe de la base est fourni par un fichier `.env` non versionné. Le moteur TTS est isolé derrière une interface dans le code du serveur, pour pouvoir être remplacé sans toucher au reste. La sauvegarde porte sur le volume `data` (fichiers audio) et sur la base, exportée à chaud par un `pg_dump` planifié ; le répertoire `pgdata` lui-même n'est pas sauvegardé par copie de fichiers.

## 14. Sécurité

Le serveur est exposé sur internet ; les mesures suivantes sont requises. Jetons stockés sous forme d'empreinte uniquement et comparés en temps constant. Limites de débit par jeton et par IP, renforcées sur `/device/register` et sur le login administrateur. Tailles maximales des corps (JSON : 64 Ko ; audio : 2 Mo) et durée maximale des clips vérifiée après décodage. Validation stricte des slugs et des motifs glob par liste blanche (caractères autorisés, longueur, §6.1). Toutes les requêtes SQL sont paramétrées, sans exception : aucune valeur venant d'un client (slug, motif, texte, identifiant, paramètre de requête) n'est concaténée dans du SQL, et les noms de tri ou de colonnes éventuellement choisis par l'interface passent par une table de correspondance fixe côté serveur. Le rôle PostgreSQL utilisé par `api` n'a que les droits nécessaires sur le schéma de l'application, sans droit de superutilisateur ni de création de rôles. Aucun contenu fourni par un agent n'est interprété côté serveur ; l'application web échappe tous les textes affichés. CORS désactivé, l'application web étant servie par la même origine. Journalisation des actions d'administration (activation, révocation, modification des règles).

## 15. Hors périmètre et évolutions possibles

Les points suivants sont volontairement exclus de la première version : transcription des messages vocaux (STT), règles de permission d'interdiction, pont MQTT vers Home Assistant (publication sortante depuis le serveur, sans dépendance du firmware), encodage Opus sur la carte, nudges d'un viewer vers un agent.

## 16. Points ouverts

- Nom définitif du projet et du dépôt.
- Conventions du framework Dagda à reporter dans la spec (structure du projet, routage, accès à PostgreSQL, gestion des migrations).
- Caractéristiques exactes du M5Stick S3 à vérifier (écran, codec et formats audio, boutons, PSRAM, capacité de batterie) pour fixer les capacités déclarées et les durées d'enregistrement.
- Ergonomie précise des boutons sur la carte.
- Valeurs par défaut à valider : intervalle de réveil, durées de vie des nudges et messages vocaux, délais d'extinction de l'écran.
- Choix de l'image Piper (serveur HTTP) et de la voix française.
- Gestion multi-utilisateurs de l'application web : pour l'instant, tout utilisateur connecté est administrateur.
