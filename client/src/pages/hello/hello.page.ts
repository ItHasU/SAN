import { AbstractPageElement } from "@dagda/client/src/pages/abstract.page.element";
import template from "./hello.page.html";

/**
 * A static page sample: no data to load, just a template.
 *
 * It still overrides `_refresh()` and `dispose()` to show where a real page
 * would hook into its lifecycle — loading data when the page is shown, and
 * releasing it (subscriptions, timers, …) when it is torn down — even though
 * neither has anything to do here.
 */
export class HelloPage extends AbstractPageElement {

    constructor() {
        super({
            template: template
        });
    }

    /** Nothing to be done here */
    protected override _refresh(): Promise<void> {
        return Promise.resolve();
    }

    /** Nothing to be done here */
    public override dispose(): Promise<void> {
        return Promise.resolve();
    }

}

customElements.define("hello-page", HelloPage);