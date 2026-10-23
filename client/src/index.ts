import "./styles/san.css";
import { APP_CONTEXT_ADAPTER } from "@san/shared/src/entities/contexts";
import { APP_MODEL } from "@san/shared/src/entities/model";
import { APP_PERMISSIONS } from "@san/shared/src/permissions";
import { DagdaClient } from "@dagda/client/src/app";
import { ClientDagda } from "@dagda/client/src/app/dagda";
import { _setDagda } from "./dagda";
import { AgentsPage } from "./pages/agents/agents.page";
import { DashboardPage } from "./pages/dashboard/dashboard.page";
import { GroupsPage } from "./pages/groups/groups.page";
import { PendingPage } from "./pages/pending/pending.page";
import { ViewerDetailPage } from "./pages/viewers/viewer-detail.page";
import { ViewersPage } from "./pages/viewers/viewers.page";
import { ClientAppTypes } from "./services";

// Tableau de bord (viewer web) en page d'accueil ; l'administration dans une
// section du menu ; la fiche d'un viewer n'est pas listée (ouverte depuis la liste).
DagdaClient.start<ClientAppTypes>({
    model: APP_MODEL,
    contextAdapter: APP_CONTEXT_ADAPTER,
    title: "SAN",
    brand: {
        label: "SAN",
        icon: "ph-broadcast"
    },
    sections: {
        admin: { label: "Administration", icon: "ph-gear-six", order: 1 }
    },
    pages: {
        dashboard: { title: "Tableau de bord", constructor: DashboardPage, icon: "ph-squares-four", menu: { order: 0 } },
        pending: { title: "Demandes en attente", constructor: PendingPage, icon: "ph-hourglass", menu: { section: "admin", order: 0 } },
        viewers: { title: "Viewers", constructor: ViewersPage, icon: "ph-devices", menu: { section: "admin", order: 1 } },
        agents: { title: "Agents", constructor: AgentsPage, icon: "ph-robot", menu: { section: "admin", order: 2 } },
        groups: { title: "Groupes", constructor: GroupsPage, icon: "ph-users-three", menu: { section: "admin", order: 3 } },
        viewerDetail: { title: "Viewer", constructor: ViewerDetailPage, icon: "ph-device-mobile" }
    },
    permissions: APP_PERMISSIONS,
    buildDagda: (params) => {
        const instance = new ClientDagda<ClientAppTypes>(params);
        _setDagda(instance);
        return instance;
    }
}).catch((err: unknown) => console.error("SAN failed to start", err));
