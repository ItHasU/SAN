import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { runPeriodicTasks } from "./san/purge";
import { createTestApp, TestApp } from "./test/app.fixture";
import { activeDevice, addRule, CAPS, createAgent, openSse, resetData } from "./test/helpers";

const ENR_RE = /^enr_[A-Za-z0-9_-]{43}$/;
const AGT_RE = /^agt_[A-Za-z0-9_-]{43}$/;

describe.runIf(inject("databaseAvailable"))("enrôlement des agents", () => {
    let t: TestApp;
    let cookie: string;

    beforeAll(async () => {
        t = await createTestApp("api_enrollment", {
            ratePerMinute: 10_000, agentRegisterRatePerHour: 10_000, agentEnrollRatePerHour: 10_000, maxPendingAgents: 3
        });
        cookie = await t.loginAdmin();
    });
    afterAll(async () => {
        await t.close();
    });
    beforeEach(async () => {
        await resetData(t);
    });

    const createGroup = async (slug = "ci") => {
        const response = await t.api("POST", "/admin/groups", { cookie, body: { slug, name: slug } });
        expect(response.status).toBe(201);
    };
    const createToken = async (group = "ci", body: Record<string, unknown> = { label: "runner" }) => {
        const response = await t.api("POST", `/admin/groups/${group}/enrollment-tokens`, { cookie, body });
        expect(response.status).toBe(201);
        return response.json as { enrollment_token: any, token: string };
    };
    const register = (body: Record<string, unknown>, headers?: Record<string, string>) => t.api("POST", "/agent/register", { body, headers });
    const membersOf = async (slug: string) =>
        (await t.db.runner.all<{ group_slug: string }>(`SELECT group_slug FROM agent_group_members WHERE agent_slug = $1 ORDER BY 1`, slug)).map((row) => row.group_slug);

    describe("jetons d'enrôlement (admin)", () => {
        it("crée un jeton enr_ affiché une seule fois, haché en base, lié au groupe", async () => {
            await createGroup();
            const created = await createToken("ci", { label: "Runners CI" });
            expect(created.token).toMatch(ENR_RE);
            expect(created.enrollment_token).toMatchObject({ group: "ci", label: "Runners CI", state: "active", use_count: 0, expires_at: null, revoked_at: null, last_used_at: null });

            const listed = await t.api("GET", "/admin/groups/ci/enrollment-tokens", { cookie });
            expect(listed.status).toBe(200);
            expect(listed.json.tokens).toHaveLength(1);
            expect(JSON.stringify(listed.json)).not.toContain(created.token);
            expect(JSON.stringify(created.enrollment_token)).not.toContain("token_hash");

            const rows = await t.db.runner.all<any>(`SELECT * FROM agent_enrollment_tokens`);
            expect(rows).toHaveLength(1);
            expect(Buffer.isBuffer(rows[0].token_hash)).toBe(true);
            expect(rows[0].token_hash).toHaveLength(32);
            // jamais le secret, ni encodé dans aucune colonne
            const dump = JSON.stringify(rows[0]);
            expect(dump).not.toContain(created.token);
            expect(dump).not.toContain(created.token.slice(4));
            expect(rows[0].token_hash.toString("utf8")).not.toContain(created.token.slice(4));
        });

        it("autorise plusieurs jetons par groupe, valide l'entrée (400) et le groupe (404), exige la session (401)", async () => {
            await createGroup();
            const a = await createToken();
            const b = await createToken("ci", { label: "autre" });
            expect(a.token).not.toBe(b.token);
            expect((await t.api("GET", "/admin/groups/ci/enrollment-tokens", { cookie })).json.tokens).toHaveLength(2);

            const post = (body: unknown) => t.api("POST", "/admin/groups/ci/enrollment-tokens", { cookie, body });
            expect((await post({})).status).toBe(400);
            expect((await post({ label: "x".repeat(101) })).status).toBe(400);
            expect((await post({ label: "x", expires_at: "pas une date" })).status).toBe(400);
            expect((await post({ label: "x", expires_at: "2001-01-01T00:00:00Z" })).status).toBe(400);
            expect((await post({ label: "x", expires_at: 12 })).status).toBe(400);
            expect((await t.api("POST", "/admin/groups/absent/enrollment-tokens", { cookie, body: { label: "x" } })).status).toBe(404);
            expect((await t.api("GET", "/admin/groups/absent/enrollment-tokens", { cookie })).status).toBe(404);
            expect((await t.api("POST", "/admin/groups/ci/enrollment-tokens", { body: { label: "x" } })).status).toBe(401);
            expect((await t.api("GET", "/admin/groups/ci/enrollment-tokens")).status).toBe(401);
        });

        it("révoque un jeton (idempotent), 404 si inconnu ou d'un autre groupe", async () => {
            await createGroup();
            await createGroup("autre");
            const { enrollment_token } = await createToken();
            const url = `/admin/groups/ci/enrollment-tokens/${enrollment_token.id}`;
            expect((await t.api("DELETE", `/admin/groups/autre/enrollment-tokens/${enrollment_token.id}`, { cookie })).status).toBe(404);
            const revoked = await t.api("DELETE", url, { cookie });
            expect(revoked.status).toBe(200);
            expect(revoked.json.enrollment_token).toMatchObject({ id: enrollment_token.id, state: "revoked" });
            expect((await t.api("DELETE", url, { cookie })).status).toBe(200);
            expect((await t.api("DELETE", "/admin/groups/ci/enrollment-tokens/99999", { cookie })).status).toBe(404);
            expect((await t.api("DELETE", "/admin/groups/ci/enrollment-tokens/abc", { cookie })).status).toBe(400);
            expect((await t.api("GET", "/admin/groups/ci/enrollment-tokens", { cookie })).json.tokens[0].state).toBe("revoked");
        });

        it("journalise création, révocation, approbation et rejet sans jamais écrire un secret", async () => {
            await createGroup();
            const { enrollment_token, token } = await createToken();
            await t.api("DELETE", `/admin/groups/ci/enrollment-tokens/${enrollment_token.id}`, { cookie });
            const a = (await register({ slug: "a" })).json;
            const b = (await register({ slug: "b" })).json;
            await t.api("POST", "/admin/agents/a/approve", { cookie, body: { groups: ["ci"] } });
            await t.api("DELETE", "/admin/agents/b", { cookie });
            const rows = await t.db.runner.all<{ name: string, details: unknown }>(`SELECT "name", "details" FROM system_audit_log WHERE "name" LIKE 'admin.%' ORDER BY "id"`);
            const names = rows.map((row) => row.name);
            for (const expected of ["admin.group.enrollment_token.create", "admin.group.enrollment_token.revoke", "admin.agent.approve", "admin.agent.reject"]) {
                expect(names).toContain(expected);
            }
            const dump = JSON.stringify(rows);
            for (const secret of [token, token.slice(4), a.token, b.token]) {
                expect(dump).not.toContain(secret);
            }
        });

        it("supprime les jetons avec leur groupe (cascade)", async () => {
            await createGroup();
            const { token } = await createToken();
            await t.api("DELETE", "/admin/groups/ci", { cookie });
            expect((await t.db.runner.get<{ n: number }>(`SELECT count(*)::int AS n FROM agent_enrollment_tokens`))!.n).toBe(0);
            const response = await register({ slug: "x", enrollment_token: token });
            expect(response.status).toBe(401);
        });
    });

    describe("POST /agent/register avec jeton d'enrôlement", () => {
        it("crée un agent actif dans le groupe du jeton, jeton d'agent valide tout de suite", async () => {
            await createGroup();
            const { token, enrollment_token } = await createToken();
            const response = await register({ slug: "runner-1", name: "Runner 1", enrollment_token: token });
            expect(response.status).toBe(201);
            expect(response.json).toMatchObject({ slug: "runner-1", status: "active", group: "ci" });
            expect(response.json.token).toMatch(AGT_RE);
            expect(Object.keys(response.json).sort()).toEqual(["group", "slug", "status", "token"]);

            expect(await membersOf("runner-1")).toEqual(["ci"]);
            const agent = await t.api("GET", "/admin/agents/runner-1", { cookie });
            expect(agent.json.agent).toMatchObject({ name: "Runner 1", status: "active", groups: ["ci"], registered_ip: expect.any(String) });
            // le jeton d'agent fonctionne immédiatement
            expect((await t.api("POST", "/agent/state", { token: response.json.token, body: { status: "working" } })).status).toBe(200);
            expect((await t.api("GET", "/agent/status", { token: response.json.token })).json).toEqual({ slug: "runner-1", status: "active" });
            // usage comptabilisé
            const used = (await t.api("GET", "/admin/groups/ci/enrollment-tokens", { cookie })).json.tokens[0];
            expect(used).toMatchObject({ id: enrollment_token.id, use_count: 1 });
            expect(used.last_used_at).not.toBeNull();
        });

        it("le nom vaut le slug par défaut ; le slug hiérarchique est accepté", async () => {
            await createGroup();
            const { token } = await createToken();
            const response = await register({ slug: "travail/ci/runner-2", enrollment_token: token });
            expect(response.status).toBe(201);
            const agent = await t.db.runner.get<any>(`SELECT name, status FROM agents WHERE slug = 'travail/ci/runner-2'`);
            expect(agent).toMatchObject({ name: "travail/ci/runner-2", status: "active" });
        });

        it("un jeton réutilisable enrôle plusieurs agents ; chaque jeton d'agent est distinct", async () => {
            await createGroup();
            const { token } = await createToken();
            const a = await register({ slug: "a", enrollment_token: token });
            const b = await register({ slug: "b", enrollment_token: token });
            expect([a.status, b.status]).toEqual([201, 201]);
            expect(a.json.token).not.toBe(b.json.token);
            expect((await t.api("GET", "/admin/groups/ci/enrollment-tokens", { cookie })).json.tokens[0].use_count).toBe(2);
        });

        it("jeton inconnu, mal formé, d'un autre type : 401 sans création d'agent (pas de repli en pending)", async () => {
            await createGroup();
            const real = await createToken();
            const agent = await createAgent(t, cookie, "existant");
            for (const bad of ["enr_" + "a".repeat(43), "n'importe quoi", agent.token, real.token.slice(0, -1) + (real.token.endsWith("A") ? "B" : "A")]) {
                const response = await register({ slug: "nouveau", enrollment_token: bad });
                expect(response.status, bad).toBe(401);
                expect(response.json.error).toBe("invalid_enrollment_token");
                expect(JSON.stringify(response.json)).not.toContain(bad);
            }
            expect((await t.db.runner.get<{ n: number }>(`SELECT count(*)::int AS n FROM agents WHERE slug = 'nouveau'`))!.n).toBe(0);
        });

        it("jeton révoqué : 401", async () => {
            await createGroup();
            const { token, enrollment_token } = await createToken();
            await t.api("DELETE", `/admin/groups/ci/enrollment-tokens/${enrollment_token.id}`, { cookie });
            const response = await register({ slug: "x", enrollment_token: token });
            expect(response.status).toBe(401);
            expect((await t.db.runner.get<{ n: number }>(`SELECT count(*)::int AS n FROM agents`))!.n).toBe(0);
        });

        it("jeton expiré : 401 ; non encore expiré : 201", async () => {
            await createGroup();
            const { token, enrollment_token } = await createToken("ci", { label: "court", expires_at: new Date(Date.now() + 3600_000).toISOString() });
            expect(enrollment_token.expires_at).not.toBeNull();
            expect((await register({ slug: "avant", enrollment_token: token })).status).toBe(201);
            await t.db.runner.run(`UPDATE agent_enrollment_tokens SET expires_at = now() - interval '1 second'`);
            const response = await register({ slug: "apres", enrollment_token: token });
            expect(response.status).toBe(401);
            expect((await t.api("GET", "/admin/groups/ci/enrollment-tokens", { cookie })).json.tokens[0].state).toBe("expired");
        });

        it("slug déjà pris : 409, l'agent existant n'est ni modifié ni exposé, l'usage n'est pas compté", async () => {
            await createGroup();
            const { token } = await createToken();
            const first = await createAgent(t, cookie, "deja", "Déjà là");
            const response = await register({ slug: "deja", name: "Usurpateur", enrollment_token: token });
            expect(response.status).toBe(409);
            expect(response.json.error).toBe("slug_taken");
            expect(JSON.stringify(response.json)).not.toContain("agt_");
            const row = await t.db.runner.get<any>(`SELECT name, status FROM agents WHERE slug = 'deja'`);
            expect(row).toMatchObject({ name: "Déjà là", status: "active" });
            expect(await membersOf("deja")).toEqual([]);
            expect((await t.api("POST", "/agent/state", { token: first.token, body: { status: "idle" } })).status).toBe(200);
            expect((await t.api("GET", "/admin/groups/ci/enrollment-tokens", { cookie })).json.tokens[0].use_count).toBe(0);
        });

        it("slugs invalides : 400 ; corps invalides : 400", async () => {
            await createGroup();
            const { token } = await createToken();
            for (const slug of ["", "Majuscules", "a b", "a_b", "../x", "a//b", "/a", "a/", "x".repeat(129), "a;b", 12, null]) {
                const response = await register({ slug, enrollment_token: token });
                expect(response.status, String(slug)).toBe(400);
            }
            expect((await register({ enrollment_token: token })).status).toBe(400);
            expect((await register({ slug: "ok", name: "x".repeat(101), enrollment_token: token })).status).toBe(400);
            expect((await register({ slug: "ok", name: 12, enrollment_token: token })).status).toBe(400);
            expect((await register({ slug: "ok", enrollment_token: 12 })).status).toBe(400);
            expect((await register({ slug: "ok", enrollment_token: "" })).status).toBe(400);
            expect((await t.api("POST", "/agent/register", { body: [1] })).status).toBe(400);
            expect((await t.api("POST", "/agent/register", { raw: "{cassé" })).json.error).toBe("invalid_json");
            expect((await t.db.runner.get<{ n: number }>(`SELECT count(*)::int AS n FROM agents`))!.n).toBe(0);
        });

        it("limite la taille du corps (413 au-delà de 4 Ko)", async () => {
            const response = await register({ slug: "x", name: "a".repeat(5000) });
            expect(response.status).toBe(413);
        });

        it("jeton d'enrôlement null ou absent équivaut à « sans jeton »", async () => {
            const response = await register({ slug: "sans", enrollment_token: null });
            expect(response.status).toBe(201);
            expect(response.json.status).toBe("pending");
        });
    });

    describe("POST /agent/register sans jeton : agent pending", () => {
        const pendingAgent = async (slug = "demande") => {
            const response = await register({ slug, name: "Demande" });
            expect(response.status).toBe(201);
            return response.json as { slug: string, status: string, token: string };
        };

        it("crée un agent pending, sans groupe, avec son jeton", async () => {
            const result = await pendingAgent();
            expect(result).toMatchObject({ slug: "demande", status: "pending" });
            expect(result.token).toMatch(AGT_RE);
            expect(Object.keys(result).sort()).toEqual(["slug", "status", "token"]);
            expect(await membersOf("demande")).toEqual([]);
            const row = await t.db.runner.get<any>(`SELECT status, pending_since, registered_ip FROM agents WHERE slug = 'demande'`);
            expect(row.status).toBe("pending");
            expect(row.pending_since).not.toBeNull();
            expect(row.registered_ip).toBeTruthy();
            const admin = await t.api("GET", "/admin/agents?status=pending", { cookie });
            expect(admin.json.agents.map((a: any) => a.slug)).toEqual(["demande"]);
            expect((await t.api("GET", "/admin/agents?status=active", { cookie })).json.agents).toEqual([]);
            expect((await t.api("GET", "/admin/agents?status=bidon", { cookie })).status).toBe(400);
        });

        it("GET /agent/status renvoie pending ; toute autre route d'agent répond 403", async () => {
            const { token } = await pendingAgent();
            const status = await t.api("GET", "/agent/status", { token });
            expect(status.status).toBe(200);
            expect(status.json).toEqual({ slug: "demande", status: "pending" });

            const calls: Array<[string, string, unknown?]> = [
                ["POST", "/agent/state", { status: "idle" }],
                ["POST", "/agent/nudge", { text: "x" }],
                ["POST", "/agent/say", { text: "x" }],
                ["POST", "/agent/voice"],
                ["GET", "/agent/inbox"],
                ["GET", "/agent/voice/c_00000000000000000000000000"],
                ["GET", "/viewer/sync"],
                ["GET", "/device/status"],
                ["GET", "/viewer/config"]
            ];
            for (const [method, path, body] of calls) {
                const response = await t.api(method, path, { token, body });
                expect(response.status, `${method} ${path}`).toBe(403);
            }
            expect((await t.api("POST", "/agent/state", { token, body: { status: "idle" } })).json.error).toBe("agent_pending");
            expect((await t.db.runner.get<{ n: number }>(`SELECT count(*)::int AS n FROM agent_state`))!.n).toBe(0);
            expect((await t.db.runner.get<{ n: number }>(`SELECT count(*)::int AS n FROM events`))!.n).toBe(0);
        });

        it("un viewer ou un agent actif ne peut pas lire /agent/status d'un autre type (403)", async () => {
            const device = await activeDevice(t, cookie);
            expect((await t.api("GET", "/agent/status", { token: device.token })).status).toBe(403);
            const agent = await createAgent(t, cookie, "actif");
            expect((await t.api("GET", "/agent/status", { token: agent.token })).json.status).toBe("active");
            expect((await t.api("GET", "/agent/status")).status).toBe(401);
        });

        it("slug déjà pris (actif ou pending) : 409, rien n'est écrasé", async () => {
            await createAgent(t, cookie, "pris");
            const first = await pendingAgent("attente");
            for (const slug of ["pris", "attente"]) {
                const response = await register({ slug, name: "Autre" });
                expect(response.status).toBe(409);
                expect(response.json.error).toBe("slug_taken");
                expect(JSON.stringify(response.json)).not.toContain("agt_");
            }
            expect((await t.api("GET", "/agent/status", { token: first.token })).json.status).toBe("pending");
        });

        it("plafonne les agents pending (429 pending_limit) ; un enrôlement avec jeton passe toujours", async () => {
            await createGroup();
            const { token } = await createToken();
            for (const slug of ["p1", "p2", "p3"]) {
                await pendingAgent(slug);
            }
            const over = await register({ slug: "p4" });
            expect(over.status).toBe(429);
            expect(over.json.error).toBe("pending_limit");
            expect((await register({ slug: "enrole", enrollment_token: token })).status).toBe(201);
            // une approbation libère une place
            await t.api("POST", "/admin/agents/p1/approve", { cookie, body: {} });
            expect((await register({ slug: "p4" })).status).toBe(201);
        });

        it("un agent pending n'a aucun effet sur les viewers : invisible, aucune config, aucun accès", async () => {
            const device = await activeDevice(t, cookie);
            await addRule(t, cookie, device.viewer_id, "*", "agent", true);
            await addRule(t, cookie, device.viewer_id, "*", "group");
            await createAgent(t, cookie, "visible");
            const { token } = await pendingAgent("secret");
            const sync = await t.api("GET", "/viewer/sync", { token: device.token });
            expect(sync.json.config.agents.map((a: any) => a.agent)).toEqual(["visible"]);
            expect(JSON.stringify(sync.json)).not.toContain("secret");

            const access = await t.api("GET", `/admin/viewers/${device.viewer_id}/access/secret`, { cookie });
            expect(access.json.access).toBe(false);
            const rules = await t.api("GET", `/admin/viewers/${device.viewer_id}/rules`, { cookie });
            for (const rule of rules.json.rules) {
                const coverage = await t.api("GET", `/admin/rules/${rule.id}/coverage`, { cookie });
                expect(coverage.json.agents.map((a: any) => a.slug)).not.toContain("secret");
            }
            const subs = await t.api("GET", `/admin/viewers/${device.viewer_id}/subscriptions`, { cookie });
            expect(subs.json.config.agents.map((a: any) => a.agent)).toEqual(["visible"]);
            // envoi d'un vocal viewer -> agent pending refusé
            const voice = await t.api("POST", "/viewer/voice?to=secret", { token: device.token, binary: new Uint8Array([1, 2, 3]), headers: { "content-type": "audio/wav" } });
            expect([403, 404]).toContain(voice.status);
            // son jeton ne lui donne ni état ni nudge
            expect((await t.api("POST", "/agent/nudge", { token, body: {} })).status).toBe(403);
        });

        it("approbation : l'agent devient actif, le même jeton vaut pour toutes les routes, les viewers gagnent l'accès", async () => {
            const device = await activeDevice(t, cookie, "Carte");
            await addRule(t, cookie, device.viewer_id, "*", "agent");
            const { token } = await pendingAgent("secret");
            await createGroup("equipe");

            const preview = await t.api("POST", "/admin/agents/secret/approve?dry_run=1", { cookie, body: { groups: ["equipe"] } });
            expect(preview.status).toBe(200);
            expect(preview.json).toMatchObject({ dry_run: true, gained: [{ viewer: device.viewer_id, agent: "secret" }], lost: [] });
            expect((await t.api("GET", "/agent/status", { token })).json.status).toBe("pending");

            const approved = await t.api("POST", "/admin/agents/secret/approve", { cookie, body: { groups: ["equipe"] } });
            expect(approved.status).toBe(200);
            expect(approved.json.agent).toMatchObject({ slug: "secret", status: "active", groups: ["equipe"] });
            expect(approved.json.impact.gained).toEqual([{ viewer: device.viewer_id, viewer_name: "Carte", agent: "secret" }]);

            expect((await t.api("GET", "/agent/status", { token })).json.status).toBe("active");
            expect((await t.api("POST", "/agent/state", { token, body: { status: "working", detail: "ok" } })).status).toBe(200);
            const sync = await t.api("GET", "/viewer/sync", { token: device.token });
            expect(sync.json.config.agents.map((a: any) => a.agent)).toEqual(["secret"]);
            expect(sync.json.states.map((s: any) => s.agent)).toEqual(["secret"]);
            expect(await membersOf("secret")).toEqual(["equipe"]);
        });

        it("approbation : sans corps, groupes inconnus (400), agent absent (404), déjà actif (409)", async () => {
            await pendingAgent("a");
            expect((await t.api("POST", "/admin/agents/a/approve", { cookie, body: { groups: ["inconnu"] } })).status).toBe(400);
            expect((await t.api("POST", "/admin/agents/a/approve", { cookie, body: { groups: "ci" } })).status).toBe(400);
            expect((await t.api("POST", "/admin/agents/a/approve", { cookie, body: { groups: ["A B"] } })).status).toBe(400);
            // le corps est facultatif : sans groupes, l'agent est simplement approuvé
            expect((await t.api("POST", "/admin/agents/a/approve", { cookie })).status).toBe(200);
            const again = await t.api("POST", "/admin/agents/a/approve", { cookie, body: {} });
            expect(again.status).toBe(409);
            expect(again.json.error).toBe("not_pending");
            expect((await t.api("POST", "/admin/agents/absent/approve", { cookie, body: {} })).status).toBe(404);
            await createAgent(t, cookie, "admin-cree");
            expect((await t.api("POST", "/admin/agents/admin-cree/approve", { cookie, body: {} })).status).toBe(409);
            expect((await t.api("POST", "/admin/agents/a/approve", { body: {} })).status).toBe(401);
        });

        it("un échec d'approbation (groupe inconnu) laisse l'agent pending", async () => {
            const { token } = await pendingAgent("a");
            expect((await t.api("POST", "/admin/agents/a/approve", { cookie, body: { groups: ["inconnu"] } })).status).toBe(400);
            expect((await t.api("GET", "/agent/status", { token })).json.status).toBe("pending");
        });

        it("slug hiérarchique : approbation et rejet par URL encodée", async () => {
            await pendingAgent("travail/ci/a");
            await pendingAgent("travail/ci/b");
            expect((await t.api("POST", "/admin/agents/travail%2Fci%2Fa/approve", { cookie, body: {} })).json.agent).toMatchObject({ slug: "travail/ci/a", status: "active" });
            expect((await t.api("DELETE", "/admin/agents/travail%2Fci%2Fb", { cookie })).status).toBe(200);
        });

        it("rejet : la suppression supprime l'agent, son jeton reçoit 401 et son slug redevient libre", async () => {
            const { token } = await pendingAgent("rejete");
            const preview = await t.api("DELETE", "/admin/agents/rejete?dry_run=1", { cookie });
            expect(preview.status).toBe(200);
            expect(preview.json.dry_run).toBe(true);
            const response = await t.api("DELETE", "/admin/agents/rejete", { cookie });
            expect(response.status).toBe(200);
            expect(response.json.deleted).toBe(true);
            expect((await t.api("GET", "/agent/status", { token })).status).toBe(401);
            expect((await t.api("GET", "/admin/agents/rejete", { cookie })).status).toBe(404);
            expect((await register({ slug: "rejete" })).status).toBe(201);
        });

        it("révoquer un agent pending est refusé (409) : on l'approuve ou on le supprime", async () => {
            await pendingAgent("a");
            const response = await t.api("PATCH", "/admin/agents/a", { cookie, body: { revoked: true } });
            expect(response.status).toBe(409);
            expect(response.json.error).toBe("agent_pending");
        });

        it("agent approuvé puis révoqué : 401 partout, y compris /agent/status", async () => {
            const { token } = await pendingAgent("a");
            await t.api("POST", "/admin/agents/a/approve", { cookie, body: {} });
            await t.api("PATCH", "/admin/agents/a", { cookie, body: { revoked: true } });
            expect((await t.api("GET", "/agent/status", { token })).status).toBe(401);
        });
    });

    describe("purge des agents pending", () => {
        it("supprime les pending de plus de 7 jours (et eux seuls), avec leur jeton", async () => {
            const old = (await register({ slug: "vieux" })).json;
            await register({ slug: "frais" });
            await createAgent(t, cookie, "actif");
            await t.db.runner.run(`UPDATE agents SET pending_since = now() - interval '8 days' WHERE slug = 'vieux'`);
            await t.db.runner.run(`UPDATE agents SET created_at = now() - interval '30 days' WHERE slug = 'actif'`);
            const result = await runPeriodicTasks(t.db.runner, { pendingMaxAgeDays: 7 });
            expect(result.purgedPendingAgents).toBe(1);
            expect((await t.db.runner.all<{ slug: string }>(`SELECT slug FROM agents ORDER BY slug`)).map((r) => r.slug)).toEqual(["actif", "frais"]);
            expect((await t.api("GET", "/agent/status", { token: old.token })).status).toBe(401);
            expect((await runPeriodicTasks(t.db.runner, { pendingMaxAgeDays: 7 })).purgedPendingAgents).toBe(0);
        });

        it("ne purge jamais un agent approuvé, même ancien", async () => {
            await register({ slug: "a" });
            await t.db.runner.run(`UPDATE agents SET pending_since = now() - interval '30 days' WHERE slug = 'a'`);
            await t.api("POST", "/admin/agents/a/approve", { cookie, body: {} });
            expect((await runPeriodicTasks(t.db.runner, { pendingMaxAgeDays: 7 })).purgedPendingAgents).toBe(0);
        });
    });

    describe("propagation aux viewers", () => {
        it("un agent enrôlé avec jeton apparaît chez les viewers dont une règle le couvre (config + SSE), comme une création admin", async () => {
            await createGroup();
            const { token } = await createToken();
            const viewer = await activeDevice(t, cookie, "Carte");
            await addRule(t, cookie, viewer.viewer_id, "ci", "group");
            const web = await t.api("POST", "/web/register", { cookie, body: { capabilities: CAPS } });
            const sse = await openSse(t, web.json.token);
            try {
                expect(sse.status).toBe(200);
                await addRule(t, cookie, web.json.viewer_id, "*", "agent");
                const before = sse.messages.length;

                const response = await register({ slug: "runner-9", name: "Runner 9", enrollment_token: token });
                expect(response.status).toBe(201);
                await sse.waitFor((m) => sse.messages.indexOf(m) >= before && m.event === "config");

                const sync = await t.api("GET", "/viewer/sync", { token: viewer.token });
                expect(sync.json.config.agents).toEqual([expect.objectContaining({ agent: "runner-9", name: "Runner 9" })]);
                // et il publie ensuite comme n'importe quel agent
                await t.api("POST", "/agent/state", { token: response.json.token, body: { status: "working", detail: "go" } });
                const after = await t.api("GET", "/viewer/sync", { token: viewer.token });
                expect(after.json.states).toEqual([expect.objectContaining({ agent: "runner-9", status: "working", detail: "go" })]);
            } finally {
                sse.close();
            }
        });

        it("un viewer sans règle sur le groupe ne voit pas l'agent enrôlé", async () => {
            await createGroup();
            await createGroup("autre");
            const { token } = await createToken();
            const viewer = await activeDevice(t, cookie);
            await addRule(t, cookie, viewer.viewer_id, "autre", "group");
            await register({ slug: "runner-9", enrollment_token: token });
            const sync = await t.api("GET", "/viewer/sync", { token: viewer.token });
            expect(sync.json.config.agents).toEqual([]);
        });
    });

    describe("limites de débit", () => {
        it("sans jeton : 5 par heure et par IP par défaut (429 + Retry-After) ; le jeton d'enrôlement a son propre compteur", async () => {
            const limited = await createTestApp("api_enrollment_rate", { agentRegisterRatePerHour: 2, agentEnrollRatePerHour: 3, maxPendingAgents: 100, ratePerMinute: 10_000 });
            try {
                const admin = await limited.loginAdmin();
                await limited.api("POST", "/admin/groups", { cookie: admin, body: { slug: "ci", name: "ci" } });
                const { token } = (await limited.api("POST", "/admin/groups/ci/enrollment-tokens", { cookie: admin, body: { label: "x" } })).json;
                const post = (slug: string, enrollment_token?: string) => limited.api("POST", "/agent/register", { body: { slug, enrollment_token } });

                expect((await post("p1")).status).toBe(201);
                expect((await post("p2")).status).toBe(201);
                const blocked = await post("p3");
                expect(blocked.status).toBe(429);
                expect(blocked.json.error).toBe("rate_limited");
                expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
                // le compteur « avec jeton » est indépendant
                for (const slug of ["e1", "e2", "e3"]) {
                    expect((await post(slug, token)).status).toBe(201);
                }
                expect((await post("e4", token)).status).toBe(429);
                // aucun agent créé par une requête limitée
                expect((await limited.db.runner.get<{ n: number }>(`SELECT count(*)::int AS n FROM agents WHERE slug IN ('p3','e4')`))!.n).toBe(0);
            } finally {
                await limited.close();
            }
        });

        it("les valeurs par défaut sont 5/h sans jeton, 60/h avec jeton, 20 pending", async () => {
            const { DEFAULT_SAN_CONFIG, readSanConfig } = await import("./san/config");
            expect(DEFAULT_SAN_CONFIG).toMatchObject({ agentRegisterRatePerHour: 5, agentEnrollRatePerHour: 60, maxPendingAgents: 20 });
            expect(readSanConfig({ SAN_AGENT_REGISTER_RATE_PER_HOUR: "7", SAN_AGENT_ENROLL_RATE_PER_HOUR: "9", SAN_MAX_PENDING_AGENTS: "4" } as any))
                .toMatchObject({ agentRegisterRatePerHour: 7, agentEnrollRatePerHour: 9, maxPendingAgents: 4 });
            expect(() => readSanConfig({ SAN_MAX_PENDING_AGENTS: "0" } as any)).toThrow();
        });

        it("les jetons d'enrôlement invalides comptent comme des échecs d'authentification (blocage de l'IP)", async () => {
            const limited = await createTestApp("api_enrollment_authfail", { authFailuresPerMinute: 2, agentEnrollRatePerHour: 1000, ratePerMinute: 10_000 });
            try {
                const bad = "enr_" + "z".repeat(43);
                const post = () => limited.api("POST", "/agent/register", { body: { slug: "x", enrollment_token: bad } });
                expect((await post()).status).toBe(401);
                expect((await post()).status).toBe(401);
                expect((await post()).status).toBe(429);
            } finally {
                await limited.close();
            }
        });
    });

    describe("secret", () => {
        it("un jeton d'enrôlement n'authentifie aucune route, et un jeton d'agent ne sert pas d'enrôlement", async () => {
            await createGroup();
            const { token } = await createToken();
            expect((await t.api("GET", "/agent/status", { token })).status).toBe(401);
            expect((await t.api("POST", "/agent/state", { token, body: { status: "idle" } })).status).toBe(401);
            const agent = await createAgent(t, cookie, "a");
            expect((await register({ slug: "b", enrollment_token: agent.token })).status).toBe(401);
        });

        it("aucun jeton (enrôlement ou agent) en clair dans les tables, ni dans les erreurs", async () => {
            await createGroup();
            const { token } = await createToken();
            const response = await register({ slug: "a", enrollment_token: token });
            const tables = await t.db.runner.all<any>(`SELECT row_to_json(a)::text AS j FROM agents a UNION ALL SELECT row_to_json(e)::text FROM agent_enrollment_tokens e`);
            const dump = tables.map((row) => row.j).join("\n");
            expect(dump).not.toContain(token);
            expect(dump).not.toContain(token.slice(4));
            expect(dump).not.toContain(response.json.token);
            expect(dump).not.toContain(response.json.token.slice(4));
            const clash = await register({ slug: "a", enrollment_token: token });
            expect(JSON.stringify(clash.json)).not.toContain(token);
        });
    });
});
