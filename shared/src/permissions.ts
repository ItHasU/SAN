import { DagdaPermission, PermissionsDeclaration } from "@dagda/shared/src/auth/permissions";

/**
 * Permissions propres à SAN : aucune. Tout utilisateur connecté est
 * administrateur (SPEC §16).
 */
export const APP_PERMISSIONS = {} as const satisfies PermissionsDeclaration;

export type AppPermission = DagdaPermission | keyof typeof APP_PERMISSIONS;
