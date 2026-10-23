import { Db } from "./db";
import { advanceCursor, getCursor } from "./cursors";
import { computeConfig, configHash, trackedAgents, ViewerConfig } from "./viewer-config";
import { EventView, fetchStates, fetchViewerEvents, StateView, SYNC_PAGE_SIZE } from "./viewer-events";

/** Synchronisation d'un viewer (SPEC §10.4, DESIGN §4) */

export const DEFAULT_NEXT_SYNC_S = 60;
export const MORE_NEXT_SYNC_S = 15;

export interface SyncQuery {
    ack?: number;
    config_hash?: string;
    caps_hash?: string;
    battery?: number;
}

export interface SyncResponse {
    server_time: string;
    capabilities_required: boolean;
    config_hash: string;
    config: ViewerConfig | null;
    states: StateView[];
    events: EventView[];
    has_more: boolean;
    next_sync_s: number;
}

/**
 * Applique l'acquittement, met à jour `last_seen_at`, `battery_pct` et
 * `next_wake_at`, puis construit la réponse. `config` n'est renseignée que si
 * le hash du viewer diffère.
 */
export async function syncViewer(db: Db, viewerId: string, query: SyncQuery, now: Date = new Date()): Promise<SyncResponse> {
    if (query.ack !== undefined) {
        await advanceCursor(db, "viewer", viewerId, query.ack);
    }
    const viewer = await db.get<{ capabilities: any, capabilities_hash: string | null }>(
        `SELECT capabilities, capabilities_hash FROM viewers WHERE id = $1`, viewerId
    );
    const cursor = await getCursor(db, "viewer", viewerId);
    const config = await computeConfig(db, viewerId);
    const hash = configHash(config);
    const capabilities = viewer?.capabilities ?? null;

    const tracked = trackedAgents(config).map((agent) => agent.agent);
    const states = await fetchStates(db, tracked, capabilities, now);
    const { events, has_more } = await fetchViewerEvents(db, config, capabilities, cursor, SYNC_PAGE_SIZE);
    const nextSyncS = has_more ? MORE_NEXT_SYNC_S : DEFAULT_NEXT_SYNC_S;

    await db.run(
        `UPDATE viewers SET last_seen_at = $2::timestamptz, battery_pct = COALESCE($3::smallint, battery_pct),
                next_wake_at = $2::timestamptz + make_interval(secs => $4::int) WHERE id = $1`,
        viewerId, now.toISOString(), query.battery ?? null, nextSyncS
    );

    return {
        server_time: now.toISOString(),
        capabilities_required: query.caps_hash == null || query.caps_hash !== viewer?.capabilities_hash,
        config_hash: hash,
        config: query.config_hash === hash ? null : config,
        states,
        events,
        has_more,
        next_sync_s: nextSyncS
    };
}
