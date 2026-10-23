import { ViewerRecord } from "@san/shared/src/api/types";
import { adminApi } from "../../app";
import { dagda } from "../../dagda";
import { h, setChildren } from "../../lib/dom";
import { formatRelative } from "../../lib/time";
import { button, emptyState, pageHeader, viewerLabel } from "../../ui/common";
import { SanPage } from "../../ui/page";

const STATUS_TAG: Record<string, string> = { active: "tag-success", pending: "tag-warning", revoked: "tag-danger" };
const STATUS_LABEL: Record<string, string> = { active: "Actif", pending: "En attente", revoked: "Révoqué" };

/** Résumé d'un viewer, utilisé par la liste */
export function viewerCard(viewer: ViewerRecord, now: number, onOpen: () => void): HTMLElement {
    const firmware = viewer.capabilities?.firmware;
    return h("article", { class: "san-card", data: { viewer: viewer.id, kind: viewer.kind, status: viewer.status } },
        h("div", { class: "san-row san-row-between" },
            h("span", { class: "san-title", text: viewerLabel(viewer) }),
            h("span", { class: `tag ${STATUS_TAG[viewer.status] ?? "tag-neutral"}`, text: STATUS_LABEL[viewer.status] ?? viewer.status })),
        h("div", { class: "san-row" },
            h("span", { class: "tag tag-outline", text: viewer.kind === "web" ? "Web" : "Carte" }),
            h("span", { class: "tag tag-outline", text: viewer.subscription_mode === "auto" ? "Mode auto" : "Mode manuel" })),
        h("p", { class: "san-meta" }, `Firmware : ${firmware ?? "—"}`),
        h("p", { class: "san-meta" }, `Dernière connexion : ${formatRelative(viewer.last_seen_at, now)}`),
        h("p", { class: "san-meta" }, `Prochain réveil : ${viewer.next_wake_at == null ? "—" : formatRelative(viewer.next_wake_at, now)}`),
        h("p", { class: "san-meta" }, `Batterie : ${viewer.battery_pct == null ? "—" : `${viewer.battery_pct} %`}`),
        button("Détail et permissions", "btn-primary", onOpen, "ph-caret-right"));
}

/** Liste des viewers connus (hors demandes en attente) */
export class ViewersPage extends SanPage {

    protected _list!: HTMLElement;

    constructor() {
        super();
    }

    protected override async _init(): Promise<void> {
        this._list = h("div", { class: "san-list san-list-cols", data: { list: "viewers" } });
        setChildren(this._root, pageHeader("Viewers", button("Actualiser", "btn-secondary", () => this.refresh().then(() => undefined), "ph-arrow-clockwise")), this._list);
        this._every(15_000, () => { void this.refresh(); });
    }

    protected async _render(): Promise<void> {
        const viewers = (await adminApi.viewers()).filter((viewer) => viewer.status !== "pending");
        const now = Date.now();
        if (viewers.length === 0) {
            this._list.replaceChildren(emptyState("Aucun viewer. Activez une demande en attente ou ouvrez le tableau de bord pour enregistrer ce navigateur."));
            return;
        }
        this._list.replaceChildren(...viewers.map((viewer) => viewerCard(viewer, now,
            () => { dagda.pages.setPage("viewerDetail", { "viewer-id": viewer.id }).catch(console.error); })));
    }

}

customElements.define("viewers-page", ViewersPage);
