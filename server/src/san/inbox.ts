import { advanceCursor, getCursor } from "./cursors";
import { Db, Sql } from "./db";
import { EventBus } from "./bus";
import { SYNC_PAGE_SIZE } from "./viewer-events";

/** Boîte de réception d'un agent (SPEC §10.1) : événements `to_agent`, long-poll */

export const MAX_INBOX_WAIT_S = 60;
/** Relecture de sécurité pendant une attente, au cas où une notification serait perdue */
const RECHECK_MS = 15_000;

export interface InboxEvent {
    id: number;
    kind: "nudge" | "voice";
    from: { viewer: string, name: string | null } | null;
    created_at: string;
    text?: string;
    priority?: string;
    clip?: { id: string, duration_ms: number | null, url: string } | null;
}

export interface InboxResult {
    events: InboxEvent[];
    has_more: boolean;
}

interface InboxRow {
    id: string;
    kind: "nudge" | "voice";
    text: string | null;
    priority: string | null;
    created_at: Date;
    from_viewer_id: string | null;
    viewer_name: string | null;
    clip_id: string | null;
    clip_status: string | null;
    clip_duration_ms: number | null;
}

/** Événements `to_agent` de l'agent, d'identifiant > `afterId` et non expirés */
export async function fetchAgentInbox(sql: Sql, agentSlug: string, afterId: number, limit: number = SYNC_PAGE_SIZE): Promise<InboxResult> {
    const rows = await sql.all<InboxRow>(
        `SELECT e.id::text AS id, e.kind, e.text, e.priority, e.created_at, e.from_viewer_id, v.name AS viewer_name,
                e.clip_id, c.status AS clip_status, c.duration_ms AS clip_duration_ms
         FROM events e
         LEFT JOIN viewers v ON v.id = e.from_viewer_id
         LEFT JOIN voice_clips c ON c.id = e.clip_id
         WHERE e.direction = 'to_agent' AND e.agent_slug = $1 AND e.id > $2::bigint AND e.expires_at > now()
         ORDER BY e.id LIMIT $3::int`,
        agentSlug, afterId, limit + 1
    );
    const events = rows.slice(0, limit).map((row): InboxEvent => {
        const event: InboxEvent = {
            id: Number(row.id), kind: row.kind, created_at: row.created_at.toISOString(),
            from: row.from_viewer_id == null ? null : { viewer: row.from_viewer_id, name: row.viewer_name }
        };
        if (row.text != null) {
            event.text = row.text;
        }
        if (row.priority != null) {
            event.priority = row.priority;
        }
        if (row.clip_id != null) {
            event.clip = row.clip_status === "ready"
                ? { id: row.clip_id, duration_ms: row.clip_duration_ms, url: `/api/v1/agent/voice/${row.clip_id}` }
                : null;
        }
        return event;
    });
    return { events, has_more: rows.length > limit };
}

/**
 * `GET /agent/inbox?ack=&wait=` : acquitte d'abord (`ack`), puis lit ; s'il n'y
 * a rien et que `waitS > 0`, attend un événement `to_agent` pour cet agent
 * (réveil par le bus) ou l'échéance. `signal` interrompt l'attente.
 */
export async function pollInbox(
    db: Db, bus: EventBus, agentSlug: string, options: { ack?: number, waitS: number, signal?: AbortSignal }
): Promise<InboxResult> {
    let woken = false;
    let wake: (() => void) | null = null;
    // S'abonner avant la première lecture : un événement inséré entre-temps réveille la boucle
    const unsubscribe = bus.subscribe((message) => {
        if (message.type === "reconnect" || (message.type === "event" && message.direction === "to_agent" && message.agent === agentSlug)) {
            woken = true;
            wake?.();
        }
    });
    try {
        if (options.ack !== undefined) {
            await advanceCursor(db, "agent", agentSlug, options.ack);
        }
        const deadline = Date.now() + Math.min(Math.max(options.waitS, 0), MAX_INBOX_WAIT_S) * 1000;
        for (;;) {
            woken = false;
            const cursor = await getCursor(db, "agent", agentSlug);
            const result = await fetchAgentInbox(db, agentSlug, cursor);
            const remaining = deadline - Date.now();
            if (result.events.length > 0 || remaining <= 0 || options.signal?.aborted === true) {
                return result;
            }
            if (!woken) {
                await new Promise<void>((resolve) => {
                    const timer = setTimeout(done, Math.min(remaining, RECHECK_MS));
                    function done(): void {
                        clearTimeout(timer);
                        options.signal?.removeEventListener("abort", done);
                        wake = null;
                        resolve();
                    }
                    wake = done;
                    options.signal?.addEventListener("abort", done, { once: true });
                });
            }
        }
    } finally {
        unsubscribe();
    }
}
