import { AccessDetail, AgentRecord, ConfigView, DryRunResult, GroupRecord, Impact, RuleCoverage, RuleRecord, SubscriptionMode, SubscriptionPatch, SyncResponse, ViewerCapabilities, ViewerConfig, ViewerRecord } from "@san/shared/src/api/types";

export const API_BASE = "/api/v1";

/** Erreur HTTP de l'API : `{error, message}` (DESIGN §4) */
export class ApiError extends Error {
    constructor(public readonly status: number, public readonly code: string, message: string, public readonly body: Record<string, unknown> = {}) {
        super(message);
        this.name = "ApiError";
    }
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** Lit la réponse JSON ; lève `ApiError` pour tout statut hors 2xx. Les jetons ne sont jamais journalisés. */
export async function readJson<T>(response: Response): Promise<T> {
    let body: unknown = null;
    const text = await response.text();
    if (text !== "") {
        try {
            body = JSON.parse(text);
        } catch {
            body = null;
        }
    }
    if (!response.ok) {
        const record = (body != null && typeof body === "object" ? body : {}) as Record<string, unknown>;
        throw new ApiError(
            response.status,
            typeof record["error"] === "string" ? record["error"] : "http_error",
            typeof record["message"] === "string" ? record["message"] : `Erreur ${response.status}`,
            record
        );
    }
    return body as T;
}

//#region Jeton du viewer web ---------------------------------------------------

export interface TokenStore {
    get(): string | null;
    /** Identifiant du viewer associé au jeton (utile pour s'accorder des droits depuis l'administration) */
    viewerId(): string | null;
    set(token: string, viewerId?: string): void;
    clear(): void;
}

export const TOKEN_KEY = "san.web.token";

/** Jeton `web_` en `localStorage` ; toute erreur de stockage (mode privé…) est absorbée */
export class LocalTokenStore implements TokenStore {
    protected _memory: string | null = null;
    protected _memoryId: string | null = null;
    constructor(protected readonly _key = TOKEN_KEY) { }
    public viewerId(): string | null {
        try {
            return window.localStorage.getItem(`${this._key}.id`) ?? this._memoryId;
        } catch {
            return this._memoryId;
        }
    }
    public get(): string | null {
        try {
            return window.localStorage.getItem(this._key) ?? this._memory;
        } catch {
            return this._memory;
        }
    }
    public set(token: string, viewerId?: string): void {
        this._memory = token;
        this._memoryId = viewerId ?? null;
        try {
            window.localStorage.setItem(this._key, token);
            if (viewerId != null) {
                window.localStorage.setItem(`${this._key}.id`, viewerId);
            }
        } catch { /* stockage indisponible : le jeton reste en mémoire */ }
    }
    public clear(): void {
        this._memory = null;
        this._memoryId = null;
        try {
            window.localStorage.removeItem(this._key);
            window.localStorage.removeItem(`${this._key}.id`);
        } catch { /* rien à faire */ }
    }
}

//#endregion

export interface ViewerApiOptions {
    tokens: TokenStore;
    /** Capacités à déclarer à l'enregistrement et à chaque ouverture */
    capabilities: () => ViewerCapabilities;
    label?: string;
    fetch?: FetchFn;
    /** Appelé après un réenregistrement (nouveau viewer : curseurs et configuration repartent de zéro) */
    onReregistered?: () => void;
}

export type ConfigUpdate = { ok: true, view: ConfigView } | { ok: false, conflict: true, view: ConfigView };

/** Client des routes `/viewer/*` avec le jeton `web_` (Bearer) */
export class ViewerApi {

    protected readonly _fetch: FetchFn;
    protected _registering: Promise<void> | null = null;
    /** Hash de la dernière configuration connue (base_hash du prochain PUT) */
    public configHash = "";

    constructor(protected readonly _options: ViewerApiOptions) {
        this._fetch = _options.fetch ?? ((input, init) => fetch(input, init));
    }

    public get viewerId(): string | null {
        return this._options.tokens.viewerId();
    }

    /** S'enregistre (`POST /web/register`, session) s'il n'y a pas de jeton */
    public async ensureRegistered(): Promise<void> {
        if (this._options.tokens.get() != null) {
            return;
        }
        await this._register();
    }

    protected _register(): Promise<void> {
        // Un seul enregistrement à la fois, même si plusieurs appels reçoivent 401 ensemble
        this._registering ??= (async () => {
            try {
                const response = await this._fetch(`${API_BASE}/web/register`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    credentials: "same-origin",
                    body: JSON.stringify({ capabilities: this._options.capabilities(), label: this._options.label })
                });
                const result = await readJson<{ viewer_id: string, token: string }>(response);
                this._options.tokens.set(result.token, result.viewer_id);
            } finally {
                this._registering = null;
            }
        })();
        return this._registering;
    }

    /** Appel authentifié ; un `401` provoque un réenregistrement puis une seule nouvelle tentative */
    public async request(path: string, init: RequestInit = {}): Promise<Response> {
        await this.ensureRegistered();
        const attempt = (): Promise<Response> => {
            const headers = new Headers(init.headers);
            headers.set("Authorization", `Bearer ${this._options.tokens.get() ?? ""}`);
            return this._fetch(`${API_BASE}${path}`, { ...init, headers });
        };
        let response = await attempt();
        if (response.status === 401) {
            this._options.tokens.clear();
            await this._register();
            this._options.onReregistered?.();
            response = await attempt();
        }
        return response;
    }

    protected async _json<T>(path: string, init: RequestInit = {}): Promise<T> {
        return readJson<T>(await this.request(path, init));
    }

    protected _jsonInit(method: string, body: unknown): RequestInit {
        return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    }

    /** Déclare les capacités (corps JSON exact, dont le serveur calcule le hash) */
    public putCapabilities(): Promise<{ caps_hash: string }> {
        return this._json("/viewer/capabilities", this._jsonInit("PUT", this._options.capabilities()));
    }

    public sync(query: { ack?: number, config_hash?: string } = {}): Promise<SyncResponse> {
        const params = new URLSearchParams();
        if (query.ack != null) {
            params.set("ack", String(query.ack));
        }
        if (query.config_hash != null && query.config_hash !== "") {
            params.set("config_hash", query.config_hash);
        }
        const suffix = params.size > 0 ? `?${params}` : "";
        return this._json<SyncResponse>(`/viewer/sync${suffix}`).then((response) => {
            this.configHash = response.config_hash;
            return response;
        });
    }

    public ack(upTo: number): Promise<{ ack: number }> {
        return this._json("/viewer/ack", this._jsonInit("POST", { up_to: upTo }));
    }

    public async getConfig(): Promise<ConfigView> {
        const view = await this._json<ConfigView>("/viewer/config");
        this.configHash = view.config_hash;
        return view;
    }

    /**
     * `PUT /viewer/config` avec `base_hash`. Sur `409 config_conflict`, la
     * configuration courante du serveur est adoptée (son hash devient la base)
     * et renvoyée : l'appelant l'affiche et laisse l'utilisateur recommencer.
     */
    public async updateConfig(subscriptions: SubscriptionPatch[]): Promise<ConfigUpdate> {
        const response = await this.request("/viewer/config", this._jsonInit("PUT", { base_hash: this.configHash, subscriptions }));
        try {
            const view = await readJson<ConfigView>(response);
            this.configHash = view.config_hash;
            return { ok: true, view };
        } catch (error) {
            if (error instanceof ApiError && error.status === 409 && error.code === "config_conflict") {
                const view: ConfigView = { config_hash: String(error.body["config_hash"]), config: error.body["config"] as ViewerConfig };
                this.configHash = view.config_hash;
                return { ok: false, conflict: true, view };
            }
            throw error;
        }
    }

    /** Ouvre le flux SSE ; l'appelant lit `response.body` */
    public events(signal: AbortSignal, lastEventId?: string): Promise<Response> {
        const headers: Record<string, string> = { Accept: "text/event-stream" };
        if (lastEventId != null) {
            headers["Last-Event-ID"] = lastEventId;
        }
        return this.request("/viewer/events", { headers, signal });
    }

    /** Clip audio en blob (le Bearer interdit une simple balise `<audio src>`) */
    public async clip(clipId: string): Promise<Blob> {
        const response = await this.request(`/viewer/voice/${encodeURIComponent(clipId)}`);
        if (!response.ok) {
            await readJson<unknown>(response);
        }
        return response.blob();
    }

    public async sendVoice(agent: string, audio: Blob): Promise<void> {
        await this._json(`/viewer/voice?to=${encodeURIComponent(agent)}`, {
            method: "POST",
            headers: { "Content-Type": audio.type === "" ? "audio/webm" : audio.type },
            body: audio
        });
    }

}

//#region Administration ---------------------------------------------------------

export interface AdminApiOptions {
    fetch?: FetchFn;
    /** Session expirée (401) : par défaut, retour à la page de connexion */
    onUnauthorized?: () => void;
}

export interface Mutation<T> {
    /** Aperçu (`?dry_run=1`) : rien n'est modifié */
    preview(): Promise<Impact>;
    /** Application réelle */
    apply(): Promise<T>;
}

/** Client des routes `/admin/*` (session Dagda, cookie) */
export class AdminApi {

    protected readonly _fetch: FetchFn;

    constructor(protected readonly _options: AdminApiOptions = {}) {
        this._fetch = _options.fetch ?? ((input, init) => fetch(input, init));
    }

    public async call<T>(method: string, path: string, body?: unknown, dryRun = false): Promise<T> {
        const url = `${API_BASE}/admin${path}${dryRun ? `${path.includes("?") ? "&" : "?"}dry_run=1` : ""}`;
        const init: RequestInit = { method, credentials: "same-origin" };
        if (body !== undefined) {
            init.headers = { "Content-Type": "application/json" };
            init.body = JSON.stringify(body);
        }
        const response = await this._fetch(url, init);
        if (response.status === 401) {
            (this._options.onUnauthorized ?? (() => window.location.assign("/login")))();
        }
        return readJson<T>(response);
    }

    /** Une mutation de la couverture : `preview()` puis `apply()` (SPEC §6.2, §11) */
    public mutation<T>(method: string, path: string, body?: unknown): Mutation<T> {
        return {
            preview: async () => {
                const result = await this.call<DryRunResult>(method, path, body, true);
                return { gained: result.gained, lost: result.lost };
            },
            apply: () => this.call<T>(method, path, body)
        };
    }

    //#region Lectures
    public async agents(): Promise<AgentRecord[]> { return (await this.call<{ agents: AgentRecord[] }>("GET", "/agents")).agents; }
    public async groups(): Promise<GroupRecord[]> { return (await this.call<{ groups: GroupRecord[] }>("GET", "/groups")).groups; }
    public async viewers(status?: string): Promise<ViewerRecord[]> {
        return (await this.call<{ viewers: ViewerRecord[] }>("GET", `/viewers${status == null ? "" : `?status=${encodeURIComponent(status)}`}`)).viewers;
    }
    public async viewer(id: string): Promise<ViewerRecord> { return (await this.call<{ viewer: ViewerRecord }>("GET", `/viewers/${encodeURIComponent(id)}`)).viewer; }
    public async rules(viewerId: string): Promise<RuleRecord[]> { return (await this.call<{ rules: RuleRecord[] }>("GET", `/viewers/${encodeURIComponent(viewerId)}/rules`)).rules; }
    public coverage(ruleId: number): Promise<RuleCoverage> { return this.call("GET", `/rules/${ruleId}/coverage`); }
    public access(viewerId: string, agent: string): Promise<AccessDetail> { return this.call("GET", `/viewers/${encodeURIComponent(viewerId)}/access/${encodeURIComponent(agent)}`); }
    public subscriptions(viewerId: string): Promise<ConfigView> { return this.call("GET", `/viewers/${encodeURIComponent(viewerId)}/subscriptions`); }
    //#endregion

    //#region Mutations (toutes avec aperçu d'impact)
    public createAgent(input: { slug: string, name: string, description?: string }): Mutation<{ agent: AgentRecord, token: string, impact: Impact }> {
        return this.mutation("POST", "/agents", input);
    }
    public regenerateToken(slug: string): Mutation<{ agent: AgentRecord, token: string, impact: Impact }> {
        return this.mutation("POST", `/agents/${encodeURIComponent(slug)}/token`);
    }
    public revokeAgent(slug: string): Mutation<{ agent: AgentRecord, impact: Impact }> {
        return this.mutation("DELETE", `/agents/${encodeURIComponent(slug)}`);
    }
    public createGroup(input: { slug: string, name: string, description?: string }): Mutation<{ group: GroupRecord, impact: Impact }> {
        return this.mutation("POST", "/groups", input);
    }
    public deleteGroup(slug: string): Mutation<{ deleted: true, impact: Impact }> {
        return this.mutation("DELETE", `/groups/${encodeURIComponent(slug)}`);
    }
    public setMembers(slug: string, members: string[]): Mutation<{ group: GroupRecord, impact: Impact }> {
        return this.mutation("PUT", `/groups/${encodeURIComponent(slug)}/members`, { members });
    }
    public activateViewer(id: string, name: string): Mutation<{ viewer: ViewerRecord, impact: Impact }> {
        return this.mutation("POST", `/viewers/${encodeURIComponent(id)}/activate`, { name });
    }
    public revokeViewer(id: string): Mutation<{ viewer: ViewerRecord, impact: Impact }> {
        return this.mutation("POST", `/viewers/${encodeURIComponent(id)}/revoke`);
    }
    public updateViewer(id: string, patch: { name?: string, subscription_mode?: SubscriptionMode }): Mutation<{ viewer: ViewerRecord, impact: Impact }> {
        return this.mutation("PATCH", `/viewers/${encodeURIComponent(id)}`, patch);
    }
    public createRule(viewerId: string, rule: { scope: "agent" | "group", pattern: string, can_send_voice: boolean }): Mutation<{ rule: RuleRecord, impact: Impact }> {
        return this.mutation("POST", `/viewers/${encodeURIComponent(viewerId)}/rules`, rule);
    }
    public updateRule(id: number, patch: { scope?: "agent" | "group", pattern?: string, can_send_voice?: boolean }): Mutation<{ rule: RuleRecord, impact: Impact }> {
        return this.mutation("PATCH", `/rules/${id}`, patch);
    }
    public deleteRule(id: number): Mutation<{ deleted: true, impact: Impact }> {
        return this.mutation("DELETE", `/rules/${id}`);
    }
    public setSubscriptions(viewerId: string, subscriptions: SubscriptionPatch[]): Mutation<ConfigView & { impact: Impact }> {
        return this.mutation("PUT", `/viewers/${encodeURIComponent(viewerId)}/subscriptions`, { subscriptions });
    }
    //#endregion

}

//#endregion
