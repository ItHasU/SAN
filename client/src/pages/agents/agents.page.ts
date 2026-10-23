import { showToast } from "@dagda/client/src/components/toast/toast.component";
import { AgentRecord } from "@san/shared/src/api/types";
import { adminApi } from "../../app";
import { h, setChildren } from "../../lib/dom";
import { slugError } from "../../lib/glob";
import { formatRelative } from "../../lib/time";
import { button, emptyState, pageHeader, progressBar, statusBadge, viewerLabel } from "../../ui/common";
import { confirmImpact, promptDialog, showAgentToken } from "../../ui/dialogs";
import { SanPage } from "../../ui/page";

/** Agents : création (jeton affiché une seule fois), régénération, révocation, état et viewers ayant accès */
export class AgentsPage extends SanPage {

    protected _list!: HTMLElement;

    constructor() {
        super();
    }

    protected override async _init(): Promise<void> {
        this._list = h("div", { class: "san-list san-list-cols", data: { list: "agents-admin" } });
        setChildren(this._root,
            pageHeader("Agents",
                button("Nouvel agent", "btn-primary", () => this._create(), "ph-plus", { data: { action: "new-agent" } }),
                button("Actualiser", "btn-secondary", () => this.refresh().then(() => undefined), "ph-arrow-clockwise")),
            this._list);
        this._every(10_000, () => { void this.refresh(); });
    }

    protected async _render(): Promise<void> {
        const agents = await adminApi.agents();
        const now = Date.now();
        if (agents.length === 0) {
            this._list.replaceChildren(emptyState("Aucun agent. Créez-en un pour obtenir son jeton."));
            return;
        }
        this._list.replaceChildren(...agents.map((agent) => this._card(agent, now)));
    }

    protected _card(agent: AgentRecord, now: number): HTMLElement {
        const access = h("div", { class: "san-meta", data: { access: agent.slug } });
        const state = agent.state;
        return h("article", { class: "san-card", data: { agent: agent.slug, revoked: String(agent.revoked) } },
            h("div", { class: "san-row san-row-between" },
                h("span", { class: "san-title", text: agent.name }),
                agent.revoked ? h("span", { class: "tag tag-danger", text: "Révoqué" }) : state == null ? h("span", { class: "tag tag-neutral", text: "Aucun état" }) : statusBadge(state.status, state.stale)),
            h("p", { class: "san-meta", text: agent.slug }),
            agent.description == null ? null : h("p", { class: "san-detail", text: agent.description }),
            state?.detail ? h("p", { class: "san-detail", text: state.detail }) : null,
            state == null ? null : progressBar(state.progress),
            state == null ? null : h("p", { class: "san-meta", text: `mis à jour ${formatRelative(state.updated_at, now)}` }),
            agent.groups.length === 0 ? null : h("div", { class: "san-row" }, ...agent.groups.map((group) => h("span", { class: "tag tag-outline", text: group }))),
            h("div", { class: "san-row" },
                button("Accès", "btn-ghost", () => this._loadAccess(agent, access), "ph-eye"),
                button("Régénérer le jeton", "btn-secondary", () => this._regenerate(agent), "ph-key", { data: { action: "regenerate" } }),
                agent.revoked ? null : button("Révoquer", "btn-danger", () => this._revoke(agent), "ph-prohibit", { data: { action: "revoke" } })),
            access);
    }

    /** Viewers actifs ayant accès à l'agent (diagnostic d'accès de chacun) */
    protected async _loadAccess(agent: AgentRecord, target: HTMLElement): Promise<void> {
        const viewers = (await adminApi.viewers("active"));
        const checks = await Promise.all(viewers.map(async (viewer) => ({ viewer, access: await adminApi.access(viewer.id, agent.slug) })));
        const names = checks.filter((check) => check.access.access).map((check) => viewerLabel(check.viewer));
        target.textContent = names.length === 0 ? "Aucun viewer n'a accès à cet agent." : `Viewers ayant accès : ${names.join(", ")}`;
    }

    protected _create(): void {
        promptDialog("Nouvel agent", [
            { key: "slug", label: "Slug", hint: "Identifiant stable : minuscules, chiffres, tirets, « / » pour hiérarchiser.", validate: slugError },
            { key: "name", label: "Nom affiché", validate: (value) => value === "" ? "Le nom est obligatoire." : null },
            { key: "description", label: "Description (facultative)" }
        ], "Continuer", async (values) => {
            const input = { slug: values["slug"]!, name: values["name"]!, ...(values["description"] ? { description: values["description"] } : {}) };
            await confirmImpact({
                title: `Créer « ${input.name} »`,
                intro: "Les règles à motif existantes peuvent donner accès à ce nouvel agent.",
                mutation: adminApi.createAgent(input),
                confirmLabel: "Créer",
                onApplied: async (result) => {
                    await this.refresh();
                    showAgentToken(result.agent.name, result.token);
                    return false as const;
                }
            });
            return false as const;
        });
    }

    protected async _regenerate(agent: AgentRecord): Promise<void> {
        await confirmImpact({
            title: `Régénérer le jeton de « ${agent.name} »`,
            intro: `L'ancien jeton cesse de fonctionner immédiatement.${agent.revoked ? " L'agent révoqué sera réactivé." : ""}`,
            mutation: adminApi.regenerateToken(agent.slug),
            confirmLabel: "Régénérer", danger: true,
            onApplied: async (result) => {
                await this.refresh();
                showAgentToken(result.agent.name, result.token);
                return false as const;
            }
        });
    }

    protected async _revoke(agent: AgentRecord): Promise<void> {
        await confirmImpact({
            title: `Révoquer « ${agent.name} »`,
            intro: "Le jeton ne fonctionnera plus ; l'agent disparaît des viewers.",
            mutation: adminApi.revokeAgent(agent.slug),
            confirmLabel: "Révoquer", danger: true,
            onApplied: async () => { showToast("Agent révoqué.", "info"); await this.refresh(); }
        });
    }

}

customElements.define("agents-page", AgentsPage);
