// Commande du `webServer` Playwright : réinitialise la base `san_e2e`, puis lance
// le serveur construit (`node dist/main.js`, depuis `server/`) avec un TTS factice.
// (Playwright lance le webServer avant le globalSetup : la remise à zéro est donc ici.)
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const port = process.env.SAN_E2E_PORT ?? "3200";
const databaseUrl = process.env.SAN_E2E_DB_URL ?? "postgresql://dagda:dagda@localhost:5432/san_e2e";
const dataDir = resolve(root, "server/.e2e-data");

/** Repart d'une base vide : Dagda recrée alors le compte admin / admin */
const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
await client.query("DROP SCHEMA IF EXISTS public CASCADE");
await client.query("CREATE SCHEMA public");
await client.end();
rmSync(dataDir, { recursive: true, force: true });

const child = spawn("node", ["dist/main.js"], {
    cwd: resolve(root, "server"),
    stdio: "inherit",
    env: {
        ...process.env,
        APP_PORT: port,
        APP_BASE_URL: `http://127.0.0.1:${port}`,
        APP_DATABASE_URL: databaseUrl,
        APP_SECRET: randomBytes(32).toString("base64"),
        DATA_DIR: dataDir,
        TTS_ENGINE: "fake",
        SAN_REGISTER_RATE_PER_HOUR: "1000",
        SAN_MAX_PENDING: "200"
    }
});
for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
}
child.on("exit", (code) => process.exit(code ?? 0));
