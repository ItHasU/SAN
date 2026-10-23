import { Db, Sql } from "./db";
import { notifyConfigChanged } from "./events";
import { accessPairs, AccessPair } from "./permissions";

/** Aperçu d'impact (SPEC §6.2, §11) : couples (viewer, agent) gagnés et perdus */
export interface Impact {
    gained: AccessPair[];
    lost: AccessPair[];
}

const key = (pair: AccessPair): string => `${pair.viewer}\u0000${pair.agent}`;

/** Différence entre deux ensembles de couples d'accès */
export function diffAccess(before: AccessPair[], after: AccessPair[]): Impact {
    const beforeKeys = new Set(before.map(key));
    const afterKeys = new Set(after.map(key));
    return {
        gained: after.filter((pair) => !beforeKeys.has(key(pair))),
        lost: before.filter((pair) => !afterKeys.has(key(pair)))
    };
}

/** Signal interne : annule la transaction d'un aperçu, en transportant son résultat */
class DryRunRollback<T> extends Error {
    constructor(public readonly outcome: MutationOutcome<T>) {
        super("dry run");
    }
}

export type MutationOutcome<T> = { dryRun: false, result: T, impact: Impact } | { dryRun: true, result: T, impact: Impact };

/**
 * Exécute une mutation d'administration dans une transaction et calcule son
 * impact sur la couverture des permissions (avant/après).
 *
 * - `dryRun = true` : la transaction est annulée (rien n'est modifié, aucune
 *   notification émise) et le résultat porte l'impact ;
 * - sinon : la mutation est validée et une notification de configuration est
 *   émise dans la même transaction (SSE `config`).
 */
export async function withImpact<T>(db: Db, dryRun: boolean, mutation: (connection: Sql) => Promise<T>): Promise<MutationOutcome<T>> {
    try {
        return await db.withTransaction(async (conn) => {
            const before = await accessPairs(conn);
            const result = await mutation(conn);
            const impact = diffAccess(before, await accessPairs(conn));
            if (dryRun) {
                throw new DryRunRollback({ dryRun: true, result, impact });
            }
            await notifyConfigChanged(conn);
            return { dryRun: false as const, result, impact };
        });
    } catch (error) {
        if (error instanceof DryRunRollback) {
            return error.outcome as MutationOutcome<T>;
        }
        throw error;
    }
}
