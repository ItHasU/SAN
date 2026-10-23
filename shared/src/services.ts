import { EntitiesService } from "@dagda/shared/src/entities/service";
import { DagdaAppEvents } from "@dagda/shared/src/notification/events";
import { NotificationService } from "@dagda/shared/src/notification/service";
import { LogService } from "@dagda/shared/src/tools/log";
import { AppContexts } from "./entities/contexts";
import { AppEntityTypes } from "./entities/types";

/** Événements du framework ; SAN n'en ajoute pas (le temps réel passe par SSE sur /api/v1). */
export type AppNotifications = DagdaAppEvents<AppContexts>;

export interface SharedServices extends LogService, EntitiesService<AppEntityTypes, AppContexts>, NotificationService<AppNotifications> {
}
