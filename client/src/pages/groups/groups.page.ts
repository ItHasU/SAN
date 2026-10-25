import { showToast } from "@dagda/client/src/components/toast/toast.component";
import { AgentRecord, EnrollmentTokenRecord, GroupRecord } from "@san/shared/src/api/types";
import { openDialog } from "@dagda/client/src/components/dialog/dialog.component";
import { adminApi } from "../../app";
import { h, setChildren } from "../../lib/dom";
import { globMatches, slugError } from "../../lib/glob";
import { formatRelative } from "../../lib/time";
import { button, checkbox, emptyState, field, pageHeader, textInput, viewerLabel } from "../../ui/common";
import { confirmImpact, promptDialog, showEnrollmentToken } from "../../ui/dialogs";
import { SanPage } from "../../ui/page";

/** Groupes d'agents : création, membres, jetons d'enrôlement, viewers concernés par les règles qui les ciblent */
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
        // Un agent en attente n'a aucun groupe : il ne peut être membre qu'après approbation
        this._agents = agents.filter((agent) => agent.status === "active");
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
                button("Jetons d'enrôlement", "btn-secondary", () => this._manageTokens(group), "ph-key", { data: { action: "enrollment-tokens" } }),
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

    /**
     * Jetons d'enrôlement du groupe (SPEC §4bis) : liste, création (secret affiché une seule fois),
     * révocation. Un agent qui présente un jeton valide est créé actif dans ce groupe.
     */
    protected async _manageTokens(group: GroupRecord): Promise<void> {
        const tokens = await adminApi.enrollmentTokens(group.slug);
        const now = Date.now();
        const list = h("div", { class: "san-list", data: { list: "enrollment-tokens", group: group.slug } },
            tokens.length === 0 ? h("p", { class: "text-muted", text: "Aucun jeton d'enrôlement." }) : null,
            ...tokens.map((token) => this._tokenRow(group, token, now)));
        const label = textInput({ name: "label", placeholder: "Libellé (ex. Runners CI)" });
        const days = textInput({ name: "days", placeholder: "Durée de validité en jours (vide : n'expire pas)", inputMode: "numeric" });
        const error = h("div", { class: "san-error", role: "alert" });
        const create = button("Créer un jeton", "btn-primary", async () => {
            const name = label.value.trim();
            const validity = days.value.trim();
            const count = Number(validity);
            if (name === "" || name.length > 100) {
                error.textContent = "Le libellé est obligatoire (100 caractères au plus).";
                return;
            }
            if (validity !== "" && (!/^\d{1,4}$/.test(validity) || count < 1 || count > 3650)) {
                error.textContent = "La durée est un nombre de jours entre 1 et 3650.";
                return;
            }
            error.textContent = "";
            const created = await adminApi.createEnrollmentToken(group.slug, {
                label: name,
                ...(validity === "" ? {} : { expires_at: new Date(Date.now() + count * 86_400_000).toISOString() })
            });
            showEnrollmentToken(group.name, created.token, () => { void this._manageTokens(group); });
        }, "ph-plus", { data: { action: "create-enrollment-token" } });
        const body = h("div", { class: "san-dialog-body" },
            h("p", { text: "Un agent qui présente un jeton valide à POST /agent/register est créé actif dans ce groupe. Sans jeton, il reste en attente d'approbation." }),
            list,
            h("h4", { text: "Nouveau jeton" }),
            field("Libellé", label), field("Validité", days), error, create);
        openDialog({ title: `Jetons d'enrôlement de « ${group.name} »`, body, actions: [{ label: "Fermer", className: "btn-secondary" }] });
    }

    protected _tokenRow(group: GroupRecord, token: EnrollmentTokenRecord, now: number): HTMLElement {
        const states = { active: ["tag-success", "Actif"], expired: ["tag-warning", "Expiré"], revoked: ["tag-danger", "Révoqué"] } as const;
        const [tagClass, tagLabel] = states[token.state];
        return h("article", { class: "san-card", data: { token: String(token.id), state: token.state } },
            h("div", { class: "san-row san-row-between" },
                h("span", { class: "san-title", text: token.label }),
                h("span", { class: `tag ${tagClass}`, text: tagLabel })),
            h("p", { class: "san-meta", text: `Créé ${formatRelative(token.created_at, now)} · ${token.expires_at == null ? "n'expire pas" : `expire le ${new Date(token.expires_at).toLocaleString()}`}` }),
            h("p", { class: "san-meta", text: `${token.use_count} utilisation(s)${token.last_used_at == null ? "" : `, dernière ${formatRelative(token.last_used_at, now)}`}` }),
            token.state === "revoked" ? null : h("div", { class: "san-row" },
                button("Révoquer", "btn-danger", async () => {
                    await adminApi.revokeEnrollmentToken(group.slug, token.id);
                    showToast("Jeton révoqué.", "info");
                    await this._manageTokens(group);
                }, "ph-prohibit", { data: { action: "revoke-enrollment-token" } })));
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
