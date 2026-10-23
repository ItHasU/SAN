import { createTestDatabase, TEST_DB_URL, TestDatabase } from "@dagda/server/src/test/pg.fixture";
import { applyMigrations } from "@dagda/server/src/sql/migrations";
import { APP_MODEL } from "@san/shared/src/entities/model";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createAgent } from "./san/agents";
import { EVENTS_LOCK_KEY, insertEvent, NOTIFY_CHANNEL } from "./san/events";
import { SAN_MIGRATIONS } from "./san/migrations";

describe.runIf(inject("databaseAvailable"))("insertion d'événements", () => {
    let db: TestDatabase;

    beforeAll(async () => {
        db = await createTestDatabase("events");
        await applyMigrations(db.runner, APP_MODEL, SAN_MIGRATIONS, "app");
        await createAgent(db.runner, { slug: "a1", name: "A1" });
    });
    afterAll(async () => {
        await db.dispose();
    });

    const nudge = (text: string) => insertEvent(db.runner, { direction: "to_viewers", agentSlug: "a1", kind: "nudge", text, ttlS: 60 });

    it("attend le verrou consultatif : les insertions sont sérialisées", async () => {
        // Une transaction extérieure détient le verrou ; l'insertion doit attendre son commit.
        const holder = await db.runner.reserveConnection();
        await holder.run("BEGIN");
        await holder.run(`SELECT pg_advisory_xact_lock($1)`, EVENTS_LOCK_KEY);

        let done = false;
        const pending = nudge("bloqué").then((event) => {
            done = true;
            return event;
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(done).toBe(false);
        expect((await db.runner.get<{ n: number }>(`SELECT count(*)::int AS n FROM events`))!.n).toBe(0);

        await holder.run("COMMIT");
        await db.runner.releaseConnection(holder);
        const event = await pending;
        expect(done).toBe(true);
        expect(event.id).toBeGreaterThan(0);
    });

    it("rend les identifiants visibles dans l'ordre sous insertions concurrentes", async () => {
        const events = await Promise.all(Array.from({ length: 40 }, (_, i) => nudge(`n${i}`)));
        const ids = events.map((event) => event.id);
        expect(new Set(ids).size).toBe(40);

        // Ordre de commit == ordre des identifiants : triés par id, les horodatages
        // (clock_timestamp pris sous verrou) sont croissants.
        const rows = await db.runner.all<{ id: string, created_at: Date }>(`SELECT id, created_at FROM events WHERE text LIKE 'n%' ORDER BY id`);
        for (let i = 1; i < rows.length; i++) {
            expect(rows[i]!.created_at.getTime()).toBeGreaterThanOrEqual(rows[i - 1]!.created_at.getTime());
        }
        // et chaque insertion est réellement un commit distinct, sans trou de visibilité : pas d'écart
        // entre le plus petit et le plus grand identifiant autre que les identifiants consommés
        expect(Math.max(...ids) - Math.min(...ids)).toBe(39);
    });

    it("émet un NOTIFY san_events au commit", async () => {
        const listener = new Client({ connectionString: TEST_DB_URL });
        await listener.connect();
        try {
            await listener.query(`LISTEN ${NOTIFY_CHANNEL}`);
            const received = new Promise<{ id: number }>((resolve) => {
                listener.on("notification", (message) => {
                    const payload = JSON.parse(message.payload ?? "{}");
                    if (payload.type === "event" && payload.agent === "a1" && payload.text === undefined) {
                        resolve(payload);
                    }
                });
            });
            const event = await nudge("notifié");
            const payload = await Promise.race([received, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("pas de NOTIFY")), 3000))]);
            expect(payload.id).toBeGreaterThanOrEqual(event.id);
        } finally {
            await listener.end();
        }
    });

    it("n'émet aucun NOTIFY ni événement si l'insertion échoue", async () => {
        const before = (await db.runner.get<{ n: number }>(`SELECT count(*)::int AS n FROM events`))!.n;
        await expect(insertEvent(db.runner, { direction: "to_viewers", agentSlug: "inconnu", kind: "nudge", ttlS: 60 })).rejects.toThrow();
        expect((await db.runner.get<{ n: number }>(`SELECT count(*)::int AS n FROM events`))!.n).toBe(before);
        // le verrou est bien relâché : une insertion suivante passe
        await nudge("après échec");
    });
});
