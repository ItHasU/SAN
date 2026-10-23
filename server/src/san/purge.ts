import { rm } from "node:fs/promises";
import { join } from "node:path";
import { SanConfig } from "./config";
import { Db, Sql } from "./db";
import { purgePendingViewers } from "./viewers";

/**
 * Tâches périodiques (DESIGN §3, SPEC §9.3) : viewers `pending` de plus de
 * 7 jours, événements expirés ou livrés, clips orphelins (lignes et fichiers).
 */

/** Un clip non référencé n'est supprimé qu'après ce délai (il peut précéder l'événement qui le référence) */
export const ORPHAN_CLIP_GRACE_S = 3600;

/** Identifiant de clip sûr pour construire un chemin de fichier (`c_` + 26 Crockford) */
const CLIP_ID_RE = /^c_[0-9A-Z]{26}$/;

export interface PurgeResult {
    purgedPendingViewers: number;
    expiredEvents: number;
    deliveredEvents: number;
    acknowledgedAgentEvents: number;
    orphanClips: number;
    staleCursors: number;
}

/** Événements dont `expires_at` est dépassé */
export async function purgeExpiredEvents(sql: Sql, now: Date = new Date()): Promise<number> {
    const rows = await sql.all<{ id: string }>(`DELETE FROM events WHERE expires_at <= $1::timestamptz RETURNING id`, now.toISOString());
    return rows.length;
}

/**
 * Événements `to_viewers` d'identifiant ≤ plus petit curseur des viewers actifs.
 * Un viewer actif sans curseur compte pour 0 ; sans viewer actif, rien n'est
 * supprimé (l'expiration s'en charge).
 */
export async function purgeDeliveredViewerEvents(sql: Sql): Promise<number> {
    const rows = await sql.all<{ id: string }>(
        `DELETE FROM events WHERE direction = 'to_viewers' AND id <= (
            SELECT COALESCE(min(COALESCE(c.last_acked_event_id, 0)), 0)
            FROM viewers v LEFT JOIN cursors c ON c.principal_type = 'viewer' AND c.principal_id = v.id
            WHERE v.status = 'active')
         RETURNING id`
    );
    return rows.length;
}

/** Événements `to_agent` acquittés par leur agent */
export async function purgeAcknowledgedAgentEvents(sql: Sql): Promise<number> {
    const rows = await sql.all<{ id: string }>(
        `DELETE FROM events e USING cursors c
         WHERE e.direction = 'to_agent' AND c.principal_type = 'agent' AND c.principal_id = e.agent_slug
           AND e.id <= c.last_acked_event_id
         RETURNING e.id`
    );
    return rows.length;
}

/** Curseurs dont le viewer ou l'agent n'existe plus */
export async function purgeStaleCursors(sql: Sql): Promise<number> {
    const rows = await sql.all<{ principal_id: string }>(
        `DELETE FROM cursors c WHERE
            (c.principal_type = 'viewer' AND NOT EXISTS (SELECT 1 FROM viewers v WHERE v.id = c.principal_id))
            OR (c.principal_type = 'agent' AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.slug = c.principal_id))
         RETURNING c.principal_id`
    );
    return rows.length;
}

/** Répertoire des fichiers d'un clip : `DATA_DIR/clips/<clip>` (DESIGN §5) */
export const clipDirectory = (dataDir: string, clipId: string): string => join(dataDir, "clips", clipId);

/**
 * Supprime les clips qu'aucun événement ne référence (lignes, conversions en
 * cascade) puis leurs fichiers sous `DATA_DIR`.
 * @returns le nombre de clips supprimés
 */
export async function purgeOrphanClips(sql: Sql, dataDir: string, now: Date = new Date()): Promise<number> {
    const rows = await sql.all<{ id: string }>(
        `DELETE FROM voice_clips c
         WHERE c.created_at < $1::timestamptz - make_interval(secs => $2::int)
           AND NOT EXISTS (SELECT 1 FROM events e WHERE e.clip_id = c.id)
         RETURNING c.id`,
        now.toISOString(), ORPHAN_CLIP_GRACE_S
    );
    for (const row of rows) {
        if (CLIP_ID_RE.test(row.id)) {
            await rm(clipDirectory(dataDir, row.id), { recursive: true, force: true });
        }
    }
    return rows.length;
}

export async function runPeriodicTasks(
    db: Db, config: Pick<SanConfig, "pendingMaxAgeDays"> & Partial<Pick<SanConfig, "dataDir">>, now: Date = new Date()
): Promise<PurgeResult> {
    const purgedPendingViewers = await purgePendingViewers(db, config.pendingMaxAgeDays, now);
    const expiredEvents = await purgeExpiredEvents(db, now);
    const deliveredEvents = await purgeDeliveredViewerEvents(db);
    const acknowledgedAgentEvents = await purgeAcknowledgedAgentEvents(db);
    // Après les événements : un clip n'est orphelin qu'une fois son événement supprimé
    const orphanClips = await purgeOrphanClips(db, config.dataDir ?? "./data", now);
    const staleCursors = await purgeStaleCursors(db);
    return { purgedPendingViewers, expiredEvents, deliveredEvents, acknowledgedAgentEvents, orphanClips, staleCursors };
}

/** Lance les tâches périodiques ; renvoie la fonction d'arrêt */
export function startPeriodicTasks(db: Db, config: Pick<SanConfig, "pendingMaxAgeDays" | "purgeIntervalMs"> & Partial<Pick<SanConfig, "dataDir">>, log: (message: string) => void = console.log): () => void {
    const timer = setInterval(() => {
        runPeriodicTasks(db, config).then((result) => {
            if (result.purgedPendingViewers > 0) {
                log(`Purge : ${result.purgedPendingViewers} demande(s) d'enrôlement expirée(s) supprimée(s).`);
            }
            const others = { ...result, purgedPendingViewers: 0 };
            if (Object.values(others).some((count) => count > 0)) {
                log(`Purge : événements expirés ${result.expiredEvents}, livrés ${result.deliveredEvents}, acquittés par agent ${result.acknowledgedAgentEvents}, clips orphelins ${result.orphanClips}, curseurs obsolètes ${result.staleCursors}.`);
            }
        }).catch((error: unknown) => console.error("Periodic task failed:", error));
    }, config.purgeIntervalMs);
    // Ne retient pas le processus à l'arrêt
    timer.unref();
    return () => clearInterval(timer);
}
