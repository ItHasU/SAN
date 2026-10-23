import { inTransaction, Sql } from "./db";
import { badRequest, conflict, notFound } from "./errors";

export interface GroupRecord {
    slug: string;
    name: string;
    description: string | null;
    members: string[];
}

interface GroupRow {
    slug: string;
    name: string;
    description: string | null;
    members: string[] | null;
}

const GROUP_SELECT = `
    SELECT g.slug, g.name, g.description,
           (SELECT array_agg(m.agent_slug ORDER BY m.agent_slug) FROM agent_group_members m WHERE m.group_slug = g.slug) AS members
    FROM agent_groups g`;

const toRecord = (row: GroupRow): GroupRecord => ({ slug: row.slug, name: row.name, description: row.description, members: row.members ?? [] });

export async function listGroups(db: Sql): Promise<GroupRecord[]> {
    return (await db.all<GroupRow>(`${GROUP_SELECT} ORDER BY g.slug`)).map(toRecord);
}

export async function getGroup(db: Sql, slug: string): Promise<GroupRecord> {
    const row = await db.get<GroupRow>(`${GROUP_SELECT} WHERE g.slug = $1`, slug);
    if (row == null) {
        throw notFound(`Groupe « ${slug} » introuvable.`);
    }
    return toRecord(row);
}

export async function createGroup(db: Sql, input: { slug: string, name: string, description?: string }): Promise<GroupRecord> {
    const row = await db.get<{ slug: string }>(
        `INSERT INTO agent_groups (slug, name, description) VALUES ($1, $2, $3) ON CONFLICT (slug) DO NOTHING RETURNING slug`,
        input.slug, input.name, input.description ?? null
    );
    if (row == null) {
        throw conflict(`Un groupe « ${input.slug} » existe déjà.`, "slug_taken");
    }
    return getGroup(db, input.slug);
}

export async function updateGroup(db: Sql, slug: string, patch: { name?: string, description?: string | null }): Promise<GroupRecord> {
    const row = await db.get<{ slug: string }>(
        `UPDATE agent_groups SET name = COALESCE($2, name),
            description = CASE WHEN $3::boolean THEN $4 ELSE description END
         WHERE slug = $1 RETURNING slug`,
        slug, patch.name ?? null, patch.description !== undefined, patch.description ?? null
    );
    if (row == null) {
        throw notFound(`Groupe « ${slug} » introuvable.`);
    }
    return getGroup(db, slug);
}

export async function deleteGroup(db: Sql, slug: string): Promise<void> {
    const row = await db.get<{ slug: string }>(`DELETE FROM agent_groups WHERE slug = $1 RETURNING slug`, slug);
    if (row == null) {
        throw notFound(`Groupe « ${slug} » introuvable.`);
    }
}

/** Remplace l'ensemble des membres du groupe (transaction ; tous les agents doivent exister) */
export async function setGroupMembers(db: Sql, slug: string, members: string[]): Promise<GroupRecord> {
    const unique = [...new Set(members)];
    await inTransaction(db, async (conn) => {
        const group = await conn.get(`SELECT slug FROM agent_groups WHERE slug = $1 FOR UPDATE`, slug);
        if (group == null) {
            throw notFound(`Groupe « ${slug} » introuvable.`);
        }
        if (unique.length > 0) {
            const existing = await conn.all<{ slug: string }>(`SELECT slug FROM agents WHERE slug = ANY($1::text[])`, unique as never);
            const known = new Set(existing.map((row) => row.slug));
            const unknown = unique.filter((member) => !known.has(member));
            if (unknown.length > 0) {
                throw badRequest(`Agents inconnus : ${unknown.join(", ")}.`, "unknown_agents");
            }
        }
        await conn.run(`DELETE FROM agent_group_members WHERE group_slug = $1`, slug);
        for (const member of unique) {
            await conn.run(`INSERT INTO agent_group_members (group_slug, agent_slug) VALUES ($1, $2)`, slug, member);
        }
    });
    return getGroup(db, slug);
}
