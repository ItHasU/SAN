import { Sql } from "./db";

/** Curseurs d'acquittement (SPEC §9.2) : un par viewer et par agent, qui ne font qu'avancer */

export type PrincipalType = "viewer" | "agent";

/** Dernier identifiant d'événement attribué (0 si aucun) */
export async function lastEventId(sql: Sql): Promise<number> {
    const row = await sql.get<{ last: string | null }>(
        `SELECT pg_sequence_last_value(pg_get_serial_sequence('events', 'id')::regclass)::text AS last`
    );
    return row?.last == null ? 0 : Number(row.last);
}

export async function getCursor(sql: Sql, type: PrincipalType, id: string): Promise<number> {
    const row = await sql.get<{ cursor: string }>(
        `SELECT last_acked_event_id::text AS cursor FROM cursors WHERE principal_type = $1 AND principal_id = $2`, type, id
    );
    return row == null ? 0 : Number(row.cursor);
}

/**
 * Avance le curseur jusqu'à `upTo` (jamais en arrière). Une valeur au-delà du
 * dernier identifiant attribué est ramenée à celui-ci : un client ne peut pas
 * acquitter à l'avance des événements qui n'existent pas encore.
 * @returns le curseur après mise à jour
 */
export async function advanceCursor(sql: Sql, type: PrincipalType, id: string, upTo: number): Promise<number> {
    const target = Math.min(Math.max(0, Math.trunc(upTo)), await lastEventId(sql));
    const row = await sql.get<{ cursor: string }>(
        `INSERT INTO cursors (principal_type, principal_id, last_acked_event_id) VALUES ($1, $2, $3::bigint)
         ON CONFLICT (principal_type, principal_id) DO UPDATE SET
            last_acked_event_id = GREATEST(cursors.last_acked_event_id, EXCLUDED.last_acked_event_id)
         RETURNING last_acked_event_id::text AS cursor`,
        type, id, target
    );
    return Number(row!.cursor);
}
