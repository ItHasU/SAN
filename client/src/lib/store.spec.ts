import { describe, expect, it } from "vitest";
import { DashboardStore, INACTIVE_AFTER_MS, isActive, lastHeard } from "./store";

const agent = (name: string, position: number | null, subscribed = true) => ({ agent: name.toLowerCase(), name, subscribed, new: false, position, muted: false, can_send_voice: false });

describe("DashboardStore", () => {
    it("ordonne les agents suivis par position puis par nom", () => {
        const store = new DashboardStore();
        store.setConfig({ mode: "auto", agents: [agent("Zed", null), agent("Bob", 1), agent("Amy", 0), agent("Cut", null, false)] });
        expect(store.tracked().map((t) => t.config.name)).toEqual(["Amy", "Bob", "Zed"]);
    });

    it("dédoublonne les événements (synchronisation puis SSE) et garde le plus récent en premier", () => {
        const store = new DashboardStore();
        const event = (id: number) => ({ id, agent: "a", kind: "nudge" as const, created_at: "2026-10-23T10:00:00Z" });
        expect(store.applySync({ config: null, states: [], events: [event(1), event(2)] }).map((e) => e.id)).toEqual([1, 2]);
        const result = store.applyMessage({ event: "event", data: JSON.stringify(event(2)), id: "2" });
        expect(result.event).toBeUndefined();
        expect(store.applyMessage({ event: "event", data: JSON.stringify(event(3)) }).event?.id).toBe(3);
        expect(store.events.map((e) => e.id)).toEqual([3, 2, 1]);
        expect(store.maxEventId).toBe(3);
    });

    it("hello et config rendent le hash annoncé ; un JSON invalide est ignoré", () => {
        const store = new DashboardStore();
        expect(store.applyMessage({ event: "hello", data: "{\"config_hash\":\"abc\"}" })).toEqual({ configHash: "abc" });
        expect(store.applyMessage({ event: "config", data: "pas du json" })).toEqual({});
    });

    it("notifie les abonnés quand un état arrive", () => {
        const store = new DashboardStore();
        let count = 0;
        const off = store.subscribe(() => count++);
        store.applyMessage({ event: "state", data: JSON.stringify({ agent: "a", name: "A", status: "idle", progress: null, stale: false, updated_at: "x" }) });
        off();
        store.applyState({ agent: "a", name: "A", status: "done", progress: null, stale: false, updated_at: "y" });
        expect(count).toBe(1);
        expect(store.state("a")?.status).toBe("done");
    });
    it("un agent est actif s'il a donné des nouvelles (état ou événement) depuis moins de 24 h", () => {
        const now = Date.parse("2026-11-01T12:00:00Z");
        const old = new Date(now - INACTIVE_AFTER_MS - 1000).toISOString();
        const recent = new Date(now - 60_000).toISOString();
        const entry = (updated_at: string | null) => ({
            config: agent("Amy", 0),
            state: updated_at == null ? null : { agent: "amy", name: "Amy", status: "idle" as const, progress: null, stale: false, updated_at }
        });
        const event = (created_at: string, name = "amy") => ({ id: 1, agent: name, kind: "nudge" as const, created_at });
        expect(isActive(entry(recent), [], now)).toBe(true);
        expect(isActive(entry(old), [], now)).toBe(false);
        expect(isActive(entry(null), [], now)).toBe(false);
        expect(isActive(entry(old), [event(recent)], now)).toBe(true);
        expect(isActive(entry(old), [event(recent, "bob")], now)).toBe(false);
        expect(lastHeard(entry(null), [event("pas une date")])).toBeNull();
    });
});
