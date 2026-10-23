import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { createTestApp, TestApp } from "./test/app.fixture";
import { createAgent, resetData } from "./test/helpers";

describe.runIf(inject("databaseAvailable"))("API /agent", () => {
    let t: TestApp;
    let cookie: string;
    let token: string;

    beforeAll(async () => {
        t = await createTestApp("api_agent", { ratePerMinute: 10_000 });
        cookie = await t.loginAdmin();
    });
    afterAll(async () => {
        await t.close();
    });
    beforeEach(async () => {
        await resetData(t);
        token = (await createAgent(t, cookie, "build-1", "Build")).token;
    });

    describe("POST /agent/state", () => {
        it("enregistre l'état courant et n'en conserve qu'un par agent", async () => {
            const first = await t.api("POST", "/agent/state", { token, body: { status: "working", detail: "Analyse", progress: 40, ttl_s: 900 } });
            expect(first.status).toBe(200);
            expect(first.json.ok).toBe(true);
            await t.api("POST", "/agent/state", { token, body: { status: "done" } });

            const rows = await t.db.runner.all<any>(`SELECT * FROM agent_state`);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ agent_slug: "build-1", status: "done", detail: null, progress: null, ttl_s: null });

            const detail = await t.api("GET", "/admin/agents/build-1", { cookie });
            expect(detail.json.agent.state).toMatchObject({ status: "done", stale: false });
        });

        it("marque l'état périmé quand le ttl_s est dépassé", async () => {
            await t.api("POST", "/agent/state", { token, body: { status: "working", ttl_s: 60 } });
            await t.db.runner.run(`UPDATE agent_state SET updated_at = now() - interval '2 minutes'`);
            const detail = await t.api("GET", "/admin/agents/build-1", { cookie });
            expect(detail.json.agent.state.stale).toBe(true);
        });

        it("valide le corps (400)", async () => {
            const post = (body: unknown) => t.api("POST", "/agent/state", { token, body });
            expect((await post({})).status).toBe(400);
            expect((await post({ status: "dancing" })).status).toBe(400);
            expect((await post({ status: "idle", progress: 101 })).status).toBe(400);
            expect((await post({ status: "idle", progress: -1 })).status).toBe(400);
            expect((await post({ status: "idle", progress: 1.5 })).status).toBe(400);
            expect((await post({ status: "idle", ttl_s: 0 })).status).toBe(400);
            expect((await post({ status: "idle", detail: 12 })).status).toBe(400);
            expect((await post({ status: "idle", detail: "x".repeat(501) })).status).toBe(400);
            expect((await post("idle")).status).toBe(400);
        });

        it("exige un jeton d'agent valide (401)", async () => {
            expect((await t.api("POST", "/agent/state", { body: { status: "idle" } })).status).toBe(401);
        });
    });

    describe("POST /agent/nudge", () => {
        const lifetimeS = async (id: number) => {
            const row = await t.db.runner.get<{ s: number }>(`SELECT extract(epoch FROM expires_at - created_at)::float AS s FROM events WHERE id = $1`, id);
            return Math.round(row!.s);
        };

        it("insère un événement to_viewers expirant dans 6 h par défaut", async () => {
            const response = await t.api("POST", "/agent/nudge", { token, body: { text: "Échec des tests", priority: "high" } });
            expect(response.status).toBe(201);
            expect(typeof response.json.id).toBe("number");
            const row = await t.db.runner.get<any>(`SELECT * FROM events WHERE id = $1`, response.json.id);
            expect(row).toMatchObject({ direction: "to_viewers", agent_slug: "build-1", kind: "nudge", text: "Échec des tests", priority: "high", from_viewer_id: null });
            expect(await lifetimeS(response.json.id)).toBe(6 * 3600);
        });

        it("accepte un nudge sans texte, avec priorité normal par défaut", async () => {
            const response = await t.api("POST", "/agent/nudge", { token, body: {} });
            expect(response.status).toBe(201);
            const row = await t.db.runner.get<any>(`SELECT * FROM events WHERE id = $1`, response.json.id);
            expect(row).toMatchObject({ text: null, priority: "normal" });
        });

        it("accepte un ttl_s plus court et plafonne un ttl_s plus long à 6 h", async () => {
            const short = await t.api("POST", "/agent/nudge", { token, body: { ttl_s: 120 } });
            expect(await lifetimeS(short.json.id)).toBe(120);
            const long = await t.api("POST", "/agent/nudge", { token, body: { ttl_s: 999_999 } });
            expect(await lifetimeS(long.json.id)).toBe(6 * 3600);
        });

        it("valide le corps (400) et donne des identifiants croissants", async () => {
            const post = (body: unknown) => t.api("POST", "/agent/nudge", { token, body });
            expect((await post({ priority: "urgent" })).status).toBe(400);
            expect((await post({ text: "x".repeat(501) })).status).toBe(400);
            expect((await post({ ttl_s: -5 })).status).toBe(400);
            expect((await post({ ttl_s: "10" })).status).toBe(400);
            const a = await post({ text: "a" });
            const b = await post({ text: "b" });
            expect(b.json.id).toBeGreaterThan(a.json.id);
            const count = await t.db.runner.get<{ n: number }>(`SELECT count(*)::int AS n FROM events`);
            expect(count!.n).toBe(2);
        });

        it("rattache le nudge à l'agent du jeton, jamais à un slug fourni dans le corps", async () => {
            await createAgent(t, cookie, "autre");
            const response = await t.api("POST", "/agent/nudge", { token, body: { text: "x", agent: "autre", agent_slug: "autre" } });
            const row = await t.db.runner.get<any>(`SELECT agent_slug FROM events WHERE id = $1`, response.json.id);
            expect(row.agent_slug).toBe("build-1");
        });
    });
});
