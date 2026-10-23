import { expect, test } from "@playwright/test";
import { createAgentApi, FakeAgent, grantSelf, login, uid } from "./support/helpers";

test.describe("Audio", () => {

    test("enregistrement vocal vers un agent autorisé (POST /viewer/voice?to=)", async ({ page }, info) => {
        await login(page);
        await expect(page.locator("[data-connection=live]")).toBeVisible();
        const slug = uid("voix");
        const token = await createAgentApi(page, slug, "Agent voix");
        // Règle unique « * » avec voix : les deux agents sont couverts ; le micro est proposé partout
        await grantSelf(page, true);
        const requests: Array<{ url: string, type: string | undefined, size: number }> = [];
        await page.route("**/api/v1/viewer/voice?*", async (route) => {
            const request = route.request();
            requests.push({ url: request.url(), type: request.headers()["content-type"], size: request.postDataBuffer()?.length ?? 0 });
            await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ clip: "c_test" }) });
        });
        await (await FakeAgent.create(token, info.project.use.baseURL ?? "http://127.0.0.1:3200")).state({ status: "idle" });
        const card = page.locator(`.san-agent[data-agent="${slug}"]`);
        const mic = card.locator(".san-rec");
        test.skip(await mic.count() === 0 || !await mic.isVisible(), "MediaRecorder indisponible dans ce navigateur");
        await mic.click();
        await expect(mic).toHaveAttribute("data-recording", "true");
        await expect(mic).toContainText("/ 0:30");
        await page.waitForTimeout(700);
        await mic.click();
        await expect.poll(() => requests.length).toBe(1);
        expect(requests[0]!.url).toContain(`to=${slug}`);
        expect(requests[0]!.type).toMatch(/^audio\/(webm|ogg)/);
        expect(requests[0]!.size).toBeGreaterThan(0);
    });

    test("lecture d'un clip say (activé quand /api/v1/health répond, après fusion des routes audio)", async ({ page, request }) => {
        const health = await request.get("/api/v1/health");
        test.skip(!health.ok(), "routes audio non fusionnées dans ce worktree (GET /api/v1/health absent)");
        await login(page);
        await expect(page.locator("[data-connection=live]")).toBeVisible();
        const slug = uid("say");
        const token = await createAgentApi(page, slug, "Agent say");
        await grantSelf(page);
        const say = await request.post("/api/v1/agent/say", { headers: { Authorization: `Bearer ${token}` }, data: { text: "Bonjour depuis le test", priority: "high" } });
        expect(say.status()).toBe(202);
        const event = page.locator(".san-event[data-kind=voice]").filter({ hasText: "Bonjour depuis le test" });
        await expect(event).toBeVisible({ timeout: 20_000 });
        await event.getByRole("button", { name: /Écouter/ }).click();
        const audio = event.locator("audio");
        await expect(audio).toBeVisible();
        await expect.poll(() => audio.evaluate((el) => (el as HTMLAudioElement).src.startsWith("blob:"))).toBe(true);
        await expect.poll(() => audio.evaluate((el) => (el as HTMLAudioElement).readyState)).toBeGreaterThan(0);
    });

});
