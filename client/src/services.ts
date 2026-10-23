import { AppTypes } from "@san/shared/src/app/types";
import { DashboardPage } from "./pages/dashboard/dashboard.page";
import { AgentsPage } from "./pages/agents/agents.page";
import { GroupsPage } from "./pages/groups/groups.page";
import { PendingPage } from "./pages/pending/pending.page";
import { ViewerDetailPage } from "./pages/viewers/viewer-detail.page";
import { ViewersPage } from "./pages/viewers/viewers.page";

export type AppPages = {
    "dashboard": DashboardPage;
    "pending": PendingPage;
    "viewers": ViewersPage;
    "viewerDetail": ViewerDetailPage;
    "agents": AgentsPage;
    "groups": GroupsPage;
};

export interface ClientAppTypes extends AppTypes {
    pages: AppPages;
    /** Aucune fonction de modèle : SAN passe par l'API REST */
    model: {};
}
