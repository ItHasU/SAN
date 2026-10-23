import { applyMigrations } from "@dagda/server/src/sql/migrations";
import { createTestDatabase, TestDatabase } from "@dagda/server/src/test/pg.fixture";
import { APP_MODEL } from "@san/shared/src/entities/model";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { createAgent, setAgentState } from "./agents";
import { EventBus, BusMessage } from "./bus";
import { advanceCursor, getCursor, lastEventId } from "./cursors";
import { insertEvent, notify } from "./events";
import { createGroup, setGroupMembers } from "./groups";
import { withImpact } from "./impact";
import { fetchAgentInbox, pollInbox } from "./inbox";
import { newClipId } from "./ids";
import { SAN_MIGRATIONS } from "./migrations";
import { createRule } from "./permissions";
import { clipDirectory, purgeOrphanClips, runPeriodicTasks } from "./purge";
import { syncViewer } from "./sync";
import { generateToken } from "./tokens";
import { applySubscriptions, computeConfig, configHash } from "./viewer-config";
import { chooseAudioFormat, fetchViewerEvents, truncateChars } from "./viewer-events";
import { activateViewer, revokeViewer } from "./viewers";
import { TEST_DB_URL } from "@dagda/server/src/test/pg.fixture";

const CAPS_SCREEN = { protocol_version: 1, display: { width: 135, height: 240, color: true, max_detail_chars: 10 }, audio_out: { formats: ["ima_adpcm", "pcm_s16le"], sample_rates: [8000, 16000] } };

describe("formats audio et troncature", () => {
    it("choisit le format préféré et la fréquence la plus haute ≤ 16000 (DESIGN §5)", () => {
        expect(chooseAudioFormat(CAPS_SCREEN)).toEqual({ format: "ima_adpcm", sample_rate: 16000 });
        expect(chooseAudioFormat({ audio_out: { formats: ["pcm_s16le"], sample_rates: [8000] } })).toEqual({ format: "pcm_s16le", sample_rate: 8000 });
        expect(chooseAudioFormat({ audio_out: { formats: ["mp3", "ogg", "pcm_s16le"] } })).toEqual({ format: "mp3", sample_rate: 16000 });
        expect(chooseAudioFormat({ audio_out: { formats: ["pcm_s16le"], sample_rates: [22050, 44100] } })).toEqual({ format: "pcm_s16le", sample_rate: 22050 });
        expect(chooseAudioFormat({ display: {} })).toBeNull();
        expect(chooseAudioFormat(null)).toBeNull();
        expect(chooseAudioFormat({ audio_out: { formats: [] } })).toBeNull();
    });

    it("tronque par points de code", () => {
        expect(truncateChars("abcdef", 3)).toBe("abc");
        expect(truncateChars("abc", 3)).toBe("abc");
        expect(truncateChars("😀😀😀", 2)).toBe("😀😀");
        expect(truncateChars("abc", 0)).toBe("");
    });
});

describe.runIf(inject("databaseAvailable"))("livraison : filtrage, pagination, curseurs, purge, bus", () => {
    let db: TestDatabase;
    const sql = () => db.runner;
    let dataDir: string;

    beforeAll(async () => {
        db = await createTestDatabase("delivery");
        await applyMigrations(db.runner, APP_MODEL, SAN_MIGRATIONS, "app");
        dataDir = await mkdtemp(join(tmpdir(), "san-data-"));
    });
    afterAll(async () => {
        await db.dispose();
    });
    beforeEach(async () => {
        await sql().run(`TRUNCATE events, cursors, voice_clips, agent_state, subscriptions, permission_rules, agent_group_members, agent_groups, agents, viewers CASCADE`);
    });

    const viewer = (id: string, mode: "auto" | "manual" = "auto", capabilities: unknown = CAPS_SCREEN, status = "active") =>
        sql().run(
            `INSERT INTO viewers (id, kind, name, status, token_hash, subscription_mode, capabilities) VALUES ($1, 'device', $1, $2, $3, $4, $5::jsonb)`,
            id, status, generateToken("dev").hash, mode, JSON.stringify(capabilities)
        );
    const agent = (slug: string) => createAgent(sql(), { slug, name: slug.toUpperCase() });
    const rule = (pattern: string, viewerId = "v1", scope: "agent" | "group" = "agent") => createRule(sql(), viewerId, { scope, pattern });
    const nudge = (slug: string, text: string, ttlS = 3600) => insertEvent(sql(), { direction: "to_viewers", agentSlug: slug, kind: "nudge", text, priority: "normal", ttlS });
    const read = async (viewerId = "v1", after = 0, limit = 50) => {
        const config = await computeConfig(sql(), viewerId);
        const caps = (await sql().get<any>(`SELECT capabilities FROM viewers WHERE id = $1`, viewerId))!.capabilities;
        return fetchViewerEvents(sql(), config, caps, after, limit);
    };

    describe("filtrage à la lecture", () => {
        it("ne livre que les événements des agents visibles et suivis, non expirés", async () => {
            await viewer("v1", "manual");
            for (const slug of ["suivi", "pas-suivi", "cache", "revoque"]) {
                await agent(slug);
            }
            await rule("suivi");
            await rule("pas-suivi");
            await rule("revoque");
            await applySubscriptions(sql(), "v1", [{ agent: "suivi", subscribed: true }, { agent: "revoque", subscribed: true }], "bad_request");

            await nudge("suivi", "ok");
            await nudge("pas-suivi", "non suivi");
            await nudge("cache", "invisible");
            await nudge("revoque", "avant révocation");
            const expired = await nudge("suivi", "expiré");
            await sql().run(`UPDATE events SET expires_at = now() - interval '1 second' WHERE id = $1`, expired.id);
            await sql().run(`UPDATE agents SET revoked_at = now() WHERE slug = 'revoque'`);

            expect((await read()).events.map((e) => e.text)).toEqual(["ok"]);
        });

        it("applique les changements d'abonnement aux événements non encore livrés (SPEC §9.2)", async () => {
            await viewer("v1", "manual");
            await agent("a1");
            await rule("a1");
            await applySubscriptions(sql(), "v1", [{ agent: "a1", subscribed: true }], "bad_request");
            await nudge("a1", "n1");
            expect((await read()).events).toHaveLength(1);
            await applySubscriptions(sql(), "v1", [{ agent: "a1", subscribed: false }], "bad_request");
            expect((await read()).events).toHaveLength(0);
            await applySubscriptions(sql(), "v1", [{ agent: "a1", subscribed: true }], "bad_request");
            expect((await read()).events).toHaveLength(1);
            await sql().run(`DELETE FROM permission_rules`);
            expect((await read()).events).toHaveLength(0);
        });

        it("livre les agents muets avec muted: true", async () => {
            await viewer("v1");
            await agent("a1");
            await agent("a2");
            await rule("*");
            await applySubscriptions(sql(), "v1", [{ agent: "a1", muted: true }], "bad_request");
            await nudge("a1", "chut");
            await nudge("a2", "bruit");
            const events = (await read()).events;
            expect(events.map((e) => [e.agent, e.muted])).toEqual([["a1", true], ["a2", undefined]]);
            expect("muted" in events[1]!).toBe(false);
        });

        it("forme des événements : nudge avec priorité, voix avec clip selon les capacités, texte seul sans audio_out", async () => {
            await viewer("v1");
            await viewer("v-noaudio", "auto", { protocol_version: 1, display: {} });
            await agent("a1");
            await rule("*");
            await rule("*", "v-noaudio");
            const clipId = newClipId();
            await sql().run(`INSERT INTO voice_clips (id, source, status, duration_ms) VALUES ($1, 'tts', 'ready', 4400)`, clipId);
            await sql().run(`INSERT INTO voice_renditions (clip_id, format, sample_rate, path, size) VALUES ($1, 'ima_adpcm', 16000, 'x', 17600)`, clipId);
            await insertEvent(sql(), { direction: "to_viewers", agentSlug: "a1", kind: "nudge", text: "Échec", priority: "high", ttlS: 60 });
            await insertEvent(sql(), { direction: "to_viewers", agentSlug: "a1", kind: "voice", text: "Trois articles.", clipId, ttlS: 60 });

            const [first, second] = (await read()).events;
            expect(first).toMatchObject({ kind: "nudge", agent: "a1", priority: "high", text: "Échec" });
            expect(first).not.toHaveProperty("clip");
            expect(second).toMatchObject({ kind: "voice", text: "Trois articles.", clip: { id: clipId, format: "ima_adpcm", sample_rate: 16000, size: 17600, duration_ms: 4400 } });
            expect(typeof second!.created_at).toBe("string");

            const textOnly = (await read("v-noaudio")).events[1]!;
            expect(textOnly.text).toBe("Trois articles.");
            expect(textOnly).not.toHaveProperty("clip");
        });
    });

    describe("pagination", () => {
        it("pages de 50 avec has_more, dans l'ordre des identifiants", async () => {
            await viewer("v1");
            await agent("a1");
            await rule("*");
            await sql().run(
                `INSERT INTO events (direction, agent_slug, kind, text, expires_at)
                 SELECT 'to_viewers', 'a1', 'nudge', 'n' || i, now() + interval '1 hour' FROM generate_series(1, 120) AS i`
            );
            const page1 = await read();
            expect(page1.events).toHaveLength(50);
            expect(page1.has_more).toBe(true);
            const page2 = await read("v1", page1.events.at(-1)!.id);
            expect(page2.events).toHaveLength(50);
            expect(page2.has_more).toBe(true);
            const page3 = await read("v1", page2.events.at(-1)!.id);
            expect(page3.events).toHaveLength(20);
            expect(page3.has_more).toBe(false);
            const all = [...page1.events, ...page2.events, ...page3.events];
            expect(all.map((e) => e.text)).toEqual(Array.from({ length: 120 }, (_, i) => `n${i + 1}`));
            expect(all.map((e) => e.id)).toEqual([...all.map((e) => e.id)].sort((a, b) => a - b));
        });

        it("sync : 50 événements, has_more, next_sync_s à 15 ; ack puis page suivante", async () => {
            await viewer("v1");
            await agent("a1");
            await rule("*");
            await sql().run(
                `INSERT INTO events (direction, agent_slug, kind, text, expires_at)
                 SELECT 'to_viewers', 'a1', 'nudge', 'n' || i, now() + interval '1 hour' FROM generate_series(1, 60) AS i`
            );
            const first = await syncViewer(sql(), "v1", {});
            expect(first.events).toHaveLength(50);
            expect(first.has_more).toBe(true);
            expect(first.next_sync_s).toBe(15);
            const second = await syncViewer(sql(), "v1", { ack: first.events.at(-1)!.id });
            expect(second.events).toHaveLength(10);
            expect(second.has_more).toBe(false);
            expect(second.next_sync_s).toBe(60);
            const third = await syncViewer(sql(), "v1", { ack: second.events.at(-1)!.id });
            expect(third.events).toEqual([]);
        });
    });

    describe("curseurs", () => {
        it("ne reculent jamais et sont plafonnés au dernier identifiant attribué", async () => {
            await agent("a1");
            const e1 = await nudge("a1", "1");
            const e2 = await nudge("a1", "2");
            expect(await getCursor(sql(), "viewer", "v1")).toBe(0);
            expect(await advanceCursor(sql(), "viewer", "v1", e2.id)).toBe(e2.id);
            expect(await advanceCursor(sql(), "viewer", "v1", e1.id)).toBe(e2.id);
            expect(await advanceCursor(sql(), "viewer", "v1", 0)).toBe(e2.id);
            // au-delà : plafonné, un événement futur n'est pas acquitté d'avance
            expect(await advanceCursor(sql(), "viewer", "v1", 10 ** 9)).toBe(e2.id);
            const e3 = await nudge("a1", "3");
            expect(e3.id).toBeGreaterThan(await getCursor(sql(), "viewer", "v1"));
            expect(await lastEventId(sql())).toBe(e3.id);
            // viewers et agents ont des curseurs distincts
            expect(await getCursor(sql(), "agent", "v1")).toBe(0);
        });

        it("sync : un ack plus ancien ne ramène pas le curseur en arrière", async () => {
            await viewer("v1");
            await agent("a1");
            await rule("*");
            const e1 = await nudge("a1", "1");
            const e2 = await nudge("a1", "2");
            expect((await syncViewer(sql(), "v1", { ack: e2.id })).events).toEqual([]);
            expect((await syncViewer(sql(), "v1", { ack: e1.id })).events).toEqual([]);
            expect(await getCursor(sql(), "viewer", "v1")).toBe(e2.id);
        });
    });

    describe("sync", () => {
        it("renvoie la config seulement si le hash diffère, et capabilities_required si caps_hash absent ou différent", async () => {
            await viewer("v1");
            await agent("a1");
            await rule("*");
            const first = await syncViewer(sql(), "v1", {});
            expect(first.capabilities_required).toBe(true);
            expect(first.config).not.toBeNull();
            expect(first.config_hash).toBe(configHash(first.config!));
            const same = await syncViewer(sql(), "v1", { config_hash: first.config_hash });
            expect(same.config).toBeNull();
            expect((await syncViewer(sql(), "v1", { config_hash: "0000000000000000" })).config).not.toBeNull();

            await sql().run(`UPDATE viewers SET capabilities_hash = 'abc123' WHERE id = 'v1'`);
            expect((await syncViewer(sql(), "v1", { caps_hash: "abc123" })).capabilities_required).toBe(false);
            expect((await syncViewer(sql(), "v1", { caps_hash: "autre" })).capabilities_required).toBe(true);
            expect((await syncViewer(sql(), "v1", {})).capabilities_required).toBe(true);
        });

        it("met à jour last_seen_at, battery_pct (conservé si absent) et next_wake_at", async () => {
            await viewer("v1");
            const now = new Date("2026-10-23T15:05:00Z");
            await syncViewer(sql(), "v1", { battery: 82 }, now);
            let row = (await sql().get<any>(`SELECT last_seen_at, battery_pct, next_wake_at FROM viewers WHERE id = 'v1'`))!;
            expect(row.battery_pct).toBe(82);
            expect(row.last_seen_at.toISOString()).toBe("2026-10-23T15:05:00.000Z");
            expect(row.next_wake_at.toISOString()).toBe("2026-10-23T15:06:00.000Z");
            await syncViewer(sql(), "v1", {}, now);
            row = (await sql().get<any>(`SELECT battery_pct FROM viewers WHERE id = 'v1'`))!;
            expect(row.battery_pct).toBe(82);
        });

        it("états : agents suivis non révoqués, detail tronqué, absent sans écran, stale", async () => {
            await viewer("v1");
            await viewer("v-noscreen", "auto", { protocol_version: 1, audio_out: { formats: ["pcm_s16le"] } });
            await agent("a1");
            await agent("a2");
            await agent("a3");
            await agent("hors");
            await rule("a?");
            await rule("a?", "v-noscreen");
            await setAgentState(sql(), "a1", { status: "working", detail: "Compilation firmware", progress: 40, ttlS: 60 });
            await setAgentState(sql(), "a2", { status: "idle" });
            await setAgentState(sql(), "a3", { status: "done" });
            await setAgentState(sql(), "hors", { status: "error" });
            await sql().run(`UPDATE agents SET revoked_at = now() WHERE slug = 'a3'`);
            await sql().run(`UPDATE agent_state SET updated_at = now() - interval '2 minutes' WHERE agent_slug = 'a1'`);

            const { states } = await syncViewer(sql(), "v1", {});
            expect(states.map((s) => s.agent)).toEqual(["a1", "a2"]);
            expect(states[0]).toMatchObject({ agent: "a1", name: "A1", status: "working", detail: "Compilatio", progress: 40, stale: true });
            expect(states[1]).toMatchObject({ status: "idle", detail: null, progress: null, stale: false });
            expect(typeof states[0]!.updated_at).toBe("string");

            const noScreen = (await syncViewer(sql(), "v-noscreen", {})).states;
            expect(noScreen).toHaveLength(2);
            expect(noScreen[0]).not.toHaveProperty("detail");
        });
    });

    describe("aperçu d'impact", () => {
        it("calcule gagnés et perdus sans rien modifier en dry run, et valide sinon", async () => {
            await viewer("v1");
            await viewer("v2");
            await agent("a1");
            await rule("a*");
            await rule("a1", "v2");
            await createGroup(sql(), { slug: "g", name: "G" });
            await createRule(sql(), "v2", { scope: "group", pattern: "g" });

            const dry = await withImpact(sql() as any, true, async (conn) => {
                await createAgent(conn, { slug: "a2", name: "A2" });
                await setGroupMembers(conn, "g", ["a1", "a2"]);
                await revokeViewer(conn, "v1");
                return "fait";
            });
            expect(dry.dryRun).toBe(true);
            expect(dry.result).toBe("fait");
            expect(dry.impact.gained.map((p) => [p.viewer, p.agent])).toEqual([["v2", "a2"]]);
            expect(dry.impact.lost.map((p) => [p.viewer, p.agent])).toEqual([["v1", "a1"]]);
            expect(dry.impact.gained[0]).toMatchObject({ viewer_name: "v2" });
            // rien n'a changé
            expect(await sql().get(`SELECT 1 AS x FROM agents WHERE slug = 'a2'`)).toBeNull();
            expect((await sql().get<any>(`SELECT status FROM viewers WHERE id = 'v1'`))!.status).toBe("active");

            const real = await withImpact(sql() as any, false, (conn) => createAgent(conn, { slug: "a2", name: "A2" }));
            expect(real.dryRun).toBe(false);
            expect(real.impact.gained.map((p) => [p.viewer, p.agent])).toEqual([["v1", "a2"]]);
            expect(await sql().get(`SELECT 1 AS x FROM agents WHERE slug = 'a2'`)).not.toBeNull();
        });

        it("une erreur annule la transaction et se propage", async () => {
            await agent("a1");
            await expect(withImpact(sql() as any, false, async (conn) => {
                await createAgent(conn, { slug: "a2", name: "A2" });
                await createAgent(conn, { slug: "a1", name: "doublon" });
            })).rejects.toMatchObject({ status: 409 });
            expect(await sql().get(`SELECT 1 AS x FROM agents WHERE slug = 'a2'`)).toBeNull();
        });

        it("l'activation d'un viewer pending fait gagner ce que ses règles couvrent", async () => {
            await viewer("v1", "manual", CAPS_SCREEN, "pending");
            await agent("a1");
            await rule("*");
            const dry = await withImpact(sql() as any, true, (conn) => activateViewer(conn, "v1", "Carte"));
            expect(dry.impact.gained.map((p) => p.agent)).toEqual(["a1"]);
            expect(dry.impact.lost).toEqual([]);
        });
    });

    describe("inbox agent", () => {
        const toAgent = (slug: string, viewerId: string | null, text: string, clipId: string | null = null) =>
            insertEvent(sql(), { direction: "to_agent", agentSlug: slug, fromViewerId: viewerId, kind: "voice", text, clipId, ttlS: 3600 });
        const bus = new EventBus({ connectionString: "" });

        it("renvoie les événements to_agent de l'agent avec l'expéditeur et le clip, ack avant lecture", async () => {
            await viewer("v1");
            await agent("a1");
            await agent("a2");
            const clipId = newClipId();
            await sql().run(`INSERT INTO voice_clips (id, source, status, duration_ms) VALUES ($1, 'viewer_upload', 'ready', 4200)`, clipId);
            const e1 = await toAgent("a1", "v1", "bonjour", clipId);
            await toAgent("a2", "v1", "pour un autre");
            await nudge("a1", "mauvaise direction");
            const first = await pollInbox(sql() as any, bus, "a1", { waitS: 0 });
            expect(first.has_more).toBe(false);
            expect(first.events).toEqual([{
                id: e1.id, kind: "voice", text: "bonjour", from: { viewer: "v1", name: "v1" },
                created_at: expect.any(String), clip: { id: clipId, duration_ms: 4200, url: `/api/v1/agent/voice/${clipId}` }
            }]);
            // pas encore acquitté : renvoyé tel quel
            expect((await pollInbox(sql() as any, bus, "a1", { waitS: 0 })).events).toHaveLength(1);
            expect((await pollInbox(sql() as any, bus, "a1", { waitS: 0, ack: e1.id })).events).toHaveLength(0);
        });

        it("ignore les événements expirés ; l'expéditeur supprimé donne from: null", async () => {
            await viewer("v1");
            await agent("a1");
            const old = await toAgent("a1", "v1", "expiré");
            await sql().run(`UPDATE events SET expires_at = now() - interval '1 second' WHERE id = $1`, old.id);
            await toAgent("a1", "v1", "orphelin");
            await sql().run(`DELETE FROM viewers WHERE id = 'v1'`);
            const { events } = await fetchAgentInbox(sql(), "a1", 0);
            expect(events.map((e) => [e.text, e.from])).toEqual([["orphelin", null]]);
        });
    });

    describe("purge", () => {
        it("supprime les événements expirés", async () => {
            await agent("a1");
            const old = await nudge("a1", "vieux");
            await nudge("a1", "frais");
            await sql().run(`UPDATE events SET expires_at = now() - interval '1 second' WHERE id = $1`, old.id);
            expect((await runPeriodicTasks(sql() as any, { pendingMaxAgeDays: 7, dataDir })).expiredEvents).toBe(1);
            expect((await sql().all<any>(`SELECT text FROM events`)).map((r) => r.text)).toEqual(["frais"]);
        });

        it("supprime les to_viewers ≤ plus petit curseur des viewers actifs ; sans curseur = 0", async () => {
            await viewer("v1");
            await viewer("v2");
            await viewer("v-revoque", "auto", null, "revoked");
            await agent("a1");
            const ids = [(await nudge("a1", "1")).id, (await nudge("a1", "2")).id, (await nudge("a1", "3")).id];
            const purge = async () => (await runPeriodicTasks(sql() as any, { pendingMaxAgeDays: 7, dataDir })).deliveredEvents;

            await advanceCursor(sql(), "viewer", "v1", ids[2]!);
            expect(await purge()).toBe(0); // v2 actif sans curseur : tout est conservé
            await advanceCursor(sql(), "viewer", "v2", ids[1]!);
            expect(await purge()).toBe(2);
            expect((await sql().all<any>(`SELECT text FROM events`)).map((r) => r.text)).toEqual(["3"]);
            // un viewer révoqué ne retient rien
            await sql().run(`UPDATE viewers SET status = 'revoked' WHERE id = 'v2'`);
            expect(await purge()).toBe(1);
        });

        it("sans viewer actif, ne supprime pas les to_viewers (l'expiration s'en charge)", async () => {
            await agent("a1");
            await nudge("a1", "x");
            expect((await runPeriodicTasks(sql() as any, { pendingMaxAgeDays: 7, dataDir })).deliveredEvents).toBe(0);
        });

        it("supprime les to_agent acquittés par leur agent, pas ceux des autres", async () => {
            await viewer("v1");
            await agent("a1");
            await agent("a2");
            const send = (slug: string) => insertEvent(sql(), { direction: "to_agent", agentSlug: slug, fromViewerId: "v1", kind: "voice", text: slug, ttlS: 3600 });
            const e1 = await send("a1");
            await send("a1");
            await send("a2");
            await advanceCursor(sql(), "agent", "a1", e1.id);
            const result = await runPeriodicTasks(sql() as any, { pendingMaxAgeDays: 7, dataDir });
            expect(result.acknowledgedAgentEvents).toBe(1);
            expect(await sql().all(`SELECT 1 FROM events`)).toHaveLength(2);
        });

        it("supprime les clips non référencés (lignes, conversions et fichiers) après un délai de grâce", async () => {
            await agent("a1");
            const kept = newClipId();
            const orphan = newClipId();
            const fresh = newClipId();
            for (const id of [kept, orphan, fresh]) {
                await sql().run(`INSERT INTO voice_clips (id, source, status, original_path) VALUES ($1, 'tts', 'ready', $2)`, id, `clips/${id}/original`);
                await mkdir(clipDirectory(dataDir, id), { recursive: true });
                await writeFile(join(clipDirectory(dataDir, id), "wav-16000.wav"), "RIFF");
            }
            await sql().run(`INSERT INTO voice_renditions (clip_id, format, sample_rate, path, size) VALUES ($1, 'wav', 16000, 'x', 4)`, orphan);
            await sql().run(`UPDATE voice_clips SET created_at = now() - interval '2 hours' WHERE id IN ($1, $2)`, kept, orphan);
            await insertEvent(sql(), { direction: "to_viewers", agentSlug: "a1", kind: "voice", clipId: kept, ttlS: 3600 });

            expect(await purgeOrphanClips(sql(), dataDir)).toBe(1);
            expect((await sql().all<any>(`SELECT id FROM voice_clips`)).map((r) => r.id).sort()).toEqual([fresh, kept].sort());
            expect(await sql().all(`SELECT 1 FROM voice_renditions`)).toHaveLength(0);
            const dirs = await readdir(join(dataDir, "clips"));
            expect(dirs).toContain(kept);
            expect(dirs).toContain(fresh);
            expect(dirs).not.toContain(orphan);
            await expect(stat(clipDirectory(dataDir, orphan))).rejects.toThrow();
        });

        it("un clip référencé seulement par un événement expiré est supprimé avec lui", async () => {
            await agent("a1");
            const clip = newClipId();
            await sql().run(`INSERT INTO voice_clips (id, source, status, created_at) VALUES ($1, 'tts', 'ready', now() - interval '2 hours')`, clip);
            const event = await insertEvent(sql(), { direction: "to_viewers", agentSlug: "a1", kind: "voice", clipId: clip, ttlS: 60 });
            await sql().run(`UPDATE events SET expires_at = now() - interval '1 second' WHERE id = $1`, event.id);
            const result = await runPeriodicTasks(sql() as any, { pendingMaxAgeDays: 7, dataDir });
            expect(result).toMatchObject({ expiredEvents: 1, orphanClips: 1 });
        });

        it("supprime les curseurs de viewers et d'agents disparus", async () => {
            await viewer("v1");
            await agent("a1");
            await nudge("a1", "x");
            await advanceCursor(sql(), "viewer", "v1", 1);
            await advanceCursor(sql(), "viewer", "fantome", 1);
            await advanceCursor(sql(), "agent", "a1", 1);
            await advanceCursor(sql(), "agent", "disparu", 1);
            expect((await runPeriodicTasks(sql() as any, { pendingMaxAgeDays: 7, dataDir })).staleCursors).toBe(2);
        });
    });

    describe("bus LISTEN/NOTIFY", () => {
        let bus: EventBus;
        const received: BusMessage[] = [];

        beforeEach(async () => {
            received.length = 0;
            const url = new URL(TEST_DB_URL);
            url.searchParams.set("options", `-c search_path=${db.schema}`);
            bus = new EventBus({ connectionString: url.toString(), reconnectMinMs: 50, reconnectMaxMs: 200, log: () => undefined });
            bus.subscribe((m) => received.push(m));
            await bus.start();
        });

        it("relaie insertions d'événements, changements d'état et de configuration", async () => {
            await agent("a1");
            const event = await nudge("a1", "x");
            await setAgentState(sql(), "a1", { status: "idle" });
            await notify(sql(), { type: "config", viewer: null });
            await expectMessages([
                { type: "event", id: event.id, direction: "to_viewers", agent: "a1" },
                { type: "state", agent: "a1" },
                { type: "config", viewer: null }
            ]);
            await bus.stop();
        });

        it("ignore les messages d'un autre schéma", async () => {
            await sql().run(`SELECT pg_notify('san_events', '{"schema":"autre","type":"state","agent":"x"}')`);
            await notify(sql(), { type: "state", agent: "ici" });
            await expectMessages([{ type: "state", agent: "ici" }]);
            await bus.stop();
        });

        it("n'émet rien pour une transaction annulée", async () => {
            await agent("a1");
            const conn = await sql().reserveConnection();
            await conn.run("BEGIN");
            await notify(conn, { type: "state", agent: "annule" });
            await conn.run("ROLLBACK");
            await sql().releaseConnection(conn);
            await notify(sql(), { type: "state", agent: "valide" });
            await expectMessages([{ type: "state", agent: "valide" }]);
            await bus.stop();
        });

        it("se reconnecte après une coupure et le signale (reconnect)", async () => {
            bus.simulateConnectionLoss();
            await waitUntil(() => received.some((m) => m.type === "reconnect"));
            received.length = 0;
            await notify(sql(), { type: "state", agent: "apres" });
            await expectMessages([{ type: "state", agent: "apres" }]);
            await bus.stop();
        });

        async function expectMessages(expected: BusMessage[]): Promise<void> {
            await waitUntil(() => received.length >= expected.length);
            expect(received).toEqual(expected);
        }
    });
});

async function waitUntil(condition: () => boolean, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error("waitUntil: délai dépassé");
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}
