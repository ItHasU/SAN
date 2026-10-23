import { describe, expect, it, vi } from "vitest";
import { ViewerSession } from "./session";
import { DashboardStore } from "./store";
import { ViewerApi } from "./api";

const enc = new TextEncoder();

/** Flux SSE contrôlé : les fragments donnés puis fermeture */
function streamOf(chunks: string[]): Response {
    return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
            chunks.forEach((chunk) => controller.enqueue(enc.encode(chunk)));
            controller.close();
        }
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const config = { mode: "auto" as const, agents: [{ agent: "a", name: "A", subscribed: true, new: false, position: 0, muted: false, can_send_voice: false }] };
const sync = { server_time: "", capabilities_required: false, config_hash: "h1", config, states: [], events: [], has_more: false, next_sync_s: 60 };

function fakeApi(openStream: (lastId: string | undefined, call: number) => Response): { api: ViewerApi, lastIds: Array<string | undefined> } {
    const lastIds: Array<string | undefined> = [];
    let calls = 0;
    const api = {
        configHash: "h1",
        ensureRegistered: async () => undefined,
        putCapabilities: async () => ({ caps_hash: "x" }),
        sync: async () => sync,
        getConfig: async () => ({ config_hash: "h1", config }),
        events: async (_signal: AbortSignal, lastId?: string) => { lastIds.push(lastId); return openStream(lastId, calls++); },
        ack: async () => ({ ack: 0 })
    } as unknown as ViewerApi;
    return { api, lastIds };
}

describe("ViewerSession", () => {
    it("applique les messages SSE, puis se reconnecte avec Last-Event-ID après la coupure", async () => {
        const store = new DashboardStore();
        const live: number[] = [];
        let session!: ViewerSession;
        const { api, lastIds } = fakeApi((_last, call) => {
            if (call === 0) {
                return streamOf([
                    "event: hello\ndata: {\"config_hash\":\"h1\"}\n\n",
                    "id: 5\nevent: event\ndata: {\"id\":5,\"agent\":\"a\",\"kind\":\"nudge\",\"text\":\"hop\",\"created_at\":\"2026-10-23T10:00:00Z\"}\n\n",
                    ":\n\nevent: state\ndata: {\"agent\":\"a\",\"name\":\"A\",\"status\":\"working\",\"progress\":10,\"stale\":false,\"updated_at\":\"2026-10-23T10:00:00Z\"}\n\n"
                ]);
            }
            session.stop();
            return streamOf([]);
        });
        session = new ViewerSession(api, store, {
            onLiveEvent: (event) => live.push(event.id),
            sleep: async () => undefined, random: () => 0, backoffMs: { initial: 1, max: 2 }
        });
        session.start();
        await vi.waitFor(() => expect(lastIds.length).toBe(2));
        expect(lastIds).toEqual([undefined, "5"]);
        expect(live).toEqual([5]);
        expect(store.state("a")?.status).toBe("working");
        expect(store.events.map((e) => e.id)).toEqual([5]);
    });

    it("recharge la configuration quand le hash annoncé diffère", async () => {
        const store = new DashboardStore();
        let session!: ViewerSession;
        const getConfig = vi.fn(async () => ({ config_hash: "h2", config: { ...config, agents: [] } }));
        const { api } = fakeApi(() => {
            session.stop();
            return streamOf(["event: config\ndata: {\"config_hash\":\"h2\"}\n\n"]);
        });
        (api as unknown as { getConfig: unknown }).getConfig = getConfig;
        session = new ViewerSession(api, store, { sleep: async () => undefined });
        session.start();
        await vi.waitFor(() => expect(getConfig).toHaveBeenCalled());
        await vi.waitFor(() => expect(store.config?.agents).toEqual([]));
    });

    it("rallonge le délai de reconnexion (backoff plafonné) quand le flux échoue", async () => {
        const store = new DashboardStore();
        const delays: number[] = [];
        let attempts = 0;
        let session!: ViewerSession;
        const { api } = fakeApi(() => {
            attempts++;
            if (attempts >= 5) {
                session.stop();
            }
            throw new Error("réseau coupé");
        });
        session = new ViewerSession(api, store, { sleep: async (ms) => { delays.push(ms); }, random: () => 1, backoffMs: { initial: 100, max: 400 } });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        session.start();
        await vi.waitFor(() => expect(attempts).toBeGreaterThanOrEqual(5));
        warn.mockRestore();
        expect(delays.slice(0, 4)).toEqual([100, 200, 400, 400]);
    });
});
