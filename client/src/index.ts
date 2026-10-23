import { APP_CONTEXT_ADAPTER } from "@san/shared/src/entities/contexts";
import { APP_MODEL } from "@san/shared/src/entities/model";
import { APP_PERMISSIONS } from "@san/shared/src/permissions";
import { DagdaClient } from "@dagda/client/src/app";
import { ClientDagda } from "@dagda/client/src/app/dagda";
import { _setDagda } from "./dagda";
import { HelloPage } from "./pages/hello/hello.page";
import { ClientAppTypes } from "./services";

// Client minimal : la page d'accueil Dagda. Le tableau de bord et
// l'administration arrivent en phase 3.
DagdaClient.start<ClientAppTypes>({
    model: APP_MODEL,
    contextAdapter: APP_CONTEXT_ADAPTER,
    title: "SAN",
    brand: {
        label: "SAN",
        icon: "ph-broadcast"
    },
    pages: {
        hello: { title: "Accueil", constructor: HelloPage, icon: "ph-house" }
    },
    permissions: APP_PERMISSIONS,
    buildDagda: (params) => {
        const instance = new ClientDagda<ClientAppTypes>(params);
        _setDagda(instance);
        return instance;
    }
}).catch((err: unknown) => console.error("SAN failed to start", err));
