import { createTestDatabase, TEST_DB_URL, TestDatabase } from "@dagda/server/src/test/pg.fixture";
import { APP_CONTEXT_ADAPTER } from "@san/shared/src/entities/contexts";
import { APP_MODEL } from "@san/shared/src/entities/model";
import { APP_PERMISSIONS } from "@san/shared/src/permissions";
import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";
import { ServerApp } from "../app";
import { SanConfig } from "../san/config";

export interface ApiResponse {
    status: number;
    headers: Headers;
    /** Corps décodé (null si vide) */
    json: any;
}

export interface RequestInit2 {
    token?: string;
    cookie?: string;
    body?: unknown;
    /** Corps brut (prioritaire sur `body`) */
    raw?: string;
    headers?: Record<string, string>;
}

export interface TestApp {
    app: ServerApp;
    db: TestDatabase;
    baseUrl: string;
    /** Appelle `/api/v1<path>` */
    api(method: string, path: string, init?: RequestInit2): Promise<ApiResponse>;
    /** Ouvre une session Dagda (admin/admin créé par le framework) et renvoie le cookie */
    loginAdmin(): Promise<string>;
    close(): Promise<void>;
}

/**
 * Une vraie application SAN contre un schéma PostgreSQL jetable, migrée,
 * servie sur un port éphémère. Pas de `listen()` : les tâches périodiques ne
 * tournent pas, les tests appellent les purges eux-mêmes.
 */
export async function createTestApp(label: string, san: Partial<SanConfig> = {}): Promise<TestApp> {
    const db = await createTestDatabase(label);
    const url = new URL(TEST_DB_URL);
    url.searchParams.set("options", `-c search_path=${db.schema}`);
    process.env["APP_PORT"] = "0";
    process.env["APP_BASE_URL"] = "http://localhost";
    process.env["APP_DATABASE_URL"] = url.toString();
    process.env["APP_SECRET"] = "glUGBe5xyLTagSXb4SFa3oQBxeVoqVymDlqy9lDSEO0=";

    const app = new ServerApp({ staticFolder: "." }, APP_MODEL, APP_CONTEXT_ADAPTER, undefined, undefined, APP_PERMISSIONS, san);
    await app.migrate();

    const server: Server = createServer(app.handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const api = async (method: string, path: string, init: RequestInit2 = {}): Promise<ApiResponse> => {
        const headers: Record<string, string> = { ...init.headers };
        if (init.token != null) {
            headers["authorization"] = `Bearer ${init.token}`;
        }
        if (init.cookie != null) {
            headers["cookie"] = init.cookie;
        }
        let body: string | undefined = init.raw;
        if (body === undefined && init.body !== undefined) {
            body = JSON.stringify(init.body);
        }
        if (body !== undefined) {
            headers["content-type"] ??= "application/json";
        }
        const response = await fetch(`${baseUrl}/api/v1${path}`, { method, headers, body, redirect: "manual" });
        const text = await response.text();
        let json: unknown = null;
        if (text !== "") {
            try {
                json = JSON.parse(text);
            } catch {
                json = text;
            }
        }
        return { status: response.status, headers: response.headers, json };
    };

    return {
        app, db, baseUrl, api,
        loginAdmin: async () => {
            const response = await fetch(`${baseUrl}/login`, {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded" },
                body: "login=admin&password=admin",
                redirect: "manual"
            });
            const cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
            if (response.status !== 302 || cookie === "") {
                throw new Error(`Login failed (${response.status})`);
            }
            return cookie;
        },
        close: async () => {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await app.close();
            await db.dispose();
        }
    };
}
