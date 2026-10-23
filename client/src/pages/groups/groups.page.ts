import { showToast } from "@dagda/client/src/components/toast/toast.component";
import { AgentRecord, GroupRecord } from "@san/shared/src/api/types";
import { openDialog } from "@dagda/client/src/components/dialog/dialog.component";
import { adminApi } from "../../app";
import { h, setChildren } from "../../lib/dom";
import { globMatches, slugError } from "../../lib/glob";
import { button, checkbox, emptyState, pageHeader, viewerLabel } from "../../ui/common";
import { confirmImpact, promptDialog } from "../../ui/dialogs";
import { SanPage } from "../../ui/page";

/** Groupes d'agents : création, membres, viewers concernés par les règles qui les ciblent */
export class GroupsPage extends SanPage {

    protected _list!: HTMLElement;
    protected _agents: AgentRecord[] = [];

    constructor() {
        super();
    }

    protected override async _init(): Promise<void> {
        this._list = h("div", { class: "san-list san-list-cols", data: { list: "groups" } });
        setChildren(this._root,
            pageHeader("Groupes", button("Nouveau groupe", "btn-primary", () => this._create(), "ph-plus", { data: { action: "new-group" } })),
            this._list);
    }

    protected async _render(): Promise<void> {
        const [groups, agents] = await Promise.all([adminApi.groups(), adminApi.agents()]);
        this._agents = agents;
        if (groups.length === 0) {
            this._list.replaceChildren(emptyState("Aucun groupe. Les groupes servent à donner accès à plusieurs agents d'un coup."));
            return;
        }
        this._list.replaceChildren(...groups.map((group) => this._card(group)));
    }

    protected _card(group: GroupRecord): HTMLElement {
        const concerned = h("div", { class: "san-meta", data: { concerned: group.slug } });
        return h("article", { class: "san-card", data: { group: group.slug } },
            h("span", { class: "san-title", text: group.name }),
            h("p", { class: "san-meta", text: group.slug }),
            group.description == null ? null : h("p", { class: "san-detail", text: group.description }),
            h("div", { class: "san-row" },
                group.members.length === 0 ? h("span", { class: "san-meta", text: "Aucun membre" }) : null,
                ...group.members.map((member) => h("span", { class: "tag tag-outline", text: member }))),
            h("div", { class: "san-row" },
                button("Membres", "btn-secondary", () => this._editMembers(group), "ph-users", { data: { action: "members" } }),
                button("Viewers concernés", "btn-ghost", () => this._loadConcerned(group, concerned), "ph-eye"),
                button("Supprimer", "btn-danger", () => this._delete(group), "ph-trash")),
            concerned);
    }

    /** Viewers dont une règle `group` a un motif qui correspond au slug du groupe */
    protected async _loadConcerned(group: GroupRecord, target: HTMLElement): Promise<void> {
        const viewers = (await adminApi.viewers()).filter((viewer) => viewer.status === "active");
        const found: string[] = [];
        for (const viewer of viewers) {
            const rules = await adminApi.rules(viewer.id);
            if (rules.some((rule) => rule.scope === "group" && globMatches(rule.pattern, group.slug))) {
                found.push(viewerLabel(viewer));
            }
        }
        target.textContent = found.length === 0 ? "Aucune règle ne cible ce groupe." : `Viewers concernés : ${found.join(", ")}`;
    }

    protected _create(): void {
        promptDialog("Nouveau groupe", [
            { key: "slug", label: "Slug", validate: slugError },
            { key: "name", label: "Nom affiché", validate: (value) => value === "" ? "Le nom est obligatoire." : null }
        ], "Continuer", async (values) => {
            const input = { slug: values["slug"]!, name: values["name"]! };
            await confirmImpact({
                title: `Créer le groupe « ${input.name} »`,
                intro: "Les règles de groupe à motif peuvent déjà cibler ce nom.",
                mutation: adminApi.createGroup(input),
                confirmLabel: "Créer",
                onApplied: async () => { showToast("Groupe créé.", "success"); await this.refresh(); }
            });
            return false as const;
        });
    }

    protected _editMembers(group: GroupRecord): void {
        const chosen = new Set(group.members);
        const body = h("div", { class: "san-dialog-body" },
            this._agents.length === 0 ? h("p", { class: "text-muted", text: "Aucun agent à ajouter." }) : null,
            ...this._agents.map((agent) => checkbox(`${agent.name} (${agent.slug})`, chosen.has(agent.slug), (checked) => {
                if (checked) { chosen.add(agent.slug); } else { chosen.delete(agent.slug); }
            })));
        openDialog({
            title: `Membres de « ${group.name} »`,
            body,
            actions: [
                { label: "Annuler", className: "btn-secondary" },
                {
                    label: "Continuer", className: "btn-primary",
                    onClick: async () => {
                        await confirmImpact({
                            title: `Membres de « ${group.name} »`,
                            mutation: adminApi.setMembers(group.slug, [...chosen].sort()),
                            confirmLabel: "Appliquer",
                            onApplied: async () => { showToast("Membres enregistrés.", "success"); await this.refresh(); }
                        });
                        return false as const;
                    }
                }
            ]
        });
    }

    protected async _delete(group: GroupRecord): Promise<void> {
        await confirmImpact({
            title: `Supprimer « ${group.name} »`,
            mutation: adminApi.deleteGroup(group.slug),
            confirmLabel: "Supprimer", danger: true,
            onApplied: async () => { showToast("Groupe supprimé.", "info"); await this.refresh(); }
        });
    }

}

customElements.define("groups-page", GroupsPage);
