import { createTestDatabase, TestDatabase } from "@dagda/server/src/test/pg.fixture";
import { applyMigrations } from "@dagda/server/src/sql/migrations";
import { APP_MODEL } from "@san/shared/src/entities/model";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { SAN_MIGRATIONS } from "./migrations";

describe.runIf(inject("databaseAvailable"))("migrations SAN", () => {
    let db: TestDatabase;

    beforeAll(async () => {
        db = await createTestDatabase("migrations");
    });
    afterAll(async () => {
        await db.dispose();
    });

    it("crée le schéma de la spec §5 (sans users) et ne se rejoue pas", async () => {
        const first = await applyMigrations(db.runner, APP_MODEL, SAN_MIGRATIONS, "app");
        expect(first).toEqual(["0001-san-schema", "0002-tts-jobs", "0003-tracking-start", "0004-nudge-type", "0005-voice-plays"]);
        expect(await applyMigrations(db.runner, APP_MODEL, SAN_MIGRATIONS, "app")).toEqual([]);

        const tables = await db.runner.all<{ table_name: string }>(
            `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`, db.schema
        );
        const names = tables.map((row) => row.table_name);
        for (const expected of ["agents", "agent_groups", "agent_group_members", "viewers", "permission_rules", "subscriptions",
            "agent_state", "voice_clips", "voice_renditions", "events", "cursors"]) {
            expect(names, expected).toContain(expected);
        }
        expect(names).not.toContain("users");
    });

    it("0004 : les nudges existants deviennent \"notification\", les voix restent NULL, rejouable", async () => {
        const old = await createTestDatabase("migrations-0004");
        try {
            await applyMigrations(old.runner, APP_MODEL, SAN_MIGRATIONS.slice(0, 3), "app");
            await old.runner.run(`INSERT INTO agents (slug, name, token_hash) VALUES ('a', 'A', 'h')`);
            await old.runner.run(`INSERT INTO events (direction, agent_slug, kind, text, expires_at) VALUES ('to_viewers', 'a', 'nudge', 'vieux', now() + interval '1 hour')`);
            await old.runner.run(`INSERT INTO events (direction, agent_slug, kind, expires_at) VALUES ('to_viewers', 'a', 'voice', now() + interval '1 hour')`);
            expect(await applyMigrations(old.runner, APP_MODEL, SAN_MIGRATIONS, "app")).toEqual(["0004-nudge-type", "0005-voice-plays"]);
            const rows = await old.runner.all<{ kind: string, nudge_type: string | null }>(`SELECT kind, nudge_type FROM events ORDER BY id`);
            expect(rows).toEqual([{ kind: "nudge", nudge_type: "notification" }, { kind: "voice", nudge_type: null }]);
            await expect(old.runner.run(`UPDATE events SET nudge_type = 'x'`)).rejects.toThrow();
            // la migration est idempotente : rejouée à la main, elle ne casse rien
            await SAN_MIGRATIONS[3]!.up(old.runner as never);
        } finally {
            await old.dispose();
        }
    });

    it("applique les contraintes CHECK et les index partiels de pending", async () => {
        const run = (sql: string, ...params: any[]) => db.runner.run(sql, ...params);
        await expect(run(`INSERT INTO viewers (id, kind, status, token_hash, subscription_mode) VALUES ('x', 'toaster', 'active', 'a', 'auto')`)).rejects.toThrow();
        await run(`INSERT INTO viewers (id, kind, status, token_hash, hardware_id, pairing_code, subscription_mode) VALUES ('a', 'device', 'pending', 'a1', 'hw', 'K7-42', 'manual')`);
        // même hardware_id ou même code parmi les pending : refusé
        await expect(run(`INSERT INTO viewers (id, kind, status, token_hash, hardware_id, pairing_code, subscription_mode) VALUES ('b', 'device', 'pending', 'b1', 'hw', 'K8-42', 'manual')`)).rejects.toThrow();
        await expect(run(`INSERT INTO viewers (id, kind, status, token_hash, hardware_id, pairing_code, subscription_mode) VALUES ('c', 'device', 'pending', 'c1', 'hw2', 'K7-42', 'manual')`)).rejects.toThrow();
        // un viewer actif peut partager le hardware_id d'un pending
        await run(`INSERT INTO viewers (id, kind, status, token_hash, hardware_id, subscription_mode) VALUES ('d', 'device', 'active', 'd1', 'hw', 'manual')`);
        await expect(run(`INSERT INTO agent_state (agent_slug, status) VALUES ('nope', 'idle')`)).rejects.toThrow();
    });
});
