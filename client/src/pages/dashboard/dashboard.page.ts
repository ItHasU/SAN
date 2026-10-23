import { showToast } from "@dagda/client/src/components/toast/toast.component";
import { ConfigAgent } from "@san/shared/src/api/types";
import { adminApi, dashboardRuntime, DashboardRuntime } from "../../app";
import { dagda } from "../../dagda";
import { browserEnv, buildCapabilities } from "../../lib/capabilities";
import { h, icon, setChildren } from "../../lib/dom";
import { notificationPermission, requestNotificationPermission } from "../../lib/notify";
import { TrackedAgent } from "../../lib/store";
import { button, emptyState, errorMessage, iconButton, pageHeader, reportError, section } from "../../ui/common";
import { confirmImpact } from "../../ui/dialogs";
import { SanPage } from "../../ui/page";
import { AgentCard } from "./agent-card";
import { EventItem } from "./event-item";

const CONNECTION_LABELS = { connecting: "Connexion…", live: "En direct", offline: "Reconnexion…" } as const;

/**
 * Tableau de bord : viewer `web` en mode `auto`. Agents suivis en temps réel
 * (SSE), historique des nudges et messages vocaux, réglages d'ordre et de mise en sourdine.
 */
export class DashboardPage extends SanPage {

    protected _runtime!: DashboardRuntime;
    protected _unsubscribe: (() => void) | null = null;
    protected _scheduled = false;
    protected _editing = false;
    protected readonly _cards = new Map<string, AgentCard>();
    protected readonly _items = new Map<number, EventItem>();
    protected _built = false;
    protected _connection!: HTMLElement;
    protected _toolbar!: HTMLElement;
    protected _agents!: HTMLElement;
    protected _settings!: HTMLElement;
    protected _events!: HTMLElement;

    constructor() {
        super();
    }

    protected override async _init(): Promise<void> {
        this._runtime = dashboardRuntime();
        this._connection = h("span", { class: "tag tag-neutral san-conn", role: "status", "aria-live": "polite", data: { connection: "connecting" } });
        this._toolbar = h("div", { class: "san-actions" });
        this._agents = h("div", { class: "san-list san-list-cols", data: { list: "agents" } });
        this._settings = h("div", { hidden: true, data: { list: "settings" } });
        this._events = h("div", { class: "san-list", data: { list: "events" } });
        setChildren(this._root,
            pageHeader("Tableau de bord", this._connection, this._toolbar),
            section("Agents", this._settings, this._agents),
            section("Activité récente", this._events));
        this._unsubscribe = this._runtime.store.subscribe(() => this._schedule());
        this._runtime.session.start();
        this._every(15_000, () => this._tick());
        this._built = true;
    }

    protected async _render(): Promise<void> {
        this._draw();
    }

    protected _schedule(): void {
        if (this._scheduled) {
            return;
        }
        this._scheduled = true;
        requestAnimationFrame(() => {
            this._scheduled = false;
            if (this.isConnected) {
                this._draw();
            }
        });
    }

    protected _tick(): void {
        const now = Date.now();
        this._items.forEach((item) => item.updateTime(now));
        this._draw();
    }

    protected _draw(): void {
        if (!this._built) {
            return;
        }
        const { store } = this._runtime;
        this._drawConnection();
        this._drawToolbar();
        const tracked = store.tracked();
        this._drawAgents(tracked);
        this._drawSettings(tracked);
        this._drawEvents();
    }

    protected _drawConnection(): void {
        const state = this._runtime.store.connection;
        this._connection.dataset["connection"] = state;
        this._connection.className = `tag ${state === "live" ? "tag-success" : state === "offline" ? "tag-warning" : "tag-neutral"} san-conn`;
        this._connection.replaceChildren(icon(state === "live" ? "ph-broadcast" : "ph-wifi-slash"), h("span", { text: CONNECTION_LABELS[state] }));
    }

    protected _drawToolbar(): void {
        const buttons: HTMLElement[] = [];
        if (notificationPermission() === "default") {
            buttons.push(button("Notifications", "btn-secondary", async () => {
                const permission = await requestNotificationPermission();
                showToast(permission === "granted" ? "Notifications activées." : "Notifications non activées.", permission === "granted" ? "success" : "info");
                if (permission === "granted") {
                    await this._runtime.api.putCapabilities();
                }
                this._draw();
            }, "ph-bell-ringing"));
        }
        const tracked = this._runtime.store.tracked();
        if (tracked.length > 1) {
            buttons.push(button(this._editing ? "Terminer" : "Réglages", this._editing ? "btn-primary" : "btn-secondary", () => {
                this._editing = !this._editing;
                this._draw();
            }, this._editing ? "ph-check" : "ph-sliders", { "aria-pressed": String(this._editing) }));
        }
        this._toolbar.replaceChildren(...buttons);
    }

    protected _drawAgents(tracked: TrackedAgent[]): void {
        const { store, api } = this._runtime;
        const context = {
            canRecord: buildCapabilities(browserEnv()).audio_in != null,
            sendVoice: (agent: string, audio: Blob) => api.sendVoice(agent, audio)
        };
        const now = Date.now();
        const wanted = new Set(tracked.map((agent) => agent.config.agent));
        for (const [slug, card] of this._cards) {
            if (!wanted.has(slug)) {
                card.dispose();
                card.element.remove();
                this._cards.delete(slug);
            }
        }
        const nodes: HTMLElement[] = [];
        for (const entry of tracked) {
            let card = this._cards.get(entry.config.agent);
            if (card == null) {
                card = new AgentCard(context);
                this._cards.set(entry.config.agent, card);
            }
            card.update(entry, now);
            nodes.push(card.element);
        }
        if (tracked.length === 0) {
            this._agents.replaceChildren(store.config == null ? emptyState("Chargement…") : this._noAgents());
            return;
        }
        // Ne réinsère que si l'ordre ou la composition change (garde le focus et les enregistrements en cours)
        const same = nodes.length === this._agents.children.length && nodes.every((node, index) => this._agents.children[index] === node);
        if (!same) {
            this._agents.replaceChildren(...nodes);
        }
    }

    /** État vide : l'administrateur peut s'accorder l'accès d'un geste */
    protected _noAgents(): HTMLElement {
        return emptyState("Aucun agent visible. Un viewer ne voit que les agents couverts par une règle de permission.",
            button("M'accorder l'accès à tous les agents", "btn-primary", () => this._grantSelf(), "ph-key", { data: { action: "grant-self" } }),
            button("Voir mes viewers", "btn-ghost", () => dagda.pages.setPage("viewers").then(() => undefined), "ph-devices"));
    }

    protected async _grantSelf(): Promise<void> {
        const viewerId = this._runtime.api.viewerId;
        if (viewerId == null) {
            throw new Error("Identifiant du viewer inconnu : rechargez la page.");
        }
        await confirmImpact({
            title: "M'accorder l'accès",
            intro: "Ajoute au viewer de ce navigateur une règle « agents : * » (tous les agents, présents et futurs).",
            mutation: adminApi.createRule(viewerId, { scope: "agent", pattern: "*", can_send_voice: true }),
            confirmLabel: "Accorder l'accès",
            onApplied: async () => {
                this._runtime.session.resync();
                showToast("Accès accordé.", "success");
            }
        });
    }

    //#region Réglages (ordre, muet) ---------------------------------------------

    protected _drawSettings(tracked: TrackedAgent[]): void {
        this._settings.hidden = !this._editing || tracked.length < 2;
        if (this._settings.hidden) {
            this._settings.replaceChildren();
            return;
        }
        const list = h("ul", { class: "san-sortable", "aria-label": "Ordre des agents" });
        tracked.forEach((entry, index) => {
            const { config } = entry;
            list.appendChild(h("li", { data: { agent: config.agent } },
                h("span", { class: "san-grow", text: config.name }),
                iconButton(`Rendre ${config.name} ${config.muted ? "audible" : "muet"}`, config.muted ? "ph-bell-slash" : "ph-bell", () => this._save(tracked, index, index, !config.muted), { "aria-pressed": String(config.muted), data: { action: "mute" } }),
                iconButton(`Monter ${config.name}`, "ph-arrow-up", () => this._save(tracked, index, index - 1), { disabled: index === 0, data: { action: "up" } }),
                iconButton(`Descendre ${config.name}`, "ph-arrow-down", () => this._save(tracked, index, index + 1), { disabled: index === tracked.length - 1, data: { action: "down" } })));
        });
        this._settings.replaceChildren(h("p", { class: "san-meta", text: "Ordre d'affichage et mise en sourdine (les messages d'un agent muet restent listés, sans alerte)." }), list);
    }

    /** Déplace l'agent `from` en `to` et/ou change son drapeau muet, puis envoie toute la liste (`base_hash`, 409 géré) */
    protected async _save(tracked: TrackedAgent[], from: number, to: number, muted?: boolean): Promise<void> {
        const ordered: ConfigAgent[] = tracked.map((entry) => ({ ...entry.config }));
        const [moved] = ordered.splice(from, 1);
        if (moved == null) {
            return;
        }
        if (muted != null) {
            moved.muted = muted;
        }
        ordered.splice(Math.max(0, Math.min(ordered.length, to)), 0, moved);
        const { api, store } = this._runtime;
        const result = await api.updateConfig(ordered.map((agent, position) => ({ agent: agent.agent, position, muted: agent.muted })));
        store.setConfig(result.view.config);
        if (!result.ok) {
            showToast("La configuration a changé ailleurs : elle a été rechargée, recommencez.", "warning");
        }
    }

    //#endregion

    protected _drawEvents(): void {
        const { store, api, session } = this._runtime;
        const events = store.events;
        const known = new Set(events.map((event) => event.id));
        for (const [id, item] of this._items) {
            if (!known.has(id)) {
                item.dispose();
                item.element.remove();
                this._items.delete(id);
            }
        }
        const nodes: HTMLElement[] = [];
        for (const event of events) {
            let item = this._items.get(event.id);
            if (item == null) {
                item = new EventItem(event, {
                    agentName: (slug) => store.agentName(slug),
                    clip: (id) => api.clip(id),
                    seen: (id) => session.markSeen(id)
                });
                this._items.set(event.id, item);
            }
            nodes.push(item.element);
        }
        if (events.length === 0) {
            this._events.replaceChildren(emptyState("Aucun nudge ni message vocal pour l'instant."));
            return;
        }
        const same = nodes.length === this._events.children.length && nodes.every((node, index) => this._events.children[index] === node);
        if (!same) {
            this._events.replaceChildren(...nodes);
        }
        // Affiché = vu (l'acquittement n'est envoyé que page visible)
        if (document.visibilityState === "visible" && events.length > 0) {
            session.markSeen(events[0]!.id);
        }
    }

    public override async dispose(): Promise<void> {
        await super.dispose();
        this._unsubscribe?.();
        this._unsubscribe = null;
        this._runtime?.session.stop();
        this._cards.forEach((card) => card.dispose());
        this._items.forEach((item) => item.dispose());
        this._cards.clear();
        this._items.clear();
    }

}

customElements.define("dashboard-page", DashboardPage);

