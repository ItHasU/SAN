import { readFile } from "node:fs/promises";
import { defineConfig } from "vitest/config";

/**
 * Loads `*.html` imports as plain strings, the same way webpack's html-loader
 * does at build time — see Dagda's own `vitest.config.ts` for the original.
 */
function htmlTemplates() {
    return {
        name: "san:html-templates",
        enforce: "pre" as const,
        async load(id: string): Promise<string | null> {
            const path = id.split("?")[0];
            if (path == null || !path.endsWith(".html")) {
                return null;
            }
            return `export default ${JSON.stringify(await readFile(path, "utf8"))};`;
        }
    };
}

/**
 * Point the framework's PostgreSQL fixture at this application's test database.
 *
 * Set here, in the config module, rather than through `test.env`: the global
 * setup that probes the database runs in the Vitest main process, before any
 * worker exists, so `test.env` would come too late and the probe would look for
 * the framework's own database instead.
 *
 * An explicit DAGDA_TEST_DB_URL still wins, for a run against another server.
 */
process.env["DAGDA_TEST_DB_URL"] ??= "postgresql://dagda:dagda@localhost:5432/dagda";

export default defineConfig({
    test: {
        projects: [
            {
                // The typed contract: model, contexts. No DOM, no database.
                test: {
                    name: "shared",
                    root: "./shared",
                    environment: "node",
                    include: ["src/**/*.spec.ts"]
                }
            },
            {
                // Components taken in isolation, against a simulated DOM.
                plugins: [htmlTemplates()],
                // Spelled out rather than read from client/tsconfig.json, which
                // excludes the test files: the transform would then fall back
                // to defaults and choke on the first `@Ref()` decorator.
                oxc: {
                    tsconfigRaw: {
                        compilerOptions: {
                            target: "es2024",
                            experimentalDecorators: true,
                            useDefineForClassFields: false
                        }
                    }
                },
                test: {
                    name: "client",
                    root: "./client",
                    environment: "jsdom",
                    // An origin, because `about:blank` is opaque and web
                    // storage does not exist on an opaque origin.
                    environmentOptions: {
                        jsdom: { url: "http://localhost/" }
                    },
                    // No localStorage setup file (compare Dagda's own
                    // vitest.config.ts): nothing under test here touches it
                    // yet. `@dagda/client` is a `file:` dependency resolved
                    // through a symlink, and Vite refuses to serve a
                    // setupFile from across it — add one once a component
                    // actually needs storage, and solve that then.
                    include: ["src/**/*.spec.ts"]
                }
            },
            {
                // Server side, including the tests that need a real PostgreSQL.
                test: {
                    name: "server",
                    root: "./server",
                    environment: "node",
                    include: ["src/**/*.spec.ts"],
                    // The framework's fixture, reused rather than copied: one
                    // implementation of "a scratch schema per suite".
                    globalSetup: ["../node_modules/@dagda/server/src/test/pg.globalsetup.ts"]
                }
            }
        ]
    }
});
