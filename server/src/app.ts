import { AbstractServerApp } from "@dagda/server/src/app";
import { RequestOptions } from "@dagda/server/src/api";
import { Data } from "@dagda/shared/src/entities/tools/adapters";
import { AppTypes } from "@san/shared/src/app/types";
import { AppContexts } from "@san/shared/src/entities/contexts";
import { AppEntityTypes } from "@san/shared/src/entities/types";

export class ServerApp extends AbstractServerApp<AppTypes> {

    /** SAN ne charge aucune entité Dagda : l'API passe par /api/v1 */
    protected override async _fetch(_context: AppContexts, _request: RequestOptions): Promise<Data<AppEntityTypes>> {
        return {};
    }

}
