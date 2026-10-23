import { isStale } from "./agents";
import { Sql } from "./db";
import { ConfigAgent, trackedAgents, ViewerConfig } from "./viewer-config";

/** Événements et états tels que les voit un viewer (SPEC §10.4) */

/** Taille d'une page d'événements (DESIGN §4) */
export const SYNC_PAGE_SIZE = 50;

export interface ClipView {
    id: string;
    duration_ms: number | null;
    /** Absents tant que la conversion n'existe pas (phase 3) ou si le viewer n'a pas de sortie audio */
    format?: string;
    sample_rate?: number;
    size?: number;
}

export interface EventView {
    id: number;
    agent: string;
    kind: "nudge" | "voice";
    priority?: string;
    text?: string;
    clip?: ClipView;
    /** Présent (true) seulement si l'agent est muet pour ce viewer */
    muted?: true;
    created_at: string;
}

export interface StateView {
    agent: string;
    name: string;
    status: string;
    detail?: string | null;
    progress: number | null;
    stale: boolean;
    updated_at: string;
}

type Capabilities = Record<string, any> | null | undefined;

//#region Audio ---------------------------------------------------------------

/** Ordre de préférence des formats servis (DESIGN §5) : `ima_adpcm`, `mp3` (web), `pcm_s16le`, `ogg` */
const FORMAT_PREFERENCE = ["ima_adpcm", "mp3", "pcm_s16le", "ogg"];
export const PIVOT_SAMPLE_RATE = 16000;

/**
 * Format de clip adapté aux capacités d'un viewer (DESIGN §5) : le préféré des
 * formats déclarés ; la fréquence la plus haute déclarée ≤ 16000 (à défaut la
 * plus basse déclarée). `null` si le viewer n'a pas de sortie audio.
 */
export function chooseAudioFormat(capabilities: Capabilities): { format: string, sample_rate: number } | null {
    const out = capabilities?.["audio_out"];
    if (out == null || typeof out !== "object") {
        return null;
    }
    const declared: string[] = Array.isArray(out.formats) ? out.formats.filter((f: unknown) => typeof f === "string") : [];
    const format = FORMAT_PREFERENCE.find((candidate) => declared.includes(candidate)) ?? declared[0];
    if (format == null) {
        return null;
    }
    const rates: number[] = Array.isArray(out.sample_rates) ? out.sample_rates.filter((r: unknown) => typeof r === "number" && r > 0) : [];
    const atMostPivot = rates.filter((rate) => rate <= PIVOT_SAMPLE_RATE);
    const sampleRate = atMostPivot.length > 0 ? Math.max(...atMostPivot) : rates.length > 0 ? Math.min(...rates) : PIVOT_SAMPLE_RATE;
    return { format, sample_rate: sampleRate };
}

//#endregion

//#region États ---------------------------------------------------------------

interface StateRow {
    slug: string;
    name: string;
    status: string;
    detail: string | null;
    progress: number | null;
    ttl_s: number | null;
    updated_at: Date;
}

/** Tronque à `max` caractères (points de code, pas unités UTF-16) */
export function truncateChars(text: string, max: number): string {
    const chars = Array.from(text);
    return chars.length <= max ? text : chars.slice(0, max).join("");
}

/** `detail` : absent sans écran, tronqué à `max_detail_chars` (SPEC §7.2, §7.3) */
function stateView(row: StateRow, capabilities: Capabilities, now: Date): StateView {
    const view: StateView = {
        agent: row.slug, name: row.name, status: row.status, progress: row.progress,
        stale: isStale(row.ttl_s, row.updated_at, now), updated_at: row.updated_at.toISOString()
    };
    const display = capabilities?.["display"];
    if (display != null && typeof display === "object") {
        const max = display.max_detail_chars;
        view.detail = row.detail != null && Number.isInteger(max) && max >= 0 ? truncateChars(row.detail, max) : row.detail;
    }
    return view;
}

/** États des agents donnés (ceux qui en ont un), dans l'ordre de `slugs` */
export async function fetchStates(sql: Sql, slugs: string[], capabilities: Capabilities, now: Date = new Date()): Promise<StateView[]> {
    if (slugs.length === 0) {
        return [];
    }
    const rows = await sql.all<StateRow>(
        `SELECT a.slug, a.name, s.status, s.detail, s.progress, s.ttl_s, s.updated_at
         FROM agents a JOIN agent_state s ON s.agent_slug = a.slug
         WHERE a.slug = ANY($1::text[]) AND a.revoked_at IS NULL`,
        slugs as never
    );
    const order = new Map(slugs.map((slug, index) => [slug, index]));
    rows.sort((a, b) => order.get(a.slug)! - order.get(b.slug)!);
    return rows.map((row) => stateView(row, capabilities, now));
}

//#endregion

//#region Événements ----------------------------------------------------------

interface EventRow {
    id: string;
    agent_slug: string;
    kind: "nudge" | "voice";
    text: string | null;
    priority: string | null;
    created_at: Date;
    clip_id: string | null;
    clip_status: string | null;
    clip_duration_ms: number | null;
}

/**
 * Événements `to_viewers` d'identifiant > `afterId`, filtrés **à la lecture**
 * (SPEC §9.2) : l'agent doit être visible et suivi (`config`), l'événement non
 * expiré. Un agent muet reste livré, marqué `muted`. Un viewer sans sortie
 * audio reçoit les messages vocaux sous forme de texte seul.
 */
export async function fetchViewerEvents(
    sql: Sql, config: ViewerConfig, capabilities: Capabilities, afterId: number, limit: number = SYNC_PAGE_SIZE
): Promise<{ events: EventView[], has_more: boolean }> {
    const tracked = trackedAgents(config);
    if (tracked.length === 0) {
        return { events: [], has_more: false };
    }
    const byAgent = new Map<string, ConfigAgent>(tracked.map((agent) => [agent.agent, agent]));
    const rows = await sql.all<EventRow>(
        `SELECT e.id::text AS id, e.agent_slug, e.kind, e.text, e.priority, e.created_at,
                e.clip_id, c.status AS clip_status, c.duration_ms AS clip_duration_ms
         FROM events e LEFT JOIN voice_clips c ON c.id = e.clip_id
         WHERE e.direction = 'to_viewers' AND e.id > $1::bigint AND e.expires_at > now()
           AND e.agent_slug = ANY($2::text[])
         ORDER BY e.id LIMIT $3::int`,
        afterId, [...byAgent.keys()] as never, limit + 1
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);

    const format = chooseAudioFormat(capabilities);
    const renditions = new Map<string, number>();
    const clipIds = page.filter((row) => row.clip_id != null).map((row) => row.clip_id!);
    if (format != null && clipIds.length > 0) {
        const found = await sql.all<{ clip_id: string, size: number }>(
            `SELECT clip_id, size FROM voice_renditions WHERE clip_id = ANY($1::text[]) AND format = $2 AND sample_rate = $3::int`,
            clipIds as never, format.format, format.sample_rate
        );
        for (const rendition of found) {
            renditions.set(rendition.clip_id, rendition.size);
        }
    }

    const events = page.map((row): EventView => {
        const event: EventView = { id: Number(row.id), agent: row.agent_slug, kind: row.kind, created_at: row.created_at.toISOString() };
        if (row.priority != null) {
            event.priority = row.priority;
        }
        if (row.text != null) {
            event.text = row.text;
        }
        if (row.clip_id != null && row.clip_status === "ready" && format != null) {
            const clip: ClipView = { id: row.clip_id, duration_ms: row.clip_duration_ms, format: format.format, sample_rate: format.sample_rate };
            const size = renditions.get(row.clip_id);
            if (size != null) {
                clip.size = size;
            }
            event.clip = clip;
        }
        if (byAgent.get(row.agent_slug)?.muted === true) {
            event.muted = true;
        }
        return event;
    });
    return { events, has_more: hasMore };
}

//#endregion
