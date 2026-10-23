import { DEFAULT_SERVER_PARAMS } from "@dagda/server/src/app";
import { APP_CONTEXT_ADAPTER } from "@san/shared/src/entities/contexts";
import { APP_MODEL } from "@san/shared/src/entities/model";
import { APP_PERMISSIONS } from "@san/shared/src/permissions";
import { ServerApp } from "./app";

async function main(): Promise<void> {
    APP_MODEL.validate();
    // Comptes locaux Dagda : sur une base vide le framework crée admin/admin
    // et le signale au démarrage (FEATURES §7).
    const app = new ServerApp({ ...DEFAULT_SERVER_PARAMS }, APP_MODEL, APP_CONTEXT_ADAPTER, undefined, undefined, APP_PERMISSIONS);
    await app.listen();
}

main().catch(e => console.error(e));
