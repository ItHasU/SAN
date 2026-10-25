import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { insertEvent } from "./san/events";
import { newClipId } from "./san/ids";
import { createTestApp, TestApp } from "./test/app.fixture";
import { activeDevice, addRule, CAPS, createAgent, openSse, registerDevice, resetData } from "./test/helpers";

const sha16 = (raw: string) => createHash("sha256").update(raw).digest("hex").slice(0, 16);

describe.runIf(inject("databaseAvailable"))("API /viewer", () => {
    let t: TestApp;
    let cookie: string;

    beforeAll(async () => {
        t = await createTestApp("api_viewer", { registerRatePerHour: 1000, ratePerMinute: 100_000, sseHeartbeatMs: 300 });
        cookie = await t.loginAdmin();
    });
    afterAll(async () => {
        await t.close();
    });
    beforeEach(async () => {
        await resetData(t);
        await t.db.runner.run(`TRUNCATE cursors`);
    });

    /** Curseur du (seul) viewer ; initialisé à l'activation (SPEC §9.2) */
    const viewerCursor = async () => (await t.db.runner.get<{ c: string }>(`SELECT last_acked_event_id::text AS c FROM cursors WHERE principal_type = 'viewer'`))?.c;
    const sync = (token: string, query = "") => t.api("GET", `/viewer/sync${query}`, { token });
    /** Carte active en mode manual (forcé par PATCH admin), règle `*`, capacités envoyées, abonnée à tout */
    async function readyCard(pattern = "*") {
        const device = await activeDevice(t, cookie, "Carte test", "manual");
        await addRule(t, cookie, device.viewer_id, pattern);
        const caps = await t.api("PUT", "/viewer/capabilities", { token: device.token, raw: JSON.stringify(CAPS) });
        const config = await t.api("GET", "/viewer/config", { token: device.token });
        await t.api("PUT", "/viewer/config", {
            token: device.token,
            body: { base_hash: config.json.config_hash, subscriptions: config.json.config.agents.map((a: any) => ({ agent: a.agent, subscribed: true })) }
        });
        return { ...device, caps_hash: caps.json.caps_hash as string };
    }

    describe("parcours complet d'une carte", () => {
        it("register -> activate -> règle -> capabilities_required -> PUT capabilities -> sync -> nudge -> sync -> ack -> resync vide", async () => {
            const robot = await createAgent(t, cookie, "robot", "Robot");
            const device = await registerDevice(t);
            // pending : seules les routes d'enrôlement
            expect((await sync(device.token)).status).toBe(403);
            await t.api("POST", `/admin/viewers/${device.viewer_id}/activate`, { cookie, body: { name: "Bureau" } });
            await t.api("PATCH", `/admin/viewers/${device.viewer_id}`, { cookie, body: { subscription_mode: "manual" } });
            await addRule(t, cookie, device.viewer_id, "*");

            // première synchronisation : ack=0 (carte réinitialisée), ni config_hash ni caps_hash
            const first = await sync(device.token, "?ack=0&battery=91");
            expect(first.status).toBe(200);
            expect(first.json).toMatchObject({
                capabilities_required: true, states: [], events: [], has_more: false, next_sync_s: 60,
                config: { mode: "manual", agents: [{ agent: "robot", name: "Robot", subscribed: false, new: true, position: null, muted: false, can_send_voice: false }] }
            });
            expect(first.json.config_hash).toMatch(/^[0-9a-f]{16}$/);
            expect(new Date(first.json.server_time).getTime()).toBeGreaterThan(Date.now() - 5000);

            // la carte envoie ses capacités (corps exact haché)
            const raw = JSON.stringify(CAPS, null, 2);
            const put = await t.api("PUT", "/viewer/capabilities", { token: device.token, raw });
            expect(put.status).toBe(200);
            expect(put.json).toEqual({ caps_hash: sha16(raw) });
            const stored = await t.db.runner.get<any>(`SELECT capabilities, capabilities_hash FROM viewers WHERE id = $1`, device.viewer_id);
            expect(stored).toEqual({ capabilities: CAPS, capabilities_hash: sha16(raw) });

            // ouvre le menu et s'abonne
            const menu = await t.api("GET", "/viewer/config", { token: device.token });
            expect(menu.json.config.agents[0]).toMatchObject({ agent: "robot", new: true, subscribed: false });
            const subscribed = await t.api("PUT", "/viewer/config", { token: device.token, body: { base_hash: menu.json.config_hash, subscriptions: [{ agent: "robot", subscribed: true, position: 0, muted: false }] } });
            expect(subscribed.status).toBe(200);
            expect(subscribed.json.config.agents[0]).toMatchObject({ subscribed: true, new: false, position: 0 });

            // synchronisation à jour : plus de capabilities_required, config absente si le hash correspond
            const q = `?ack=0&config_hash=${subscribed.json.config_hash}&caps_hash=${sha16(raw)}&battery=90`;
            const second = await sync(device.token, q);
            expect(second.json).toMatchObject({ capabilities_required: false, config: null, config_hash: subscribed.json.config_hash, events: [] });

            // l'agent publie un état et un nudge
            await t.api("POST", "/agent/state", { token: robot.token, body: { status: "working", detail: "Compilation du firmware en cours", progress: 40, ttl_s: 900 } });
            const nudge = await t.api("POST", "/agent/nudge", { token: robot.token, body: { text: "Échec des tests", priority: "high" } });
            const third = await sync(device.token, q);
            expect(third.json.states).toEqual([{
                agent: "robot", name: "Robot", status: "working", detail: "Compilation du firmware en cours".slice(0, 80), progress: 40, stale: false, voice_pending: 0, voice_pending_clips: [],
                updated_at: expect.any(String)
            }]);
            expect(third.json.events).toEqual([{ id: nudge.json.id, agent: "robot", kind: "nudge", priority: "high", type: "notification", text: "Échec des tests", created_at: expect.any(String) }]);

            // un nudge typé est renvoyé avec sa clé `type`
            const typed = await t.api("POST", "/agent/nudge", { token: robot.token, body: { text: "Terminé", type: "done" } });
            const fourth = await sync(device.token, q);
            expect(fourth.json.events.find((e: any) => e.id === typed.json.id)).toMatchObject({ kind: "nudge", type: "done", priority: "normal" });

            // non acquitté : renvoyé ; acquitté : vide
            expect((await sync(device.token, q)).json.events).toHaveLength(2);
            const acked = await sync(device.token, `?ack=${typed.json.id}&config_hash=${subscribed.json.config_hash}&caps_hash=${sha16(raw)}`);
            expect(acked.json.events).toEqual([]);
            expect((await sync(device.token, `?ack=0&config_hash=${subscribed.json.config_hash}`)).json.events).toEqual([]);

            const viewer = await t.api("GET", `/admin/viewers/${device.viewer_id}`, { cookie });
            expect(viewer.json.viewer).toMatchObject({ battery_pct: 90, last_seen_at: expect.any(String), next_wake_at: expect.any(String) });
        });

        it("401 sans jeton, 403 pour un agent, 400 sur des paramètres invalides", async () => {
            const robot = await createAgent(t, cookie, "robot");
            const card = await readyCard();
            expect((await t.api("GET", "/viewer/sync")).status).toBe(401);
            expect((await sync(robot.token)).status).toBe(403);
            expect((await t.api("GET", "/agent/inbox", { token: card.token })).status).toBe(403);
            for (const query of ["?ack=-1", "?ack=abc", "?battery=101", "?battery=x", "?config_hash=%20%20", "?caps_hash=a;b"]) {
                expect((await sync(card.token, query)).status, query).toBe(400);
            }
            // un viewer révoqué reçoit 401
            await t.api("POST", `/admin/viewers/${card.viewer_id}/revoke`, { cookie });
            expect((await sync(card.token)).status).toBe(401);
        });
    });

    describe("POST /viewer/ack", () => {
        it("avance le curseur sans reculer et valide le corps", async () => {
            const robot = await createAgent(t, cookie, "robot");
            const card = await readyCard();
            const ids: number[] = [];
            for (let i = 0; i < 3; i++) {
                ids.push((await t.api("POST", "/agent/nudge", { token: robot.token, body: { text: `n${i}` } })).json.id);
            }
            expect((await t.api("POST", "/viewer/ack", { token: card.token, body: { up_to: ids[1] } })).json).toEqual({ ack: ids[1] });
            expect((await t.api("POST", "/viewer/ack", { token: card.token, body: { up_to: ids[0] } })).json).toEqual({ ack: ids[1] });
            expect((await sync(card.token)).json.events.map((e: any) => e.text)).toEqual(["n2"]);
            for (const body of [{}, { up_to: -1 }, { up_to: "3" }, { up_to: 1.5 }]) {
                expect((await t.api("POST", "/viewer/ack", { token: card.token, body })).status).toBe(400);
            }
        });
    });

    describe("PUT /viewer/capabilities", () => {
        it("hache le corps brut (espaces compris) et stocke JSON et hash", async () => {
            const card = await readyCard();
            const compact = JSON.stringify(CAPS);
            const spaced = `  ${JSON.stringify(CAPS, null, 4)}\n`;
            const a = await t.api("PUT", "/viewer/capabilities", { token: card.token, raw: compact });
            const b = await t.api("PUT", "/viewer/capabilities", { token: card.token, raw: spaced });
            expect(a.json.caps_hash).toBe(sha16(compact));
            expect(b.json.caps_hash).toBe(sha16(spaced));
            expect(a.json.caps_hash).not.toBe(b.json.caps_hash);
            const row = await t.db.runner.get<any>(`SELECT capabilities_hash FROM viewers WHERE id = $1`, card.viewer_id);
            expect(row!.capabilities_hash).toBe(b.json.caps_hash);
        });

        it("répond 426 pour une autre version de protocole, 400 pour un document invalide", async () => {
            const card = await readyCard();
            const put = (raw: string) => t.api("PUT", "/viewer/capabilities", { token: card.token, raw });
            expect((await put(JSON.stringify({ ...CAPS, protocol_version: 2 }))).status).toBe(426);
            expect((await put(JSON.stringify({ firmware: "x" }))).status).toBe(400);
            expect((await put("[1]")).status).toBe(400);
            expect((await put("{pas du json")).status).toBe(400);
            expect((await t.api("PUT", "/viewer/capabilities", { token: card.token })).status).toBe(400);
            // rien n'a été remplacé par les refus
            expect((await t.db.runner.get<any>(`SELECT capabilities FROM viewers WHERE id = $1`, card.viewer_id))!.capabilities).toEqual(CAPS);
        });

        it("un changement de capacités change la configuration effective (can_send_voice dépend de audio_in)", async () => {
            await createAgent(t, cookie, "robot");
            const device = await activeDevice(t, cookie);
            await addRule(t, cookie, device.viewer_id, "*", "agent", true);
            const before = await t.api("GET", "/viewer/config", { token: device.token });
            expect(before.json.config.agents[0].can_send_voice).toBe(false);
            const withMic = { ...CAPS, audio_in: { formats: ["pcm_s16le"], sample_rate: 16000, max_duration_s: 10 } };
            await t.api("PUT", "/viewer/capabilities", { token: device.token, raw: JSON.stringify(withMic) });
            const after = await t.api("GET", "/viewer/config", { token: device.token });
            expect(after.json.config.agents[0].can_send_voice).toBe(true);
            expect(after.json.config_hash).not.toBe(before.json.config_hash);
        });
    });

    describe("GET/PUT /viewer/config", () => {
        it("PUT : 409 avec la configuration courante quand le base_hash est périmé", async () => {
            await createAgent(t, cookie, "a1");
            const card = await readyCard();
            const stale = (await t.api("GET", "/viewer/config", { token: card.token })).json.config_hash;
            await createAgent(t, cookie, "a2");
            const conflict = await t.api("PUT", "/viewer/config", { token: card.token, body: { base_hash: stale, subscriptions: [{ agent: "a1", subscribed: false }] } });
            expect(conflict.status).toBe(409);
            expect(conflict.json).toMatchObject({ error: "config_conflict", config: { mode: "manual" } });
            expect(conflict.json.config.agents.map((a: any) => a.agent)).toEqual(["a1", "a2"]);
            expect(conflict.json.config_hash).toMatch(/^[0-9a-f]{16}$/);
            expect(conflict.json.config_hash).not.toBe(stale);
            // rien n'a été appliqué ; la configuration adoptée permet de réessayer
            expect((await t.db.runner.get<any>(`SELECT subscribed FROM subscriptions WHERE agent_slug = 'a1'`))!.subscribed).toBe(true);
            const retry = await t.api("PUT", "/viewer/config", { token: card.token, body: { base_hash: conflict.json.config_hash, subscriptions: [{ agent: "a1", subscribed: false }] } });
            expect(retry.status).toBe(200);
            expect(retry.json.config.agents.find((a: any) => a.agent === "a1").subscribed).toBe(false);
        });

        it("PUT : rejette les agents non visibles (403) et les corps invalides (400) sans rien écrire", async () => {
            await createAgent(t, cookie, "visible");
            await createAgent(t, cookie, "cache");
            const card = await readyCard("visible");
            const hash = (await t.api("GET", "/viewer/config", { token: card.token })).json.config_hash;
            const put = (body: unknown) => t.api("PUT", "/viewer/config", { token: card.token, body });
            const forbidden = await put({ base_hash: hash, subscriptions: [{ agent: "visible", muted: true }, { agent: "cache", subscribed: true }] });
            expect(forbidden.status).toBe(403);
            expect(forbidden.json.error).toBe("agent_not_visible");
            expect((await put({ base_hash: hash, subscriptions: [{ agent: "inconnu" }] })).status).toBe(403);
            expect((await put({ subscriptions: [] })).status).toBe(400);
            expect((await put({ base_hash: hash })).status).toBe(400);
            expect((await put({ base_hash: hash, subscriptions: [{ agent: "visible", position: "x" }] })).status).toBe(400);
            expect((await t.db.runner.get<any>(`SELECT muted FROM subscriptions WHERE agent_slug = 'visible'`))!.muted).toBe(false);
        });

        it("GET en manual crée les lignes subscribed=false, avec les marqueurs new de cette consultation", async () => {
            await createAgent(t, cookie, "a1");
            await createAgent(t, cookie, "a2");
            const device = await activeDevice(t, cookie, "Carte test", "manual");
            await addRule(t, cookie, device.viewer_id, "*");
            const first = await t.api("GET", "/viewer/config", { token: device.token });
            expect(first.json.config.agents.map((a: any) => [a.agent, a.new, a.subscribed])).toEqual([["a1", true, false], ["a2", true, false]]);
            expect(await t.db.runner.all(`SELECT * FROM subscriptions WHERE subscribed = false`)).toHaveLength(2);
            const second = await t.api("GET", "/viewer/config", { token: device.token });
            expect(second.json.config.agents.every((a: any) => !a.new)).toBe(true);
            expect(second.json.config_hash).toBe(first.json.config_hash);
            // un agent apparu ensuite est le seul nouveau
            await createAgent(t, cookie, "a3");
            const third = await t.api("GET", "/viewer/config", { token: device.token });
            expect(third.json.config.agents.filter((a: any) => a.new).map((a: any) => a.agent)).toEqual(["a3"]);
        });

        it("auto : subscribed vaut toujours true et le PUT ne règle que position et muted", async () => {
            await createAgent(t, cookie, "a1");
            await createAgent(t, cookie, "a2");
            const device = await activeDevice(t, cookie);
            await addRule(t, cookie, device.viewer_id, "*");
            const config = await t.api("GET", "/viewer/config", { token: device.token });
            expect(config.json.config.mode).toBe("auto");
            expect(config.json.config.agents.every((a: any) => a.subscribed && !a.new)).toBe(true);
            expect(await t.db.runner.all(`SELECT * FROM subscriptions`)).toHaveLength(0);
            const put = await t.api("PUT", "/viewer/config", { token: device.token, body: { base_hash: config.json.config_hash, subscriptions: [{ agent: "a2", subscribed: false, position: 0, muted: true }] } });
            expect(put.json.config.agents.map((a: any) => [a.agent, a.subscribed, a.position, a.muted])).toEqual([["a2", true, 0, true], ["a1", true, null, false]]);
        });

        it("une carte nouvellement activée est en auto : elle voit tous les agents visibles sans abonnement, et un nouvel agent apparaît sans action de sa part", async () => {
            await createAgent(t, cookie, "a1");
            await createAgent(t, cookie, "a2");
            await createAgent(t, cookie, "cache");
            const device = await activeDevice(t, cookie);
            await addRule(t, cookie, device.viewer_id, "a?");
            const first = await t.api("GET", "/viewer/config", { token: device.token });
            expect(first.json.config.mode).toBe("auto");
            expect(first.json.config.agents.map((a: any) => [a.agent, a.subscribed, a.new])).toEqual([["a1", true, false], ["a2", true, false]]);
            expect(await t.db.runner.all(`SELECT * FROM subscriptions`)).toHaveLength(0);
            // un agent visible créé ensuite est suivi à la synchronisation suivante, sans PUT de la carte
            await createAgent(t, cookie, "a3");
            const next = await sync(device.token, `?config_hash=${first.json.config_hash}`);
            expect(next.json.config.agents.map((a: any) => [a.agent, a.subscribed])).toEqual([["a1", true], ["a2", true], ["a3", true]]);
            expect(next.json.config_hash).not.toBe(first.json.config_hash);
            expect(await t.db.runner.all(`SELECT * FROM subscriptions`)).toHaveLength(0);
        });

        it("le passage manual -> auto conserve les lignes ; les changements admin changent le hash vu par sync", async () => {
            await createAgent(t, cookie, "a1");
            const card = await readyCard();
            const hash0 = (await sync(card.token)).json.config_hash;
            await t.api("PATCH", `/admin/viewers/${card.viewer_id}`, { cookie, body: { subscription_mode: "auto" } });
            expect(await t.db.runner.all(`SELECT * FROM subscriptions`)).toHaveLength(1);
            const auto = await sync(card.token, `?config_hash=${hash0}`);
            expect(auto.json.config).toMatchObject({ mode: "auto" });
            expect(auto.json.config_hash).not.toBe(hash0);
        });
    });

    describe("filtrage à la lecture via l'API", () => {
        it("retire les événements d'un agent désabonné ou dont le droit est retiré, livre les muets avec muted", async () => {
            const a1 = await createAgent(t, cookie, "a1");
            const a2 = await createAgent(t, cookie, "a2");
            const card = await readyCard();
            const ruleId = (await t.api("GET", `/admin/viewers/${card.viewer_id}/rules`, { cookie })).json.rules[0].id;
            await t.api("POST", "/agent/nudge", { token: a1.token, body: { text: "de a1" } });
            await t.api("POST", "/agent/nudge", { token: a2.token, body: { text: "de a2" } });
            expect((await sync(card.token)).json.events.map((e: any) => e.text)).toEqual(["de a1", "de a2"]);

            await t.api("PUT", `/admin/viewers/${card.viewer_id}/subscriptions`, { cookie, body: { subscriptions: [{ agent: "a1", muted: true }, { agent: "a2", subscribed: false }] } });
            const muted = await sync(card.token);
            expect(muted.json.events).toEqual([expect.objectContaining({ text: "de a1", muted: true })]);

            await t.api("PATCH", `/admin/rules/${ruleId}`, { cookie, body: { pattern: "a2" } });
            expect((await sync(card.token)).json.events).toEqual([]);
            // le droit revient : l'abonnement (désabonné de a2) est restauré tel quel
            await t.api("PATCH", `/admin/rules/${ruleId}`, { cookie, body: { pattern: "*" } });
            expect((await sync(card.token)).json.events.map((e: any) => e.text)).toEqual(["de a1"]);
        });
    });

    describe("administration : permissions, impact, abonnements", () => {
        it("CRUD des règles, validation du motif et de la portée", async () => {
            const device = await activeDevice(t, cookie);
            const base = `/admin/viewers/${device.viewer_id}/rules`;
            const created = await t.api("POST", base, { cookie, body: { scope: "group", pattern: "perso-*", can_send_voice: true } });
            expect(created.status).toBe(201);
            expect(created.json.rule).toEqual({ id: expect.any(Number), viewer_id: device.viewer_id, scope: "group", pattern: "perso-*", can_send_voice: true });
            expect(created.json.impact).toEqual({ gained: [], lost: [] });
            const id = created.json.rule.id;

            for (const body of [{ scope: "agent", pattern: "a b" }, { scope: "agent", pattern: "a%" }, { scope: "agent", pattern: "A" }, { scope: "agent", pattern: "" },
                { scope: "agent" }, { scope: "autre", pattern: "a" }, { pattern: "a" }, { scope: "agent", pattern: "x".repeat(129) }, { scope: "agent", pattern: "a", can_send_voice: "oui" }]) {
                expect((await t.api("POST", base, { cookie, body })).status, JSON.stringify(body)).toBe(400);
            }
            expect((await t.api("POST", "/admin/viewers/v_inconnu/rules", { cookie, body: { scope: "agent", pattern: "a" } })).status).toBe(404);

            expect((await t.api("GET", base, { cookie })).json.rules).toHaveLength(1);
            const patched = await t.api("PATCH", `/admin/rules/${id}`, { cookie, body: { scope: "agent", pattern: "x?" , can_send_voice: false } });
            expect(patched.json.rule).toMatchObject({ scope: "agent", pattern: "x?", can_send_voice: false });
            expect((await t.api("PATCH", `/admin/rules/${id}`, { cookie, body: {} })).status).toBe(400);
            expect((await t.api("PATCH", `/admin/rules/${id}`, { cookie, body: { pattern: "a'; --" } })).status).toBe(400);
            expect((await t.api("PATCH", "/admin/rules/999999", { cookie, body: { can_send_voice: true } })).status).toBe(404);
            expect((await t.api("PATCH", "/admin/rules/abc", { cookie, body: { can_send_voice: true } })).status).toBe(400);

            const deleted = await t.api("DELETE", `/admin/rules/${id}`, { cookie });
            expect(deleted.status).toBe(200);
            expect(deleted.json).toMatchObject({ deleted: true, rule: { id } });
            expect((await t.api("DELETE", `/admin/rules/${id}`, { cookie })).status).toBe(404);
        });

        it("coverage et access : agents couverts, révoqués exclus, règles accordant l'accès", async () => {
            const device = await activeDevice(t, cookie);
            for (const slug of ["travail/ci/lint", "travail/ci/build", "veille", "vieux"]) {
                await createAgent(t, cookie, slug);
            }
            await t.api("POST", "/admin/groups", { cookie, body: { slug: "travail/ci", name: "CI" } });
            await t.api("PUT", "/admin/groups/travail%2Fci/members", { cookie, body: { members: ["travail/ci/lint"] } });
            await t.api("DELETE", "/admin/agents/vieux", { cookie });
            const wild = await addRule(t, cookie, device.viewer_id, "*");
            const group = await addRule(t, cookie, device.viewer_id, "travail/*", "group", true);

            const coverage = await t.api("GET", `/admin/rules/${wild.id}/coverage`, { cookie });
            expect(coverage.json.agents.map((a: any) => a.slug)).toEqual(["travail/ci/build", "travail/ci/lint", "veille"]);
            const groupCoverage = await t.api("GET", `/admin/rules/${group.id}/coverage`, { cookie });
            expect(groupCoverage.json.agents.map((a: any) => a.slug)).toEqual(["travail/ci/lint"]);
            expect(groupCoverage.json.groups.map((g: any) => g.slug)).toEqual(["travail/ci"]);
            expect((await t.api("GET", "/admin/rules/424242/coverage", { cookie })).status).toBe(404);

            const access = await t.api("GET", `/admin/viewers/${device.viewer_id}/access/travail%2Fci%2Flint`, { cookie });
            expect(access.json).toMatchObject({ access: true, rule_can_send_voice: true, audio_in: false, can_send_voice: false });
            expect(access.json.rules.map((r: any) => [r.id, r.via_groups])).toEqual([[wild.id, []], [group.id, ["travail/ci"]]]);
            expect((await t.api("GET", `/admin/viewers/${device.viewer_id}/access/vieux`, { cookie })).json).toMatchObject({ access: false, agent_revoked: true });
            expect((await t.api("GET", `/admin/viewers/${device.viewer_id}/access/inconnu`, { cookie })).status).toBe(404);
        });

        it("dry_run sur toutes les routes qui modifient la couverture : aperçu fidèle, rien de modifié", async () => {
            const v1 = await activeDevice(t, cookie, "Carte 1");
            const v2 = await activeDevice(t, cookie, "Carte 2");
            const pending = await registerDevice(t);
            await createAgent(t, cookie, "a1", "A1");
            await createAgent(t, cookie, "a2", "A2");
            await t.api("POST", "/admin/groups", { cookie, body: { slug: "g", name: "G" } });
            const r1 = await addRule(t, cookie, v1.viewer_id, "a?");
            await addRule(t, cookie, v2.viewer_id, "g", "group");
            await addRule(t, cookie, pending.viewer_id, "*");

            const snapshot = async () => JSON.stringify(await Promise.all([
                t.db.runner.all(`SELECT slug, revoked_at FROM agents ORDER BY slug`),
                t.db.runner.all(`SELECT slug FROM agent_groups ORDER BY slug`),
                t.db.runner.all(`SELECT group_slug, agent_slug FROM agent_group_members ORDER BY 1, 2`),
                t.db.runner.all(`SELECT id, viewer_id, scope, pattern, can_send_voice FROM permission_rules ORDER BY id`),
                t.db.runner.all(`SELECT id, status, name, subscription_mode FROM viewers ORDER BY id`),
                t.db.runner.all(`SELECT * FROM subscriptions`)
            ]));
            const before = await snapshot();
            const pair = (viewer: string, agent: string) => expect.objectContaining({ viewer, agent });
            const dry = async (method: string, path: string, body?: unknown) => {
                const response = await t.api(method, `${path}${path.includes("?") ? "&" : "?"}dry_run=1`, { cookie, body });
                expect(response.status, `${method} ${path}`).toBe(200);
                expect(response.json.dry_run).toBe(true);
                return response.json as { gained: any[], lost: any[] };
            };

            // règle : création / modification / suppression
            expect((await dry("POST", `/admin/viewers/${v2.viewer_id}/rules`, { scope: "agent", pattern: "a1" })).gained).toEqual([expect.objectContaining({ viewer: v2.viewer_id, viewer_name: "Carte 2", agent: "a1" })]);
            expect((await dry("PATCH", `/admin/rules/${r1.id}`, { pattern: "a1" })).lost).toEqual([pair(v1.viewer_id, "a2")]);
            expect((await dry("DELETE", `/admin/rules/${r1.id}`)).lost).toEqual([pair(v1.viewer_id, "a1"), pair(v1.viewer_id, "a2")]);
            // agent : création (les wildcards en profitent), révocation, suppression
            expect((await dry("POST", "/admin/agents", { slug: "a3", name: "A3" })).gained).toEqual([pair(v1.viewer_id, "a3")]);
            expect((await dry("PATCH", "/admin/agents/a1", { revoked: true })).lost).toEqual([pair(v1.viewer_id, "a1")]);
            expect((await dry("DELETE", "/admin/agents/a1")).lost).toEqual([pair(v1.viewer_id, "a1")]);
            expect((await dry("DELETE", "/admin/agents/a1?purge=true")).lost).toEqual([pair(v1.viewer_id, "a1")]);
            // groupe : appartenance, suppression, création
            expect((await dry("PUT", "/admin/groups/g/members", { members: ["a1", "a2"] })).gained).toEqual([pair(v2.viewer_id, "a1"), pair(v2.viewer_id, "a2")]);
            expect(await dry("POST", "/admin/groups", { slug: "g2", name: "G2" })).toMatchObject({ gained: [], lost: [] });
            // viewer : activation (le pending a une règle *), révocation
            expect((await dry("POST", `/admin/viewers/${pending.viewer_id}/activate`, { name: "Neuve" })).gained).toEqual([pair(pending.viewer_id, "a1"), pair(pending.viewer_id, "a2")]);
            expect((await dry("POST", `/admin/viewers/${v1.viewer_id}/revoke`)).lost).toEqual([pair(v1.viewer_id, "a1"), pair(v1.viewer_id, "a2")]);
            expect((await dry("PUT", `/admin/viewers/${v1.viewer_id}/subscriptions`, { subscriptions: [{ agent: "a1", subscribed: true }] }))).toMatchObject({ gained: [], lost: [] });
            expect((await dry("POST", "/admin/agents/a1/token")).gained).toEqual([]);

            expect(await snapshot()).toBe(before);
            // les erreurs restent des erreurs en dry run
            expect((await t.api("POST", "/admin/agents?dry_run=1", { cookie, body: { slug: "a1", name: "doublon" } })).status).toBe(409);
            expect((await t.api("PATCH", "/admin/agents/inconnu?dry_run=1", { cookie, body: { revoked: true } })).status).toBe(404);
        });

        it("sans dry_run, la réponse normale inclut impact {gained, lost}", async () => {
            const v1 = await activeDevice(t, cookie, "Carte 1");
            await addRule(t, cookie, v1.viewer_id, "*");
            await createAgent(t, cookie, "a1");
            const created = await t.api("POST", "/admin/agents", { cookie, body: { slug: "a2", name: "A2" } });
            expect(created.json.impact).toEqual({ gained: [{ viewer: v1.viewer_id, viewer_name: "Carte 1", agent: "a2" }], lost: [] });
            expect(created.json.token).toMatch(/^agt_/);
            const revoked = await t.api("PATCH", "/admin/agents/a1", { cookie, body: { revoked: true } });
            expect(revoked.json.impact.lost).toEqual([{ viewer: v1.viewer_id, viewer_name: "Carte 1", agent: "a1" }]);
            const regenerated = await t.api("POST", "/admin/agents/a1/token", { cookie });
            expect(regenerated.json.impact.gained).toEqual([expect.objectContaining({ agent: "a1" })]);
            const deleted = await t.api("DELETE", "/admin/agents/a2?purge=true", { cookie });
            expect(deleted.json).toEqual({ deleted: true, impact: { gained: [], lost: [expect.objectContaining({ agent: "a2" })] } });
            const revokedViewer = await t.api("POST", `/admin/viewers/${v1.viewer_id}/revoke`, { cookie });
            expect(revokedViewer.json.impact.lost).toEqual([expect.objectContaining({ agent: "a1" })]);
        });

        it("GET/PUT /admin/viewers/:id/subscriptions", async () => {
            await createAgent(t, cookie, "a1");
            await createAgent(t, cookie, "cache");
            const device = await activeDevice(t, cookie, "Carte test", "manual");
            await addRule(t, cookie, device.viewer_id, "a1");
            const get = await t.api("GET", `/admin/viewers/${device.viewer_id}/subscriptions`, { cookie });
            expect(get.json.config.agents).toEqual([expect.objectContaining({ agent: "a1", subscribed: false, new: true })]);
            expect(await t.db.runner.all(`SELECT * FROM subscriptions`)).toHaveLength(0);
            const put = await t.api("PUT", `/admin/viewers/${device.viewer_id}/subscriptions`, { cookie, body: { subscriptions: [{ agent: "a1", subscribed: true, position: 2, muted: true }] } });
            expect(put.status).toBe(200);
            expect(put.json.config.agents[0]).toMatchObject({ subscribed: true, position: 2, muted: true });
            expect(put.json.config_hash).not.toBe(get.json.config_hash);
            expect((await t.api("PUT", `/admin/viewers/${device.viewer_id}/subscriptions`, { cookie, body: { subscriptions: [{ agent: "cache", subscribed: true }] } })).status).toBe(400);
            expect((await t.api("PUT", "/admin/viewers/v_inconnu/subscriptions", { cookie, body: { subscriptions: [] } })).status).toBe(404);
            expect((await t.api("GET", "/admin/viewers/v_inconnu/subscriptions", { cookie })).status).toBe(404);
            // le hash vu par la carte suit (atteint la carte à son réveil)
            expect((await sync(device.token, `?config_hash=${get.json.config_hash}`)).json.config_hash).toBe(put.json.config_hash);
        });
    });

    describe("SSE GET /viewer/events", () => {
        it("exige un jeton de viewer ; envoie hello puis les événements en moins d'une seconde", async () => {
            const robot = await createAgent(t, cookie, "robot", "Robot");
            const card = await readyCard();
            const cursorBefore = await viewerCursor();
            expect((await openSse(t, "")).status).toBe(401);
            expect((await openSse(t, robot.token)).status).toBe(403);

            const sse = await openSse(t, card.token);
            try {
                expect(sse.status).toBe(200);
                const hello = await sse.waitFor((m) => m.event === "hello");
                const config = await t.api("GET", "/viewer/config", { token: card.token });
                expect(hello.data).toEqual({ config_hash: config.json.config_hash });

                const sent = Date.now();
                const nudge = await t.api("POST", "/agent/nudge", { token: robot.token, body: { text: "Salut", priority: "high" } });
                const received = await sse.waitFor((m) => m.event === "event", 1000);
                expect(Date.now() - sent).toBeLessThan(1000);
                expect(received.id).toBe(String(nudge.json.id));
                expect(received.data).toEqual({ id: nudge.json.id, agent: "robot", kind: "nudge", priority: "high", type: "notification", text: "Salut", created_at: expect.any(String) });

                // le même format que sync, et le curseur n'a pas bougé
                const viaSync = await sync(card.token);
                expect(viaSync.json.events[0]).toEqual(received.data);
                expect(await viewerCursor()).toBe(cursorBefore);

                // état d'un agent suivi
                await t.api("POST", "/agent/state", { token: robot.token, body: { status: "working", detail: "Calcul", progress: 10 } });
                const state = await sse.waitFor((m) => m.event === "state", 1000);
                expect(state.data).toEqual({ agent: "robot", name: "Robot", status: "working", detail: "Calcul", progress: 10, stale: false, voice_pending: 0, voice_pending_clips: [], updated_at: expect.any(String) });
            } finally {
                sse.close();
            }
        });

        it("ne diffuse que ce que le viewer suit (agents non suivis, sans droit, muets marqués)", async () => {
            const a1 = await createAgent(t, cookie, "a1");
            const a2 = await createAgent(t, cookie, "a2");
            const hidden = await createAgent(t, cookie, "cache");
            const card = await readyCard("a?");
            await t.api("PUT", `/admin/viewers/${card.viewer_id}/subscriptions`, { cookie, body: { subscriptions: [{ agent: "a2", subscribed: false }, { agent: "a1", muted: true }] } });
            const sse = await openSse(t, card.token);
            try {
                await sse.waitFor((m) => m.event === "hello");
                await t.api("POST", "/agent/nudge", { token: hidden.token, body: { text: "invisible" } });
                await t.api("POST", "/agent/state", { token: hidden.token, body: { status: "idle" } });
                await t.api("POST", "/agent/nudge", { token: a2.token, body: { text: "non suivi" } });
                await t.api("POST", "/agent/state", { token: a2.token, body: { status: "idle" } });
                await t.api("POST", "/agent/nudge", { token: a1.token, body: { text: "suivi mais muet" } });
                await sse.waitFor((m) => m.event === "event" && m.data.text === "suivi mais muet");
                expect(sse.messages.filter((m) => m.event === "event").map((m) => [m.data.text, m.data.muted])).toEqual([["suivi mais muet", true]]);
                expect(sse.messages.filter((m) => m.event === "state")).toEqual([]);
            } finally {
                sse.close();
            }
        });

        it("émet config quand la configuration change (règle, abonnement), puis l'état d'un agent nouvellement suivi", async () => {
            const robot = await createAgent(t, cookie, "robot", "Robot");
            const card = await readyCard();
            await t.api("POST", "/agent/state", { token: robot.token, body: { status: "idle" } });
            const sse = await openSse(t, card.token);
            try {
                const hello = await sse.waitFor((m) => m.event === "hello");
                await t.api("PUT", `/admin/viewers/${card.viewer_id}/subscriptions`, { cookie, body: { subscriptions: [{ agent: "robot", muted: true }] } });
                const changed = await sse.waitFor((m) => m.event === "config", 1000);
                expect(changed.data.config_hash).toMatch(/^[0-9a-f]{16}$/);
                expect(changed.data.config_hash).not.toBe(hello.data.config_hash);
                expect(changed.data.config_hash).toBe((await sync(card.token)).json.config_hash);

                // désabonné puis réabonné : le nouvel état est poussé
                await t.api("PUT", `/admin/viewers/${card.viewer_id}/subscriptions`, { cookie, body: { subscriptions: [{ agent: "robot", subscribed: false }] } });
                await sse.waitFor((m) => m.event === "config" && m.data.config_hash !== changed.data.config_hash, 1000);
                const statesBefore = sse.messages.filter((m) => m.event === "state").length;
                await t.api("PUT", `/admin/viewers/${card.viewer_id}/subscriptions`, { cookie, body: { subscriptions: [{ agent: "robot", subscribed: true }] } });
                await sse.waitFor((m) => m.event === "state" && sse.messages.filter((x) => x.event === "state").length > statesBefore, 1000);

                // nouvelle règle qui apporte un agent : config aussi
                const countConfigs = () => sse.messages.filter((m) => m.event === "config").length;
                const configs = countConfigs();
                await createAgent(t, cookie, "autre");
                await sse.waitFor(() => countConfigs() > configs, 1000);
            } finally {
                sse.close();
            }
        });

        it("reprise par Last-Event-ID : renvoie les événements manqués, sans faire avancer le curseur", async () => {
            const robot = await createAgent(t, cookie, "robot");
            const card = await readyCard();
            const cursorBefore = await viewerCursor();
            const ids: number[] = [];
            for (const text of ["un", "deux", "trois"]) {
                ids.push((await t.api("POST", "/agent/nudge", { token: robot.token, body: { text } })).json.id);
            }
            const sse = await openSse(t, card.token, { "Last-Event-ID": String(ids[0]) });
            try {
                await sse.waitFor((m) => m.event === "event" && m.data.text === "trois");
                expect(sse.messages.filter((m) => m.event === "event").map((m) => m.data.text)).toEqual(["deux", "trois"]);
                expect(sse.messages.filter((m) => m.event === "event").map((m) => m.id)).toEqual([String(ids[1]), String(ids[2])]);
                // un événement arrivé pendant l'absence puis un nouveau, dans l'ordre
                const live = await t.api("POST", "/agent/nudge", { token: robot.token, body: { text: "quatre" } });
                await sse.waitFor((m) => m.event === "event" && m.data.text === "quatre");
                expect(sse.messages.filter((m) => m.event === "event").at(-1)!.id).toBe(String(live.json.id));
            } finally {
                sse.close();
            }
            expect(await viewerCursor()).toBe(cursorBefore);

            // sans Last-Event-ID : repart du curseur acquitté
            await t.api("POST", "/viewer/ack", { token: card.token, body: { up_to: ids[1] } });
            const again = await openSse(t, card.token);
            try {
                await again.waitFor((m) => m.event === "event" && m.data.text === "quatre");
                expect(again.messages.filter((m) => m.event === "event").map((m) => m.data.text)).toEqual(["trois", "quatre"]);
            } finally {
                again.close();
            }
        });

        it("envoie un commentaire de battement régulièrement", async () => {
            const card = await readyCard();
            const sse = await openSse(t, card.token);
            try {
                await sse.waitFor((m) => m.event === ":", 2000);
            } finally {
                sse.close();
            }
        });

        it("se termine quand le viewer est révoqué", async () => {
            const card = await readyCard();
            const sse = await openSse(t, card.token);
            try {
                await sse.waitFor((m) => m.event === "hello");
                await t.api("POST", `/admin/viewers/${card.viewer_id}/revoke`, { cookie });
                await sse.waitFor(() => sse.ended, 2000);
            } finally {
                sse.close();
            }
        });
    });

    describe("GET /agent/inbox (long-poll)", () => {
        const toAgent = (slug: string, viewerId: string, text: string, clipId: string | null = null) =>
            insertEvent(t.db.runner as any, { direction: "to_agent", agentSlug: slug, fromViewerId: viewerId, kind: "voice", text, clipId, ttlS: 3600 });

        it("renvoie tout de suite ce qui est en attente, au format de la spec", async () => {
            const robot = await createAgent(t, cookie, "robot");
            const card = await activeDevice(t, cookie, "Carte bureau");
            const clipId = newClipId();
            await t.db.runner.run(`INSERT INTO voice_clips (id, source, status, duration_ms) VALUES ($1, 'viewer_upload', 'ready', 4200)`, clipId);
            const event = await toAgent("robot", card.viewer_id, "", clipId);
            const response = await t.api("GET", "/agent/inbox", { token: robot.token });
            expect(response.status).toBe(200);
            expect(response.json).toEqual({
                events: [{
                    id: event.id, kind: "voice", from: { viewer: card.viewer_id, name: "Carte bureau" }, created_at: expect.any(String), text: "",
                    clip: { id: clipId, duration_ms: 4200, url: `/api/v1/agent/voice/${clipId}` }
                }],
                has_more: false
            });
            // ack avant lecture
            const acked = await t.api("GET", `/agent/inbox?ack=${event.id}`, { token: robot.token });
            expect(acked.json).toEqual({ events: [], has_more: false });
        });

        it("attend : réveillé par une insertion en moins d'une seconde, vide à l'échéance", async () => {
            const robot = await createAgent(t, cookie, "robot");
            const other = await createAgent(t, cookie, "autre");
            const card = await activeDevice(t, cookie);
            const started = Date.now();
            const waiting = t.api("GET", "/agent/inbox?wait=30", { token: robot.token });
            await new Promise((resolve) => setTimeout(resolve, 300));
            // pour un autre agent : ne réveille pas (ou réveille et se rendort)
            await toAgent("autre", card.viewer_id, "pas pour toi");
            await new Promise((resolve) => setTimeout(resolve, 200));
            const inserted = Date.now();
            await toAgent("robot", card.viewer_id, "pour toi");
            const response = await waiting;
            expect(response.json.events.map((e: any) => e.text)).toEqual(["pour toi"]);
            expect(Date.now() - inserted).toBeLessThan(1000);
            expect(Date.now() - started).toBeLessThan(5000);
            expect((await t.api("GET", "/agent/inbox", { token: other.token })).json.events).toHaveLength(1);
        });

        it("renvoie une liste vide à l'échéance de wait, et rejette les paramètres invalides", async () => {
            const robot = await createAgent(t, cookie, "robot");
            const started = Date.now();
            const empty = await t.api("GET", "/agent/inbox?wait=1", { token: robot.token });
            expect(empty.json).toEqual({ events: [], has_more: false });
            expect(Date.now() - started).toBeGreaterThanOrEqual(900);
            for (const query of ["?wait=61", "?wait=-1", "?wait=x", "?ack=-3", "?ack=z"]) {
                expect((await t.api("GET", `/agent/inbox${query}`, { token: robot.token })).status, query).toBe(400);
            }
            expect((await t.api("GET", "/agent/inbox")).status).toBe(401);
        });
    });

    describe("vocaux en attente (pastille de la carte)", () => {
        async function voiceFor(slug: string, ttlS = 3600): Promise<string> {
            const clipId = newClipId();
            await t.db.runner.run(`INSERT INTO voice_clips (id, source, status, duration_ms) VALUES ($1, 'agent_upload', 'ready', 1000)`, clipId);
            await insertEvent(t.db.runner as any, { direction: "to_viewers", agentSlug: slug, kind: "voice", clipId, ttlS });
            return clipId;
        }
        const state = async (token: string) => (await sync(token)).json.states.find((s: any) => s.agent === "robot");

        it("voice_pending / voice_pending_clips dans les états, décrémentés par POST /viewer/voice/:clip/played (idempotent)", async () => {
            const robot = await createAgent(t, cookie, "robot");
            const card = await readyCard();
            await t.api("POST", "/agent/state", { token: robot.token, body: { status: "idle" } });
            expect(await state(card.token)).toMatchObject({ voice_pending: 0, voice_pending_clips: [] });
            const a = await voiceFor("robot");
            const b = await voiceFor("robot");
            await voiceFor("robot", 1).then(() => t.db.runner.run(`UPDATE events SET expires_at = now() - interval '1 second' WHERE id = (SELECT max(id) FROM events)`));
            expect(await state(card.token)).toMatchObject({ voice_pending: 2, voice_pending_clips: [a, b] });
            // l'acquittement du curseur ne change pas le compteur
            const last = (await sync(card.token)).json.events.at(-1).id;
            await sync(card.token, `?ack=${last}`);
            expect(await state(card.token)).toMatchObject({ voice_pending: 2 });
            for (let i = 0; i < 2; i++) {
                expect((await t.api("POST", `/viewer/voice/${a}/played`, { token: card.token })).json).toEqual({ ok: true });
            }
            expect(await state(card.token)).toMatchObject({ voice_pending: 1, voice_pending_clips: [b] });
            expect((await t.api("POST", `/viewer/voice/${newClipId()}/played`, { token: card.token })).status).toBe(404);
            expect((await t.api("POST", `/viewer/voice/nope/played`, { token: card.token })).status).toBe(404);
            expect((await t.api("POST", `/viewer/voice/${a}/played`)).status).toBe(401);
        });

        it("le compteur est propre à chaque viewer et l'événement vocal n'est purgé qu'une fois lu par la carte", async () => {
            const robot = await createAgent(t, cookie, "robot");
            const card = await readyCard();
            await t.api("POST", "/agent/state", { token: robot.token, body: { status: "idle" } });
            const clip = await voiceFor("robot");
            const nudge = await t.api("POST", "/agent/nudge", { token: robot.token, body: { text: "x" } });
            await sync(card.token, `?ack=${nudge.json.id}`);
            const { runPeriodicTasks } = await import("./san/purge");
            // le nudge est purgé, le vocal non lu reste (et reste téléchargeable)
            expect((await runPeriodicTasks(t.db.runner as any, { pendingMaxAgeDays: 7 })).deliveredEvents).toBe(1);
            expect((await t.db.runner.all(`SELECT id FROM events WHERE clip_id = $1`, clip))).toHaveLength(1);
            await t.api("POST", `/viewer/voice/${clip}/played`, { token: card.token });
            expect((await runPeriodicTasks(t.db.runner as any, { pendingMaxAgeDays: 7 })).deliveredEvents).toBe(1);
            expect(await state(card.token)).toMatchObject({ voice_pending: 0 });
        });
    });

    describe("purge via l'API de données", () => {
        it("un événement acquitté par tous les viewers actifs est purgé", async () => {
            const robot = await createAgent(t, cookie, "robot");
            const card = await readyCard();
            const nudge = await t.api("POST", "/agent/nudge", { token: robot.token, body: { text: "x" } });
            await sync(card.token, `?ack=${nudge.json.id}`);
            const { runPeriodicTasks } = await import("./san/purge");
            expect((await runPeriodicTasks(t.db.runner as any, { pendingMaxAgeDays: 7 })).deliveredEvents).toBe(1);
        });
    });
});
