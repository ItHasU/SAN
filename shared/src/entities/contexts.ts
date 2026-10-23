import { ContextAdapter } from "@dagda/shared/src/entities/tools/adapters";
import { buildContextAdapter, neverIntersects } from "@dagda/shared/src/entities/tools/contexts";
import { BaseContext } from "@dagda/shared/src/entities/types";

/**
 * Aucun chargement d'entités Dagda dans SAN : les données passent par l'API
 * REST `/api/v1`. Un contexte factice est néanmoins requis par les types.
 */
export type NoneContext = BaseContext<"none", {}>;

export type AppContexts = NoneContext;

export const APP_CONTEXT_ADAPTER: ContextAdapter<AppContexts> = buildContextAdapter<AppContexts>({
    none: neverIntersects()
});
