import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { createTestApp, TestApp } from "./test/app.fixture";
import { activeDevice, createAgent, registerDevice, resetData } from "./test/helpers";

describe.runIf(inject("databaseAvailable"))("API /admin", () => {
    let t: TestApp;
    let cookie: string;

    beforeAll(async () => {
        t = await createTestApp("api_admin", { registerRatePerHour: 1000, ratePerMinute: 10_000 });
        cookie = await t.loginAdmin();
    });
    afterAll(async () => {
        await t.close();
    });
    beforeEach(async () => {
        await resetData(t);
    });

    it("exige la session Dagda sur toutes les routes d'administration (401)", async () => {
        const routes: Array<[string, string]> = [
            ["GET", "/admin/agents"], ["POST", "/admin/agents"], ["GET", "/admin/agents/x"], ["PATCH", "/admin/agents/x"],
            ["DELETE", "/admin/agents/x"], ["POST", "/admin/agents/x/token"],
            ["GET", "/admin/groups"], ["POST", "/admin/groups"], ["GET", "/admin/groups/x"], ["PATCH", "/admin/groups/x"],
            ["DELETE", "/admin/groups/x"], ["PUT", "/admin/groups/x/members"],
            ["GET", "/admin/viewers"], ["GET", "/admin/viewers/v_x"], ["PATCH", "/admin/viewers/v_x"],
            ["POST", "/admin/viewers/v_x/activate"], ["POST", "/admin/viewers/v_x/revoke"]
        ];
        for (const [method, path] of routes) {
            const response = await t.api(method, path, { body: method === "GET" || method === "DELETE" ? undefined : {} });
            expect(response.status, `${method} ${path}`).toBe(401);
        }
        // un jeton d'agent ou de viewer ne donne pas accès à l'administration
        const agent = await createAgent(t, cookie, "robot");
        expect((await t.api("GET", "/admin/agents", { token: agent.token })).status).toBe(401);
    });

    describe("agents", () => {
        it("crée un agent et n'affiche le jeton qu'une fois", async () => {
            const created = await t.api("POST", "/admin/agents", { cookie, body: { slug: "travail/ci/lint", name: "Lint", description: "Analyse statique" } });
            expect(created.status).toBe(201);
            expect(created.json.token).toMatch(/^agt_[A-Za-z0-9_-]{43}$/);
            expect(created.json.agent).toMatchObject({ slug: "travail/ci/lint", name: "Lint", description: "Analyse statique", revoked: false, groups: [], state: null });

            for (const path of ["/admin/agents/travail/ci/lint", "/admin/agents"]) {
                const read = await t.api("GET", path === "/admin/agents" ? path : "/admin/agents/travail%2Fci%2Flint", { cookie });
                expect(JSON.stringify(read.json)).not.toContain(created.json.token);
                expect(JSON.stringify(read.json)).not.toContain("token_hash");
            }
            // le jeton fonctionne
            expect((await t.api("POST", "/agent/state", { token: created.json.token, body: { status: "idle" } })).status).toBe(200);
        });

        it("refuse un slug invalide (400) ou déjà pris (409)", async () => {
            for (const slug of ["Majuscule", "a b", "a%", "a_b", "", "/a", "a//b", "x".repeat(129), 12, undefined]) {
                const response = await t.api("POST", "/admin/agents", { cookie, body: { slug, name: "n" } });
                expect(response.status, String(slug)).toBe(400);
            }
            expect((await t.api("POST", "/admin/agents", { cookie, body: { slug: "ok" } })).status).toBe(400);
            expect((await t.api("POST", "/admin/agents", { cookie, body: { slug: "ok", name: "A" } })).status).toBe(201);
            const dup = await t.api("POST", "/admin/agents", { cookie, body: { slug: "ok", name: "B" } });
            expect(dup.status).toBe(409);
            expect(dup.json.error).toBe("slug_taken");
        });

        it("liste, lit, modifie nom et description (slug immuable)", async () => {
            await createAgent(t, cookie, "b-agent", "B");
            await createAgent(t, cookie, "a-agent", "A");
            const list = await t.api("GET", "/admin/agents", { cookie });
            expect(list.json.agents.map((agent: any) => agent.slug)).toEqual(["a-agent", "b-agent"]);

            const patched = await t.api("PATCH", "/admin/agents/a-agent", { cookie, body: { name: "Nouveau nom", description: "desc", slug: "autre" } });
            expect(patched.status).toBe(200);
            expect(patched.json.agent).toMatchObject({ slug: "a-agent", name: "Nouveau nom", description: "desc" });
            const cleared = await t.api("PATCH", "/admin/agents/a-agent", { cookie, body: { description: null } });
            expect(cleared.json.agent.description).toBeNull();

            expect((await t.api("PATCH", "/admin/agents/a-agent", { cookie, body: {} })).status).toBe(400);
            expect((await t.api("PATCH", "/admin/agents/a-agent", { cookie, body: { name: "" } })).status).toBe(400);
            expect((await t.api("PATCH", "/admin/agents/inconnu", { cookie, body: { name: "x" } })).status).toBe(404);
            expect((await t.api("GET", "/admin/agents/inconnu", { cookie })).status).toBe(404);
            expect((await t.api("GET", "/admin/agents/Pas%20Valide", { cookie })).status).toBe(400);
        });

        it("régénère le jeton : l'ancien est invalidé", async () => {
            const { token: oldToken } = await createAgent(t, cookie, "regen");
            const regenerated = await t.api("POST", "/admin/agents/regen/token", { cookie });
            expect(regenerated.status).toBe(200);
            expect(regenerated.json.token).not.toBe(oldToken);
            expect((await t.api("POST", "/agent/state", { token: oldToken, body: { status: "idle" } })).status).toBe(401);
            expect((await t.api("POST", "/agent/state", { token: regenerated.json.token, body: { status: "idle" } })).status).toBe(200);
            expect((await t.api("POST", "/admin/agents/inconnu/token", { cookie })).status).toBe(404);
        });

        it("révoque via PATCH ou DELETE (401 ensuite) ; la régénération réactive ; ?purge=true supprime", async () => {
            const a = await createAgent(t, cookie, "rev-patch");
            const b = await createAgent(t, cookie, "rev-delete");

            const patch = await t.api("PATCH", "/admin/agents/rev-patch", { cookie, body: { revoked: true } });
            expect(patch.json.agent).toMatchObject({ revoked: true });
            expect(patch.json.agent.revoked_at).toBeTruthy();
            expect((await t.api("PATCH", "/admin/agents/rev-patch", { cookie, body: { revoked: false } })).status).toBe(400);

            const del = await t.api("DELETE", "/admin/agents/rev-delete", { cookie });
            expect(del.status).toBe(200);
            expect(del.json.agent.revoked).toBe(true);
            for (const agent of [a, b]) {
                expect((await t.api("POST", "/agent/state", { token: agent.token, body: { status: "idle" } })).status).toBe(401);
            }

            const reactivated = await t.api("POST", "/admin/agents/rev-patch/token", { cookie });
            expect(reactivated.json.agent.revoked).toBe(false);
            expect((await t.api("POST", "/agent/state", { token: reactivated.json.token, body: { status: "idle" } })).status).toBe(200);

            expect((await t.api("DELETE", "/admin/agents/rev-patch?purge=true", { cookie })).status).toBe(204);
            expect((await t.api("GET", "/admin/agents/rev-patch", { cookie })).status).toBe(404);
            expect((await t.api("DELETE", "/admin/agents/rev-patch?purge=true", { cookie })).status).toBe(404);
        });
    });

    describe("groupes", () => {
        it("crée, lit, modifie et supprime un groupe", async () => {
            const created = await t.api("POST", "/admin/groups", { cookie, body: { slug: "perso-maison", name: "Maison", description: "d" } });
            expect(created.status).toBe(201);
            expect(created.json.group).toEqual({ slug: "perso-maison", name: "Maison", description: "d", members: [] });
            expect((await t.api("POST", "/admin/groups", { cookie, body: { slug: "perso-maison", name: "Doublon" } })).status).toBe(409);
            expect((await t.api("POST", "/admin/groups", { cookie, body: { slug: "Bad Slug", name: "x" } })).status).toBe(400);

            const patched = await t.api("PATCH", "/admin/groups/perso-maison", { cookie, body: { name: "Maison 2" } });
            expect(patched.json.group.name).toBe("Maison 2");
            expect((await t.api("GET", "/admin/groups", { cookie })).json.groups).toHaveLength(1);
            expect((await t.api("GET", "/admin/groups/inconnu", { cookie })).status).toBe(404);

            expect((await t.api("DELETE", "/admin/groups/perso-maison", { cookie })).status).toBe(204);
            expect((await t.api("DELETE", "/admin/groups/perso-maison", { cookie })).status).toBe(404);
        });

        it("remplace les membres avec PUT /members (agents inconnus refusés, rien n'est modifié)", async () => {
            await createAgent(t, cookie, "a1");
            await createAgent(t, cookie, "a2");
            await createAgent(t, cookie, "a3");
            await t.api("POST", "/admin/groups", { cookie, body: { slug: "g", name: "G" } });

            const set = await t.api("PUT", "/admin/groups/g/members", { cookie, body: { members: ["a2", "a1", "a1"] } });
            expect(set.status).toBe(200);
            expect(set.json.group.members).toEqual(["a1", "a2"]);

            const replaced = await t.api("PUT", "/admin/groups/g/members", { cookie, body: { members: ["a3"] } });
            expect(replaced.json.group.members).toEqual(["a3"]);
            expect((await t.api("GET", "/admin/agents/a3", { cookie })).json.agent.groups).toEqual(["g"]);
            expect((await t.api("GET", "/admin/agents/a1", { cookie })).json.agent.groups).toEqual([]);

            const unknown = await t.api("PUT", "/admin/groups/g/members", { cookie, body: { members: ["a1", "fantome"] } });
            expect(unknown.status).toBe(400);
            expect(unknown.json.error).toBe("unknown_agents");
            expect((await t.api("GET", "/admin/groups/g", { cookie })).json.group.members).toEqual(["a3"]);

            expect((await t.api("PUT", "/admin/groups/g/members", { cookie, body: { members: "a1" } })).status).toBe(400);
            expect((await t.api("PUT", "/admin/groups/g/members", { cookie, body: { members: ["A 1"] } })).status).toBe(400);
            expect((await t.api("PUT", "/admin/groups/inconnu/members", { cookie, body: { members: [] } })).status).toBe(404);
            expect((await t.api("PUT", "/admin/groups/g/members", { cookie, body: { members: [] } })).json.group.members).toEqual([]);
        });

        it("supprimer un agent le retire des groupes ; supprimer un groupe garde les agents", async () => {
            await createAgent(t, cookie, "m1");
            await t.api("POST", "/admin/groups", { cookie, body: { slug: "g", name: "G" } });
            await t.api("PUT", "/admin/groups/g/members", { cookie, body: { members: ["m1"] } });
            await t.api("DELETE", "/admin/agents/m1?purge=true", { cookie });
            expect((await t.api("GET", "/admin/groups/g", { cookie })).json.group.members).toEqual([]);

            await createAgent(t, cookie, "m2");
            await t.api("PUT", "/admin/groups/g/members", { cookie, body: { members: ["m2"] } });
            await t.api("DELETE", "/admin/groups/g", { cookie });
            expect((await t.api("GET", "/admin/agents/m2", { cookie })).status).toBe(200);
        });
    });

    describe("viewers", () => {
        it("liste avec filtre ?status= et refuse un statut inconnu (400)", async () => {
            const pending = await registerDevice(t);
            const active = await activeDevice(t, cookie, "Active");
            const revoked = await activeDevice(t, cookie, "Révoquée");
            await t.api("POST", `/admin/viewers/${revoked.viewer_id}/revoke`, { cookie });

            const ids = (response: any) => response.json.viewers.map((viewer: any) => viewer.id).sort();
            expect(ids(await t.api("GET", "/admin/viewers", { cookie }))).toEqual([pending.viewer_id, active.viewer_id, revoked.viewer_id].sort());
            expect(ids(await t.api("GET", "/admin/viewers?status=pending", { cookie }))).toEqual([pending.viewer_id]);
            expect(ids(await t.api("GET", "/admin/viewers?status=active", { cookie }))).toEqual([active.viewer_id]);
            expect(ids(await t.api("GET", "/admin/viewers?status=revoked", { cookie }))).toEqual([revoked.viewer_id]);
            expect((await t.api("GET", "/admin/viewers?status=zombie", { cookie })).status).toBe(400);
            expect((await t.api("GET", "/admin/viewers?status=pending';DROP TABLE viewers;--", { cookie })).status).toBe(400);
        });

        it("montre code, modèle, matériel et IP d'une demande, sans jamais exposer le hash du jeton", async () => {
            const device = await registerDevice(t, "hw-detail");
            const detail = await t.api("GET", `/admin/viewers/${device.viewer_id}`, { cookie });
            expect(detail.status).toBe(200);
            expect(detail.json.viewer).toMatchObject({
                id: device.viewer_id, kind: "device", status: "pending", hardware_id: "hw-detail", model: "M5StickS3",
                pairing_code: device.pairing_code, subscription_mode: "manual", name: null
            });
            expect(detail.json.viewer.registered_ip).toBeTruthy();
            expect(detail.json.viewer.pending_since).toBeTruthy();
            expect(JSON.stringify(detail.json)).not.toContain("token");
            expect((await t.api("GET", "/admin/viewers/v_inconnu", { cookie })).status).toBe(404);
        });

        it("active un viewer pending avec un nom ; 409 s'il ne l'est plus ; 400 sans nom", async () => {
            const device = await registerDevice(t);
            expect((await t.api("POST", `/admin/viewers/${device.viewer_id}/activate`, { cookie, body: {} })).status).toBe(400);
            expect((await t.api("POST", `/admin/viewers/${device.viewer_id}/activate`, { cookie, body: { name: "  " } })).status).toBe(400);

            const activated = await t.api("POST", `/admin/viewers/${device.viewer_id}/activate`, { cookie, body: { name: "Carte bureau" } });
            expect(activated.status).toBe(200);
            expect(activated.json.viewer).toMatchObject({ status: "active", name: "Carte bureau", pairing_code: null });
            expect(activated.json.viewer.activated_at).toBeTruthy();

            const again = await t.api("POST", `/admin/viewers/${device.viewer_id}/activate`, { cookie, body: { name: "Autre" } });
            expect(again.status).toBe(409);
            expect(again.json.error).toBe("not_pending");
            expect((await t.api("POST", "/admin/viewers/v_inconnu/activate", { cookie, body: { name: "x" } })).status).toBe(404);
        });

        it("révoque un viewer (idempotent) ; plus aucun accès avec son jeton", async () => {
            const device = await activeDevice(t, cookie);
            const revoked = await t.api("POST", `/admin/viewers/${device.viewer_id}/revoke`, { cookie });
            expect(revoked.json.viewer).toMatchObject({ status: "revoked" });
            expect(revoked.json.viewer.revoked_at).toBeTruthy();
            const again = await t.api("POST", `/admin/viewers/${device.viewer_id}/revoke`, { cookie });
            expect(again.status).toBe(200);
            expect(again.json.viewer.revoked_at).toEqual(revoked.json.viewer.revoked_at);
            expect((await t.api("GET", "/device/status", { token: device.token })).status).toBe(401);
            expect((await t.api("POST", "/admin/viewers/v_inconnu/revoke", { cookie })).status).toBe(404);
        });

        it("révoque aussi une demande pending (son code disparaît)", async () => {
            const device = await registerDevice(t);
            const revoked = await t.api("POST", `/admin/viewers/${device.viewer_id}/revoke`, { cookie });
            expect(revoked.json.viewer).toMatchObject({ status: "revoked", pairing_code: null });
            expect((await t.api("GET", "/device/status", { token: device.token })).status).toBe(401);
        });

        it("modifie nom et mode d'abonnement avec PATCH", async () => {
            const device = await activeDevice(t, cookie, "Avant");
            const patched = await t.api("PATCH", `/admin/viewers/${device.viewer_id}`, { cookie, body: { name: "Après", subscription_mode: "auto" } });
            expect(patched.status).toBe(200);
            expect(patched.json.viewer).toMatchObject({ name: "Après", subscription_mode: "auto" });
            const nameOnly = await t.api("PATCH", `/admin/viewers/${device.viewer_id}`, { cookie, body: { name: "Encore" } });
            expect(nameOnly.json.viewer).toMatchObject({ name: "Encore", subscription_mode: "auto" });

            expect((await t.api("PATCH", `/admin/viewers/${device.viewer_id}`, { cookie, body: { subscription_mode: "wild" } })).status).toBe(400);
            expect((await t.api("PATCH", `/admin/viewers/${device.viewer_id}`, { cookie, body: { name: "" } })).status).toBe(400);
            expect((await t.api("PATCH", `/admin/viewers/${device.viewer_id}`, { cookie, body: {} })).status).toBe(400);
            expect((await t.api("PATCH", "/admin/viewers/v_inconnu", { cookie, body: { name: "x" } })).status).toBe(404);
        });

        it("applique la règle §8.1 en passant de auto à manual via PATCH", async () => {
            const device = await activeDevice(t, cookie);
            await createAgent(t, cookie, "visible-1");
            await createAgent(t, cookie, "visible-2");
            await createAgent(t, cookie, "cache");
            await t.db.runner.run(
                `INSERT INTO permission_rules (viewer_id, scope, pattern, like_pattern) VALUES ($1, 'agent', 'visible-*', 'visible-%')`, device.viewer_id
            );
            await t.api("PATCH", `/admin/viewers/${device.viewer_id}`, { cookie, body: { subscription_mode: "auto" } });
            await t.api("PATCH", `/admin/viewers/${device.viewer_id}`, { cookie, body: { subscription_mode: "manual" } });
            const rows = await t.db.runner.all<any>(`SELECT agent_slug, subscribed FROM subscriptions WHERE viewer_id = $1 ORDER BY agent_slug`, device.viewer_id);
            expect(rows).toEqual([{ agent_slug: "visible-1", subscribed: true }, { agent_slug: "visible-2", subscribed: true }]);
        });
    });

    describe("journal d'audit Dagda", () => {
        it("enregistre les actions d'administration, sans jamais y mettre un jeton", async () => {
            await t.db.runner.run(`DELETE FROM system_audit_log`);
            const created = await t.api("POST", "/admin/agents", { cookie, body: { slug: "audited", name: "A" } });
            await t.api("POST", "/admin/agents/audited/token", { cookie });
            const device = await registerDevice(t);
            await t.api("POST", `/admin/viewers/${device.viewer_id}/activate`, { cookie, body: { name: "Carte" } });
            await t.api("POST", `/admin/viewers/${device.viewer_id}/revoke`, { cookie });
            await t.api("POST", "/web/register", { cookie, body: { capabilities: { protocol_version: 1 } } });

            const rows = await t.db.runner.all<{ name: string, kind: string, userId: number, details: string }>(
                `SELECT "name", "kind", "userId", "details" FROM system_audit_log WHERE "name" LIKE 'admin.%' ORDER BY "id"`
            );
            expect(rows.map((row) => row.name)).toEqual([
                "admin.agent.create", "admin.agent.token.regenerate", "admin.viewer.activate", "admin.viewer.revoke", "admin.web.register"
            ]);
            expect(rows.every((row) => row.kind === "action" && row.userId > 0)).toBe(true);
            expect(rows.map((row) => row.details).join("")).not.toContain(created.json.token);
        });
    });
});
