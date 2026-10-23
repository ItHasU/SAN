import { applyMigrations } from "@dagda/server/src/sql/migrations";
import { createTestDatabase, TestDatabase } from "@dagda/server/src/test/pg.fixture";
import { APP_MODEL } from "@san/shared/src/entities/model";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { SAN_MIGRATIONS } from "./migrations";
import { runPeriodicTasks, startPeriodicTasks } from "./purge";
import { generateToken } from "./tokens";
import { purgePendingViewers } from "./viewers";

describe.runIf(inject("databaseAvailable"))("purge des viewers pending", () => {
    let db: TestDatabase;

    beforeAll(async () => {
        db = await createTestDatabase("purge");
        await applyMigrations(db.runner, APP_MODEL, SAN_MIGRATIONS, "app");
    });
    afterAll(async () => {
        await db.dispose();
    });
    afterEach(async () => {
        vi.useRealTimers();
        await db.runner.run(`DELETE FROM viewers`);
    });

    const insert = (id: string, status: string, pendingDaysAgo: number | null) =>
        db.runner.run(
            `INSERT INTO viewers (id, kind, status, token_hash, subscription_mode, hardware_id, pending_since)
             VALUES ($1, 'device', $2, $3, 'manual', $1, CASE WHEN $4::int IS NULL THEN NULL ELSE now() - make_interval(days => $4::int) END)`,
            id, status, generateToken("dev").hash, pendingDaysAgo
        );
    const ids = async () => (await db.runner.all<{ id: string }>(`SELECT id FROM viewers ORDER BY id`)).map((row) => row.id);

    it("supprime les pending de plus de 7 jours (et eux seuls), avec leur jeton", async () => {
        await insert("old-pending", "pending", 8);
        await insert("fresh-pending", "pending", 6);
        await insert("old-active", "active", 30);
        await insert("old-revoked", "revoked", 30);
        expect(await purgePendingViewers(db.runner)).toBe(1);
        expect(await ids()).toEqual(["fresh-pending", "old-active", "old-revoked"]);
    });

    it("respecte l'horloge fournie et la durée configurée", async () => {
        await insert("p", "pending", 2);
        expect(await purgePendingViewers(db.runner, 7, new Date())).toBe(0);
        expect(await purgePendingViewers(db.runner, 7, new Date(Date.now() + 6 * 86400_000))).toBe(1);
        await insert("q", "pending", 2);
        expect(await purgePendingViewers(db.runner, 1)).toBe(1);
    });

    it("runPeriodicTasks rapporte le nombre de demandes purgées", async () => {
        await insert("a", "pending", 10);
        await insert("b", "pending", 9);
        expect(await runPeriodicTasks(db.runner, { pendingMaxAgeDays: 7 })).toEqual({ purgedPendingViewers: 2 });
        expect(await runPeriodicTasks(db.runner, { pendingMaxAgeDays: 7 })).toEqual({ purgedPendingViewers: 0 });
    });

    it("la tâche planifiée purge à chaque période et s'arrête", async () => {
        await insert("old", "pending", 9);
        const logs: string[] = [];
        const stop = startPeriodicTasks(db.runner, { pendingMaxAgeDays: 7, purgeIntervalMs: 50 }, (message) => logs.push(message));
        try {
            await vi.waitFor(async () => expect(await ids()).toEqual([]), { timeout: 3000, interval: 25 });
            expect(logs.join("\n")).toContain("1 demande");
        } finally {
            stop();
        }
        await insert("old2", "pending", 9);
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(await ids()).toEqual(["old2"]);
    });
});
