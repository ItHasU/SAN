import { APIRequestContext, expect, Page, request, TestInfo } from "@playwright/test";

export const ADMIN = { login: "admin", password: "admin" };

/** Identifiant unique pour que les parcours (même base, même serveur) ne se marchent pas dessus */
export function uid(prefix = "t"): string {
    return `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

/** Connexion Dagda ; attend le dessin de la coquille puis du tableau de bord */
export async function login(page: Page): Promise<void> {
    await page.goto("/login");
    await page.fill("#login", ADMIN.login);
    await page.fill("#password", ADMIN.password);
    await page.click("button[type=submit]");
    await expect(page.locator("dagda-app .shell")).toBeVisible();
    await expect(page.locator("dashboard-page .san-page")).toBeVisible();
}

/** Ouvre le menu s'il est replié (mobile : tiroir) */
async function openMenu(page: Page): Promise<void> {
    const toggle = page.locator(".shell-toggle");
    if (await toggle.getAttribute("aria-expanded") === "false") {
        await toggle.click();
    }
}

/** Navigue par le menu Dagda (sections dépliées au besoin) puis referme le tiroir */
export async function goTo(page: Page, label: string): Promise<void> {
    await openMenu(page);
    const entry = page.locator(".shell-pages .shell-entry, .shell-group-primary > li > .shell-entry").filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).first();
    if (!await entry.isVisible()) {
        await page.locator(".shell-group-primary > li > .shell-entry", { hasText: "Administration" }).click();
    }
    await entry.click();
    await expect(entry).toHaveAttribute("aria-current", "page");
}

/** Session administrateur pour appeler `/api/v1/admin/*` depuis le test (même cookie que la page) */
export function adminCall<T = unknown>(page: Page, method: string, path: string, data?: unknown): Promise<T> {
    return page.evaluate(async ([m, p, d]) => {
        const response = await fetch(`/api/v1/admin${p}`, { method: m as string, credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: d === undefined ? undefined : JSON.stringify(d) });
        return response.json();
    }, [method, path, data] as const) as Promise<T>;
}

/** Client d'un agent simulé (jeton `agt_`) : publie état et nudges comme un vrai `curl` */
export class FakeAgent {
    constructor(private readonly _api: APIRequestContext, private readonly _token: string) { }

    private _headers(): Record<string, string> {
        return { Authorization: `Bearer ${this._token}`, "Content-Type": "application/json" };
    }

    public async state(body: { status: string, detail?: string, progress?: number, ttl_s?: number }): Promise<void> {
        const response = await this._api.post("/api/v1/agent/state", { headers: this._headers(), data: body });
        expect(response.status()).toBe(200);
    }

    public async nudge(body: { text?: string, priority?: "normal" | "high" }): Promise<void> {
        const response = await this._api.post("/api/v1/agent/nudge", { headers: this._headers(), data: body });
        expect(response.status(), await response.text()).toBeLessThan(300);
    }

    public static async create(token: string, baseURL: string): Promise<FakeAgent> {
        return new FakeAgent(await request.newContext({ baseURL }), token);
    }
}

/** Capture d'écran dans `e2e/screenshots/<projet>-<nom>.png` (revue visuelle) */
export async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
    await page.screenshot({ path: `e2e/screenshots/${info.project.name}-${name}.png`, fullPage: false });
}
