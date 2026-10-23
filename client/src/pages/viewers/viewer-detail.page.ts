import { showToast } from "@dagda/client/src/components/toast/toast.component";
import { AccessDetail, AgentRecord, ConfigView, GroupRecord, RuleRecord, SubscriptionPatch, ViewerRecord } from "@san/shared/src/api/types";
import { adminApi } from "../../app";
import { dagda } from "../../dagda";
import { globMatches, patternError } from "../../lib/glob";
import { h, setChildren } from "../../lib/dom";
import { formatRelative } from "../../lib/time";
import { button, checkbox, emptyState, errorMessage, field, iconButton, pageHeader, reportError, section, segmented, textInput, viewerLabel } from "../../ui/common";
import { confirmImpact, promptDialog } from "../../ui/dialogs";
import { SanPage } from "../../ui/page";

type Scope = "agent" | "group";

/** Fiche d'un viewer : capacités, mode, règles de permission, diagnostic d'accès, abonnements */
export class ViewerDetailPage extends SanPage {

    protected _viewer!: ViewerRecord;
    protected _agents: AgentRecord[] = [];
    protected _groups: GroupRecord[] = [];

    constructor() {
        super();
    }

    protected get _viewerId(): string {
        const id = this.getAttribute("viewer-id");
        if (id == null) {
            throw new Error("Aucun viewer sélectionné.");
        }
        return id;
    }

    /** Un viewer sans micro ne peut pas recevoir `can_send_voice` (SPEC §7.3) */
    protected get _hasMic(): boolean {
        const caps = this._viewer.capabilities;
        return caps != null && typeof caps === "object" && caps.audio_in != null;
    }

    protected async _render(): Promise<void> {
        const id = this._viewerId;
        const [viewer, rules, agents, groups, subscriptions] = await Promise.all([
            adminApi.viewer(id), adminApi.rules(id), adminApi.agents(), adminApi.groups(), adminApi.subscriptions(id)
        ]);
        this._viewer = viewer;
        this._agents = agents;
        this._groups = groups;
        setChildren(this._root,
            pageHeader(viewerLabel(viewer),
                button("Viewers", "btn-ghost", () => dagda.pages.setPage("viewers").then(() => undefined), "ph-caret-left")),
            this._identity(viewer),
            this._capabilities(viewer),
            this._rulesSection(rules),
            this._diagnostic(),
            this._subscriptionsSection(subscriptions),
            viewer.status === "revoked" ? null : section("Zone dangereuse",
                button("Révoquer ce viewer", "btn-danger", () => this._revoke(), "ph-prohibit", { data: { action: "revoke" } })));
    }

    //#region Identité et mode ---------------------------------------------------------

    protected _identity(viewer: ViewerRecord): HTMLElement {
        const now = Date.now();
        return section("Informations",
            h("div", { class: "san-card" },
                h("div", { class: "san-row" },
                    h("span", { class: "tag tag-outline", text: viewer.kind === "web" ? "Web" : "Carte" }),
                    h("span", { class: "tag tag-outline", text: viewer.status })),
                h("p", { class: "san-meta" }, `Identifiant : ${viewer.id}`),
                h("p", { class: "san-meta" }, `Dernière connexion : ${formatRelative(viewer.last_seen_at, now)}`),
                h("p", { class: "san-meta" }, `Prochain réveil : ${viewer.next_wake_at == null ? "—" : formatRelative(viewer.next_wake_at, now)}`),
                h("p", { class: "san-meta" }, `Batterie : ${viewer.battery_pct == null ? "—" : `${viewer.battery_pct} %`}`),
                field("Mode d'abonnement", segmented("mode", [{ value: "auto", label: "Auto" }, { value: "manual", label: "Manuel" }], viewer.subscription_mode, (mode) => {
                    adminApi.call("PATCH", `/viewers/${encodeURIComponent(viewer.id)}`, { subscription_mode: mode })
                        .then(() => { showToast("Mode modifié.", "success"); return this.refresh(); }).catch(reportError);
                }), "Auto : tous les agents visibles sont suivis. Manuel : seuls les agents cochés."),
                button("Renommer", "btn-secondary", () => promptDialog("Renommer le viewer", [{ key: "name", label: "Nom", value: viewer.name ?? "", validate: (v) => v === "" ? "Le nom est obligatoire." : null }], "Renommer", async (values) => {
                    await adminApi.call("PATCH", `/viewers/${encodeURIComponent(viewer.id)}`, { name: values["name"] });
                    await this.refresh();
                }), "ph-pencil")));
    }

    protected _capabilities(viewer: ViewerRecord): HTMLElement {
        const caps = viewer.capabilities;
        const tags: HTMLElement[] = [];
        if (caps?.audio_out != null) {
            tags.push(h("span", { class: "tag tag-info", text: `Sortie audio : ${(caps.audio_out.formats ?? []).join(", ") || "oui"}` }));
        }
        tags.push(h("span", { class: `tag ${this._hasMic ? "tag-success" : "tag-neutral"}`, text: this._hasMic ? "Micro" : "Pas de micro" }));
        if (caps?.display != null) {
            tags.push(h("span", { class: "tag tag-neutral", text: `Écran : ${caps.display.max_detail_chars ?? "?"} car. de détail` }));
        }
        if (caps?.firmware != null) {
            tags.push(h("span", { class: "tag tag-neutral", text: caps.firmware }));
        }
        return section("Capacités",
            h("div", { class: "san-row", data: { list: "capabilities" } }, ...tags),
            h("details", {}, h("summary", { text: "Document complet" }), h("pre", { class: "san-json", text: JSON.stringify(caps, null, 2) })));
    }

    //#endregion

    //#region Règles --------------------------------------------------------------------

    protected _rulesSection(rules: RuleRecord[]): HTMLElement {
        const list = h("div", { class: "san-list", data: { list: "rules" } });
        if (rules.length === 0) {
            list.appendChild(emptyState("Aucune règle : ce viewer ne voit aucun agent."));
        }
        for (const rule of rules) {
            list.appendChild(this._ruleCard(rule));
        }
        return section("Règles de permission", list, this._ruleForm());
    }

    protected _ruleCard(rule: RuleRecord): HTMLElement {
        const coverage = h("div", { class: "san-meta", data: { coverage: String(rule.id) } });
        const voiceDisabled = !this._hasMic;
        return h("article", { class: "san-card", data: { rule: String(rule.id) } },
            h("div", { class: "san-row san-row-between" },
                h("span", { class: "san-title" }, h("span", { class: "tag tag-outline", text: rule.scope === "agent" ? "Agents" : "Groupes" }), ` ${rule.pattern}`),
                iconButton("Supprimer la règle", "ph-trash", () => confirmImpact({
                    title: `Supprimer la règle « ${rule.pattern} »`,
                    mutation: adminApi.deleteRule(rule.id),
                    confirmLabel: "Supprimer", danger: true,
                    onApplied: async () => { showToast("Règle supprimée.", "info"); await this.refresh(); }
                }), { data: { action: "delete-rule" } })),
            checkbox("Peut envoyer de la voix", rule.can_send_voice && !voiceDisabled, (checked) => {
                adminApi.call("PATCH", `/rules/${rule.id}`, { can_send_voice: checked }).then(() => this.refresh()).catch(reportError);
            }, { disabled: voiceDisabled }),
            voiceDisabled ? h("p", { class: "san-hint text-muted", data: { hint: "no-mic" }, text: "Grisé : ce viewer ne déclare pas de micro (audio_in), la voix serait sans effet." }) : null,
            button("Couverture actuelle", "btn-ghost", async () => {
                const result = await adminApi.coverage(rule.id);
                const names = [...result.agents.map((a) => a.slug), ...result.groups.map((g) => `groupe ${g.slug}`)];
                coverage.textContent = names.length === 0 ? "Ne couvre rien pour l'instant." : `Couvre ${result.agents.length} agent(s) : ${names.join(", ")}`;
            }, "ph-eye"),
            coverage);
    }

    protected _ruleForm(): HTMLElement {
        let scope: Scope = "agent";
        const pattern = textInput({ name: "pattern", placeholder: "ex. travail/* ou build-?", autocomplete: "off" });
        const error = h("div", { class: "san-error", role: "alert" });
        const preview = h("div", { class: "san-meta", data: { preview: "pattern" } });
        const voiceBox = checkbox("Peut envoyer de la voix", false, () => undefined, { disabled: !this._hasMic });
        const voiceInput = voiceBox.querySelector("input")!;
        const update = (): void => {
            const value = pattern.value.trim();
            const message = value === "" ? null : patternError(value);
            error.textContent = message ?? "";
            if (value === "" || message != null) {
                preview.textContent = "";
                return;
            }
            const slugs = scope === "agent" ? this._agents.map((a) => a.slug) : this._groups.map((g) => g.slug);
            const matched = slugs.filter((slug) => globMatches(value, slug));
            preview.textContent = `Aujourd'hui : ${matched.length} ${scope === "agent" ? "agent(s)" : "groupe(s)"}${matched.length > 0 ? ` — ${matched.slice(0, 8).join(", ")}${matched.length > 8 ? "…" : ""}` : ""}. Les futurs seront couverts aussi.`;
        };
        pattern.addEventListener("input", update);
        const submit = button("Ajouter la règle", "btn-primary", async () => {
            const value = pattern.value.trim();
            const message = patternError(value);
            if (message != null) {
                error.textContent = message;
                return;
            }
            await confirmImpact({
                title: `Ajouter la règle « ${value} »`,
                mutation: adminApi.createRule(this._viewer.id, { scope, pattern: value, can_send_voice: voiceInput.checked && this._hasMic }),
                confirmLabel: "Ajouter",
                onApplied: async () => { showToast("Règle ajoutée.", "success"); await this.refresh(); }
            });
        }, "ph-plus", { data: { action: "add-rule" } });
        return h("form", { class: "san-card", data: { form: "rule" } },
            h("h4", { text: "Nouvelle règle" }),
            field("Cible", segmented<Scope>("scope", [{ value: "agent", label: "Agents" }, { value: "group", label: "Groupes" }], scope, (value) => { scope = value; update(); })),
            field("Motif (glob)", pattern, "a-z 0-9 / - ; * = suite de caractères, ? = un caractère"),
            error, preview, voiceBox, submit);
    }

    //#endregion

    //#region Diagnostic ------------------------------------------------------------------

    protected _diagnostic(): HTMLElement {
        const result = h("div", { data: { result: "access" }, "aria-live": "polite" });
        const input = textInput({ name: "agent", placeholder: "slug de l'agent", list: "san-agents" });
        const datalist = h("datalist", { id: "san-agents" }, ...this._agents.map((agent) => h("option", { value: agent.slug })));
        const run = button("Diagnostiquer", "btn-secondary", async () => {
            const slug = input.value.trim();
            if (slug === "") {
                return;
            }
            try {
                result.replaceChildren(this._accessView(await adminApi.access(this._viewer.id, slug)));
            } catch (error) {
                result.replaceChildren(h("p", { class: "san-error", text: errorMessage(error) }));
            }
        }, "ph-magnifying-glass", { data: { action: "diagnose" } });
        return section("Diagnostic d'accès", h("div", { class: "san-card" }, field("Agent", input), datalist, run, result));
    }

    protected _accessView(access: AccessDetail): HTMLElement {
        const lines: HTMLElement[] = [
            h("p", { class: access.access ? "tag tag-success" : "tag tag-danger", text: access.access ? `Accès accordé à « ${access.agent} »` : `Pas d'accès à « ${access.agent} »${access.agent_revoked ? " (agent révoqué)" : ""}` })
        ];
        for (const rule of access.rules) {
            lines.push(h("p", { class: "san-meta" }, `Règle #${rule.id} : ${rule.scope === "agent" ? "agents" : "groupes"} « ${rule.pattern} »${rule.via_groups.length > 0 ? ` via ${rule.via_groups.join(", ")}` : ""}${rule.can_send_voice ? " (voix)" : ""}`));
        }
        if (access.access) {
            lines.push(h("p", { class: "san-meta", text: `Envoi vocal effectif : ${access.can_send_voice ? "oui" : access.rule_can_send_voice ? "non (pas de micro)" : "non (aucune règle ne l'autorise)"}` }));
        }
        return h("div", { class: "san-section" }, ...lines);
    }

    //#endregion

    //#region Abonnements -----------------------------------------------------------------

    protected _subscriptionsSection(view: ConfigView): HTMLElement {
        const manual = view.config.mode === "manual";
        const agents = [...view.config.agents].sort((a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name));
        const list = h("ul", { class: "san-sortable", data: { list: "subscriptions" } });
        const patches = (items: typeof agents): SubscriptionPatch[] =>
            items.map((agent, position) => manual ? { agent: agent.agent, position, subscribed: agent.subscribed, muted: agent.muted } : { agent: agent.agent, position, muted: agent.muted });
        const save = async (items: typeof agents): Promise<void> => {
            await adminApi.setSubscriptions(this._viewer.id, patches(items)).apply();
            await this.refresh();
        };
        agents.forEach((agent, index) => {
            const move = (to: number): Promise<void> => {
                const next = [...agents];
                const [item] = next.splice(index, 1);
                next.splice(to, 0, item!);
                return save(next);
            };
            list.appendChild(h("li", { data: { agent: agent.agent } },
                h("span", { class: "san-grow" }, agent.name, agent.new ? h("span", { class: "tag tag-accent", text: "nouveau" }) : null),
                manual ? checkbox("Suivi", agent.subscribed, (checked) => { save(agents.map((a) => a === agent ? { ...a, subscribed: checked } : a)).catch(reportError); }) : null,
                checkbox("Muet", agent.muted, (checked) => { save(agents.map((a) => a === agent ? { ...a, muted: checked } : a)).catch(reportError); }),
                iconButton(`Monter ${agent.name}`, "ph-arrow-up", () => move(index - 1), { disabled: index === 0 }),
                iconButton(`Descendre ${agent.name}`, "ph-arrow-down", () => move(index + 1), { disabled: index === agents.length - 1 })));
        });
        return section("Abonnements", agents.length === 0 ? emptyState("Aucun agent visible pour ce viewer.") : list);
    }

    //#endregion

    protected async _revoke(): Promise<void> {
        await confirmImpact({
            title: `Révoquer ${viewerLabel(this._viewer)}`,
            intro: "Le jeton de ce viewer cesse immédiatement de fonctionner.",
            mutation: adminApi.revokeViewer(this._viewer.id),
            confirmLabel: "Révoquer", danger: true,
            onApplied: async () => { showToast("Viewer révoqué.", "info"); await this.refresh(); }
        });
    }

}

customElements.define("viewer-detail-page", ViewerDetailPage);
