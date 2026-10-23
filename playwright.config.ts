import { defineConfig, devices } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Chromium préinstallé (le `playwright install` n'est pas lancé). La révision
 * installée peut différer de celle attendue par @playwright/test : on désigne
 * donc l'exécutable. `SAN_E2E_CHROMIUM` le force ; sinon recherche dans
 * `PLAYWRIGHT_BROWSERS_PATH`, `/opt/pw-browsers` et `~/.cache/ms-playwright`.
 */
function findChromium(): string | undefined {
    const forced = process.env["SAN_E2E_CHROMIUM"];
    if (forced != null && forced !== "") {
        return forced;
    }
    const roots = [process.env["PLAYWRIGHT_BROWSERS_PATH"], "/opt/pw-browsers", join(homedir(), ".cache", "ms-playwright")];
    for (const root of roots) {
        if (root == null || !existsSync(root)) {
            continue;
        }
        const entries = readdirSync(root).sort().reverse();
        for (const [prefix, binary] of [["chromium_headless_shell-", "chrome-headless-shell-linux64/chrome-headless-shell"], ["chromium-", "chrome-linux64/chrome"]] as const) {
            for (const entry of entries.filter((name) => name.startsWith(prefix))) {
                const candidate = join(root, entry, binary);
                if (existsSync(candidate)) {
                    return candidate;
                }
            }
        }
    }
    return undefined;
}

const executablePath = findChromium();

/** Bibliothèques système extraites (libnss…) si le conteneur n'en fournit pas : `SAN_E2E_LIBS` ou `~/.cache/pw-libs/root` */
const libs = process.env["SAN_E2E_LIBS"] ?? join(homedir(), ".cache", "pw-libs", "root", "usr", "lib", "x86_64-linux-gnu");
const launchEnv: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
    if (value != null) {
        launchEnv[key] = value;
    }
}
if (existsSync(libs)) {
    launchEnv["LD_LIBRARY_PATH"] = [libs, process.env["LD_LIBRARY_PATH"]].filter(Boolean).join(":");
}

/**
 * Tests de bout en bout : le vrai serveur construit, une vraie base PostgreSQL
 * (`san_e2e`, recréée à chaque exécution), un vrai navigateur. Mobile d'abord.
 */
const PORT = Number(process.env["SAN_E2E_PORT"] ?? 3200);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
    testDir: "./e2e",
    testMatch: "**/*.e2e.ts",
    globalSetup: "./e2e/support/global-setup.ts",
    // Une seule base partagée : les parcours se préfixent par un identifiant unique, mais le serveur est unique
    fullyParallel: false,
    workers: 1,
    forbidOnly: !!process.env["CI"],
    retries: process.env["CI"] ? 1 : 0,
    reporter: process.env["CI"] ? "github" : "list",
    outputDir: "./e2e/.results",
    use: {
        baseURL: BASE_URL,
        trace: "retain-on-failure",
        // Micro factice : MediaRecorder fonctionne sans matériel ni invite de permission
        launchOptions: { executablePath, env: launchEnv, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
        permissions: ["microphone"]
    },
    projects: [
        { name: "pixel-7", use: { ...devices["Pixel 7"] } },
        // WebKit n'est pas installé : iPhone 13 en Chromium (viewport, UA et tactile de l'appareil)
        { name: "iphone-13", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" } },
        { name: "desktop", use: { ...devices["Desktop Chrome"] } }
    ],
    webServer: {
        // Le build est fait par le script `test:e2e`
        command: "node e2e/support/start-server.mjs",
        url: `${BASE_URL}/login`,
        reuseExistingServer: false,
        timeout: 90_000,
        stdout: "pipe",
        stderr: "pipe"
    }
});
