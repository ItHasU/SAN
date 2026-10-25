import { showToast } from "@dagda/client/src/components/toast/toast.component";
import { openDialog } from "@dagda/client/src/components/dialog/dialog.component";
import { AgentRecord, GroupRecord, ViewerRecord } from "@san/shared/src/api/types";
import { adminApi } from "../../app";
import { h, setChildren } from "../../lib/dom";
import { formatRelative } from "../../lib/time";
import { button, checkbox, emptyState, pageHeader, section, viewerLabel } from "../../ui/common";
import { confirmImpact, promptDialog } from "../../ui/dialogs";
import { SanPage } from "../../ui/page";

/**
 * Demandes d'enrôlement en attente (SPEC §11) : cartes (activer avec un nom, ou refuser)
 * et agents enrôlés sans jeton d'enrôlement (approuver, éventuellement dans des groupes, ou rejeter)
 */
export class PendingPage extends SanPage {

    protected _built = false;
    protected _list!: HTMLElement;
    protected _agentList!: HTMLElement;

    constructor() {
        super();
    }

    protected override async _init(): Promise<void> {
        this._list = h("div", { class: "san-list san-list-cols", data: { list: "pending" } });
        this._agentList = h("div", { class: "san-list san-list-cols", data: { list: "pending-agents" } });
        setChildren(this._root,
            pageHeader("Demandes en attente", button("Actualiser", "btn-secondary", () => this.refresh().then(() => undefined), "ph-arrow-clockwise")),
            section("Agents", this._agentList),
            section("Cartes", this._list));
        this._every(10_000, () => { void this.refresh(); });
        this._built = true;
    }

    protected async _render(): Promise<void> {
        const [viewers, agents] = await Promise.all([adminApi.viewers("pending"), adminApi.agents("pending")]);
        const now = Date.now();
        if (agents.length === 0) {
            this._agentList.replaceChildren(emptyState("Aucun agent en attente. Un agent qui s'enrôle sans jeton d'enrôlement apparaît ici."));
        } else {
            this._agentList.replaceChildren(...agents.map((agent) => this._agentCard(agent, now)));
        }
        if (viewers.length === 0) {
            this._list.replaceChildren(emptyState("Aucune demande en attente. Une carte qui s'enrôle apparaît ici avec son code d'appairage."));
            return;
        }
        this._list.replaceChildren(...viewers.map((viewer) => this._card(viewer, now)));
    }

    protected _card(viewer: ViewerRecord, now: number): HTMLElement {
        return h("article", { class: "san-card", data: { viewer: viewer.id } },
            h("div", { class: "san-row san-row-between" },
                h("span", { class: "san-pairing", data: { field: "code" }, text: viewer.pairing_code ?? "—" }),
                h("span", { class: "san-meta", text: formatRelative(viewer.pending_since ?? viewer.created_at, now) })),
            h("p", { class: "san-detail" }, h("strong", { text: viewer.model ?? "Modèle inconnu" })),
            h("p", { class: "san-meta" }, `Matériel : ${viewer.hardware_id ?? "—"}`),
            h("p", { class: "san-meta" }, `IP : ${viewer.registered_ip ?? "—"}`),
            h("div", { class: "san-row" },
                button("Activer", "btn-primary", () => this._activate(viewer), "ph-check"),
                button("Refuser", "btn-danger", () => this._refuse(viewer), "ph-x")));
    }

    protected _agentCard(agent: AgentRecord, now: number): HTMLElement {
        return h("article", { class: "san-card", data: { agent: agent.slug } },
            h("div", { class: "san-row san-row-between" },
                h("span", { class: "san-title", text: agent.name }),
                h("span", { class: "san-meta", text: formatRelative(agent.pending_since ?? agent.created_at, now) })),
            h("p", { class: "san-meta", text: agent.slug }),
            h("p", { class: "san-meta" }, `IP : ${agent.registered_ip ?? "—"}`),
            h("div", { class: "san-row" },
                button("Approuver", "btn-primary", () => this._approve(agent), "ph-check", { data: { action: "approve-agent" } }),
                button("Rejeter", "btn-danger", () => this._reject(agent), "ph-x", { data: { action: "reject-agent" } })));
    }

    /** Choix des groupes à rejoindre, puis aperçu des viewers qui gagnent l'accès */
    protected async _approve(agent: AgentRecord): Promise<void> {
        const groups = await adminApi.groups();
        const chosen = new Set<string>();
        const body = h("div", { class: "san-dialog-body" },
            h("p", { text: "Groupes à rejoindre (facultatif). L'agent devient actif tout de suite et son jeton existant vaut pour toutes les routes." }),
            groups.length === 0 ? h("p", { class: "text-muted", text: "Aucun groupe." }) : null,
            ...groups.map((group: GroupRecord) => checkbox(`${group.name} (${group.slug})`, false, (checked) => {
                if (checked) { chosen.add(group.slug); } else { chosen.delete(group.slug); }
            })));
        openDialog({
            title: `Approuver « ${agent.name} »`,
            body,
            actions: [
                { label: "Annuler", className: "btn-secondary" },
                {
                    label: "Continuer", className: "btn-primary",
                    onClick: async () => {
                        await confirmImpact({
                            title: `Approuver « ${agent.name} »`,
                            intro: "Les viewers dont une règle couvre cet agent y gagnent l'accès.",
                            mutation: adminApi.approveAgent(agent.slug, [...chosen].sort()),
                            confirmLabel: "Approuver",
                            onApplied: async () => { showToast(`« ${agent.name} » approuvé.`, "success"); await this.refresh(); }
                        });
                        return false as const;
                    }
                }
            ]
        });
    }

    protected async _reject(agent: AgentRecord): Promise<void> {
        await confirmImpact({
            title: `Rejeter « ${agent.name} »`,
            intro: "La demande est supprimée avec son jeton ; l'agent recevra 401 et devra se réenrôler.",
            mutation: adminApi.rejectAgent(agent.slug),
            confirmLabel: "Rejeter", danger: true,
            onApplied: async () => { showToast("Demande rejetée.", "info"); await this.refresh(); }
        });
    }

    protected _activate(viewer: ViewerRecord): void {
        promptDialog(`Activer ${viewer.pairing_code ?? viewer.id}`, [{
            key: "name", label: "Nom du viewer", value: viewer.model ?? "",
            validate: (value) => value === "" ? "Le nom est obligatoire." : value.length > 100 ? "100 caractères au plus." : null
        }], "Continuer", async (values) => {
            await confirmImpact({
                title: `Activer « ${values["name"]} »`,
                intro: "Un viewer activé ne voit aucun agent tant qu'aucune règle de permission ne lui est donnée.",
                mutation: adminApi.activateViewer(viewer.id, values["name"]!),
                confirmLabel: "Activer",
                onApplied: async () => {
                    showToast(`« ${values["name"]} » activé.`, "success");
                    await this.refresh();
                }
            });
            return false as const;
        }, `Code d'appairage ${viewer.pairing_code ?? ""} : vérifiez qu'il s'affiche sur la carte.`);
    }

    protected async _refuse(viewer: ViewerRecord): Promise<void> {
        await confirmImpact({
            title: `Refuser ${viewerLabel(viewer)}`,
            intro: "La demande sera révoquée ; la carte devra recommencer l'enrôlement.",
            mutation: adminApi.revokeViewer(viewer.id),
            confirmLabel: "Refuser",
            danger: true,
            onApplied: async () => {
                showToast("Demande refusée.", "info");
                await this.refresh();
            }
        });
    }

}

customElements.define("pending-page", PendingPage);
