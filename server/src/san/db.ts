import { PGRunner } from "@dagda/server/src/sql/impl/pg.runner";
import { SQLConnection } from "@dagda/server/src/sql/runner";

/** Exécuteur SQL (pool) de l'application */
export type Db = PGRunner;
/** Exécuteur ou connexion de transaction : les fonctions de données acceptent les deux */
export type Sql = SQLConnection;
