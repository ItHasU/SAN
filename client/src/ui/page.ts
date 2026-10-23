import { AbstractPageElement } from "@dagda/client/src/pages/abstract.page.element";
import { h } from "../lib/dom";
import { button, errorMessage } from "./common";

/**
 * Base des pages SAN : un conteneur `.san-page` rempli par `_render()`.
 * Une erreur de chargement s'affiche avec un bouton « Réessayer » plutôt que de vider la page.
 */
export abstract class SanPage extends AbstractPageElement {

    protected _timers: Array<ReturnType<typeof setInterval>> = [];

    protected constructor() {
        super({ template: `<div class="san-page" data-san-page></div>` });
    }

    protected get _root(): HTMLElement {
        return this.querySelector("[data-san-page]") as HTMLElement;
    }

    /** Dessine la page dans `_root` */
    protected abstract _render(): Promise<void>;

    protected override async _refresh(): Promise<void> {
        try {
            await this._render();
        } catch (error) {
            console.warn("Chargement impossible :", errorMessage(error));
            this._root.replaceChildren(h("div", { class: "san-empty", role: "alert" },
                h("p", { text: `Chargement impossible : ${errorMessage(error)}` }),
                button("Réessayer", "btn-primary", () => this.refresh().then(() => undefined), "ph-arrow-clockwise")));
        }
    }

    /** Intervalle supprimé à la fermeture de la page */
    protected _every(ms: number, action: () => void): void {
        this._timers.push(setInterval(action, ms));
    }

    public override dispose(): Promise<void> {
        this._timers.forEach((timer) => clearInterval(timer));
        this._timers = [];
        return Promise.resolve();
    }

}
