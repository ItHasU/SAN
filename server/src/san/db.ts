import { PGRunner } from "@dagda/server/src/sql/impl/pg.runner";
import { SQLConnection } from "@dagda/server/src/sql/runner";

/** Exécuteur SQL (pool) de l'application */
export type Db = PGRunner;
/** Exécuteur ou connexion de transaction : les fonctions de données acceptent les deux */
export type Sql = SQLConnection;

/**
 * Exécute `callback` dans une transaction. Sur un exécuteur (pool), ouvre une
 * transaction ; sur une connexion déjà en transaction (aperçu d'impact), se
 * contente d'appeler `callback` : la transaction englobante s'applique.
 */
export function inTransaction<T>(sql: Sql, callback: (connection: Sql) => Promise<T>): Promise<T> {
    const runner = sql as Partial<Pick<PGRunner, "withTransaction">>;
    if (typeof runner.withTransaction === "function") {
        return runner.withTransaction.call(sql, callback) as Promise<T>;
    }
    return callback(sql);
}
