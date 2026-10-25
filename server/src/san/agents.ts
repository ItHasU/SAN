import { inTransaction, Sql } from "./db";
import { badRequest, conflict, notFound } from "./errors";
import { generateToken } from "./tokens";
import { notify } from "./events";

export const AGENT_STATUSES = ["idle", "working", "waiting", "error", "done"] as const;
export type AgentStatus = typeof AGENT_STATUSES[number];

/** Statut d'enrôlement d'un agent (colonne `agents.status`, SPEC §4bis) : `pending` tant qu'un administrateur n'a pas approuvé */
export const AGENT_ENROLLMENT_STATUSES = ["pending", "active"] as const;
export type AgentEnrollmentStatus = typeof AGENT_ENROLLMENT_STATUSES[number];

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
    /** `pending` : enrôlé sans jeton d'enrôlement, en attente d'approbation (invisible des viewers) */
    status: AgentEnrollmentStatus;
    registered_ip: string | null;
    pending_since: Date | null;
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
    status: AgentEnrollmentStatus;
    registered_ip: string | null;
    pending_since: Date | null;
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
    SELECT a.slug, a.name, a.description, a.status, a.registered_ip, a.pending_since, a.created_at, a.revoked_at,
           (SELECT array_agg(m.group_slug ORDER BY m.group_slug) FROM agent_group_members m WHERE m.agent_slug = a.slug) AS groups,
           s.status AS s_status, s.detail AS s_detail, s.progress AS s_progress, s.ttl_s AS s_ttl_s, s.updated_at AS s_updated_at
    FROM agents a LEFT JOIN agent_state s ON s.agent_slug = a.slug`;

function toRecord(row: AgentRow): AgentRecord {
    return {
        slug: row.slug,
        name: row.name,
        description: row.description,
        status: row.status,
        registered_ip: row.registered_ip,
        pending_since: row.pending_since,
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

export async function listAgents(db: Sql, status?: AgentEnrollmentStatus): Promise<AgentRecord[]> {
    return (await db.all<AgentRow>(`${AGENT_SELECT} WHERE ($1::text IS NULL OR a.status = $1) ORDER BY a.slug`, status ?? null)).map(toRecord);
}

export async function getAgent(db: Sql, slug: string): Promise<AgentRecord> {
    const row = await db.get<AgentRow>(`${AGENT_SELECT} WHERE a.slug = $1`, slug);
    if (row == null) {
        throw notFound(`Agent « ${slug} » introuvable.`);
    }
    return toRecord(row);
}

/**
 * Crée un agent ; le jeton en clair n'est renvoyé qu'ici. Chemin commun à la
 * création par un administrateur (`active`) et à l'enrôlement automatique
 * (`active` avec jeton d'enrôlement, `pending` sans).
 */
export async function createAgent(
    db: Sql,
    input: { slug: string, name: string, description?: string, status?: AgentEnrollmentStatus, registeredIp?: string | null }
): Promise<{ agent: AgentRecord, token: string }> {
    const { token, hash } = generateToken("agt");
    const status = input.status ?? "active";
    const row = await db.get<{ slug: string }>(
        `INSERT INTO agents (slug, name, description, token_hash, status, registered_ip, pending_since)
         VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $5 = 'pending' THEN now() END)
         ON CONFLICT (slug) DO NOTHING RETURNING slug`,
        input.slug, input.name, input.description ?? null, hash, status, input.registeredIp ?? null
    );
    if (row == null) {
        throw conflict(`Un agent « ${input.slug} » existe déjà.`, "slug_taken");
    }
    return { agent: await getAgent(db, input.slug), token };
}

/**
 * Approuve un agent `pending` : il devient `active` (son jeton vaut pour toutes
 * les routes) et rejoint éventuellement des groupes. Le rejet est une suppression.
 * @throws ApiError 404 (inconnu), 409 `not_pending`, 400 `unknown_groups`
 */
export async function approveAgent(db: Sql, slug: string, groups: string[] = []): Promise<AgentRecord> {
    const row = await db.get<{ slug: string }>(
        `UPDATE agents SET status = 'active' WHERE slug = $1 AND status = 'pending' RETURNING slug`, slug
    );
    if (row == null) {
        const existing = await getAgent(db, slug);
        throw conflict(`L'agent est déjà « ${existing.status} » : seul un agent en attente peut être approuvé.`, "not_pending");
    }
    const unique = [...new Set(groups)];
    if (unique.length > 0) {
        const known = new Set((await db.all<{ slug: string }>(`SELECT slug FROM agent_groups WHERE slug = ANY($1::text[])`, unique as never)).map((group) => group.slug));
        const unknown = unique.filter((group) => !known.has(group));
        if (unknown.length > 0) {
            throw badRequest(`Groupes inconnus : ${unknown.join(", ")}.`, "unknown_groups");
        }
        for (const group of unique) {
            await db.run(`INSERT INTO agent_group_members (group_slug, agent_slug) VALUES ($1, $2) ON CONFLICT DO NOTHING`, group, slug);
        }
    }
    return getAgent(db, slug);
}

/** Supprime les agents `pending` de plus de `maxAgeDays` jours (SPEC §4bis), avec leur jeton */
export async function purgePendingAgents(db: Sql, maxAgeDays = 7, now: Date = new Date()): Promise<number> {
    const rows = await db.all<{ slug: string }>(
        `DELETE FROM agents WHERE status = 'pending' AND pending_since < $1::timestamptz - make_interval(days => $2) RETURNING slug`,
        now.toISOString(), maxAgeDays
    );
    return rows.length;
}

export async function updateAgent(db: Sql, slug: string, patch: { name?: string, description?: string | null, revoked?: true }): Promise<AgentRecord> {
    if (patch.revoked === true) {
        const current = await db.get<{ status: AgentEnrollmentStatus }>(`SELECT status FROM agents WHERE slug = $1`, slug);
        if (current?.status === "pending") {
            throw conflict("L'agent est en attente d'approbation : approuvez-le ou supprimez-le.", "agent_pending");
        }
    }
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
export async function regenerateAgentToken(db: Sql, slug: string): Promise<{ agent: AgentRecord, token: string }> {
    const { token, hash } = generateToken("agt");
    const row = await db.get<{ slug: string }>(`UPDATE agents SET token_hash = $2, revoked_at = NULL WHERE slug = $1 RETURNING slug`, slug, hash);
    if (row == null) {
        throw notFound(`Agent « ${slug} » introuvable.`);
    }
    return { agent: await getAgent(db, slug), token };
}

/** Suppression définitive (état, événements et appartenances partent en cascade) */
export async function deleteAgent(db: Sql, slug: string): Promise<void> {
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
export async function setAgentState(db: Sql, slug: string, input: StateInput): Promise<{ updated_at: Date }> {
    return inTransaction(db, async (conn) => {
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
