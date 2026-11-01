import { expect, test } from "@playwright/test";
import { login } from "./support/helpers";

test.describe("PWA", () => {

    test("manifest, icônes et service worker accessibles sans session", async ({ request }) => {
        const manifest = await request.get("/assets/manifest.json", { maxRedirects: 0 });
        expect(manifest.status()).toBe(200);
        expect(manifest.headers()["content-type"]).toContain("application/manifest+json");
        const body = await manifest.json() as { short_name: string, display: string, icons: Array<{ src: string, sizes: string, purpose?: string }> };
        expect(body.short_name).toBe("SAN");
        expect(body.display).toBe("standalone");
        expect(body.icons.map((icon) => icon.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
        expect(body.icons.some((icon) => icon.purpose === "maskable")).toBe(true);
        for (const icon of body.icons) {
            const response = await request.get(`/assets/${icon.src}`, { maxRedirects: 0 });
            expect(response.status(), icon.src).toBe(200);
        }
        expect((await request.get("/assets/icon.png", { maxRedirects: 0 })).status()).toBe(200);
        const worker = await request.get("/sw.js", { maxRedirects: 0 });
        expect(worker.status()).toBe(200);
        expect(worker.headers()["cache-control"]).toBe("no-cache");
        // Le bundle, lui, reste derrière la porte de session
        expect((await request.get("/main.js", { maxRedirects: 0 })).status()).toBe(302);
    });

    test("la page de connexion annonce le manifest et le service worker s'enregistre", async ({ page }) => {
        await page.goto("/login");
        await expect(page.locator("link[rel=manifest]")).toHaveAttribute("href", "/assets/manifest.json");
        await login(page);
        await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.scriptURL ?? null), { timeout: 10_000 })
            .toMatch(/\/sw\.js$/);
    });

    test("page « Hors ligne » quand le serveur est injoignable", async ({ page, context }) => {
        await login(page);
        await page.evaluate(() => navigator.serviceWorker.ready);
        await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller != null)).toBe(true);
        await context.setOffline(true);
        await page.reload();
        await expect(page.getByRole("heading", { name: "Hors ligne" })).toBeVisible();
        await context.setOffline(false);
        await page.getByRole("button", { name: "Réessayer" }).click();
        await expect(page.locator("[data-connection]")).toBeVisible();
    });

});
