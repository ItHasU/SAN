import { describe, expect, it, vi } from "vitest";
import { AdminApi, ApiError, TokenStore, ViewerApi } from "./api";

function memoryTokens(initial: string | null = null): TokenStore & { value: string | null } {
    const store = {
        value: initial,
        get: () => store.value,
        viewerId: () => "v_x",
        set: (token: string) => { store.value = token; },
        clear: () => { store.value = null; }
    };
    return store;
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const caps = (): { protocol_version: number } => ({ protocol_version: 1 });

describe("ViewerApi", () => {
    it("s'enregistre par la session quand il n'a pas de jeton, puis appelle avec le Bearer", async () => {
        const tokens = memoryTokens();
        const calls: Array<{ url: string, auth: string | null, credentials?: RequestCredentials }> = [];
        const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
            calls.push({ url, auth: new Headers(init?.headers).get("Authorization"), credentials: init?.credentials });
            return url.endsWith("/web/register") ? json(201, { viewer_id: "v_1", token: "web_abc" }) : json(200, { ack: 3 });
        });
        const api = new ViewerApi({ tokens, capabilities: caps, fetch: fetchFn });
        await api.ack(3);
        expect(calls.map((c) => c.url)).toEqual(["/api/v1/web/register", "/api/v1/viewer/ack"]);
        expect(calls[0]!.credentials).toBe("same-origin");
        expect(calls[1]!.auth).toBe("Bearer web_abc");
        expect(tokens.value).toBe("web_abc");
    });

    it("sur 401 : efface le jeton, se réenregistre et rejoue l'appel une fois", async () => {
        const tokens = memoryTokens("web_old");
        let registered = 0;
        const onReregistered = vi.fn();
        const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/web/register")) {
                registered++;
                return json(201, { viewer_id: "v_2", token: "web_new" });
            }
            return new Headers(init?.headers).get("Authorization") === "Bearer web_new" ? json(200, { ack: 1 }) : json(401, { error: "unauthorized", message: "Jeton inconnu" });
        });
        const api = new ViewerApi({ tokens, capabilities: caps, fetch: fetchFn, onReregistered });
        await expect(api.ack(1)).resolves.toEqual({ ack: 1 });
        expect(registered).toBe(1);
        expect(tokens.value).toBe("web_new");
        expect(onReregistered).toHaveBeenCalledOnce();
    });

    it("ne boucle pas : un second 401 est remonté", async () => {
        const tokens = memoryTokens("web_old");
        const fetchFn = vi.fn(async (url: string) => url.endsWith("/web/register") ? json(201, { viewer_id: "v", token: "web_n" }) : json(401, { error: "unauthorized", message: "non" }));
        const api = new ViewerApi({ tokens, capabilities: caps, fetch: fetchFn });
        await expect(api.ack(1)).rejects.toMatchObject({ status: 401 });
        expect(fetchFn).toHaveBeenCalledTimes(3);
    });

    it("sur 409 config_conflict : adopte la configuration du serveur et son hash", async () => {
        const tokens = memoryTokens("web_t");
        const serverConfig = { mode: "auto", agents: [{ agent: "a", name: "A", subscribed: true, new: false, position: 0, muted: false, can_send_voice: false }] };
        const bodies: unknown[] = [];
        const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
            bodies.push(JSON.parse(String(init?.body)));
            return json(409, { error: "config_conflict", message: "changé", config_hash: "h2", config: serverConfig });
        });
        const api = new ViewerApi({ tokens, capabilities: caps, fetch: fetchFn });
        api.configHash = "h1";
        const result = await api.updateConfig([{ agent: "a", position: 0 }]);
        expect(bodies[0]).toEqual({ base_hash: "h1", subscriptions: [{ agent: "a", position: 0 }] });
        expect(result).toEqual({ ok: false, conflict: true, view: { config_hash: "h2", config: serverConfig } });
        expect(api.configHash).toBe("h2");
    });

    it("sur succès, le hash renvoyé devient la base du prochain PUT", async () => {
        const fetchFn = vi.fn(async () => json(200, { config_hash: "h9", config: { mode: "auto", agents: [] } }));
        const api = new ViewerApi({ tokens: memoryTokens("web_t"), capabilities: caps, fetch: fetchFn });
        const result = await api.updateConfig([]);
        expect(result.ok).toBe(true);
        expect(api.configHash).toBe("h9");
    });

    it("les autres erreurs deviennent des ApiError", async () => {
        const fetchFn = vi.fn(async () => json(403, { error: "agent_not_visible", message: "non visible" }));
        const api = new ViewerApi({ tokens: memoryTokens("web_t"), capabilities: caps, fetch: fetchFn });
        await expect(api.updateConfig([])).rejects.toBeInstanceOf(ApiError);
    });
});

describe("AdminApi", () => {
    it("ajoute ?dry_run=1 pour l'aperçu et rend gained/lost", async () => {
        const urls: string[] = [];
        const fetchFn = vi.fn(async (url: string) => {
            urls.push(url);
            return json(200, { dry_run: true, gained: [{ viewer: "v1", viewer_name: "W", agent: "a" }], lost: [] });
        });
        const api = new AdminApi({ fetch: fetchFn });
        const impact = await api.createRule("v1", { scope: "agent", pattern: "*", can_send_voice: false }).preview();
        expect(urls).toEqual(["/api/v1/admin/viewers/v1/rules?dry_run=1"]);
        expect(impact.gained).toHaveLength(1);
    });

    it("encode les slugs hiérarchiques dans l'URL", async () => {
        const urls: string[] = [];
        const api = new AdminApi({ fetch: async (url) => { urls.push(url); return json(200, {}); } });
        await api.regenerateToken("travail/ci").apply();
        expect(urls[0]).toBe("/api/v1/admin/agents/travail%2Fci/token");
    });

    it("signale une session expirée (401)", async () => {
        const onUnauthorized = vi.fn();
        const api = new AdminApi({ fetch: async () => json(401, { error: "unauthorized", message: "x" }), onUnauthorized });
        await expect(api.agents()).rejects.toMatchObject({ status: 401 });
        expect(onUnauthorized).toHaveBeenCalled();
    });

    it("agents en attente : filtre, approbation avec groupes, rejet", async () => {
        const calls: Array<{ url: string, method?: string, body?: unknown }> = [];
        const api = new AdminApi({ fetch: async (url, init) => { calls.push({ url, method: init?.method, body: init?.body == null ? undefined : JSON.parse(String(init.body)) }); return json(200, { agents: [], dry_run: true, gained: [], lost: [] }); } });
        await api.agents("pending");
        await api.approveAgent("travail/ci", ["g1"]).preview();
        await api.rejectAgent("a").preview();
        expect(calls).toEqual([
            { url: "/api/v1/admin/agents?status=pending", method: "GET", body: undefined },
            { url: "/api/v1/admin/agents/travail%2Fci/approve?dry_run=1", method: "POST", body: { groups: ["g1"] } },
            { url: "/api/v1/admin/agents/a?dry_run=1", method: "DELETE", body: undefined }
        ]);
    });

    it("jetons d'enrôlement : liste, création, révocation", async () => {
        const calls: Array<{ url: string, method?: string, body?: unknown }> = [];
        const api = new AdminApi({ fetch: async (url, init) => { calls.push({ url, method: init?.method, body: init?.body == null ? undefined : JSON.parse(String(init.body)) }); return json(200, { tokens: [], token: "enr_x", enrollment_token: {} }); } });
        await api.enrollmentTokens("ci");
        await expect(api.createEnrollmentToken("ci", { label: "L", expires_at: "2030-01-01T00:00:00.000Z" })).resolves.toMatchObject({ token: "enr_x" });
        await api.revokeEnrollmentToken("ci", 4);
        expect(calls).toEqual([
            { url: "/api/v1/admin/groups/ci/enrollment-tokens", method: "GET", body: undefined },
            { url: "/api/v1/admin/groups/ci/enrollment-tokens", method: "POST", body: { label: "L", expires_at: "2030-01-01T00:00:00.000Z" } },
            { url: "/api/v1/admin/groups/ci/enrollment-tokens/4", method: "DELETE", body: undefined }
        ]);
    });
});
