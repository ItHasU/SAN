import { Client } from "pg";

/**
 * La base `san_e2e` (créée une fois : `sudo -u postgres createdb -O dagda san_e2e`)
 * est recréée à chaque exécution par `start-server.mjs`. Playwright lance en effet
 * le `webServer` AVANT le `globalSetup` : la remise à zéro doit précéder le
 * démarrage du serveur. Ce setup vérifie seulement que la base répond.
 */
export default async function globalSetup(): Promise<void> {
    const client = new Client({ connectionString: process.env["SAN_E2E_DB_URL"] ?? "postgresql://dagda:dagda@localhost:5432/san_e2e" });
    await client.connect();
    await client.end();
}
