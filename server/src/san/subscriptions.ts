import { Sql } from "./db";
import { visibleAgentSlugs } from "./permissions";

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
            `INSERT INTO subscriptions (viewer_id, agent_slug, subscribed) VALUES ($1, $2, true)
             ON CONFLICT (viewer_id, agent_slug) DO UPDATE SET subscribed = true`,
            viewerId, slug
        );
    }
    return slugs;
}
