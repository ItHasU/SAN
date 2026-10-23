import { createHash } from "node:crypto";
import { Sql } from "./db";
import { badRequest, forbidden, notFound } from "./errors";
import { declaresAudioIn, RULE_COVERS_AGENT_SQL } from "./permissions";
import { JsonObject } from "./validate";
import { SubscriptionMode } from "./viewers";

/**
 * Configuration effective d'un viewer (SPEC §8, DESIGN §4) : mode, agents
 * visibles, état d'abonnement, position, muet, `can_send_voice` effectif.
 */

export interface ConfigAgent {
    agent: string;
    name: string;
    subscribed: boolean;
    new: boolean;
    position: number | null;
    muted: boolean;
    can_send_voice: boolean;
}

export interface ViewerConfig {
    mode: SubscriptionMode;
    agents: ConfigAgent[];
}

/** Sérialisation JSON canonique : clés triées récursivement, sans espaces */
export function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
    }
    if (value != null && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}

/** 16 premiers caractères hex de `sha256(JSON canonique)` (DESIGN §4) */
export function configHash(config: ViewerConfig): string {
    return createHash("sha256").update(canonicalJson(config), "utf8").digest("hex").slice(0, 16);
}

/** Les agents suivis : `subscribed` en manual, tous les visibles en auto (où `subscribed` vaut toujours true) */
export const trackedAgents = (config: ViewerConfig): ConfigAgent[] => config.agents.filter((agent) => agent.subscribed);

interface ViewerRow {
    subscription_mode: SubscriptionMode;
    capabilities: unknown;
    status: string;
}

interface AgentRow {
    slug: string;
    name: string;
    voice: boolean;
    s_exists: boolean;
    s_subscribed: boolean | null;
    s_position: number | null;
    s_muted: boolean | null;
}

/** Ordre d'affichage : position (null en dernier), puis nom, puis slug */
function compareAgents(a: ConfigAgent, b: ConfigAgent): number {
    if (a.position !== b.position) {
        if (a.position == null) {
            return 1;
        }
        if (b.position == null) {
            return -1;
        }
        return a.position - b.position;
    }
    return a.name < b.name ? -1 : a.name > b.name ? 1 : a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0;
}

/**
 * Calcule la configuration effective d'un viewer, sans rien écrire.
 * Les agents révoqués et ceux sans règle qui les couvre en sont exclus ; leurs
 * lignes d'abonnement sont conservées en base (SPEC §8.1).
 * @throws ApiError 404 si le viewer n'existe pas
 */
export async function computeConfig(sql: Sql, viewerId: string): Promise<ViewerConfig> {
    const viewer = await sql.get<ViewerRow>(`SELECT subscription_mode, capabilities, status FROM viewers WHERE id = $1`, viewerId);
    if (viewer == null) {
        throw notFound(`Viewer « ${viewerId} » introuvable.`);
    }
    const audioIn = declaresAudioIn(viewer.capabilities);
    const rows = await sql.all<AgentRow>(
        `SELECT a.slug, a.name, COALESCE(bool_or(r.can_send_voice), false) AS voice,
                (s.viewer_id IS NOT NULL) AS s_exists, s.subscribed AS s_subscribed, s.position AS s_position, s.muted AS s_muted
         FROM agents a
         JOIN permission_rules r ON r.viewer_id = $1 AND ${RULE_COVERS_AGENT_SQL}
         LEFT JOIN subscriptions s ON s.viewer_id = $1 AND s.agent_slug = a.slug
         WHERE a.revoked_at IS NULL
         GROUP BY a.slug, a.name, s.viewer_id, s.subscribed, s.position, s.muted`,
        viewerId
    );
    const auto = viewer.subscription_mode === "auto";
    const agents: ConfigAgent[] = rows.map((row) => ({
        agent: row.slug,
        name: row.name,
        subscribed: auto ? true : row.s_subscribed === true,
        new: auto ? false : !row.s_exists,
        position: row.s_position,
        muted: row.s_muted === true,
        can_send_voice: row.voice && audioIn
    }));
    agents.sort(compareAgents);
    return { mode: viewer.subscription_mode, agents };
}

/**
 * Première consultation du menu en mode manual : crée les lignes manquantes
 * (`subscribed = false`, `first_seen_at`) pour les agents visibles (SPEC §8.1).
 * Sans effet en mode auto.
 */
export async function materializeNewAgents(sql: Sql, viewerId: string, config: ViewerConfig): Promise<void> {
    if (config.mode !== "manual") {
        return;
    }
    for (const agent of config.agents) {
        if (agent.new) {
            await sql.run(
                `INSERT INTO subscriptions (viewer_id, agent_slug, subscribed) VALUES ($1, $2, false) ON CONFLICT DO NOTHING`,
                viewerId, agent.agent
            );
        }
    }
}

/** Réponse de `GET /viewer/config` et de `PUT /viewer/config` */
export interface ConfigView {
    config_hash: string;
    config: ViewerConfig;
}

/**
 * `GET /viewer/config` : les lignes manquantes sont créées, mais la réponse
 * garde les marqueurs `new` de cette consultation. Le `config_hash` est celui
 * de l'état persisté après création (où `new` vaut false) : c'est celui que
 * verront les synchronisations suivantes et que le viewer renverra en
 * `base_hash` ; sans cela le premier `PUT` suivant un `GET` serait en conflit.
 */
export async function consultConfig(sql: Sql, viewerId: string): Promise<ConfigView> {
    const config = await computeConfig(sql, viewerId);
    if (!config.agents.some((agent) => agent.new)) {
        return { config_hash: configHash(config), config };
    }
    await materializeNewAgents(sql, viewerId, config);
    const persisted = await computeConfig(sql, viewerId);
    return { config_hash: configHash(persisted), config };
}

export interface SubscriptionPatch {
    agent: string;
    subscribed?: boolean;
    position?: number | null;
    muted?: boolean;
}

const POSITION_MAX = 100_000;

/** Valide le tableau `subscriptions` d'un `PUT` (400 si mal formé) */
export function parseSubscriptions(value: unknown): SubscriptionPatch[] {
    if (!Array.isArray(value) || value.length > 1000) {
        throw badRequest("subscriptions doit être un tableau (1000 entrées au plus).");
    }
    const seen = new Set<string>();
    return value.map((entry, index): SubscriptionPatch => {
        if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
            throw badRequest(`subscriptions[${index}] doit être un objet.`);
        }
        const item = entry as JsonObject;
        const agent = item["agent"];
        if (typeof agent !== "string" || agent === "") {
            throw badRequest(`subscriptions[${index}].agent est obligatoire.`);
        }
        if (seen.has(agent)) {
            throw badRequest(`subscriptions : agent « ${agent} » en double.`);
        }
        seen.add(agent);
        const patch: SubscriptionPatch = { agent };
        if (item["subscribed"] !== undefined) {
            if (typeof item["subscribed"] !== "boolean") {
                throw badRequest(`subscriptions[${index}].subscribed doit être un booléen.`);
            }
            patch.subscribed = item["subscribed"];
        }
        if (item["muted"] !== undefined) {
            if (typeof item["muted"] !== "boolean") {
                throw badRequest(`subscriptions[${index}].muted doit être un booléen.`);
            }
            patch.muted = item["muted"];
        }
        if (item["position"] !== undefined) {
            const position = item["position"];
            if (position !== null && (typeof position !== "number" || !Number.isInteger(position) || position < 0 || position > POSITION_MAX)) {
                throw badRequest(`subscriptions[${index}].position doit être un entier entre 0 et ${POSITION_MAX}, ou null.`);
            }
            patch.position = position as number | null;
        }
        return patch;
    });
}

/**
 * Applique des abonnements (upsert champ par champ : un champ absent n'est pas
 * touché). Les agents non visibles sont rejetés en bloc, avant toute écriture.
 * @param onInvisible erreur à lever (403 pour un viewer, 400 pour un administrateur)
 */
export async function applySubscriptions(sql: Sql, viewerId: string, patches: SubscriptionPatch[], onInvisible: "forbidden" | "bad_request"): Promise<void> {
    const config = await computeConfig(sql, viewerId);
    const visible = new Set(config.agents.map((agent) => agent.agent));
    const invisible = patches.filter((patch) => !visible.has(patch.agent)).map((patch) => patch.agent);
    if (invisible.length > 0) {
        const message = `Agents non visibles par ce viewer : ${invisible.join(", ")}.`;
        throw onInvisible === "forbidden" ? forbidden(message, "agent_not_visible") : badRequest(message, "agent_not_visible");
    }
    for (const patch of patches) {
        await sql.run(
            `INSERT INTO subscriptions (viewer_id, agent_slug, subscribed, position, muted)
             VALUES ($1, $2, COALESCE($3::boolean, false), $4::int, COALESCE($5::boolean, false))
             ON CONFLICT (viewer_id, agent_slug) DO UPDATE SET
                subscribed = COALESCE($3::boolean, subscriptions.subscribed),
                position = CASE WHEN $6::boolean THEN $4::int ELSE subscriptions.position END,
                muted = COALESCE($5::boolean, subscriptions.muted)`,
            viewerId, patch.agent, patch.subscribed ?? null, patch.position ?? null, patch.muted ?? null, patch.position !== undefined
        );
    }
}
