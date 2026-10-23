import { expect, test } from "@playwright/test";
import { createAgentApi, dialog, dialogAction, FakeAgent, goTo, grantSelf, login, shot, uid } from "./support/helpers";

test.describe("Tableau de bord en temps réel", () => {

    test("login, création d'agent (jeton affiché une fois), état et nudge reçus sans recharger", async ({ page, baseURL }, info) => {
        await login(page);
        await page.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true; });
        await expect(page.locator("[data-connection=live]")).toBeVisible();

        // Aucun agent visible : l'administrateur s'accorde l'accès d'un geste, avec aperçu d'impact
        await expect(page.locator("[data-action=grant-self]")).toBeVisible();
        await shot(page, info, "dashboard-vide");
        await page.locator("[data-action=grant-self]").click();
        // Selon les agents déjà présents en base : « gagnent l'accès » ou « aucun changement »
        await expect(dialog(page).locator("[data-impact]").first()).toBeVisible();
        await dialogAction(page, "Accorder l'accès");
        await expect(dialog(page)).toHaveCount(0);

        // Création d'un agent depuis l'administration
        const slug = uid("agent");
        await goTo(page, "Agents");
        await page.locator("[data-action=new-agent]").click();
        await dialog(page).locator("input[name=slug]").fill("Mauvais Slug");
        await dialog(page).locator("input[name=name]").fill("Agent e2e");
        await dialogAction(page, "Continuer");
        await expect(dialog(page).locator(".san-error").first()).toContainText("Segments");
        await dialog(page).locator("input[name=slug]").fill(slug);
        await dialogAction(page, "Continuer");

        // Aperçu d'impact : le viewer web gagne l'accès au nouvel agent (règle « * »)
        const gained = dialog(page).locator("[data-impact=gained]");
        await expect(gained).toBeVisible();
        await expect(gained).toContainText(slug);
        await shot(page, info, "impact-creation-agent");
        await dialogAction(page, "Créer");

        // Jeton affiché une seule fois, dans une boîte copiable avec avertissement et exemple curl
        const secret = dialog(page).locator("[data-secret=agent-token]");
        await expect(secret).toContainText("ne sera plus jamais affiché");
        const token = await secret.locator("input[data-copy='Jeton de l\\'agent']").inputValue();
        expect(token).toMatch(/^agt_[A-Za-z0-9_-]{20,}$/);
        await expect(secret.locator("textarea[data-copy='Exemple curl']")).toHaveValue(new RegExp(`TOKEN=${token}[\\s\\S]*agent/state`));
        await shot(page, info, "jeton-agent");
        await dialogAction(page, "J'ai copié le jeton");
        await expect(page.locator(`[data-agent="${slug}"]`)).toBeVisible();
        // Le jeton n'apparaît plus nulle part dans la page
        await expect(page.locator("body")).not.toContainText(token);

        // Retour au tableau de bord ; un agent simulé publie : la page se met à jour seule
        await goTo(page, "Tableau de bord");
        await expect(page.locator("[data-connection=live]")).toBeVisible();
        const agent = await FakeAgent.create(token, baseURL!);
        await agent.state({ status: "working", detail: "Compilation", progress: 40, ttl_s: 900 });
        const card = page.locator(`.san-agent[data-agent="${slug}"]`);
        await expect(card).toBeVisible();
        await expect(card.locator(".san-status")).toHaveAttribute("data-status", "working");
        await expect(card).toContainText("Compilation");
        await expect(card.locator("[role=progressbar]")).toHaveAttribute("aria-valuenow", "40");

        await agent.state({ status: "error", detail: "Échec des tests", progress: 80 });
        await expect(card.locator(".san-status")).toHaveAttribute("data-status", "error");
        await expect(card).toContainText("Échec des tests");

        await agent.nudge({ text: `Validation requise ${slug}`, priority: "high" });
        const nudge = page.locator(".san-event[data-priority=high]").filter({ hasText: `Validation requise ${slug}` });
        await expect(nudge).toBeVisible();
        await expect(nudge).toContainText("Urgent");
        await agent.nudge({ text: `Simple info ${slug}` });
        await expect(page.locator(".san-event[data-priority=normal]").filter({ hasText: `Simple info ${slug}` })).toBeVisible();
        await shot(page, info, "dashboard");

        expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
    });

    test("échappe un detail et un nudge malveillants", async ({ page, baseURL }, info) => {
        await login(page);
        await expect(page.locator("[data-connection=live]")).toBeVisible();
        const slug = uid("evil");
        const token = await createAgentApi(page, slug, "<b>Nom</b> piégé");
        await grantSelf(page);
        const evil = "<img src=x onerror=\"window.__pwned=1\">";
        const agent = await FakeAgent.create(token, baseURL!);
        await agent.state({ status: "working", detail: evil });
        await agent.nudge({ text: `${slug} <script>window.__pwned=1</script>${evil}`, priority: "high" });
        const card = page.locator(`.san-agent[data-agent="${slug}"]`);
        await expect(card).toContainText(evil);
        await expect(page.locator(".san-event").filter({ hasText: `${slug} <script>` })).toBeVisible();
        await expect(page.locator("dashboard-page img, dashboard-page script, dashboard-page b")).toHaveCount(0);
        expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
        await shot(page, info, "echappement");
    });

    test("réglages : ordre et muet via PUT /viewer/config", async ({ page, baseURL }) => {
        await login(page);
        await expect(page.locator("[data-connection=live]")).toBeVisible();
        const a = uid("ord-a");
        const b = uid("ord-b");
        const tokenA = await createAgentApi(page, a, "Alpha");
        await createAgentApi(page, b, "Bravo");
        await grantSelf(page);
        await (await FakeAgent.create(tokenA, baseURL!)).state({ status: "idle" });
        await expect(page.locator(`.san-agent[data-agent="${a}"]`)).toBeVisible();
        await expect(page.locator(`.san-agent[data-agent="${b}"]`)).toBeVisible();
        // Pas de can_send_voice sur la règle : ni micro ni « Annuler » sur la carte
        await expect(page.locator(`.san-agent[data-agent="${b}"] .san-rec`)).toBeHidden();
        await expect(page.locator(`.san-agent[data-agent="${b}"] button`)).toHaveCount(2);
        await expect(page.locator(`.san-agent[data-agent="${b}"] button:visible`)).toHaveCount(0);
        const slugs = (): Promise<string[]> => page.locator(".san-agent").evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset["agent"]!));
        const before = (await slugs()).filter((s) => s === a || s === b);
        expect(before).toEqual([a, b]);

        await page.getByRole("button", { name: "Réglages" }).click();
        // D'autres agents peuvent s'intercaler (base partagée) : on remonte Bravo jusqu'à passer devant Alpha
        const order = async (): Promise<string[]> => (await slugs()).filter((s) => s === a || s === b);
        for (let i = 0; i < 40 && (await order())[0] !== b; i++) {
            const shown = await page.locator(`.san-agent`).count();
            await page.locator(`[data-list=settings] li[data-agent="${b}"] [data-action=up]`).click();
            await expect.poll(async () => (await page.locator(`[data-list=settings] li[data-agent="${b}"]`).evaluate((li) => Array.from(li.parentElement!.children).indexOf(li))), { timeout: 3000 }).not.toBe(-1);
            await page.waitForTimeout(150);
            expect(await page.locator(`.san-agent`).count()).toBe(shown);
        }
        expect(await order()).toEqual([b, a]);
        await page.locator(`[data-list=settings] li[data-agent="${a}"] [data-action=mute]`).click();
        await expect(page.locator(`.san-agent[data-agent="${a}"]`)).toHaveAttribute("data-muted", "true");
    });

    test("reprend le flux après une coupure réseau (resync au retour en ligne)", async ({ page, context, baseURL }) => {
        await login(page);
        await expect(page.locator("[data-connection=live]")).toBeVisible();
        const slug = uid("net");
        const token = await createAgentApi(page, slug, "Réseau");
        await grantSelf(page);
        const agent = await FakeAgent.create(token, baseURL!);
        await agent.state({ status: "working", detail: "avant" });
        await expect(page.locator(`.san-agent[data-agent="${slug}"]`)).toContainText("avant");
        await context.setOffline(true);
        await page.evaluate(() => window.dispatchEvent(new Event("offline")));
        await agent.state({ status: "done", detail: "pendant la coupure" });
        await context.setOffline(false);
        await page.evaluate(() => window.dispatchEvent(new Event("online")));
        await expect(page.locator(`.san-agent[data-agent="${slug}"]`)).toContainText("pendant la coupure", { timeout: 20_000 });
        await expect(page.locator("[data-connection=live]")).toBeVisible();
    });

});
