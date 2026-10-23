import { EntitiesAPI } from "@dagda/shared/src/api/impl/entities.api";
import { SystemAPI } from "@dagda/shared/src/api/impl/system.api";
import { BaseAppTypes } from "@dagda/shared/src/app/types";
import { AppContexts } from "../entities/contexts";
import { AppEntityTypes, AppFieldTypes } from "../entities/types";
import { AppPermission } from "../permissions";
import { AppNotifications } from "../services";

/** App types — the contract both sides of the application compile against */
export interface AppTypes extends BaseAppTypes {
    fieldTypes: AppFieldTypes;
    entities: AppEntityTypes;
    contexts: AppContexts;
    apis: SystemAPI & EntitiesAPI<AppContexts, AppEntityTypes>;
    events: AppNotifications;
    permissions: AppPermission;
}
