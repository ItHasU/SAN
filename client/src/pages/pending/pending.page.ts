import { showToast } from "@dagda/client/src/components/toast/toast.component";
import { ViewerRecord } from "@san/shared/src/api/types";
import { adminApi } from "../../app";
import { h, setChildren } from "../../lib/dom";
import { formatRelative } from "../../lib/time";
import { button, emptyState, pageHeader, viewerLabel } from "../../ui/common";
import { confirmImpact, promptDialog } from "../../ui/dialogs";
import { SanPage } from "../../ui/page";

/** Demandes d'enrôlement en attente (SPEC §11) : activer avec un nom, ou refuser */
export class PendingPage extends SanPage {

    protected _built = false;
    protected _list!: HTMLElement;

    constructor() {
        super();
    }

    protected override async _init(): Promise<void> {
        this._list = h("div", { class: "san-list san-list-cols", data: { list: "pending" } });
        setChildren(this._root, pageHeader("Demandes en attente", button("Actualiser", "btn-secondary", () => this.refresh().then(() => undefined), "ph-arrow-clockwise")), this._list);
        this._every(10_000, () => { void this.refresh(); });
        this._built = true;
    }

    protected async _render(): Promise<void> {
        const viewers = await adminApi.viewers("pending");
        const now = Date.now();
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
