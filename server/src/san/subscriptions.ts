import { Sql } from "./db";
import { RULE_COVERS_AGENT_SQL, visibleAgentSlugs } from "./permissions";

/** Début du suivi en `auto` (création de la première règle qui couvre l'agent `$2`) : le suivi continue sans perdre d'événement */
const AUTO_SINCE_SQL = `(SELECT min(r.created_at) FROM permission_rules r JOIN agents a ON a.slug = $2
    WHERE r.viewer_id = $1 AND ${RULE_COVERS_AGENT_SQL})`;

/**
 * Passage d'un viewer de `auto` à `manual` (SPEC §8.1) : une ligne
 * `subscribed = true` est créée ou mise à jour pour chaque agent actuellement
 * visible, afin que rien ne disparaisse de l'affichage. Position et `muted`
 * existants sont conservés. À appeler dans la transaction qui change le mode.
 *
 * @returns les slugs des agents abonnés
 */
export async function applyAutoToManual(sql: Sql, viewerId: string): Promise<string[]> {
    const slugs = await visibleAgentSlugs(sql, viewerId);
    for (const slug of slugs) {
        await sql.run(
            `INSERT INTO subscriptions (viewer_id, agent_slug, subscribed, subscribed_at)
             VALUES ($1, $2, true, ${AUTO_SINCE_SQL})
             ON CONFLICT (viewer_id, agent_slug) DO UPDATE SET subscribed = true,
                subscribed_at = CASE WHEN subscriptions.subscribed THEN subscriptions.subscribed_at ELSE ${AUTO_SINCE_SQL} END`,
            viewerId, slug
        );
    }
    return slugs;
}
