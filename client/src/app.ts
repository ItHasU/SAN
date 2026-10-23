import { EventView } from "@san/shared/src/api/types";
import { AdminApi, LocalTokenStore, ViewerApi } from "./lib/api";
import { buildCapabilities } from "./lib/capabilities";
import { showSystemNotification, vibrateFor } from "./lib/notify";
import { ViewerSession } from "./lib/session";
import { DashboardStore } from "./lib/store";

/** API d'administration (session Dagda) */
export const adminApi = new AdminApi();

export interface DashboardRuntime {
    api: ViewerApi;
    store: DashboardStore;
    session: ViewerSession;
}

let runtime: DashboardRuntime | null = null;

/** Le viewer web de ce navigateur : un seul par onglet, partagé entre les visites de la page */
export function dashboardRuntime(): DashboardRuntime {
    if (runtime == null) {
        const store = new DashboardStore();
        const api: ViewerApi = new ViewerApi({
            tokens: new LocalTokenStore(),
            capabilities: () => buildCapabilities(undefined, typeof Notification !== "undefined" && Notification.permission === "granted"),
            label: `Navigateur web (${navigator.platform || "inconnu"})`,
            onReregistered: () => { store.maxEventId = 0; }
        });
        const onLiveEvent = (event: EventView): void => {
            if (event.muted === true) {
                return;
            }
            vibrateFor(event);
            showSystemNotification(event, store.agentName(event.agent));
        };
        runtime = { api, store, session: new ViewerSession(api, store, { onLiveEvent }) };
    }
    return runtime;
}
