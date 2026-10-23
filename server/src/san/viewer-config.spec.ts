import { applyMigrations } from "@dagda/server/src/sql/migrations";
import { createTestDatabase, TestDatabase } from "@dagda/server/src/test/pg.fixture";
import { APP_MODEL } from "@san/shared/src/entities/model";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { createAgent, updateAgent } from "./agents";
import { ApiError } from "./errors";
import { createGroup, setGroupMembers } from "./groups";
import { SAN_MIGRATIONS } from "./migrations";
import { accessDetail, createRule, ruleCoverage, updateRule } from "./permissions";
import { generateToken } from "./tokens";
import { applySubscriptions, canonicalJson, computeConfig, configHash, consultConfig, parseSubscriptions, ViewerConfig } from "./viewer-config";
import { updateViewer } from "./viewers";

const BASE: ViewerConfig = {
    mode: "manual",
    agents: [
        { agent: "a1", name: "Un", subscribed: true, new: false, position: 0, muted: false, can_send_voice: true },
        { agent: "a2", name: "Deux", subscribed: false, new: true, position: null, muted: true, can_send_voice: false }
    ]
};

describe("config_hash", () => {
    it("fait 16 caractères hex, stable d'un appel à l'autre et de l'ordre des clés", () => {
        const hash = configHash(BASE);
        expect(hash).toMatch(/^[0-9a-f]{16}$/);
        expect(configHash(structuredClone(BASE))).toBe(hash);
        const shuffled = { agents: BASE.agents.map((a) => Object.fromEntries(Object.entries(a).reverse())), mode: BASE.mode };
        expect(configHash(shuffled as ViewerConfig)).toBe(hash);
        expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
    });

    it("change quand n'importe quel élément change", () => {
        const variants: Array<(c: ViewerConfig) => void> = [
            (c) => { c.mode = "auto"; },
            (c) => { c.agents[0]!.agent = "a9"; },
            (c) => { c.agents[0]!.name = "Autre"; },
            (c) => { c.agents[0]!.subscribed = false; },
            (c) => { c.agents[1]!.new = false; },
            (c) => { c.agents[0]!.position = 1; },
            (c) => { c.agents[1]!.position = 0; },
            (c) => { c.agents[1]!.muted = false; },
            (c) => { c.agents[0]!.can_send_voice = false; },
            (c) => { c.agents.reverse(); },
            (c) => { c.agents.pop(); },
            (c) => { c.agents.push({ ...c.agents[0]!, agent: "a3" }); }
        ];
        const hashes = new Set([configHash(BASE)]);
        for (const mutate of variants) {
            const copy = structuredClone(BASE);
            mutate(copy);
            hashes.add(configHash(copy));
        }
        expect(hashes.size).toBe(variants.length + 1);
    });
});

describe.runIf(inject("databaseAvailable"))("configuration effective", () => {
    let db: TestDatabase;
    const sql = () => db.runner;

    beforeAll(async () => {
        db = await createTestDatabase("viewer_config");
        await applyMigrations(db.runner, APP_MODEL, SAN_MIGRATIONS, "app");
    });
    afterAll(async () => {
        await db.dispose();
    });
    beforeEach(async () => {
        await sql().run(`TRUNCATE events, agent_state, subscriptions, permission_rules, agent_group_members, agent_groups, agents, viewers CASCADE`);
        await viewer("v1", "manual", { audio_in: { formats: ["pcm_s16le"] } });
    });

    const viewer = (id: string, mode: "auto" | "manual", capabilities: unknown = null, status = "active") =>
        sql().run(
            `INSERT INTO viewers (id, kind, name, status, token_hash, subscription_mode, capabilities) VALUES ($1, 'device', $1, $2, $3, $4, $5::jsonb)`,
            id, status, generateToken("dev").hash, mode, JSON.stringify(capabilities)
        );
    const agent = (slug: string, name = slug) => createAgent(sql(), { slug, name });
    const rule = (scope: "agent" | "group", pattern: string, voice = false, viewerId = "v1") =>
        createRule(sql(), viewerId, { scope, pattern, can_send_voice: voice });
    const slugs = async (viewerId = "v1") => (await computeConfig(sql(), viewerId)).agents.map((a) => a.agent);

    describe("couverture par motifs et groupes hiérarchiques", () => {
        beforeEach(async () => {
            for (const slug of ["travail/ci/lint", "travail/ci/build", "perso-maison", "veille", "a1", "a2", "ab1"]) {
                await agent(slug);
            }
            await createGroup(sql(), { slug: "travail", name: "Travail" });
            await createGroup(sql(), { slug: "travail/ci", name: "CI" });
            await createGroup(sql(), { slug: "perso", name: "Perso" });
            await createGroup(sql(), { slug: "perso-x", name: "Perso X" });
            await setGroupMembers(sql(), "travail/ci", ["travail/ci/lint", "travail/ci/build"]);
            await setGroupMembers(sql(), "travail", ["veille"]);
            await setGroupMembers(sql(), "perso-x", ["perso-maison", "a1"]);
        });

        it("scope agent : * traverse les niveaux, ? vaut un caractère, sensible à la casse", async () => {
            const covered = async (pattern: string) => {
                const r = await rule("agent", pattern);
                const out = (await ruleCoverage(sql(), r.id)).agents.map((a) => a.slug);
                await sql().run(`DELETE FROM permission_rules WHERE id = $1`, r.id);
                return out;
            };
            expect(await covered("travail/ci/*")).toEqual(["travail/ci/build", "travail/ci/lint"]);
            expect(await covered("travail/*")).toEqual(["travail/ci/build", "travail/ci/lint"]);
            expect(await covered("a?")).toEqual(["a1", "a2"]);
            expect(await covered("a*1")).toEqual(["a1", "ab1"]);
            expect(await covered("a")).toEqual([]);
            expect(await covered("*")).toHaveLength(7);
            expect(await covered("veille")).toEqual(["veille"]);
        });

        it("scope group : le motif porte sur le slug du groupe, pas sur celui de l'agent", async () => {
            const covered = async (pattern: string) => {
                const r = await rule("group", pattern);
                const coverage = await ruleCoverage(sql(), r.id);
                await sql().run(`DELETE FROM permission_rules WHERE id = $1`, r.id);
                return { agents: coverage.agents.map((a) => a.slug), groups: coverage.groups.map((g) => g.slug) };
            };
            expect(await covered("travail/*")).toEqual({ agents: ["travail/ci/build", "travail/ci/lint"], groups: ["travail/ci"] });
            expect(await covered("travail")).toEqual({ agents: ["veille"], groups: ["travail"] });
            expect(await covered("travail*")).toEqual({ agents: ["travail/ci/build", "travail/ci/lint", "veille"], groups: ["travail", "travail/ci"] });
            expect(await covered("perso-*")).toEqual({ agents: ["a1", "perso-maison"], groups: ["perso-x"] });
            // « perso » (sans tiret) ne couvre pas le groupe « perso-x »
            expect(await covered("perso")).toEqual({ agents: [], groups: ["perso"] });
            expect(await covered("*")).toEqual({ agents: ["a1", "perso-maison", "travail/ci/build", "travail/ci/lint", "veille"], groups: ["perso", "perso-x", "travail", "travail/ci"] });
        });

        it("une règle à wildcard couvre les agents et groupes créés ensuite", async () => {
            await rule("group", "travail/*");
            await rule("agent", "nouveau-*");
            expect(await slugs()).toEqual(["travail/ci/build", "travail/ci/lint"]);
            await agent("nouveau-1");
            await agent("travail/ci/test");
            await setGroupMembers(sql(), "travail/ci", ["travail/ci/lint", "travail/ci/build", "travail/ci/test"]);
            expect(await slugs()).toEqual(["nouveau-1", "travail/ci/build", "travail/ci/lint", "travail/ci/test"]);
        });

        it("exclut les agents révoqués et conserve leurs lignes d'abonnement", async () => {
            await rule("agent", "a?");
            await applySubscriptions(sql(), "v1", [{ agent: "a1", subscribed: true, position: 2, muted: true }], "bad_request");
            await updateAgent(sql(), "a1", { revoked: true });
            expect(await slugs()).toEqual(["a2"]);
            expect(await sql().get(`SELECT 1 AS x FROM subscriptions WHERE agent_slug = 'a1'`)).not.toBeNull();
            expect((await accessDetail(sql(), "v1", "a1")).access).toBe(false);
        });

        it("accessDetail liste les règles accordant l'accès, avec les groupes traversés", async () => {
            const byAgent = await rule("agent", "a*");
            const byGroup = await rule("group", "perso-*", true);
            await rule("agent", "veille");
            const detail = await accessDetail(sql(), "v1", "a1");
            expect(detail.access).toBe(true);
            expect(detail.rules.map((r) => [r.id, r.via_groups])).toEqual([[byAgent.id, []], [byGroup.id, ["perso-x"]]]);
            expect(detail.rule_can_send_voice).toBe(true);
            expect(detail.audio_in).toBe(true);
            expect(detail.can_send_voice).toBe(true);
            const none = await accessDetail(sql(), "v1", "travail/ci/lint");
            expect(none).toMatchObject({ access: false, rules: [], can_send_voice: false });
            await expect(accessDetail(sql(), "v1", "inconnu")).rejects.toMatchObject({ status: 404 });
            await expect(accessDetail(sql(), "v-inconnu", "a1")).rejects.toMatchObject({ status: 404 });
        });

        it("modifier une règle recalcule son motif LIKE", async () => {
            const r = await rule("agent", "a1");
            expect(await slugs()).toEqual(["a1"]);
            await updateRule(sql(), r.id, { pattern: "a?" });
            expect(await slugs()).toEqual(["a1", "a2"]);
            expect((await sql().get<any>(`SELECT like_pattern FROM permission_rules WHERE id = $1`, r.id))!.like_pattern).toBe("a_");
            await expect(updateRule(sql(), r.id, { pattern: "a%" })).rejects.toBeInstanceOf(ApiError);
        });
    });

    describe("can_send_voice effectif", () => {
        it("exige une règle qui le porte ET audio_in déclaré", async () => {
            await agent("a1");
            await agent("a2");
            await viewer("v-mute", "manual", { display: {} });
            await rule("agent", "a1", true);
            await rule("agent", "a2", false);
            await rule("agent", "a2", true, "v1");
            const voice = async (id: string) => Object.fromEntries((await computeConfig(sql(), id)).agents.map((a) => [a.agent, a.can_send_voice]));
            expect(await voice("v1")).toEqual({ a1: true, a2: true });
            // même règle, mais pas de micro déclaré
            await rule("agent", "a1", true, "v-mute");
            expect(await voice("v-mute")).toEqual({ a1: false });
            await sql().run(`UPDATE viewers SET capabilities = NULL WHERE id = 'v1'`);
            expect(await voice("v1")).toEqual({ a1: false, a2: false });
        });
    });

    describe("modes d'abonnement", () => {
        beforeEach(async () => {
            await agent("zeta", "Zeta");
            await agent("alpha", "Alpha");
            await agent("beta", "Beta");
            await rule("agent", "*");
        });

        it("manual : un agent sans ligne est nouveau et non suivi ; la consultation crée les lignes", async () => {
            const before = await computeConfig(sql(), "v1");
            expect(before.agents.map((a) => [a.agent, a.subscribed, a.new])).toEqual([["alpha", false, true], ["beta", false, true], ["zeta", false, true]]);
            expect(await sql().all(`SELECT * FROM subscriptions`)).toHaveLength(0);

            const view = await consultConfig(sql(), "v1");
            expect(view.config.agents.every((a) => a.new && !a.subscribed)).toBe(true);
            const rows = await sql().all<any>(`SELECT agent_slug, subscribed, first_seen_at FROM subscriptions ORDER BY agent_slug`);
            expect(rows.map((r) => [r.agent_slug, r.subscribed])).toEqual([["alpha", false], ["beta", false], ["zeta", false]]);
            expect(rows[0].first_seen_at).toBeInstanceOf(Date);

            // le hash renvoyé est celui de l'état persisté, que les synchronisations suivantes verront
            const after = await computeConfig(sql(), "v1");
            expect(after.agents.every((a) => !a.new)).toBe(true);
            expect(view.config_hash).toBe(configHash(after));
            const again = await consultConfig(sql(), "v1");
            expect(again.config.agents.every((a) => !a.new)).toBe(true);
            expect(again.config_hash).toBe(view.config_hash);
        });

        it("manual : un nouvel agent visible apparaît comme nouveau, les autres non", async () => {
            await consultConfig(sql(), "v1");
            await agent("gamma", "Gamma");
            const config = await computeConfig(sql(), "v1");
            expect(config.agents.filter((a) => a.new).map((a) => a.agent)).toEqual(["gamma"]);
        });

        it("auto : subscribed toujours true, new toujours false, tri position puis nom", async () => {
            await updateViewer(sql(), "v1", { subscriptionMode: "auto" });
            await sql().run(`DELETE FROM subscriptions`);
            await sql().run(`INSERT INTO subscriptions (viewer_id, agent_slug, subscribed, position, muted) VALUES ('v1', 'zeta', false, 0, true)`);
            const config = await computeConfig(sql(), "v1");
            expect(config.mode).toBe("auto");
            expect(config.agents.map((a) => [a.agent, a.subscribed, a.new, a.position, a.muted])).toEqual([
                ["zeta", true, false, 0, true], ["alpha", true, false, null, false], ["beta", true, false, null, false]
            ]);
            expect((await consultConfig(sql(), "v1")).config.agents).toHaveLength(3);
            expect(await sql().all(`SELECT * FROM subscriptions`)).toHaveLength(1);
        });

        it("auto -> manual abonne les agents visibles ; manual -> auto conserve les lignes", async () => {
            await updateViewer(sql(), "v1", { subscriptionMode: "auto" });
            await updateViewer(sql(), "v1", { subscriptionMode: "manual" });
            expect((await computeConfig(sql(), "v1")).agents.map((a) => [a.agent, a.subscribed, a.new])).toEqual([["alpha", true, false], ["beta", true, false], ["zeta", true, false]]);
            await applySubscriptions(sql(), "v1", [{ agent: "beta", subscribed: false, position: 5, muted: true }], "bad_request");
            await updateViewer(sql(), "v1", { subscriptionMode: "auto" });
            expect(await sql().all(`SELECT * FROM subscriptions`)).toHaveLength(3);
            const config = await computeConfig(sql(), "v1");
            expect(config.agents.map((a) => [a.agent, a.subscribed, a.position, a.muted])).toEqual([
                ["beta", true, 5, true], ["alpha", true, null, false], ["zeta", true, null, false]
            ]);
            // retour en manual : la préférence subscribed=false de beta a été écrasée par la règle §8.1 (tout est abonné)
            await updateViewer(sql(), "v1", { subscriptionMode: "manual" });
            expect((await computeConfig(sql(), "v1")).agents.every((a) => a.subscribed)).toBe(true);
        });

        it("le droit retiré puis rendu restaure la configuration telle quelle", async () => {
            await applySubscriptions(sql(), "v1", [{ agent: "beta", subscribed: true, position: 1, muted: true }], "bad_request");
            const before = await computeConfig(sql(), "v1");
            await sql().run(`DELETE FROM permission_rules`);
            expect((await computeConfig(sql(), "v1")).agents).toEqual([]);
            await rule("agent", "*");
            expect(await computeConfig(sql(), "v1")).toEqual(before);
        });

        it("applySubscriptions rejette en bloc les agents non visibles (403 viewer, 400 admin) sans rien écrire", async () => {
            await agent("cache");
            await sql().run(`DELETE FROM permission_rules`);
            await rule("agent", "alpha");
            const patches = [{ agent: "alpha", subscribed: true }, { agent: "cache", subscribed: true }];
            await expect(applySubscriptions(sql(), "v1", patches, "forbidden")).rejects.toMatchObject({ status: 403, code: "agent_not_visible" });
            await expect(applySubscriptions(sql(), "v1", patches, "bad_request")).rejects.toMatchObject({ status: 400 });
            await expect(applySubscriptions(sql(), "v1", [{ agent: "inexistant" }], "forbidden")).rejects.toMatchObject({ status: 403 });
            expect(await sql().all(`SELECT * FROM subscriptions`)).toHaveLength(0);
        });

        it("applySubscriptions ne touche pas aux champs absents", async () => {
            await applySubscriptions(sql(), "v1", [{ agent: "alpha", subscribed: true, position: 4, muted: true }], "bad_request");
            await applySubscriptions(sql(), "v1", [{ agent: "alpha", muted: false }], "bad_request");
            await applySubscriptions(sql(), "v1", [{ agent: "alpha", position: null }], "bad_request");
            expect(await sql().get(`SELECT subscribed, position, muted FROM subscriptions`)).toEqual({ subscribed: true, position: null, muted: false });
        });
    });

    it("parseSubscriptions valide la forme", () => {
        expect(parseSubscriptions([{ agent: "a", subscribed: true, position: 0, muted: false }, { agent: "b", position: null }])).toHaveLength(2);
        const bad: unknown[] = [
            "x", [1], [{}], [{ agent: "a", subscribed: "yes" }], [{ agent: "a", muted: 1 }], [{ agent: "a", position: -1 }],
            [{ agent: "a", position: 1.5 }], [{ agent: "a", position: "1" }], [{ agent: "a" }, { agent: "a" }], Array(1001).fill({ agent: "a" })
        ];
        for (const value of bad) {
            expect(() => parseSubscriptions(value), JSON.stringify(value)?.slice(0, 40)).toThrow(ApiError);
        }
    });
});
