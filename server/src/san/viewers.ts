import { createHash } from "node:crypto";
import { SanConfig } from "./config";
import { advanceCursor } from "./cursors";
import { inTransaction, Sql } from "./db";
import { badRequest, conflict, notFound, tooManyRequests, upgradeRequired } from "./errors";
import { notifyConfigChanged } from "./events";
import { newPairingCode, newViewerId } from "./ids";
import { applyAutoToManual } from "./subscriptions";
import { generateToken } from "./tokens";

export const VIEWER_STATUSES = ["pending", "active", "revoked"] as const;
export type ViewerStatus = typeof VIEWER_STATUSES[number];
export const SUBSCRIPTION_MODES = ["auto", "manual"] as const;
export type SubscriptionMode = typeof SUBSCRIPTION_MODES[number];

/** Version de protocole supportée (DESIGN §4) */
export const SUPPORTED_PROTOCOL_VERSION = 1;

/** Clé du verrou consultatif qui sérialise les enrôlements (plafond de pending) */
export const REGISTER_LOCK_KEY = 7_301_002;

export interface ViewerRecord {
    id: string;
    kind: "device" | "web";
    name: string | null;
    status: ViewerStatus;
    subscription_mode: SubscriptionMode;
    hardware_id: string | null;
    model: string | null;
    registered_ip: string | null;
    /** Visible uniquement tant que le viewer est pending */
    pairing_code: string | null;
    capabilities: unknown;
    capabilities_hash: string | null;
    battery_pct: number | null;
    next_wake_at: Date | null;
    last_seen_at: Date | null;
    created_at: Date;
    pending_since: Date | null;
    activated_at: Date | null;
    revoked_at: Date | null;
}

/** Colonnes exposées : tout sauf `token_hash` */
const VIEWER_COLUMNS = `id, kind, name, status, subscription_mode, hardware_id, model, registered_ip,
    CASE WHEN status = 'pending' THEN pairing_code END AS pairing_code,
    capabilities, capabilities_hash, battery_pct, next_wake_at, last_seen_at, created_at, pending_since, activated_at, revoked_at`;

/**
 * Valide un document de capacités (SPEC §7) : objet avec `protocol_version`.
 * @throws ApiError 400 si le document est invalide, 426 si la version n'est pas supportée
 */
export function validateCapabilities(value: unknown): Record<string, unknown> {
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
        throw badRequest("capabilities doit être un objet JSON.");
    }
    const capabilities = value as Record<string, unknown>;
    const version = capabilities["protocol_version"];
    if (typeof version !== "number" || !Number.isInteger(version)) {
        throw badRequest("capabilities.protocol_version est obligatoire (entier).");
    }
    if (version !== SUPPORTED_PROTOCOL_VERSION) {
        throw upgradeRequired(`protocol_version ${version} non supportée (supportée : ${SUPPORTED_PROTOCOL_VERSION}).`);
    }
    return capabilities;
}

export interface RegisterDeviceInput {
    hardwareId: string;
    model: string;
    capabilities: Record<string, unknown>;
    ip: string | null;
}

/**
 * Enrôlement d'une carte (SPEC §4.2-4.3), en une transaction sérialisée :
 * - une demande `pending` de même `hardware_id` est remplacée (nouveau jeton, nouveau code) ;
 * - un viewer `active` de même `hardware_id` n'est pas touché ;
 * - le nombre de demandes en attente est plafonné (`429 pending_limit`).
 */
export async function registerDevice(db: Sql, input: RegisterDeviceInput, config: Pick<SanConfig, "maxPending">): Promise<{ viewer_id: string, token: string, pairing_code: string }> {
    const { token, hash } = generateToken("dev");
    const id = newViewerId();
    return inTransaction(db, async (conn) => {
        await conn.run(`SELECT pg_advisory_xact_lock($1)`, REGISTER_LOCK_KEY);
        await conn.run(`DELETE FROM viewers WHERE status = 'pending' AND hardware_id = $1`, input.hardwareId);
        const count = await conn.get<{ count: number }>(`SELECT count(*)::int AS count FROM viewers WHERE status = 'pending'`);
        if (count!.count >= config.maxPending) {
            throw tooManyRequests("Trop de demandes d'enrôlement en attente d'activation.", "pending_limit", 3600);
        }
        let code = newPairingCode();
        for (let attempt = 0; attempt < 50; attempt++) {
            const clash = await conn.get(`SELECT 1 FROM viewers WHERE status = 'pending' AND pairing_code = $1`, code);
            if (clash == null) {
                break;
            }
            code = newPairingCode();
        }
        await conn.run(
            `INSERT INTO viewers (id, kind, status, token_hash, hardware_id, model, registered_ip, pairing_code,
                                  subscription_mode, capabilities, pending_since)
             VALUES ($1, 'device', 'pending', $2, $3, $4, $5, $6, 'auto', $7::jsonb, now())`,
            id, hash, input.hardwareId, input.model, input.ip, code, JSON.stringify(input.capabilities)
        );
        return { viewer_id: id, token, pairing_code: code };
    });
}

/**
 * Curseur initial (SPEC §9.2) : un viewer qui devient actif reçoit l'état courant
 * mais pas l'historique, son curseur démarre au dernier identifiant d'événement.
 */
export async function initViewerCursor(sql: Sql, viewerId: string): Promise<void> {
    await advanceCursor(sql, "viewer", viewerId, Number.MAX_SAFE_INTEGER);
}

/** Crée un viewer `web`, actif d'emblée (SPEC §4.4) : l'utilisateur est authentifié */
export async function createWebViewer(db: Sql, input: { capabilities: Record<string, unknown>, label?: string }): Promise<{ viewer_id: string, token: string }> {
    const { token, hash } = generateToken("web");
    const id = newViewerId();
    await db.run(
        `INSERT INTO viewers (id, kind, name, status, token_hash, subscription_mode, capabilities, activated_at)
         VALUES ($1, 'web', $2, 'active', $3, 'auto', $4::jsonb, now())`,
        id, input.label ?? "Navigateur web", hash, JSON.stringify(input.capabilities)
    );
    await initViewerCursor(db, id);
    return { viewer_id: id, token };
}

export async function listViewers(db: Sql, status?: ViewerStatus): Promise<ViewerRecord[]> {
    return db.all<ViewerRecord>(
        `SELECT ${VIEWER_COLUMNS} FROM viewers WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC, id`,
        status ?? null
    );
}

export async function getViewer(db: Sql, id: string): Promise<ViewerRecord> {
    const row = await db.get<ViewerRecord>(`SELECT ${VIEWER_COLUMNS} FROM viewers WHERE id = $1`, id);
    if (row == null) {
        throw notFound(`Viewer « ${id} » introuvable.`);
    }
    return row;
}

/**
 * Modifie nom et/ou mode d'abonnement. Le passage `auto` → `manual` applique la
 * règle §8.1 dans la même transaction.
 */
export async function updateViewer(db: Sql, id: string, patch: { name?: string, subscriptionMode?: SubscriptionMode }): Promise<ViewerRecord> {
    await inTransaction(db, async (conn) => {
        const current = await conn.get<{ subscription_mode: SubscriptionMode }>(`SELECT subscription_mode FROM viewers WHERE id = $1 FOR UPDATE`, id);
        if (current == null) {
            throw notFound(`Viewer « ${id} » introuvable.`);
        }
        await conn.run(
            `UPDATE viewers SET name = COALESCE($2, name), subscription_mode = COALESCE($3, subscription_mode) WHERE id = $1`,
            id, patch.name ?? null, patch.subscriptionMode ?? null
        );
        if (current.subscription_mode === "auto" && patch.subscriptionMode === "manual") {
            await applyAutoToManual(conn, id);
        }
    });
    return getViewer(db, id);
}

/** Active un viewer pending en lui donnant un nom (SPEC §4.2) */
export async function activateViewer(db: Sql, id: string, name: string): Promise<ViewerRecord> {
    const row = await db.get<{ id: string }>(
        `UPDATE viewers SET status = 'active', name = $2, activated_at = now(), pairing_code = NULL
         WHERE id = $1 AND status = 'pending' RETURNING id`,
        id, name
    );
    if (row == null) {
        const existing = await getViewer(db, id);
        throw conflict(`Le viewer est « ${existing.status} » : seul un viewer en attente peut être activé.`, "not_pending");
    }
    await initViewerCursor(db, id);
    return getViewer(db, id);
}

/** Révoque un viewer (idempotent) : son jeton reçoit désormais 401 */
export async function revokeViewer(db: Sql, id: string): Promise<ViewerRecord> {
    const row = await db.get<{ id: string }>(
        `UPDATE viewers SET status = 'revoked', revoked_at = COALESCE(revoked_at, now()), pairing_code = NULL WHERE id = $1 RETURNING id`,
        id
    );
    if (row == null) {
        throw notFound(`Viewer « ${id} » introuvable.`);
    }
    return getViewer(db, id);
}

/** Supprime les viewers `pending` plus anciens que `maxAgeDays` (SPEC §4.3), avec leur jeton */
export async function purgePendingViewers(db: Sql, maxAgeDays = 7, now: Date = new Date()): Promise<number> {
    const rows = await db.all<{ id: string }>(
        `DELETE FROM viewers WHERE status = 'pending' AND pending_since < $1::timestamptz - make_interval(days => $2) RETURNING id`,
        now.toISOString(), maxAgeDays
    );
    return rows.length;
}

/** 16 premiers caractères hex de `sha256(corps brut)` (DESIGN §4) */
export function capabilitiesHash(raw: Buffer): string {
    return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/**
 * Enregistre le document de capacités d'un viewer (`PUT /viewer/capabilities`) :
 * le hash est calculé sur le corps exact reçu, le JSON parsé est stocké en même temps.
 * @throws ApiError 400 (JSON invalide), 426 (version de protocole non supportée)
 */
export async function storeCapabilities(db: Sql, viewerId: string, raw: Buffer): Promise<{ caps_hash: string }> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw.toString("utf8"));
    } catch {
        throw badRequest("Corps JSON invalide.", "invalid_json");
    }
    const capabilities = validateCapabilities(parsed);
    const hash = capabilitiesHash(raw);
    await inTransaction(db, async (conn) => {
        await conn.run(`UPDATE viewers SET capabilities = $2::jsonb, capabilities_hash = $3 WHERE id = $1`, viewerId, JSON.stringify(capabilities), hash);
        // can_send_voice effectif dépend de audio_in : la configuration peut changer
        await notifyConfigChanged(conn, viewerId);
    });
    return { caps_hash: hash };
}
