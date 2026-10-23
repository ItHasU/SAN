import { Request, Router } from "express";
import { createAgent, deleteAgent, getAgent, listAgents, regenerateAgentToken, updateAgent } from "../agents";
import { Db } from "../db";
import { badRequest } from "../errors";
import { assertSlug } from "../glob";
import { createGroup, deleteGroup, getGroup, listGroups, setGroupMembers, updateGroup } from "../groups";
import { asObject, JsonObject, optionalEnum, optionalString, requiredString } from "../validate";
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

/** Routes `/admin/*` (SPEC §10.5, phase 1 : agents, groupes, viewers) — session Dagda exigée en amont */
export function adminRoutes(db: Db, audit: AuditFn): Router {
    const router = Router();

    //#region Agents ---------------------------------------------------------

    router.get("/agents", async (_req, res) => {
        res.json({ agents: await listAgents(db) });
    });

    router.post("/agents", async (req, res) => {
        const body = asObject(req.body);
        const slug = assertSlug(body["slug"]);
        const name = requiredString(body, "name", NAME_MAX);
        const description = optionalString(body, "description", DESCRIPTION_MAX);
        const created = await createAgent(db, { slug, name, description });
        await audit(req, "agent.create", { slug });
        // Le jeton n'est affiché qu'ici
        res.status(201).json(created);
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
        const agent = await updateAgent(db, slug, patch);
        await audit(req, patch.revoked ? "agent.revoke" : "agent.update", { slug });
        res.json({ agent });
    });

    /** Révoque l'agent ; `?purge=true` le supprime définitivement avec son état et ses événements */
    router.delete("/agents/:slug", async (req, res) => {
        const slug = assertSlug(req.params["slug"]);
        if (req.query["purge"] === "true") {
            await deleteAgent(db, slug);
            await audit(req, "agent.delete", { slug });
            res.status(204).end();
            return;
        }
        const agent = await updateAgent(db, slug, { revoked: true });
        await audit(req, "agent.revoke", { slug });
        res.json({ agent });
    });

    router.post("/agents/:slug/token", async (req, res) => {
        const slug = assertSlug(req.params["slug"]);
        const result = await regenerateAgentToken(db, slug);
        await audit(req, "agent.token.regenerate", { slug });
        res.json(result);
    });

    //#endregion

    //#region Groupes --------------------------------------------------------

    router.get("/groups", async (_req, res) => {
        res.json({ groups: await listGroups(db) });
    });

    router.post("/groups", async (req, res) => {
        const body = asObject(req.body);
        const slug = assertSlug(body["slug"]);
        const group = await createGroup(db, { slug, name: requiredString(body, "name", NAME_MAX), description: optionalString(body, "description", DESCRIPTION_MAX) });
        await audit(req, "group.create", { slug });
        res.status(201).json({ group });
    });

    router.get("/groups/:slug", async (req, res) => {
        res.json({ group: await getGroup(db, assertSlug(req.params["slug"])) });
    });

    router.patch("/groups/:slug", async (req, res) => {
        const slug = assertSlug(req.params["slug"]);
        const body = asObject(req.body);
        const patch = { name: optionalString(body, "name", NAME_MAX, 1), description: nullableDescription(body) };
        assertNotEmpty(patch);
        const group = await updateGroup(db, slug, patch);
        await audit(req, "group.update", { slug });
        res.json({ group });
    });

    router.delete("/groups/:slug", async (req, res) => {
        const slug = assertSlug(req.params["slug"]);
        await deleteGroup(db, slug);
        await audit(req, "group.delete", { slug });
        res.status(204).end();
    });

    router.put("/groups/:slug/members", async (req, res) => {
        const slug = assertSlug(req.params["slug"]);
        const body = asObject(req.body);
        const members = body["members"];
        if (!Array.isArray(members) || members.length > 1000) {
            throw badRequest("members doit être un tableau de slugs d'agents (1000 au plus).");
        }
        const group = await setGroupMembers(db, slug, members.map((member) => assertSlug(member, "members[]")));
        await audit(req, "group.members.set", { slug, members: group.members });
        res.json({ group });
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
        const viewer = await updateViewer(db, id, patch);
        await audit(req, "viewer.update", { id, ...patch });
        res.json({ viewer });
    });

    router.post("/viewers/:id/activate", async (req, res) => {
        const id = String(req.params["id"]);
        const name = requiredString(asObject(req.body), "name", NAME_MAX);
        const viewer = await activateViewer(db, id, name);
        await audit(req, "viewer.activate", { id, name });
        res.json({ viewer });
    });

    router.post("/viewers/:id/revoke", async (req, res) => {
        const id = String(req.params["id"]);
        const viewer = await revokeViewer(db, id);
        await audit(req, "viewer.revoke", { id });
        res.json({ viewer });
    });

    //#endregion

    return router;
}
