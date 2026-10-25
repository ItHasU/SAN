import { Sql } from "./db";
import { badRequest, notFound } from "./errors";
import { assertPattern, globToLike } from "./glob";

/**
 * Permissions (SPEC §6) : règles à motifs, accès effectif, couverture.
 *
 * Le motif n'est jamais concaténé : il est lu dans la colonne `like_pattern`
 * et comparé entre deux colonnes, avec `ESCAPE '\'` déclaré (SPEC §6.1).
 */

export const RULE_SCOPES = ["agent", "group"] as const;
export type RuleScope = typeof RULE_SCOPES[number];

/**
 * Fragment SQL : « la règle `r` couvre l'agent `a` » (alias `r` = permission_rules,
 * `a` = agents). Un groupe couvre ses membres, à n'importe quel niveau de la
 * hiérarchie de slugs : `perso-*` ou `travail/*` s'évaluent sur le slug du groupe.
 */
export const RULE_COVERS_AGENT_SQL = `(
    (r.scope = 'agent' AND a.slug LIKE r.like_pattern ESCAPE '\\')
    OR (r.scope = 'group' AND EXISTS (
        SELECT 1 FROM agent_group_members m
        WHERE m.agent_slug = a.slug AND m.group_slug LIKE r.like_pattern ESCAPE '\\'))
)`;

/** Fragment SQL : « l'agent `a` est couvert par une règle du viewer `$1` » */
export const AGENT_COVERED_BY_RULE_SQL = `
    EXISTS (
        SELECT 1 FROM permission_rules r
        WHERE r.viewer_id = $1 AND ${RULE_COVERS_AGENT_SQL}
    )`;

/** Slugs des agents (non révoqués) auxquels le viewer a accès, triés */
export async function visibleAgentSlugs(sql: Sql, viewerId: string): Promise<string[]> {
    const rows = await sql.all<{ slug: string }>(
        `SELECT a.slug FROM agents a WHERE a.revoked_at IS NULL AND a.status = 'active' AND ${AGENT_COVERED_BY_RULE_SQL} ORDER BY a.slug`,
        viewerId
    );
    return rows.map((row) => row.slug);
}

/** `can_send_voice` est sans effet sans `audio_in` déclaré (SPEC §7.3) */
export function declaresAudioIn(capabilities: unknown): boolean {
    if (capabilities == null || typeof capabilities !== "object") {
        return false;
    }
    const audioIn = (capabilities as Record<string, unknown>)["audio_in"];
    return audioIn != null && typeof audioIn === "object" && !Array.isArray(audioIn);
}

//#region Règles -------------------------------------------------------------

export interface RuleRecord {
    id: number;
    viewer_id: string;
    scope: RuleScope;
    pattern: string;
    can_send_voice: boolean;
}

const RULE_COLUMNS = `id::int AS id, viewer_id, scope, pattern, can_send_voice`;

async function assertViewerExists(sql: Sql, viewerId: string): Promise<void> {
    if (await sql.get(`SELECT 1 FROM viewers WHERE id = $1`, viewerId) == null) {
        throw notFound(`Viewer « ${viewerId} » introuvable.`);
    }
}

export async function listRules(sql: Sql, viewerId: string): Promise<RuleRecord[]> {
    await assertViewerExists(sql, viewerId);
    return sql.all<RuleRecord>(`SELECT ${RULE_COLUMNS} FROM permission_rules WHERE viewer_id = $1 ORDER BY id`, viewerId);
}

export async function getRule(sql: Sql, id: number): Promise<RuleRecord> {
    const row = await sql.get<RuleRecord>(`SELECT ${RULE_COLUMNS} FROM permission_rules WHERE id = $1`, id);
    if (row == null) {
        throw notFound(`Règle ${id} introuvable.`);
    }
    return row;
}

export interface RuleInput {
    scope: RuleScope;
    pattern: string;
    can_send_voice?: boolean;
}

export async function createRule(sql: Sql, viewerId: string, input: RuleInput): Promise<RuleRecord> {
    await assertViewerExists(sql, viewerId);
    const likePattern = globToLike(assertPattern(input.pattern));
    const row = await sql.get<{ id: number }>(
        `INSERT INTO permission_rules (viewer_id, scope, pattern, like_pattern, can_send_voice)
         VALUES ($1, $2, $3, $4, $5) RETURNING id::int AS id`,
        viewerId, input.scope, input.pattern, likePattern, input.can_send_voice ?? false
    );
    return getRule(sql, row!.id);
}

export async function updateRule(sql: Sql, id: number, patch: Partial<RuleInput>): Promise<RuleRecord> {
    const current = await getRule(sql, id);
    const pattern = patch.pattern ?? current.pattern;
    const likePattern = globToLike(assertPattern(pattern));
    await sql.run(
        `UPDATE permission_rules SET scope = $2, pattern = $3, like_pattern = $4, can_send_voice = $5 WHERE id = $1`,
        id, patch.scope ?? current.scope, pattern, likePattern, patch.can_send_voice ?? current.can_send_voice
    );
    return getRule(sql, id);
}

export async function deleteRule(sql: Sql, id: number): Promise<RuleRecord> {
    const row = await sql.get<RuleRecord>(`DELETE FROM permission_rules WHERE id = $1 RETURNING ${RULE_COLUMNS}`, id);
    if (row == null) {
        throw notFound(`Règle ${id} introuvable.`);
    }
    return row;
}

export interface RuleCoverage {
    rule: RuleRecord;
    /** Agents non révoqués actuellement couverts */
    agents: Array<{ slug: string, name: string }>;
    /** Groupes dont le slug correspond au motif (règles `group` uniquement) */
    groups: Array<{ slug: string, name: string }>;
}

/** Agents (et groupes) actuellement couverts par une règle (SPEC §6.2) */
export async function ruleCoverage(sql: Sql, id: number): Promise<RuleCoverage> {
    const rule = await getRule(sql, id);
    const agents = await sql.all<{ slug: string, name: string }>(
        `SELECT a.slug, a.name FROM agents a, permission_rules r
         WHERE r.id = $1 AND a.revoked_at IS NULL AND a.status = 'active' AND ${RULE_COVERS_AGENT_SQL} ORDER BY a.slug`,
        id
    );
    const groups = rule.scope === "group"
        ? await sql.all<{ slug: string, name: string }>(
            `SELECT g.slug, g.name FROM agent_groups g, permission_rules r
             WHERE r.id = $1 AND g.slug LIKE r.like_pattern ESCAPE '\\' ORDER BY g.slug`, id)
        : [];
    return { rule, agents, groups };
}

//#endregion

//#region Accès effectif -----------------------------------------------------

export interface AccessDetail {
    viewer: string;
    agent: string;
    /** Le viewer a-t-il accès à l'agent (agent non révoqué couvert par au moins une règle) ? */
    access: boolean;
    agent_revoked: boolean;
    /** Règles qui accordent l'accès, avec les groupes par lesquels elles couvrent l'agent */
    rules: Array<RuleRecord & { via_groups: string[] }>;
    /** Une règle qui accorde l'accès porte `can_send_voice` */
    rule_can_send_voice: boolean;
    /** Le viewer déclare `audio_in` */
    audio_in: boolean;
    /** `can_send_voice` effectif : règle ET `audio_in` déclaré (SPEC §7.3) */
    can_send_voice: boolean;
}

/** Règles qui accordent l'accès d'un viewer à un agent (SPEC §6.2, diagnostic) */
export async function accessDetail(sql: Sql, viewerId: string, agentSlug: string): Promise<AccessDetail> {
    const viewer = await sql.get<{ capabilities: unknown }>(`SELECT capabilities FROM viewers WHERE id = $1`, viewerId);
    if (viewer == null) {
        throw notFound(`Viewer « ${viewerId} » introuvable.`);
    }
    const agent = await sql.get<{ revoked_at: Date | null, status: string }>(`SELECT revoked_at, status FROM agents WHERE slug = $1`, agentSlug);
    if (agent == null) {
        throw notFound(`Agent « ${agentSlug} » introuvable.`);
    }
    const rows = await sql.all<RuleRecord & { via_groups: string[] | null }>(
        `SELECT r.id::int AS id, r.viewer_id, r.scope, r.pattern, r.can_send_voice,
                (SELECT array_agg(m.group_slug ORDER BY m.group_slug) FROM agent_group_members m
                  WHERE r.scope = 'group' AND m.agent_slug = a.slug AND m.group_slug LIKE r.like_pattern ESCAPE '\\') AS via_groups
         FROM permission_rules r, agents a
         WHERE r.viewer_id = $1 AND a.slug = $2 AND ${RULE_COVERS_AGENT_SQL}
         ORDER BY r.id`,
        viewerId, agentSlug
    );
    // Un agent en attente d'approbation n'est accessible à personne (comme un agent révoqué)
    const agentRevoked = agent.revoked_at != null;
    const agentPending = agent.status === "pending";
    const rules = rows.map((row) => ({ ...row, via_groups: row.via_groups ?? [] }));
    const access = !agentRevoked && !agentPending && rules.length > 0;
    const ruleVoice = access && rules.some((rule) => rule.can_send_voice);
    const audioIn = declaresAudioIn(viewer.capabilities);
    return {
        viewer: viewerId, agent: agentSlug, access, agent_revoked: agentRevoked, rules,
        rule_can_send_voice: ruleVoice, audio_in: audioIn, can_send_voice: ruleVoice && audioIn
    };
}

export interface AccessPair {
    viewer: string;
    viewer_name: string | null;
    agent: string;
}

/** Tous les couples (viewer actif, agent non révoqué) couverts par au moins une règle */
export async function accessPairs(sql: Sql): Promise<AccessPair[]> {
    return sql.all<AccessPair>(
        `SELECT DISTINCT v.id AS viewer, v.name AS viewer_name, a.slug AS agent
         FROM viewers v
         JOIN permission_rules r ON r.viewer_id = v.id
         JOIN agents a ON a.revoked_at IS NULL AND a.status = 'active' AND ${RULE_COVERS_AGENT_SQL}
         WHERE v.status = 'active'
         ORDER BY v.id, a.slug`
    );
}

//#endregion

export function assertScope(value: unknown): RuleScope {
    if (typeof value !== "string" || !(RULE_SCOPES as readonly string[]).includes(value)) {
        throw badRequest(`scope doit valoir l'une des valeurs : ${RULE_SCOPES.join(", ")}.`);
    }
    return value as RuleScope;
}
