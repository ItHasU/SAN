import { Db, Sql } from "./db";

/** Canal LISTEN/NOTIFY qui réveille SSE et long-polls (DESIGN §3) */
export const NOTIFY_CHANNEL = "san_events";

/**
 * Clé du verrou consultatif qui sérialise les insertions dans `events` (SPEC §9.2).
 * Les identifiants d'une séquence sont attribués à l'insertion mais visibles au
 * commit : sans ce verrou, l'événement 42 pourrait devenir visible après le 43.
 */
export const EVENTS_LOCK_KEY = 7_301_001;

/** Durées d'expiration par défaut (SPEC §9.3) */
export const NUDGE_TTL_S = 6 * 3600;
export const VOICE_TTL_S = 7 * 24 * 3600;

export interface NewEvent {
    direction: "to_viewers" | "to_agent";
    agentSlug: string;
    fromViewerId?: string | null;
    kind: "nudge" | "voice";
    text?: string | null;
    priority?: string | null;
    clipId?: string | null;
    /** Durée de vie en secondes ; l'appelant a déjà appliqué défaut et plafond */
    ttlS: number;
}

export interface InsertedEvent {
    id: number;
    created_at: Date;
    expires_at: Date;
}

/**
 * Notifie les écouteurs ; livré au commit de la transaction en cours (rien
 * n'est émis si elle est annulée). Le schéma courant est ajouté au message :
 * `NOTIFY` est global à la base, et le bus ignore les messages d'un autre
 * schéma (suites de tests en parallèle).
 */
export async function notify(sql: Sql, payload: Record<string, unknown>): Promise<void> {
    await sql.run(
        `SELECT pg_notify($1, (jsonb_build_object('schema', current_schema()) || $2::jsonb)::text)`,
        NOTIFY_CHANNEL, JSON.stringify(payload)
    );
}

/** Signal « la configuration d'un viewer (ou de tous) a peut-être changé » */
export async function notifyConfigChanged(sql: Sql, viewerId: string | null = null): Promise<void> {
    await notify(sql, { type: "config", viewer: viewerId });
}

/**
 * Insère un événement dans une transaction qui prend d'abord le verrou
 * consultatif, puis émet le `NOTIFY` (SPEC §9.2).
 */
export async function insertEvent(db: Db, event: NewEvent): Promise<InsertedEvent> {
    return db.withTransaction(async (conn) => {
        await conn.run(`SELECT pg_advisory_xact_lock($1)`, EVENTS_LOCK_KEY);
        const row = await conn.get<{ id: string, created_at: Date, expires_at: Date }>(
            `INSERT INTO events (direction, agent_slug, from_viewer_id, kind, text, priority, clip_id, created_at, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp(), clock_timestamp() + make_interval(secs => $8))
             RETURNING id, created_at, expires_at`,
            event.direction, event.agentSlug, event.fromViewerId ?? null, event.kind,
            event.text ?? null, event.priority ?? null, event.clipId ?? null, event.ttlS
        );
        const inserted = { id: Number(row!.id), created_at: row!.created_at, expires_at: row!.expires_at };
        await notify(conn, { type: "event", id: inserted.id, direction: event.direction, agent: event.agentSlug });
        return inserted;
    });
}
