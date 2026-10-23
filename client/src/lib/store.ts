import { ConfigAgent, EventView, StateView, ViewerConfig } from "@san/shared/src/api/types";
import { SseMessage } from "./sse";

export type ConnectionState = "connecting" | "live" | "offline";

/** Nombre d'événements conservés à l'écran */
export const MAX_EVENTS = 100;

/** Un agent suivi : sa configuration et son dernier état connu */
export interface TrackedAgent {
    config: ConfigAgent;
    state: StateView | null;
}

/**
 * État du tableau de bord : configuration, états des agents, historique des
 * événements. Aucune E/S : alimenté par la synchronisation et les messages SSE,
 * il notifie ses abonnés à chaque changement.
 */
export class DashboardStore {

    public config: ViewerConfig | null = null;
    public connection: ConnectionState = "connecting";
    protected readonly _states = new Map<string, StateView>();
    protected _events: EventView[] = [];
    protected readonly _listeners = new Set<() => void>();

    /** Identifiant d'événement le plus élevé connu (reprise `Last-Event-ID`) */
    public maxEventId = 0;

    public subscribe(listener: () => void): () => void {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    protected _changed(): void {
        for (const listener of this._listeners) {
            listener();
        }
    }

    public setConnection(state: ConnectionState): void {
        if (this.connection !== state) {
            this.connection = state;
            this._changed();
        }
    }

    public setConfig(config: ViewerConfig): void {
        this.config = config;
        this._changed();
    }

    public applyState(state: StateView): void {
        this._states.set(state.agent, state);
        this._changed();
    }

    /** Ajoute un événement ; rend `false` s'il était déjà connu (aperçu SSE / synchronisation) */
    public addEvent(event: EventView): boolean {
        if (this._events.some((known) => known.id === event.id)) {
            return false;
        }
        this._events.push(event);
        this._events.sort((a, b) => b.id - a.id);
        if (this._events.length > MAX_EVENTS) {
            this._events.length = MAX_EVENTS;
        }
        this.maxEventId = Math.max(this.maxEventId, event.id);
        this._changed();
        return true;
    }

    /** Intègre une réponse de `GET /viewer/sync` ; rend les événements nouveaux */
    public applySync(response: { config: ViewerConfig | null, states: StateView[], events: EventView[] }): EventView[] {
        if (response.config != null) {
            this.config = response.config;
        }
        for (const state of response.states) {
            this._states.set(state.agent, state);
        }
        const fresh: EventView[] = [];
        for (const event of response.events) {
            if (this.addEvent(event)) {
                fresh.push(event);
            }
        }
        this._changed();
        return fresh;
    }

    /**
     * Intègre un message SSE. `hello` et `config` rendent le hash annoncé (le
     * session le compare au sien et recharge la configuration) ; `state` et
     * `event` sont appliqués ici. Rend l'événement nouveau, le cas échéant.
     */
    public applyMessage(message: SseMessage): { configHash?: string, event?: EventView } {
        let data: unknown;
        try {
            data = JSON.parse(message.data);
        } catch {
            return {};
        }
        if (data == null || typeof data !== "object") {
            return {};
        }
        switch (message.event) {
            case "hello":
            case "config": {
                const hash = (data as { config_hash?: unknown }).config_hash;
                return typeof hash === "string" ? { configHash: hash } : {};
            }
            case "state":
                this.applyState(data as StateView);
                return {};
            case "event":
                return this.addEvent(data as EventView) ? { event: data as EventView } : {};
            default:
                return {};
        }
    }

    public get events(): readonly EventView[] {
        return this._events;
    }

    public state(agent: string): StateView | null {
        return this._states.get(agent) ?? null;
    }

    /** Agents suivis, dans l'ordre de la configuration (position puis nom) */
    public tracked(): TrackedAgent[] {
        const agents = (this.config?.agents ?? []).filter((agent) => agent.subscribed);
        return agents
            .sort((a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name))
            .map((config) => ({ config, state: this._states.get(config.agent) ?? null }));
    }

    /** Nom d'affichage d'un agent (repli sur le slug) */
    public agentName(slug: string): string {
        return this.config?.agents.find((agent) => agent.agent === slug)?.name ?? slug;
    }

}
