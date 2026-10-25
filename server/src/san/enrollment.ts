import { SanConfig } from "./config";
import { inTransaction, Sql } from "./db";
import { ApiError, notFound, tooManyRequests } from "./errors";
import { notifyConfigChanged } from "./events";
import { createAgent, AgentEnrollmentStatus } from "./agents";
import { generateToken, hashesEqual, hashToken, tokenKind } from "./tokens";

/**
 * Enrôlement automatique des agents (SPEC §4bis) : jetons d'enrôlement liés à
 * un groupe, et `POST /agent/register`.
 *
 * Un jeton d'enrôlement est un secret `enr_<32 octets base64url>`, stocké sous
 * forme d'empreinte SHA-256 uniquement, affiché une seule fois à la création.
 */

/** Clé du verrou consultatif qui sérialise les enrôlements d'agents (plafond de pending) */
export const AGENT_REGISTER_LOCK_KEY = 7_301_003;

export type EnrollmentTokenState = "active" | "expired" | "revoked";

export interface EnrollmentTokenRecord {
    id: number;
    group: string;
    label: string;
    created_at: Date;
    expires_at: Date | null;
    revoked_at: Date | null;
    use_count: number;
    last_used_at: Date | null;
    /** Calculé : révoqué, expiré ou actif */
    state: EnrollmentTokenState;
}

/** Colonnes exposées : tout sauf `token_hash` */
const TOKEN_COLUMNS = `id::int AS id, group_slug AS "group", label, created_at, expires_at, revoked_at, use_count, last_used_at,
    CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN expires_at IS NOT NULL AND expires_at <= now() THEN 'expired' ELSE 'active' END AS state`;

async function assertGroupExists(sql: Sql, groupSlug: string): Promise<void> {
    if (await sql.get(`SELECT 1 FROM agent_groups WHERE slug = $1`, groupSlug) == null) {
        throw notFound(`Groupe « ${groupSlug} » introuvable.`);
    }
}

/** Crée un jeton d'enrôlement pour un groupe ; le secret en clair n'est renvoyé qu'ici */
export async function createEnrollmentToken(
    sql: Sql, groupSlug: string, input: { label: string, expiresAt: Date | null }
): Promise<{ enrollment_token: EnrollmentTokenRecord, token: string }> {
    await assertGroupExists(sql, groupSlug);
    const { token, hash } = generateToken("enr");
    const record = await sql.get<EnrollmentTokenRecord>(
        `INSERT INTO agent_enrollment_tokens (group_slug, label, token_hash, expires_at)
         VALUES ($1, $2, $3, $4::timestamptz) RETURNING ${TOKEN_COLUMNS}`,
        groupSlug, input.label, hash, input.expiresAt?.toISOString() ?? null
    );
    return { enrollment_token: record!, token };
}

export async function listEnrollmentTokens(sql: Sql, groupSlug: string): Promise<EnrollmentTokenRecord[]> {
    await assertGroupExists(sql, groupSlug);
    return sql.all<EnrollmentTokenRecord>(
        `SELECT ${TOKEN_COLUMNS} FROM agent_enrollment_tokens WHERE group_slug = $1 ORDER BY created_at DESC, id DESC`, groupSlug
    );
}

/** Révoque un jeton d'enrôlement (idempotent). Les agents déjà enrôlés ne sont pas touchés. */
export async function revokeEnrollmentToken(sql: Sql, groupSlug: string, id: number): Promise<EnrollmentTokenRecord> {
    const row = await sql.get<{ id: number }>(
        `UPDATE agent_enrollment_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 AND group_slug = $2 RETURNING id::int AS id`,
        id, groupSlug
    );
    if (row == null) {
        throw notFound(`Jeton d'enrôlement introuvable dans le groupe « ${groupSlug} ».`);
    }
    return (await sql.get<EnrollmentTokenRecord>(`SELECT ${TOKEN_COLUMNS} FROM agent_enrollment_tokens WHERE id = $1`, id))!;
}

/**
 * Jeton d'enrôlement valide (existant, non révoqué, non expiré) : recherche par
 * empreinte (index unique) puis comparaison en temps constant. `null` sinon.
 */
export async function findValidEnrollmentToken(sql: Sql, token: string): Promise<{ id: number, group: string } | null> {
    if (tokenKind(token) !== "enr") {
        return null;
    }
    const hash = hashToken(token);
    const row = await sql.get<{ id: number, group_slug: string, token_hash: Buffer }>(
        `SELECT id::int AS id, group_slug, token_hash FROM agent_enrollment_tokens
         WHERE token_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`, hash
    );
    if (row == null || !hashesEqual(row.token_hash, hash)) {
        return null;
    }
    return { id: row.id, group: row.group_slug };
}

export interface RegisterAgentInput {
    slug: string;
    name: string;
    /** Jeton d'enrôlement présenté par le client, si présent */
    enrollmentToken?: string;
    ip: string | null;
}

export interface RegisterAgentResult {
    slug: string;
    status: AgentEnrollmentStatus;
    /** Jeton d'agent, renvoyé une seule fois */
    token: string;
    group?: string;
    /** Identifiant du jeton d'enrôlement utilisé (journal) */
    enrollment_token_id?: number;
}

/**
 * Enrôlement d'un agent (`POST /agent/register`), en une transaction sérialisée.
 * - jeton d'enrôlement valide : l'agent est créé `active` et ajouté au groupe du jeton ;
 * - jeton fourni mais invalide, révoqué ou expiré : `401 invalid_enrollment_token`
 *   (aucun repli silencieux en pending) ;
 * - aucun jeton : agent `pending`, dans la limite du plafond (`429 pending_limit`) ;
 * - slug déjà pris : `409 slug_taken`, l'agent existant n'est jamais touché.
 * Un agent actif suit le même chemin (`createAgent`, notification de configuration)
 * que la création par un administrateur.
 */
export async function registerAgent(db: Sql, input: RegisterAgentInput, config: Pick<SanConfig, "maxPendingAgents">): Promise<RegisterAgentResult> {
    return inTransaction(db, async (conn) => {
        await conn.run(`SELECT pg_advisory_xact_lock($1)`, AGENT_REGISTER_LOCK_KEY);
        let enrollment: { id: number, group: string } | null = null;
        if (input.enrollmentToken !== undefined) {
            enrollment = await findValidEnrollmentToken(conn, input.enrollmentToken);
            if (enrollment == null) {
                throw new ApiError(401, "invalid_enrollment_token", "Jeton d'enrôlement inconnu, expiré ou révoqué.");
            }
        } else {
            const count = await conn.get<{ count: number }>(`SELECT count(*)::int AS count FROM agents WHERE status = 'pending'`);
            if (count!.count >= config.maxPendingAgents) {
                throw tooManyRequests("Trop d'agents en attente d'approbation.", "pending_limit", 3600);
            }
        }
        const { token } = await createAgent(conn, {
            slug: input.slug, name: input.name, status: enrollment == null ? "pending" : "active", registeredIp: input.ip
        });
        if (enrollment == null) {
            return { slug: input.slug, status: "pending" as const, token };
        }
        await conn.run(`INSERT INTO agent_group_members (group_slug, agent_slug) VALUES ($1, $2)`, enrollment.group, input.slug);
        await conn.run(`UPDATE agent_enrollment_tokens SET use_count = use_count + 1, last_used_at = now() WHERE id = $1`, enrollment.id);
        // Les viewers dont une règle couvre le nouvel agent le voient (SSE `config`), comme pour une création admin
        await notifyConfigChanged(conn);
        return { slug: input.slug, status: "active" as const, token, group: enrollment.group, enrollment_token_id: enrollment.id };
    });
}
