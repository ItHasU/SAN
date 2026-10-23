import { EntitiesModel } from "@dagda/shared/src/entities/model";
import { JSTypes } from "@dagda/shared/src/entities/tools/javascript.types";

/**
 * Modèle d'entités Dagda de SAN : volontairement vide.
 *
 * Le schéma métier (agents, viewers, événements…) est décrit par des migrations
 * SQL brutes côté serveur (docs/DESIGN.md §2) : identifiants texte, `bytea`,
 * contraintes `CHECK` et index partiels ne s'expriment pas dans ce modèle.
 * Les comptes administrateurs sont ceux de Dagda (`system_users`).
 */
export const APP_MODEL = new EntitiesModel({
    TEXT: {
        rawType: JSTypes.string
    }
}, {});
