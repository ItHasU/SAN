import { Db } from "./db";
import { hashesEqual, hashToken, tokenKind } from "./tokens";

/** Principal authentifié par jeton Bearer */
export interface AgentPrincipal {
    type: "agent";
    slug: string;
    name: string;
    /** `pending` : enrôlé sans jeton d'enrôlement, seul `GET /agent/status` est permis (SPEC §4bis) */
    status: "pending" | "active";
}

export interface ViewerPrincipal {
    type: "viewer";
    id: string;
    kind: "device" | "web";
    status: "pending" | "active";
    name: string | null;
    subscriptionMode: "auto" | "manual";
}

export type Principal = AgentPrincipal | ViewerPrincipal;

/**
 * Résout un jeton en principal : recherche par empreinte (index unique) puis
 * comparaison en temps constant (DESIGN §4). `null` pour un jeton mal formé,
 * inconnu ou révoqué (→ 401).
 */
export async function authenticateToken(db: Db, token: string): Promise<Principal | null> {
    const kind = tokenKind(token);
    // Un jeton d'enrôlement (`enr_`) n'authentifie aucun principal : il ne sert qu'à `POST /agent/register`
    if (kind == null || kind === "enr") {
        return null;
    }
    const hash = hashToken(token);

    if (kind === "agt") {
        const row = await db.get<{ slug: string, name: string, status: "pending" | "active", token_hash: Buffer, revoked_at: Date | null }>(
            `SELECT slug, name, status, token_hash, revoked_at FROM agents WHERE token_hash = $1`, hash
        );
        if (row == null || !hashesEqual(row.token_hash, hash) || row.revoked_at != null) {
            return null;
        }
        return { type: "agent", slug: row.slug, name: row.name, status: row.status };
    }

    const row = await db.get<{ id: string, kind: "device" | "web", name: string | null, status: "pending" | "active" | "revoked", subscription_mode: "auto" | "manual", token_hash: Buffer }>(
        `SELECT id, kind, name, status, subscription_mode, token_hash FROM viewers WHERE token_hash = $1`, hash
    );
    if (row == null || !hashesEqual(row.token_hash, hash) || row.status === "revoked") {
        return null;
    }
    // Le préfixe doit correspondre au type de viewer : un jeton web_ ne vaut pas pour une carte
    if ((kind === "dev") !== (row.kind === "device")) {
        return null;
    }
    return { type: "viewer", id: row.id, kind: row.kind, status: row.status, name: row.name, subscriptionMode: row.subscription_mode };
}
