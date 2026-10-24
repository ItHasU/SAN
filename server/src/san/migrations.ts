import { Migration } from "@dagda/server/src/sql/migrations";

/**
 * Schéma SQL de SAN (SPEC §5, sans la table `users`, DESIGN §2).
 *
 * Les tables portent les noms de la spec, sans préfixe `data_`. Un identifiant
 * de migration appliqué n'est jamais renommé ni précédé d'une nouvelle migration.
 *
 * Écarts avec la spec §5, tous additifs :
 * - `viewers.model` et `viewers.registered_ip` : la demande d'appairage doit
 *   montrer le modèle et l'IP à l'administrateur (SPEC §4.2), ce que le schéma
 *   de la spec ne pouvait pas stocker ;
 * - index unique partiel sur `viewers.pairing_code` des viewers `pending`
 *   (DESIGN §4 : « unique parmi les pending »).
 */
export const SAN_MIGRATIONS: Migration[] = [
    {
        id: "0001-san-schema",
        up: async (tools) => {
            await tools.run(`
                CREATE TABLE agents (
                    slug        text PRIMARY KEY,
                    name        text NOT NULL,
                    description text,
                    token_hash  bytea NOT NULL UNIQUE,
                    created_at  timestamptz NOT NULL DEFAULT now(),
                    revoked_at  timestamptz
                )`);
            await tools.run(`
                CREATE TABLE agent_groups (
                    slug        text PRIMARY KEY,
                    name        text NOT NULL,
                    description text
                )`);
            await tools.run(`
                CREATE TABLE agent_group_members (
                    group_slug text REFERENCES agent_groups ON DELETE CASCADE,
                    agent_slug text REFERENCES agents       ON DELETE CASCADE,
                    PRIMARY KEY (group_slug, agent_slug)
                )`);
            await tools.run(`
                CREATE TABLE viewers (
                    id                text PRIMARY KEY,
                    kind              text NOT NULL CHECK (kind IN ('device','web')),
                    name              text,
                    status            text NOT NULL CHECK (status IN ('pending','active','revoked')),
                    token_hash        bytea NOT NULL UNIQUE,
                    hardware_id       text,
                    model             text,
                    registered_ip     text,
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
                )`);
            await tools.run(`CREATE UNIQUE INDEX viewers_pending_hw ON viewers (hardware_id) WHERE status = 'pending'`);
            await tools.run(`CREATE UNIQUE INDEX viewers_pending_code ON viewers (pairing_code) WHERE status = 'pending'`);
            await tools.run(`
                CREATE TABLE permission_rules (
                    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                    viewer_id      text NOT NULL REFERENCES viewers ON DELETE CASCADE,
                    scope          text NOT NULL CHECK (scope IN ('agent','group')),
                    pattern        text NOT NULL,
                    like_pattern   text NOT NULL,
                    can_send_voice boolean NOT NULL DEFAULT false
                )`);
            await tools.run(`
                CREATE TABLE subscriptions (
                    viewer_id     text REFERENCES viewers ON DELETE CASCADE,
                    agent_slug    text REFERENCES agents  ON DELETE CASCADE,
                    subscribed    boolean NOT NULL DEFAULT false,
                    position      integer,
                    muted         boolean NOT NULL DEFAULT false,
                    first_seen_at timestamptz NOT NULL DEFAULT now(),
                    PRIMARY KEY (viewer_id, agent_slug)
                )`);
            await tools.run(`
                CREATE TABLE agent_state (
                    agent_slug text PRIMARY KEY REFERENCES agents ON DELETE CASCADE,
                    status     text NOT NULL CHECK (status IN ('idle','working','waiting','error','done')),
                    detail     text,
                    progress   smallint CHECK (progress BETWEEN 0 AND 100),
                    ttl_s      integer,
                    updated_at timestamptz NOT NULL DEFAULT now()
                )`);
            await tools.run(`
                CREATE TABLE voice_clips (
                    id            text PRIMARY KEY,
                    source        text NOT NULL CHECK (source IN ('tts','agent_upload','viewer_upload')),
                    status        text NOT NULL CHECK (status IN ('pending','ready','failed')),
                    duration_ms   integer,
                    original_path text,
                    created_at    timestamptz NOT NULL DEFAULT now()
                )`);
            await tools.run(`
                CREATE TABLE voice_renditions (
                    clip_id     text REFERENCES voice_clips ON DELETE CASCADE,
                    format      text,
                    sample_rate integer,
                    path        text NOT NULL,
                    size        integer NOT NULL,
                    PRIMARY KEY (clip_id, format, sample_rate)
                )`);
            await tools.run(`
                CREATE TABLE events (
                    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                    direction      text NOT NULL CHECK (direction IN ('to_viewers','to_agent')),
                    agent_slug     text NOT NULL REFERENCES agents ON DELETE CASCADE,
                    from_viewer_id text REFERENCES viewers ON DELETE SET NULL,
                    kind           text NOT NULL CHECK (kind IN ('nudge','voice')),
                    text           text,
                    priority       text,
                    clip_id        text REFERENCES voice_clips,
                    created_at     timestamptz NOT NULL DEFAULT now(),
                    expires_at     timestamptz NOT NULL
                )`);
            await tools.run(`CREATE INDEX events_agent_id ON events (agent_slug, id)`);
            await tools.run(`CREATE INDEX events_expires ON events (expires_at)`);
            await tools.run(`
                CREATE TABLE cursors (
                    principal_type      text,
                    principal_id        text,
                    last_acked_event_id bigint NOT NULL DEFAULT 0,
                    PRIMARY KEY (principal_type, principal_id)
                )`);
        }
    },
    {
        // Phase 3 : file de jobs TTS (texte source, priorité, durée de vie d'un clip `pending`)
        id: "0002-tts-jobs",
        up: async (tools) => {
            await tools.run(`
                CREATE TABLE tts_jobs (
                    clip_id    text PRIMARY KEY REFERENCES voice_clips ON DELETE CASCADE,
                    agent_slug text NOT NULL REFERENCES agents ON DELETE CASCADE,
                    text       text NOT NULL,
                    priority   text,
                    ttl_s      integer NOT NULL,
                    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
                )`);
        }
    },
    {
        // Début du suivi d'un agent par un viewer (SPEC §9.2 : pas d'historique à l'abonnement)
        id: "0003-tracking-start",
        up: async (tools) => {
            await tools.run(`ALTER TABLE subscriptions ADD COLUMN subscribed_at timestamptz`);
            await tools.run(`UPDATE subscriptions SET subscribed_at = first_seen_at WHERE subscribed`);
            await tools.run(`ALTER TABLE permission_rules ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp()`);
            await tools.run(`UPDATE permission_rules r SET created_at = v.created_at FROM viewers v WHERE v.id = r.viewer_id`);
        }
    },
    {
        // Type d'un nudge (start|notification|question|done|error) ; NULL pour les événements vocaux
        id: "0004-nudge-type",
        up: async (tools) => {
            await tools.run(`ALTER TABLE events ADD COLUMN IF NOT EXISTS nudge_type text`);
            await tools.run(`UPDATE events SET nudge_type = 'notification' WHERE kind = 'nudge' AND nudge_type IS NULL`);
            await tools.run(`ALTER TABLE events DROP CONSTRAINT IF EXISTS events_nudge_type_check`);
            await tools.run(`ALTER TABLE events ADD CONSTRAINT events_nudge_type_check
                CHECK (nudge_type IS NULL OR nudge_type IN ('start','notification','question','done','error'))`);
        }
    }
];
