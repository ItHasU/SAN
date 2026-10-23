import { applyMigrations } from "@dagda/server/src/sql/migrations";
import { createTestDatabase, TestDatabase } from "@dagda/server/src/test/pg.fixture";
import { APP_MODEL } from "@san/shared/src/entities/model";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { createAgent, updateAgent } from "./agents";
import { globToLike } from "./glob";
import { createGroup, setGroupMembers } from "./groups";
import { SAN_MIGRATIONS } from "./migrations";
import { visibleAgentSlugs } from "./permissions";
import { applyAutoToManual } from "./subscriptions";
import { generateToken } from "./tokens";
import { updateViewer } from "./viewers";

describe.runIf(inject("databaseAvailable"))("règle §8.1 et visibilité", () => {
    let db: TestDatabase;

    beforeAll(async () => {
        db = await createTestDatabase("subscriptions");
        await applyMigrations(db.runner, APP_MODEL, SAN_MIGRATIONS, "app");
    });
    afterAll(async () => {
        await db.dispose();
    });
    beforeEach(async () => {
        await db.runner.run(`TRUNCATE viewers, agents, agent_groups CASCADE`);
        await db.runner.run(
            `INSERT INTO viewers (id, kind, status, token_hash, subscription_mode) VALUES ('v1', 'web', 'active', $1, 'auto')`,
            generateToken("web").hash
        );
    });

    const rule = (scope: "agent" | "group", pattern: string) =>
        db.runner.run(`INSERT INTO permission_rules (viewer_id, scope, pattern, like_pattern) VALUES ('v1', $1, $2, $3)`, scope, pattern, globToLike(pattern));
    const subs = () => db.runner.all<any>(`SELECT agent_slug, subscribed, position, muted FROM subscriptions WHERE viewer_id = 'v1' ORDER BY agent_slug`);

    it("calcule les agents visibles par règles d'agent et de groupe, sans les révoqués", async () => {
        for (const slug of ["travail/ci/lint", "travail/ci/build", "travail/doc", "perso-a", "perso-b", "autre", "revoque"]) {
            await createAgent(db.runner, { slug, name: slug });
        }
        await updateAgent(db.runner, "revoque", { revoked: true });
        await createGroup(db.runner, { slug: "perso-maison", name: "Maison" });
        await setGroupMembers(db.runner, "perso-maison", ["perso-a", "autre"]);

        expect(await visibleAgentSlugs(db.runner, "v1")).toEqual([]);
        await rule("agent", "travail/ci/*");
        expect(await visibleAgentSlugs(db.runner, "v1")).toEqual(["travail/ci/build", "travail/ci/lint"]);
        await rule("group", "perso-*");
        expect(await visibleAgentSlugs(db.runner, "v1")).toEqual(["autre", "perso-a", "travail/ci/build", "travail/ci/lint"]);
        await rule("agent", "*");
        expect(await visibleAgentSlugs(db.runner, "v1")).toEqual(["autre", "perso-a", "perso-b", "travail/ci/build", "travail/ci/lint", "travail/doc"]);
    });

    it("un joker ne couvre pas par accident : `?` = un caractère, la casse et l'ancrage comptent", async () => {
        for (const slug of ["ab", "abc", "xab"]) {
            await createAgent(db.runner, { slug, name: slug });
        }
        await rule("agent", "a?");
        expect(await visibleAgentSlugs(db.runner, "v1")).toEqual(["ab"]);
    });

    it("auto -> manual : abonne chaque agent visible et conserve position et muted", async () => {
        for (const slug of ["a1", "a2", "hors"]) {
            await createAgent(db.runner, { slug, name: slug });
        }
        await rule("agent", "a?");
        // une préférence existante d'une période auto : elle doit survivre, abonnée
        await db.runner.run(`INSERT INTO subscriptions (viewer_id, agent_slug, subscribed, position, muted) VALUES ('v1', 'a1', false, 3, true)`);

        await updateViewer(db.runner, "v1", { subscriptionMode: "manual" });
        expect(await subs()).toEqual([
            { agent_slug: "a1", subscribed: true, position: 3, muted: true },
            { agent_slug: "a2", subscribed: true, position: null, muted: false }
        ]);
    });

    it("n'applique la règle que lors du passage auto -> manual", async () => {
        await createAgent(db.runner, { slug: "a1", name: "a1" });
        await rule("agent", "*");
        await updateViewer(db.runner, "v1", { name: "renommé" });
        expect(await subs()).toEqual([]);
        await updateViewer(db.runner, "v1", { subscriptionMode: "auto" }); // auto -> auto
        expect(await subs()).toEqual([]);

        await updateViewer(db.runner, "v1", { subscriptionMode: "manual" });
        expect(await subs()).toHaveLength(1);
        // manual -> auto : les lignes sont conservées comme préférences
        await updateViewer(db.runner, "v1", { subscriptionMode: "auto" });
        expect(await subs()).toHaveLength(1);
        // manual -> manual : rien de plus
        await db.runner.run(`UPDATE subscriptions SET subscribed = false`);
        await updateViewer(db.runner, "v1", { subscriptionMode: "manual" });
        await updateViewer(db.runner, "v1", { subscriptionMode: "manual" });
        expect((await subs())[0].subscribed).toBe(true); // auto -> manual a réabonné
    });

    it("applyAutoToManual est idempotent et renvoie les slugs abonnés", async () => {
        await createAgent(db.runner, { slug: "a1", name: "a1" });
        await rule("agent", "a1");
        expect(await applyAutoToManual(db.runner, "v1")).toEqual(["a1"]);
        expect(await applyAutoToManual(db.runner, "v1")).toEqual(["a1"]);
        expect(await subs()).toHaveLength(1);
    });

    it("un viewer inconnu et les règles d'un autre viewer ne donnent rien", async () => {
        await createAgent(db.runner, { slug: "a1", name: "a1" });
        await rule("agent", "*");
        expect(await visibleAgentSlugs(db.runner, "v-inconnu")).toEqual([]);
    });
});
