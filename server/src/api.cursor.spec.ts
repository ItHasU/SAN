import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { createTestApp, TestApp } from "./test/app.fixture";
import { activeDevice, addRule, CAPS, createAgent, resetData } from "./test/helpers";

describe.runIf(inject("databaseAvailable"))("santé, curseur initial et début du suivi", () => {
    let t: TestApp;
    let cookie: string;
    let robot: { token: string };

    beforeAll(async () => {
        t = await createTestApp("api_cursor", { ratePerMinute: 100_000 });
        cookie = await t.loginAdmin();
    });
    afterAll(async () => {
        await t.close();
    });
    beforeEach(async () => {
        await resetData(t);
        await t.db.runner.run(`TRUNCATE cursors`);
        robot = await createAgent(t, cookie, "robot", "Robot");
    });

    const nudge = async (text: string) => (await t.api("POST", "/agent/nudge", { token: robot.token, body: { text } })).json.id as number;
    const texts = async (token: string) => ((await t.api("GET", "/viewer/sync", { token })).json.events as any[]).map((e) => e.text);
    const cursor = async (viewer: string) => (await t.db.runner.get<{ c: string }>(`SELECT last_acked_event_id::text AS c FROM cursors WHERE principal_type = 'viewer' AND principal_id = $1`, viewer))?.c;

    it("GET /health est public : 200 {ok:true} après SELECT 1", async () => {
        const response = await t.api("GET", "/health");
        expect(response.status).toBe(200);
        expect(response.json).toEqual({ ok: true });
        expect(response.headers.get("cache-control")).toBe("no-store");
    });

    it("GET /health répond 503 quand la base est injoignable", async () => {
        const other = await createTestApp("api_health_down");
        await other.app.close();
        const response = await other.api("GET", "/health");
        expect(response.status).toBe(503);
        expect(response.json).toEqual({ ok: false });
        // ferme le reste sans rejouer la fermeture du pool
        await other.db.dispose().catch(() => undefined);
    });

    it("un viewer activé reçoit l'état courant mais pas l'historique : curseur au dernier événement", async () => {
        await nudge("ancien");
        const last = await nudge("ancien 2");
        await t.api("POST", "/agent/state", { token: robot.token, body: { status: "working", detail: "En cours" } });

        const device = await activeDevice(t, cookie);
        expect(await cursor(device.viewer_id)).toBe(String(last));
        await addRule(t, cookie, device.viewer_id, "*");
        const config = await t.api("GET", "/viewer/config", { token: device.token });
        await t.api("PUT", "/viewer/config", { token: device.token, body: { base_hash: config.json.config_hash, subscriptions: [{ agent: "robot", subscribed: true }] } });
        const sync = await t.api("GET", "/viewer/sync", { token: device.token });
        expect(sync.json.events).toEqual([]);
        expect(sync.json.states).toHaveLength(1);
        expect(sync.json.states[0]).toMatchObject({ agent: "robot", status: "working" });

        await nudge("nouveau");
        expect(await texts(device.token)).toEqual(["nouveau"]);
    });

    it("un viewer web enregistré reçoit lui aussi le curseur initial", async () => {
        const last = await nudge("ancien");
        const web = await t.api("POST", "/web/register", { cookie, body: { capabilities: CAPS } });
        expect(await cursor(web.json.viewer_id)).toBe(String(last));
        await addRule(t, cookie, web.json.viewer_id, "*");
        expect(await texts(web.json.token)).toEqual([]);
        await nudge("frais");
        expect(await texts(web.json.token)).toEqual(["frais"]);
    });

    it("curseur initial à 0 quand aucun événement n'existe encore", async () => {
        const web = await t.api("POST", "/web/register", { cookie, body: { capabilities: CAPS } });
        // la séquence peut avoir avancé (autres tests) mais aucun événement n'est visible
        expect(Number(await cursor(web.json.viewer_id))).toBeGreaterThanOrEqual(0);
        await addRule(t, cookie, web.json.viewer_id, "*");
        await nudge("premier");
        expect(await texts(web.json.token)).toEqual(["premier"]);
    });

    it("auto : un agent qui devient visible plus tard (nouvelle règle) ne livre pas ses événements antérieurs", async () => {
        const web = await t.api("POST", "/web/register", { cookie, body: { capabilities: CAPS } });
        await addRule(t, cookie, web.json.viewer_id, "autre");
        await nudge("avant la règle");
        await new Promise((resolve) => setTimeout(resolve, 20));
        await addRule(t, cookie, web.json.viewer_id, "robot");
        expect(await texts(web.json.token)).toEqual([]);
        await nudge("après la règle");
        expect(await texts(web.json.token)).toEqual(["après la règle"]);
    });

    it("manual : s'abonner à un agent plus tard ne livre que les événements postérieurs à l'abonnement", async () => {
        const device = await activeDevice(t, cookie, "Carte test", "manual");
        await addRule(t, cookie, device.viewer_id, "*");
        await nudge("avant abonnement");
        await new Promise((resolve) => setTimeout(resolve, 20));
        const config = await t.api("GET", "/viewer/config", { token: device.token });
        await t.api("PUT", "/viewer/config", { token: device.token, body: { base_hash: config.json.config_hash, subscriptions: [{ agent: "robot", subscribed: true }] } });
        expect(await texts(device.token)).toEqual([]);
        await nudge("après abonnement");
        expect(await texts(device.token)).toEqual(["après abonnement"]);
    });

    it("auto → manual conserve le suivi en cours sans perdre d'événement", async () => {
        const web = await t.api("POST", "/web/register", { cookie, body: { capabilities: CAPS } });
        await addRule(t, cookie, web.json.viewer_id, "*");
        await nudge("suivi en auto");
        await t.api("PATCH", `/admin/viewers/${web.json.viewer_id}`, { cookie, body: { subscription_mode: "manual" } });
        expect(await texts(web.json.token)).toEqual(["suivi en auto"]);
    });
});
