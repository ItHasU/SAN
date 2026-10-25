import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { PAIRING_CODE_RE } from "./san/ids";
import { runPeriodicTasks } from "./san/purge";
import { createTestApp, TestApp } from "./test/app.fixture";
import { activeDevice, CAPS, createAgent, registerDevice, resetData } from "./test/helpers";

describe.runIf(inject("databaseAvailable"))("API /device", () => {
    let t: TestApp;
    let cookie: string;

    beforeAll(async () => {
        t = await createTestApp("api_device", { registerRatePerHour: 1000, maxPending: 3 });
        cookie = await t.loginAdmin();
    });
    afterAll(async () => {
        await t.close();
    });
    beforeEach(async () => {
        await resetData(t);
    });

    describe("POST /device/register", () => {
        it("crée un viewer pending en mode auto avec jeton et code d'appairage", async () => {
            const response = await t.api("POST", "/device/register", { body: { hardware_id: "aa:bb", model: "M5StickS3", capabilities: CAPS } });
            expect(response.status).toBe(201);
            expect(response.json.status).toBe("pending");
            expect(response.json.token).toMatch(/^dev_[A-Za-z0-9_-]{43}$/);
            expect(response.json.pairing_code).toMatch(PAIRING_CODE_RE);

            const row = await t.db.runner.get<any>(`SELECT * FROM viewers WHERE id = $1`, response.json.viewer_id);
            expect(row).toMatchObject({ kind: "device", status: "pending", subscription_mode: "auto", hardware_id: "aa:bb", model: "M5StickS3" });
            expect(row.registered_ip).toBeTruthy();
            expect(row.capabilities.protocol_version).toBe(1);
            // seul le hash est stocké
            expect(Buffer.isBuffer(row.token_hash)).toBe(true);
            expect(row.token_hash.toString("hex")).not.toContain(response.json.token);
        });

        it("refuse les corps invalides (400) et les protocoles inconnus (426)", async () => {
            const post = (body: unknown) => t.api("POST", "/device/register", { body });
            expect((await post({ model: "x", capabilities: CAPS })).status).toBe(400);
            expect((await post({ hardware_id: "x", capabilities: CAPS })).status).toBe(400);
            expect((await post({ hardware_id: "x", model: "x" })).status).toBe(400);
            expect((await post({ hardware_id: "x", model: "x", capabilities: { firmware: "1" } })).status).toBe(400);
            expect((await post({ hardware_id: "x".repeat(200), model: "x", capabilities: CAPS })).status).toBe(400);
            expect((await post([1, 2])).status).toBe(400);
            const old = await post({ hardware_id: "x", model: "x", capabilities: { ...CAPS, protocol_version: 2 } });
            expect(old.status).toBe(426);
            expect(old.json.error).toBe("unsupported_protocol_version");
            const broken = await t.api("POST", "/device/register", { raw: "{pas du json" });
            expect(broken.status).toBe(400);
            expect(broken.json.error).toBe("invalid_json");
            // sans Content-Type JSON, le corps n'est pas lu
            const noType = await t.api("POST", "/device/register", { raw: "hardware_id=x", headers: { "content-type": "text/plain" } });
            expect(noType.status).toBe(400);
        });

        it("répond 413 au-delà de 64 Ko, même sans authentification", async () => {
            const big = { hardware_id: "x", model: "x", capabilities: { ...CAPS, pad: "a".repeat(70 * 1024) } };
            const response = await t.api("POST", "/device/register", { body: big });
            expect(response.status).toBe(413);
            expect(response.json.error).toBe("payload_too_large");
        });

        it("remplace une demande pending de même hardware_id (nouveau jeton, nouveau code)", async () => {
            const first = await registerDevice(t, "hw-same");
            const second = await registerDevice(t, "hw-same");
            expect(second.viewer_id).not.toBe(first.viewer_id);
            expect(second.token).not.toBe(first.token);

            expect((await t.api("GET", "/device/status", { token: first.token })).status).toBe(401);
            expect((await t.api("GET", "/device/status", { token: second.token })).json).toEqual({ status: "pending" });
            const count = await t.db.runner.get<{ n: number }>(`SELECT count(*)::int AS n FROM viewers WHERE hardware_id = 'hw-same'`);
            expect(count!.n).toBe(1);
        });

        it("ne touche pas un viewer actif de même hardware_id : une nouvelle demande s'ajoute", async () => {
            const first = await registerDevice(t, "hw-active");
            await t.api("POST", `/admin/viewers/${first.viewer_id}/activate`, { cookie, body: { name: "Bureau" } });
            const again = await registerDevice(t, "hw-active");

            expect((await t.api("GET", "/device/status", { token: first.token })).json).toEqual({ status: "active" });
            expect((await t.api("GET", "/device/status", { token: again.token })).json).toEqual({ status: "pending" });
        });

        it("plafonne le nombre de demandes en attente (429 pending_limit), sauf remplacement", async () => {
            await registerDevice(t, "hw-1");
            await registerDevice(t, "hw-2");
            await registerDevice(t, "hw-3");
            const over = await t.api("POST", "/device/register", { body: { hardware_id: "hw-4", model: "m", capabilities: CAPS } });
            expect(over.status).toBe(429);
            expect(over.json.error).toBe("pending_limit");
            // un remplacement ne change pas le total : accepté
            expect((await t.api("POST", "/device/register", { body: { hardware_id: "hw-2", model: "m", capabilities: CAPS } })).status).toBe(201);
            const count = await t.db.runner.get<{ n: number }>(`SELECT count(*)::int AS n FROM viewers WHERE status = 'pending'`);
            expect(count!.n).toBe(3);
        });

        it("garde des codes d'appairage distincts entre pending", async () => {
            const codes = new Set<string>();
            for (const hw of ["a", "b", "c"]) {
                codes.add((await registerDevice(t, hw)).pairing_code);
            }
            expect(codes.size).toBe(3);
        });
    });

    describe("GET /device/status et cycle de vie", () => {
        it("suit pending, active puis révoqué (401)", async () => {
            const device = await registerDevice(t);
            expect((await t.api("GET", "/device/status", { token: device.token })).json).toEqual({ status: "pending" });
            const seen = await t.db.runner.get<{ last_seen_at: Date | null }>(`SELECT last_seen_at FROM viewers WHERE id = $1`, device.viewer_id);
            expect(seen!.last_seen_at).not.toBeNull();

            await t.api("POST", `/admin/viewers/${device.viewer_id}/activate`, { cookie, body: { name: "Salon" } });
            expect((await t.api("GET", "/device/status", { token: device.token })).json).toEqual({ status: "active" });

            await t.api("POST", `/admin/viewers/${device.viewer_id}/revoke`, { cookie });
            const revoked = await t.api("GET", "/device/status", { token: device.token });
            expect(revoked.status).toBe(401);
            expect(revoked.json.error).toBe("unauthorized");
        });

        it("la purge des demandes de plus de 7 jours invalide le jeton (401) et libère le matériel", async () => {
            const stale = await registerDevice(t, "hw-stale");
            const fresh = await registerDevice(t, "hw-fresh");
            await t.db.runner.run(`UPDATE viewers SET pending_since = now() - interval '8 days' WHERE id = $1`, stale.viewer_id);

            expect(await runPeriodicTasks(t.db.runner, { pendingMaxAgeDays: 7 })).toMatchObject({ purgedPendingViewers: 1 });
            expect((await t.api("GET", "/device/status", { token: stale.token })).status).toBe(401);
            expect((await t.api("GET", "/device/status", { token: fresh.token })).json).toEqual({ status: "pending" });
            // la carte peut se réenregistrer
            expect((await registerDevice(t, "hw-stale")).status).toBe("pending");
        });

        it("répond 403 viewer_pending sur toute autre route tant que le viewer est pending", async () => {
            const device = await registerDevice(t);
            for (const [method, path] of [["POST", "/agent/state"], ["POST", "/agent/nudge"], ["GET", "/viewer/sync"], ["GET", "/nope"]]) {
                const response = await t.api(method!, path!, { token: device.token, body: method === "POST" ? { status: "idle" } : undefined });
                expect(response.status, `${method} ${path}`).toBe(403);
                expect(response.json.error).toBe("viewer_pending");
            }
        });

        it("refuse un jeton d'agent sur /device/status (403) et un jeton de viewer sur /agent/* (403)", async () => {
            const { token: agentToken } = await createAgent(t, cookie, "robot");
            expect((await t.api("GET", "/device/status", { token: agentToken })).status).toBe(403);

            const device = await activeDevice(t, cookie);
            expect((await t.api("POST", "/agent/state", { token: device.token, body: { status: "idle" } })).status).toBe(403);
        });

        it("web/register : session requise (401), puis viewer web actif en mode auto", async () => {
            expect((await t.api("POST", "/web/register", { body: { capabilities: CAPS } })).status).toBe(401);
            const response = await t.api("POST", "/web/register", { cookie, body: { capabilities: CAPS, label: "Firefox bureau" } });
            expect(response.status).toBe(201);
            expect(response.json.token).toMatch(/^web_/);
            const viewer = await t.api("GET", `/admin/viewers/${response.json.viewer_id}`, { cookie });
            expect(viewer.json.viewer).toMatchObject({ kind: "web", status: "active", subscription_mode: "auto", name: "Firefox bureau" });

            expect((await t.api("POST", "/web/register", { cookie, body: {} })).status).toBe(400);
            expect((await t.api("POST", "/web/register", { cookie, body: { capabilities: { ...CAPS, protocol_version: 9 } } })).status).toBe(426);
            // un jeton web_ ne vaut pas sur /device/status
            expect((await t.api("GET", "/device/status", { token: response.json.token })).json).toEqual({ status: "active" });
        });
    });
});
