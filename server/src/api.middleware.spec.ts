import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { generateToken } from "./san/tokens";
import { createTestApp, TestApp } from "./test/app.fixture";
import { activeDevice, CAPS, createAgent, registerDevice, resetData } from "./test/helpers";

describe.runIf(inject("databaseAvailable"))("API /api/v1 — middlewares", () => {
    let t: TestApp;
    let cookie: string;

    beforeAll(async () => {
        t = await createTestApp("api_middleware", { registerRatePerHour: 5, ratePerMinute: 6, authFailuresPerMinute: 4 });
        cookie = await t.loginAdmin();
        await resetData(t);
    });
    afterAll(async () => {
        await t.close();
    });

    it("répond 401 JSON (et non une redirection vers /login) sans jeton valide", async () => {
        const none = await t.api("GET", "/device/status");
        expect(none.status).toBe(401);
        expect(none.json).toEqual({ error: "unauthorized", message: expect.any(String) });
        expect(none.headers.get("cache-control")).toBe("no-store");

        // ces tests consomment le quota d'échecs d'une IP : on change d'adresse à chaque fois
        const ip = (n: number) => ({ "x-forwarded-for": `10.0.0.${n}` });
        expect((await t.api("GET", "/device/status", { token: "agt_trop-court", headers: ip(1) })).status).toBe(401);
        expect((await t.api("GET", "/device/status", { token: generateToken("agt").token, headers: ip(2) })).status).toBe(401);
        expect((await t.api("GET", "/device/status", { headers: { authorization: "Basic abc", ...ip(3) } })).status).toBe(401);
        expect((await t.api("POST", "/agent/state", { token: generateToken("dev").token, body: { status: "idle" }, headers: ip(4) })).status).toBe(401);
    });

    it("laisse Dagda protéger le reste du serveur (redirection vers /login)", async () => {
        const response = await fetch(`${t.baseUrl}/n-importe-quoi`, { redirect: "manual" });
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("/login");
    });

    it("répond 404 JSON sur une route inconnue (authentifié) et 401 sur /admin sans session", async () => {
        const { token } = await createAgent(t, cookie, "robot-404");
        const unknown = await t.api("GET", "/inconnue", { token });
        expect(unknown.status).toBe(404);
        expect(unknown.json.error).toBe("not_found");
        expect((await t.api("GET", "/admin/agents")).status).toBe(401);
        expect((await t.api("GET", "/admin/agents", { cookie: "connect.sid=forge" })).status).toBe(401);
    });

    it("répond 413 au-delà de 64 Ko pour un agent authentifié et accepte juste en dessous", async () => {
        const { token } = await createAgent(t, cookie, "robot-big");
        const big = await t.api("POST", "/agent/state", { token, body: { status: "idle", detail: "a".repeat(70 * 1024) } });
        expect(big.status).toBe(413);
        expect(big.json.error).toBe("payload_too_large");
        // sous la limite de 64 Ko mais rejeté par la validation du champ : 400 et non 413
        const ok = await t.api("POST", "/agent/state", { token, body: { status: "idle", detail: "a".repeat(60 * 1024) } });
        expect(ok.status).toBe(400);
        // et aussi sur /admin
        const admin = await t.api("POST", "/admin/agents", { cookie, body: { slug: "x", name: "a".repeat(70 * 1024) } });
        expect(admin.status).toBe(413);
    });

    it("limite le débit par jeton (429 + Retry-After)", async () => {
        const { token } = await createAgent(t, cookie, "robot-rate");
        for (let i = 0; i < 6; i++) {
            expect((await t.api("POST", "/agent/state", { token, body: { status: "working" } })).status).toBe(200);
        }
        const limited = await t.api("POST", "/agent/state", { token, body: { status: "working" } });
        expect(limited.status).toBe(429);
        expect(limited.json.error).toBe("rate_limited");
        expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
        // un autre jeton n'est pas affecté
        const other = await createAgent(t, cookie, "robot-rate-2");
        expect((await t.api("POST", "/agent/state", { token: other.token, body: { status: "idle" } })).status).toBe(200);
    });

    it("bloque une IP après trop d'échecs d'authentification (429), même avec un bon jeton", async () => {
        const { token } = await createAgent(t, cookie, "robot-brute");
        const headers = { "x-forwarded-for": "192.0.2.77" };
        for (let i = 0; i < 4; i++) {
            expect((await t.api("GET", "/device/status", { token: generateToken("dev").token, headers })).status).toBe(401);
        }
        const blocked = await t.api("POST", "/agent/state", { token, body: { status: "idle" }, headers });
        expect(blocked.status).toBe(429);
        // une autre IP passe
        expect((await t.api("POST", "/agent/state", { token, body: { status: "idle" }, headers: { "x-forwarded-for": "192.0.2.78" } })).status).toBe(200);
    });

    it("limite /device/register à N demandes par heure et par IP (429)", async () => {
        const ipA = { "x-forwarded-for": "198.51.100.1" };
        for (let i = 0; i < 5; i++) {
            expect((await t.api("POST", "/device/register", { body: { hardware_id: `rl-${i}`, model: "m", capabilities: CAPS }, headers: ipA })).status).toBe(201);
        }
        const limited = await t.api("POST", "/device/register", { body: { hardware_id: "rl-5", model: "m", capabilities: CAPS }, headers: ipA });
        expect(limited.status).toBe(429);
        expect(limited.json.error).toBe("rate_limited");
        expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
        // une autre adresse n'est pas concernée
        const ipB = { "x-forwarded-for": "198.51.100.2" };
        expect((await t.api("POST", "/device/register", { body: { hardware_id: "rl-b", model: "m", capabilities: CAPS }, headers: ipB })).status).toBe(201);
        // les demandes refusées pour 429 n'ont rien créé
        const count = await t.db.runner.get<{ n: number }>(`SELECT count(*)::int AS n FROM viewers WHERE hardware_id = 'rl-5'`);
        expect(count!.n).toBe(0);
    });

    it("distingue les jetons révoqués : agent révoqué et viewer révoqué reçoivent 401", async () => {
        const agent = await createAgent(t, cookie, "robot-revoked");
        expect((await t.api("POST", "/agent/state", { token: agent.token, body: { status: "idle" } })).status).toBe(200);
        await t.api("PATCH", "/admin/agents/robot-revoked", { cookie, body: { revoked: true } });
        expect((await t.api("POST", "/agent/state", { token: agent.token, body: { status: "idle" } })).status).toBe(401);

        const device = await activeDevice(t, cookie);
        await t.api("POST", `/admin/viewers/${device.viewer_id}/revoke`, { cookie });
        expect((await t.api("GET", "/device/status", { token: device.token })).status).toBe(401);
    });

    it("refuse un préfixe de jeton incohérent avec le type du viewer", async () => {
        // un viewer web dont l'empreinte correspond à un jeton dev_ (cas anormal, forgé en base)
        const forged = generateToken("dev");
        await t.db.runner.run(
            `INSERT INTO viewers (id, kind, status, token_hash, subscription_mode) VALUES ('v_forgedweb', 'web', 'active', $1, 'auto')`,
            forged.hash
        );
        const response = await t.api("GET", "/device/status", { token: forged.token, headers: { "x-forwarded-for": "203.0.113.10" } });
        expect(response.status).toBe(401);
    });
});
