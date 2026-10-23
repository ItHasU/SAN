import { SanConfig } from "./config";
import { Db } from "./db";
import { purgePendingViewers } from "./viewers";

/**
 * Tâches périodiques (DESIGN §3). Phase 1 : purge des viewers `pending` de plus
 * de 7 jours. Les purges d'événements expirés et de clips orphelins s'ajouteront
 * ici en phase 2.
 */
export async function runPeriodicTasks(db: Db, config: Pick<SanConfig, "pendingMaxAgeDays">, now: Date = new Date()): Promise<{ purgedPendingViewers: number }> {
    return { purgedPendingViewers: await purgePendingViewers(db, config.pendingMaxAgeDays, now) };
}

/** Lance les tâches périodiques ; renvoie la fonction d'arrêt */
export function startPeriodicTasks(db: Db, config: Pick<SanConfig, "pendingMaxAgeDays" | "purgeIntervalMs">, log: (message: string) => void = console.log): () => void {
    const timer = setInterval(() => {
        runPeriodicTasks(db, config).then((result) => {
            if (result.purgedPendingViewers > 0) {
                log(`Purge : ${result.purgedPendingViewers} demande(s) d'enrôlement expirée(s) supprimée(s).`);
            }
        }).catch((error: unknown) => console.error("Periodic task failed:", error));
    }, config.purgeIntervalMs);
    // Ne retient pas le processus à l'arrêt
    timer.unref();
    return () => clearInterval(timer);
}
