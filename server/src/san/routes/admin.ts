import { Request, Response, Router } from "express";
import { AGENT_ENROLLMENT_STATUSES, approveAgent, createAgent, deleteAgent, getAgent, listAgents, regenerateAgentToken, updateAgent } from "../agents";
import { createEnrollmentToken, listEnrollmentTokens, revokeEnrollmentToken } from "../enrollment";
import { Db } from "../db";
import { withImpact, MutationOutcome } from "../impact";
import { accessDetail, assertScope, createRule, deleteRule, getRule, listRules, ruleCoverage, updateRule } from "../permissions";
import { applySubscriptions, computeConfig, configHash, parseSubscriptions } from "../viewer-config";
import { badRequest } from "../errors";
import { assertPattern, assertSlug } from "../glob";
import { createGroup, deleteGroup, getGroup, listGroups, setGroupMembers, updateGroup } from "../groups";
import { asObject, JsonObject, optionalBoolean, optionalEnum, optionalString, requiredString } from "../validate";
import { activateViewer, createWebViewer, getViewer, listViewers, revokeViewer, SUBSCRIPTION_MODES, updateViewer, validateCapabilities, VIEWER_STATUSES } from "../viewers";

/** Enregistre une action d'administration dans le journal d'audit */
export type AuditFn = (req: Request, action: string, details: unknown) => Promise<void>;

const NAME_MAX = 100;
const DESCRIPTION_MAX = 500;

/** Un PATCH doit modifier au moins un champ */
function assertNotEmpty(patch: Record<string, unknown>): void {
    if (Object.values(patch).every((value) => value === undefined)) {
        throw badRequest("Aucun champ à modifier.");
    }
}

/** `null` explicite = effacer ; absent = ne pas toucher */
function nullableDescription(body: JsonObject): string | null | undefined {
    if (body["description"] === null) {
        return null;
    }
    return optionalString(body, "description", DESCRIPTION_MAX);
}

/** `revoked` n'accepte que `true` : on réactive un agent en régénérant son jeton */
function revokedFlag(body: JsonObject): true | undefined {
    if (body["revoked"] === undefined) {
        return undefined;
    }
    if (body["revoked"] !== true) {
        throw badRequest("revoked ne peut valoir que true : régénérez le jeton pour réactiver un agent.");
    }
    return true;
}

/** `POST /web/register` : un utilisateur connecté enregistre son navigateur comme viewer `web` (DESIGN §3) */
export function webRegisterRoutes(db: Db, audit: AuditFn): Router {
    const router = Router();
    router.post("/register", async (req, res) => {
        const body = asObject(req.body);
        const capabilities = validateCapabilities(body["capabilities"]);
        const label = optionalString(body, "label", NAME_MAX, 1);
        const result = await createWebViewer(db, { capabilities, label });
        await audit(req, "web.register", { viewer_id: result.viewer_id });
        res.status(201).json(result);
    });
    return router;
}

/** `?dry_run=1` (ou `true`) : calcule l'impact sans rien modifier (SPEC §6.2, §11) */
const isDryRun = (req: Request): boolean => req.query["dry_run"] === "1" || req.query["dry_run"] === "true";

/** Réponse d'un aperçu : `{dry_run: true, gained, lost}` ; renvoie true si la requête était un aperçu */
function replyIfDryRun(res: Response, outcome: MutationOutcome<unknown>): boolean {
    if (!outcome.dryRun) {
        return false;
    }
    res.json({ dry_run: true, gained: outcome.impact.gained, lost: outcome.impact.lost });
    return true;
}

/** `groups` d'une approbation : tableau de slugs de groupes (absent = aucun) */
function parseGroupSlugs(value: unknown): string[] {
    if (value === undefined || value === null) {
        return [];
    }
    if (!Array.isArray(value) || value.length > 100) {
        throw badRequest("groups doit être un tableau de slugs de groupes (100 au plus).");
    }
    return value.map((group) => assertSlug(group, "groups[]"));
}

/** `expires_at` d'un jeton d'enrôlement : date ISO 8601 future, ou absent/null (n'expire pas) */
function parseExpiry(value: unknown): Date | null {
    if (value === undefined || value === null) {
        return null;
    }
    const date = typeof value === "string" ? new Date(value) : null;
    if (date == null || Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
        throw badRequest("expires_at doit être une date ISO 8601 dans le futur.");
    }
    return date;
}

/** Entier positif d'un segment d'URL */
function idParam(value: unknown): number {
    if (typeof value !== "string" || !/^\d{1,15}$/.test(value)) {
        throw badRequest("Identifiant invalide.");
    }
    return Number(value);
}

/**
 * Routes `/admin/*` (SPEC §10.5) — session Dagda exigée en amont.
 *
 * Toute route qui modifie la couverture des permissions s'exécute dans une
 * transaction (`withImpact`) : avec `?dry_run=1` elle est annulée et ne renvoie
 * que `{dry_run, gained, lost}` ; sinon la réponse normale inclut `impact`.
 */
export function adminRoutes(db: Db, audit: AuditFn): Router {
    const router = Router();

    //#region Agents ---------------------------------------------------------

    router.get("/agents", async (req, res) => {
        const status = optionalEnum({ status: req.query["status"] }, "status", AGENT_ENROLLMENT_STATUSES);
        res.json({ agents: await listAgents(db, status) });
    });

    router.post("/agents", async (req, res) => {
        const body = asObject(req.body);
        const slug = assertSlug(body["slug"]);
        const name = requiredString(body, "name", NAME_MAX);
        const description = optionalString(body, "description", DESCRIPTION_MAX);
        const outcome = await withImpact(db, isDryRun(req), (conn) => createAgent(conn, { slug, name, description }));
        if (replyIfDryRun(res, outcome)) {
            return;
        }
        await audit(req, "agent.create", { slug });
        // Le jeton n'est affiché qu'ici
        res.status(201).json({ ...outcome.result, impact: outcome.impact });
    });

    router.get("/agents/:slug", async (req, res) => {
        res.json({ agent: await getAgent(db, assertSlug(req.params["slug"])) });
    });

    router.patch("/agents/:slug", async (req, res) => {
        const slug = assertSlug(req.params["slug"]);
        const body = asObject(req.body);
        const patch = {
            name: optionalString(body, "name", NAME_MAX, 1),
            description: nullableDescription(body),
            revoked: revokedFlag(body)
        };
        assertNotEmpty(patch);
        const outcome = await withImpact(db, isDryRun(req), (conn) => updateAgent(conn, slug, patch));
        if (replyIfDryRun(res, outcome)) {
            return;
        }
        await audit(req, patch.revoked ? "agent.revoke" : "agent.update", { slug });
        res.json({ agent: outcome.result, impact: outcome.impact });
    });

    /**
     * Révoque l'agent ; `?purge=true` le supprime définitivement avec son état et ses
     * événements. Un agent `pending` est toujours supprimé : c'est le rejet de sa demande.
     */
    router.delete("/agents/:slug", async (req, res) => {
        const slug = assertSlug(req.params["slug"]);
        const pending = (await getAgent(db, slug)).status === "pending";
        if (req.query["purge"] === "true" || pending) {
            const outcome = await withImpact(db, isDryRun(req), (conn) => deleteAgent(conn, slug));
            if (replyIfDryRun(res, outcome)) {
                return;
            }
            await audit(req, pending ? "agent.reject" : "agent.delete", { slug });
            res.json({ deleted: true, impact: outcome.impact });
            return;
        }
        const outcome = await withImpact(db, isDryRun(req), (conn) => updateAgent(conn, slug, { revoked: true }));
        if (replyIfDryRun(res, outcome)) {
            return;
        }
        await audit(req, "agent.revoke", { slug });
        res.json({ agent: outcome.result, impact: outcome.impact });
    });

    /**
     * Approuve un agent `pending` (SPEC §4bis), avec éventuellement des groupes à rejoindre.
     * Aperçu d'impact : les viewers dont une règle couvre l'agent gagnent l'accès.
     */
    router.post("/agents/:slug/approve", async (req, res) => {
        const slug = assertSlug(req.params["slug"]);
        const groups = parseGroupSlugs(asObject(req.body ?? {})["groups"]);
        const outcome = await withImpact(db, isDryRun(req), (conn) => approveAgent(conn, slug, groups));
        if (replyIfDryRun(res, outcome)) {
            return;
        }
        await audit(req, "agent.approve", { slug, groups });
        res.json({ agent: outcome.result, impact: outcome.impact });
    });

    /** Régénère le jeton ; un agent révoqué est réactivé (il peut donc gagner des viewers) */
    router.post("/agents/:slug/token", async (req, res) => {
        const slug = assertSlug(req.params["slug"]);
        const outcome = await withImpact(db, isDryRun(req), (conn) => regenerateAgentToken(conn, slug));
        if (replyIfDryRun(res, outcome)) {
            return;
        }
        await audit(req, "agent.token.regenerate", { slug });
        res.json({ ...outcome.result, impact: outcome.impact });
    });

    //#endregion

    //#region Groupes --------------------------------------------------------

    router.get("/groups", async (_req, res) => {
        res.json({ groups: await listGroups(db) });
    });

    router.post("/groups", async (req, res) => {
        const body = asObject(req.body);
        const slug = assertSlug(body["slug"]);
        const input = { slug, name: requiredString(body, "name", NAME_MAX), description: optionalString(body, "description", DESCRIPTION_MAX) };
        const outcome = await withImpact(db, isDryRun(req), (conn) => createGroup(conn, input));
        if (replyIfDryRun(res, outcome)) {
            return;
        }
        await audit(req, "group.create", { slug });
        res.status(201).json({ group: outcome.result, impact: outcome.impact });
    });

    router.get("/groups/:slug", async (req, res) => {
        res.json({ group: await getGroup(db, assertSlug(req.params["slug"])) });
    });

    router.patch("/groups/:slug", async (req, res) => {
        const slug = assertSlug(req.params["slug"]);
        const body = asObject(req.body);
        const patch = { name: optionalString(body, "name", NAME_MAX, 1), description: nullableDescription(body) };
        assertNotEmpty(patch);
        const outcome = await withImpact(db, isDryRun(req), (conn) => updateGroup(conn, slug, patch));
        if (replyIfDryRun(res, outcome)) {
            return;
        }
        await audit(req, "group.update", { slug });
        res.json({ group: outcome.result, impact: outcome.impact });
    });

    router.delete("/groups/:slug", async (req, res) => {
        const slug = assertSlug(req.params["slug"]);
        const outcome = await withImpact(db, isDryRun(req), (conn) => deleteGroup(conn, slug));
        if (replyIfDryRun(res, outcome)) {
            return;
        }
        await audit(req, "group.delete", { slug });
        res.json({ deleted: true, impact: outcome.impact });
    });

    router.put("/groups/:slug/members", async (req, res) => {
        const slug = assertSlug(req.params["slug"]);
        const body = asObject(req.body);
        const members = body["members"];
        if (!Array.isArray(members) || members.length > 1000) {
            throw badRequest("members doit être un tableau de slugs d'agents (1000 au plus).");
        }
        const slugs = members.map((member) => assertSlug(member, "members[]"));
        const outcome = await withImpact(db, isDryRun(req), (conn) => setGroupMembers(conn, slug, slugs));
        if (replyIfDryRun(res, outcome)) {
            return;
        }
        await audit(req, "group.members.set", { slug, members: outcome.result.members });
        res.json({ group: outcome.result, impact: outcome.impact });
    });

    //#endregion

    //#region Jetons d'enrôlement (SPEC §4bis) --------------------------------

    router.get("/groups/:slug/enrollment-tokens", async (req, res) => {
        res.json({ tokens: await listEnrollmentTokens(db, assertSlug(req.params["slug"])) });
    });

    /** Crée un jeton d'enrôlement ; le secret n'est renvoyé qu'ici (seule son empreinte est stockée) */
    router.post("/groups/:slug/enrollment-tokens", async (req, res) => {
        const slug = assertSlug(req.params["slug"]);
        const body = asObject(req.body);
        const label = requiredString(body, "label", NAME_MAX);
        const expiresAt = parseExpiry(body["expires_at"]);
        const created = await createEnrollmentToken(db, slug, { label, expiresAt });
        await audit(req, "group.enrollment_token.create", { group: slug, id: created.enrollment_token.id, label, expires_at: expiresAt });
        res.status(201).json({ enrollment_token: created.enrollment_token, token: created.token });
    });

    /** Révoque un jeton (le jeton reste listé, marqué révoqué) ; les agents déjà enrôlés ne sont pas touchés */
    router.delete("/groups/:slug/enrollment-tokens/:id", async (req, res) => {
        const slug = assertSlug(req.params["slug"]);
        const id = idParam(req.params["id"]);
        const token = await revokeEnrollmentToken(db, slug, id);
        await audit(req, "group.enrollment_token.revoke", { group: slug, id });
        res.json({ enrollment_token: token });
    });

    //#endregion

    //#region Viewers --------------------------------------------------------

    router.get("/viewers", async (req, res) => {
        const status = optionalEnum({ status: req.query["status"] }, "status", VIEWER_STATUSES);
        res.json({ viewers: await listViewers(db, status) });
    });

    router.get("/viewers/:id", async (req, res) => {
        res.json({ viewer: await getViewer(db, String(req.params["id"])) });
    });

    router.patch("/viewers/:id", async (req, res) => {
        const id = String(req.params["id"]);
        const body = asObject(req.body);
        const patch = {
            name: optionalString(body, "name", NAME_MAX, 1),
            subscriptionMode: optionalEnum({ subscription_mode: body["subscription_mode"] }, "subscription_mode", SUBSCRIPTION_MODES)
        };
        assertNotEmpty(patch);
        const outcome = await withImpact(db, isDryRun(req), (conn) => updateViewer(conn, id, patch));
        if (replyIfDryRun(res, outcome)) {
            return;
        }
        await audit(req, "viewer.update", { id, ...patch });
        res.json({ viewer: outcome.result, impact: outcome.impact });
    });

    router.post("/viewers/:id/activate", async (req, res) => {
        const id = String(req.params["id"]);
        const name = requiredString(asObject(req.body), "name", NAME_MAX);
        const outcome = await withImpact(db, isDryRun(req), (conn) => activateViewer(conn, id, name));
        if (replyIfDryRun(res, outcome)) {
            return;
        }
        await audit(req, "viewer.activate", { id, name });
        res.json({ viewer: outcome.result, impact: outcome.impact });
    });

    router.post("/viewers/:id/revoke", async (req, res) => {
        const id = String(req.params["id"]);
        const outcome = await withImpact(db, isDryRun(req), (conn) => revokeViewer(conn, id));
        if (replyIfDryRun(res, outcome)) {
            return;
        }
        await audit(req, "viewer.revoke", { id });
        res.json({ viewer: outcome.result, impact: outcome.impact });
    });

    //#endregion

    //#region Permissions ----------------------------------------------------

    router.get("/viewers/:id/rules", async (req, res) => {
        res.json({ rules: await listRules(db, String(req.params["id"])) });
    });

    router.post("/viewers/:id/rules", async (req, res) => {
        const id = String(req.params["id"]);
        const body = asObject(req.body);
        const input = {
            scope: assertScope(body["scope"]),
            pattern: assertPattern(body["pattern"]),
            can_send_voice: optionalBoolean(body, "can_send_voice")
        };
        const outcome = await withImpact(db, isDryRun(req), (conn) => createRule(conn, id, input));
        if (replyIfDryRun(res, outcome)) {
            return;
        }
        await audit(req, "rule.create", { viewer: id, ...input });
        res.status(201).json({ rule: outcome.result, impact: outcome.impact });
    });

    router.patch("/rules/:id", async (req, res) => {
        const id = idParam(req.params["id"]);
        const body = asObject(req.body);
        const patch = {
            scope: body["scope"] === undefined ? undefined : assertScope(body["scope"]),
            pattern: body["pattern"] === undefined ? undefined : assertPattern(body["pattern"]),
            can_send_voice: optionalBoolean(body, "can_send_voice")
        };
        assertNotEmpty(patch);
        const outcome = await withImpact(db, isDryRun(req), (conn) => updateRule(conn, id, patch));
        if (replyIfDryRun(res, outcome)) {
            return;
        }
        await audit(req, "rule.update", { id, ...patch });
        res.json({ rule: outcome.result, impact: outcome.impact });
    });

    router.delete("/rules/:id", async (req, res) => {
        const id = idParam(req.params["id"]);
        const outcome = await withImpact(db, isDryRun(req), (conn) => deleteRule(conn, id));
        if (replyIfDryRun(res, outcome)) {
            return;
        }
        await audit(req, "rule.delete", { id, viewer: outcome.result.viewer_id, pattern: outcome.result.pattern });
        res.json({ deleted: true, rule: outcome.result, impact: outcome.impact });
    });

    /** Agents (et groupes) actuellement couverts par la règle (SPEC §6.2) */
    router.get("/rules/:id/coverage", async (req, res) => {
        res.json(await ruleCoverage(db, idParam(req.params["id"])));
    });

    /** Règles qui accordent l'accès du viewer à l'agent (diagnostic, SPEC §6.2) */
    router.get("/viewers/:id/access/:agent", async (req, res) => {
        res.json(await accessDetail(db, String(req.params["id"]), assertSlug(req.params["agent"], "agent")));
    });

    //#endregion

    //#region Abonnements ----------------------------------------------------

    router.get("/viewers/:id/subscriptions", async (req, res) => {
        const config = await computeConfig(db, String(req.params["id"]));
        res.json({ config_hash: configHash(config), config });
    });

    /** Applique des abonnements au nom du viewer (immédiat ; la carte les reçoit à son réveil via le hash) */
    router.put("/viewers/:id/subscriptions", async (req, res) => {
        const id = String(req.params["id"]);
        const patches = parseSubscriptions(asObject(req.body)["subscriptions"]);
        const outcome = await withImpact(db, isDryRun(req), async (conn) => {
            await computeConfig(conn, id);
            await applySubscriptions(conn, id, patches, "bad_request");
            return computeConfig(conn, id);
        });
        if (replyIfDryRun(res, outcome)) {
            return;
        }
        await audit(req, "viewer.subscriptions.set", { id, count: patches.length });
        res.json({ config_hash: configHash(outcome.result), config: outcome.result, impact: outcome.impact });
    });

    //#endregion

    return router;
}
