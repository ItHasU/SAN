import { Sql } from "./db";

/**
 * Accès effectif d'un viewer aux agents (SPEC §6.2) — partie nécessaire à la
 * phase 1 (règle §8.1). Les règles CRUD, l'aperçu de couverture et le
 * diagnostic d'accès arrivent en phase 2 dans ce module.
 *
 * Le motif n'est jamais concaténé : il est lu dans la colonne `like_pattern`
 * et comparé entre deux colonnes, avec `ESCAPE '\'` déclaré (SPEC §6.1).
 */

/** Fragment SQL : « l'agent `a` est couvert par une règle du viewer `$1` » */
export const AGENT_COVERED_BY_RULE_SQL = `
    EXISTS (
        SELECT 1 FROM permission_rules r
        WHERE r.viewer_id = $1 AND (
            (r.scope = 'agent' AND a.slug LIKE r.like_pattern ESCAPE '\\')
            OR (r.scope = 'group' AND EXISTS (
                SELECT 1 FROM agent_group_members m
                WHERE m.agent_slug = a.slug AND m.group_slug LIKE r.like_pattern ESCAPE '\\'))
        )
    )`;

/** Slugs des agents (non révoqués) auxquels le viewer a accès, triés */
export async function visibleAgentSlugs(sql: Sql, viewerId: string): Promise<string[]> {
    const rows = await sql.all<{ slug: string }>(
        `SELECT a.slug FROM agents a WHERE a.revoked_at IS NULL AND ${AGENT_COVERED_BY_RULE_SQL} ORDER BY a.slug`,
        viewerId
    );
    return rows.map((row) => row.slug);
}
