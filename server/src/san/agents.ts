import { Db } from "./db";
import { conflict, notFound } from "./errors";
import { generateToken } from "./tokens";
import { notify } from "./events";

export const AGENT_STATUSES = ["idle", "working", "waiting", "error", "done"] as const;
export type AgentStatus = typeof AGENT_STATUSES[number];

export interface AgentState {
    status: AgentStatus;
    detail: string | null;
    progress: number | null;
    ttl_s: number | null;
    updated_at: Date;
    stale: boolean;
}

export interface AgentRecord {
    slug: string;
    name: string;
    description: string | null;
    created_at: Date;
    revoked_at: Date | null;
    revoked: boolean;
    groups: string[];
    state: AgentState | null;
}

/** Périmé : `ttl_s != null && now > updated_at + ttl_s` (DESIGN §4) */
export function isStale(ttlS: number | null, updatedAt: Date, now: Date = new Date()): boolean {
    return ttlS != null && now.getTime() > updatedAt.getTime() + ttlS * 1000;
}

interface AgentRow {
    slug: string;
    name: string;
    description: string | null;
    created_at: Date;
    revoked_at: Date | null;
    groups: string[] | null;
    s_status: AgentStatus | null;
    s_detail: string | null;
    s_progress: number | null;
    s_ttl_s: number | null;
    s_updated_at: Date | null;
}

const AGENT_SELECT = `
    SELECT a.slug, a.name, a.description, a.created_at, a.revoked_at,
           (SELECT array_agg(m.group_slug ORDER BY m.group_slug) FROM agent_group_members m WHERE m.agent_slug = a.slug) AS groups,
           s.status AS s_status, s.detail AS s_detail, s.progress AS s_progress, s.ttl_s AS s_ttl_s, s.updated_at AS s_updated_at
    FROM agents a LEFT JOIN agent_state s ON s.agent_slug = a.slug`;

function toRecord(row: AgentRow): AgentRecord {
    return {
        slug: row.slug,
        name: row.name,
        description: row.description,
        created_at: row.created_at,
        revoked_at: row.revoked_at,
        revoked: row.revoked_at != null,
        groups: row.groups ?? [],
        state: row.s_status == null ? null : {
            status: row.s_status,
            detail: row.s_detail,
            progress: row.s_progress,
            ttl_s: row.s_ttl_s,
            updated_at: row.s_updated_at!,
            stale: isStale(row.s_ttl_s, row.s_updated_at!)
        }
    };
}

export async function listAgents(db: Db): Promise<AgentRecord[]> {
    return (await db.all<AgentRow>(`${AGENT_SELECT} ORDER BY a.slug`)).map(toRecord);
}

export async function getAgent(db: Db, slug: string): Promise<AgentRecord> {
    const row = await db.get<AgentRow>(`${AGENT_SELECT} WHERE a.slug = $1`, slug);
    if (row == null) {
        throw notFound(`Agent « ${slug} » introuvable.`);
    }
    return toRecord(row);
}

/** Crée un agent ; le jeton en clair n'est renvoyé qu'ici */
export async function createAgent(db: Db, input: { slug: string, name: string, description?: string }): Promise<{ agent: AgentRecord, token: string }> {
    const { token, hash } = generateToken("agt");
    const row = await db.get<{ slug: string }>(
        `INSERT INTO agents (slug, name, description, token_hash) VALUES ($1, $2, $3, $4)
         ON CONFLICT (slug) DO NOTHING RETURNING slug`,
        input.slug, input.name, input.description ?? null, hash
    );
    if (row == null) {
        throw conflict(`Un agent « ${input.slug} » existe déjà.`, "slug_taken");
    }
    return { agent: await getAgent(db, input.slug), token };
}

export async function updateAgent(db: Db, slug: string, patch: { name?: string, description?: string | null, revoked?: true }): Promise<AgentRecord> {
    const row = await db.get<{ slug: string }>(
        `UPDATE agents SET
            name = COALESCE($2, name),
            description = CASE WHEN $3::boolean THEN $4 ELSE description END,
            revoked_at = CASE WHEN $5::boolean THEN COALESCE(revoked_at, now()) ELSE revoked_at END
         WHERE slug = $1 RETURNING slug`,
        slug, patch.name ?? null, patch.description !== undefined, patch.description ?? null, patch.revoked === true
    );
    if (row == null) {
        throw notFound(`Agent « ${slug} » introuvable.`);
    }
    return getAgent(db, slug);
}

/**
 * Régénère le jeton : l'ancien cesse de fonctionner. Un agent révoqué est
 * réactivé (il reçoit un jeton neuf).
 */
export async function regenerateAgentToken(db: Db, slug: string): Promise<{ agent: AgentRecord, token: string }> {
    const { token, hash } = generateToken("agt");
    const row = await db.get<{ slug: string }>(`UPDATE agents SET token_hash = $2, revoked_at = NULL WHERE slug = $1 RETURNING slug`, slug, hash);
    if (row == null) {
        throw notFound(`Agent « ${slug} » introuvable.`);
    }
    return { agent: await getAgent(db, slug), token };
}

/** Suppression définitive (état, événements et appartenances partent en cascade) */
export async function deleteAgent(db: Db, slug: string): Promise<void> {
    const row = await db.get<{ slug: string }>(`DELETE FROM agents WHERE slug = $1 RETURNING slug`, slug);
    if (row == null) {
        throw notFound(`Agent « ${slug} » introuvable.`);
    }
}

export interface StateInput {
    status: AgentStatus;
    detail?: string | null;
    progress?: number | null;
    ttlS?: number | null;
}

/** Remplace l'état courant de l'agent (seule la dernière valeur est conservée) et notifie */
export async function setAgentState(db: Db, slug: string, input: StateInput): Promise<{ updated_at: Date }> {
    return db.withTransaction(async (conn) => {
        const row = await conn.get<{ updated_at: Date }>(
            `INSERT INTO agent_state (agent_slug, status, detail, progress, ttl_s, updated_at)
             VALUES ($1, $2, $3, $4, $5, clock_timestamp())
             ON CONFLICT (agent_slug) DO UPDATE SET
                status = EXCLUDED.status, detail = EXCLUDED.detail, progress = EXCLUDED.progress,
                ttl_s = EXCLUDED.ttl_s, updated_at = EXCLUDED.updated_at
             RETURNING updated_at`,
            slug, input.status, input.detail ?? null, input.progress ?? null, input.ttlS ?? null
        );
        await notify(conn, { type: "state", agent: slug });
        return row!;
    });
}
