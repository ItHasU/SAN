import { expect, test } from "@playwright/test";
import { adminCall, createAgentApi, dialog, dialogAction, expectNoHorizontalScroll, goTo, grantSelf, login, shot, uid } from "./support/helpers";

/** Enrôle une carte simulée comme le ferait le firmware (route publique) */
async function enrollCard(request: import("@playwright/test").APIRequestContext, hardwareId: string, withMic = false): Promise<{ token: string, pairing_code: string }> {
    const response = await request.post("/api/v1/device/register", {
        data: {
            hardware_id: hardwareId, model: "M5StickS3-e2e",
            capabilities: {
                protocol_version: 1, firmware: "san-m5sticks3 0.1.0",
                display: { width: 135, height: 240, color: true, max_detail_chars: 80 },
                audio_out: { formats: ["ima_adpcm", "pcm_s16le"], sample_rates: [8000, 16000] },
                ...(withMic ? { audio_in: { formats: ["pcm_s16le"], sample_rate: 16000, max_duration_s: 10 } } : {}),
                battery: true
            }
        }
    });
    expect(response.status(), await response.text()).toBe(201);
    return response.json();
}

test.describe("Administration", () => {

    test("enrôlement d'une carte : demande visible, activation avec aperçu, règle avec aperçu et couverture", async ({ page, request }, info) => {
        await login(page);
        const slug = uid("cov");
        await createAgentApi(page, slug, "Agent couvert");
        const hardware = uid("hw");
        const card = await enrollCard(request, hardware);

        // La demande est visible avec son code, son modèle et son matériel
        await goTo(page, "Demandes en attente");
        const pending = page.locator(`[data-list=pending] article`).filter({ hasText: hardware });
        await expect(pending).toBeVisible();
        await expect(pending.locator("[data-field=code]")).toHaveText(card.pairing_code);
        await expect(pending).toContainText("M5StickS3-e2e");
        await shot(page, info, "demandes-en-attente");

        // Activation : saisie du nom, puis aperçu d'impact, puis application
        await pending.getByRole("button", { name: "Activer" }).click();
        await dialog(page).locator("input[name=name]").fill("");
        await dialogAction(page, "Continuer");
        await expect(dialog(page).locator(".san-error").first()).toContainText("obligatoire");
        const name = `Carte ${uid("c")}`;
        await dialog(page).locator("input[name=name]").fill(name);
        await dialogAction(page, "Continuer");
        await expect(dialog(page)).toContainText(`Activer « ${name} »`);
        await expect(dialog(page).locator("[data-impact=none]")).toBeVisible();
        await shot(page, info, "impact-activation");
        await dialogAction(page, "Activer");
        await expect(pending).toHaveCount(0);

        // Fiche du viewer : capacités, pas de micro
        await goTo(page, "Viewers");
        const viewerCard = page.locator("[data-list=viewers] article").filter({ hasText: name });
        await expect(viewerCard).toContainText("san-m5sticks3 0.1.0");
        await expect(viewerCard).toContainText("Mode manuel");
        await viewerCard.getByRole("button", { name: "Détail et permissions" }).click();
        await expect(page.locator("[data-list=capabilities]")).toContainText("Pas de micro");

        // Règle : motif validé côté client avec la liste blanche
        const form = page.locator("[data-form=rule]");
        await form.locator("input[name=pattern]").fill("Mauvais motif%");
        await expect(form.locator(".san-error")).toContainText("Caractères autorisés");
        await form.locator("input[name=pattern]").fill(`${slug.slice(0, 8)}*`);
        await expect(form.locator("[data-preview=pattern]")).toContainText("1 agent");

        // can_send_voice grisé avec explication : la carte n'a pas de micro
        await expect(form.locator("input[type=checkbox]")).toBeDisabled();

        // Aperçu d'impact : la carte gagne l'accès à l'agent
        await page.locator("[data-action=add-rule]").click();
        const gained = dialog(page).locator("[data-impact=gained]");
        await expect(gained).toContainText(name);
        await expect(gained).toContainText(slug);
        await shot(page, info, "impact-regle");
        await dialogAction(page, "Ajouter");

        // Couverture de la règle, avec explication du can_send_voice grisé
        const rule = page.locator("[data-list=rules] article").first();
        await expect(rule).toContainText(`${slug.slice(0, 8)}*`);
        await expect(rule.locator("[data-hint=no-mic]")).toContainText("ne déclare pas de micro");
        await expect(rule.locator("input[type=checkbox]")).toBeDisabled();
        await rule.getByRole("button", { name: "Couverture actuelle" }).click();
        await expect(rule).toContainText(slug);

        // Diagnostic d'accès
        await page.locator("input[name=agent]").fill(slug);
        await page.locator("[data-action=diagnose]").click();
        await expect(page.locator("[data-result=access]")).toContainText("Accès accordé");
        await expect(page.locator("[data-result=access]")).toContainText("Règle #");
        await shot(page, info, "viewer-detail");

        // L'agent liste le viewer parmi ceux qui y ont accès
        await goTo(page, "Agents");
        const agentCard = page.locator(`[data-list=agents-admin] [data-agent="${slug}"]`);
        await agentCard.getByRole("button", { name: "Accès" }).click();
        await expect(agentCard.locator(`[data-access="${slug}"]`)).toContainText(name);

        // Supprimer la règle : aperçu des viewers qui perdent l'accès
        await goTo(page, "Viewers");
        await page.locator("[data-list=viewers] article").filter({ hasText: name }).getByRole("button", { name: "Détail et permissions" }).click();
        await page.locator("[data-action=delete-rule]").first().click();
        await expect(dialog(page).locator("[data-impact=lost]")).toContainText(slug);
        await dialogAction(page, "Supprimer");
        await expect(page.locator("[data-list=rules]")).toContainText("Aucune règle");
    });

    test("refus d'une demande, groupes avec aperçu, régénération du jeton", async ({ page, request }, info) => {
        await login(page);
        const hardware = uid("hw");
        await enrollCard(request, hardware);
        await goTo(page, "Demandes en attente");
        const pending = page.locator("[data-list=pending] article").filter({ hasText: hardware });
        await pending.getByRole("button", { name: "Refuser" }).click();
        await dialogAction(page, "Refuser");
        await expect(pending).toHaveCount(0);

        // Groupes : le viewer web a une règle de groupe « g-* » ; un nouveau groupe fait gagner l'accès à ses membres
        const viewerId = await grantSelf(page);
        await adminCall(page, "DELETE", `/rules/${(await adminCall<{ rules: Array<{ id: number }> }>(page, "GET", `/viewers/${viewerId}/rules`)).rules[0]!.id}`);
        await adminCall(page, "POST", `/viewers/${viewerId}/rules`, { scope: "group", pattern: "grp-*", can_send_voice: false });
        const agentSlug = uid("m");
        await createAgentApi(page, agentSlug, "Membre");
        const group = uid("grp");
        await goTo(page, "Groupes");
        await page.locator("[data-action=new-group]").click();
        await dialog(page).locator("input[name=slug]").fill(group);
        await dialog(page).locator("input[name=name]").fill("Groupe e2e");
        await dialogAction(page, "Continuer");
        await dialogAction(page, "Créer");
        const card = page.locator(`[data-list=groups] [data-group="${group}"]`);
        await expect(card).toBeVisible();
        await card.locator("[data-action=members]").click();
        await dialog(page).getByText(`(${agentSlug})`).click();
        await dialogAction(page, "Continuer");
        await expect(dialog(page).locator("[data-impact=gained]")).toContainText(agentSlug);
        await shot(page, info, "impact-groupe");
        await dialogAction(page, "Appliquer");
        await expect(card).toContainText(agentSlug);
        await card.getByRole("button", { name: "Viewers concernés" }).click();
        await expect(card.locator(`[data-concerned="${group}"]`)).toContainText("Navigateur web");

        // Agent : régénération du jeton, affichée une fois
        await goTo(page, "Agents");
        const agentCard = page.locator(`[data-list=agents-admin] [data-agent="${agentSlug}"]`);
        await agentCard.locator("[data-action=regenerate]").click();
        await dialogAction(page, "Régénérer");
        await expect(dialog(page).locator("[data-secret=agent-token] input")).toHaveValue(/^agt_/);
        await dialogAction(page, "J'ai copié le jeton");

        // Révocation d'agent avec aperçu des viewers qui perdent l'accès
        await agentCard.locator("[data-action=revoke]").click();
        await expect(dialog(page).locator("[data-impact=lost]")).toContainText(agentSlug);
        await dialogAction(page, "Révoquer");
        await expect(agentCard).toHaveAttribute("data-revoked", "true");
        await shot(page, info, "agents");
    });

    test("règle can_send_voice possible pour un viewer qui déclare un micro", async ({ page, request }) => {
        await login(page);
        const card = await enrollCard(request, uid("hw"), true);
        void card;
        await goTo(page, "Demandes en attente");
        const pending = page.locator("[data-list=pending] article").last();
        await pending.getByRole("button", { name: "Activer" }).click();
        const name = `Micro ${uid("m")}`;
        await dialog(page).locator("input[name=name]").fill(name);
        await dialogAction(page, "Continuer");
        await dialogAction(page, "Activer");
        await goTo(page, "Viewers");
        await page.locator("[data-list=viewers] article").filter({ hasText: name }).getByRole("button", { name: "Détail et permissions" }).click();
        await expect(page.locator("[data-list=capabilities]")).toContainText("Micro");
        await expect(page.locator("[data-form=rule] input[type=checkbox]")).toBeEnabled();
    });

});

test.describe("Mise en page", () => {

    test("aucun défilement horizontal à 360 px sur chaque page", async ({ page, request }, info) => {
        await page.setViewportSize({ width: 360, height: 740 });
        await login(page);
        await expect(page.locator("[data-connection=live]")).toBeVisible();
        const slug = uid("long");
        const token = await createAgentApi(page, slug, `Nom très long ${"x".repeat(80)}`);
        const viewerId = await grantSelf(page);
        const { FakeAgent } = await import("./support/helpers");
        const agent = await FakeAgent.create(token, info.project.use.baseURL ?? "http://127.0.0.1:3200");
        await agent.state({ status: "working", detail: `détail ${"y".repeat(250)} https://exemple.org/${"z".repeat(150)}`, progress: 55 });
        await agent.nudge({ text: "w".repeat(400), priority: "high" });
        await enrollCard(request, uid("hw"));
        await expect(page.locator(`.san-agent[data-agent="${slug}"]`)).toBeVisible();
        await expectNoHorizontalScroll(page);
        for (const label of ["Demandes en attente", "Viewers", "Agents", "Groupes"]) {
            await goTo(page, label);
            await expect(page.locator(".san-page")).toBeVisible();
            await page.waitForTimeout(300);
            await expectNoHorizontalScroll(page);
        }
        await goTo(page, "Viewers");
        await page.locator(`[data-list=viewers] [data-viewer="${viewerId}"]`).getByRole("button", { name: "Détail et permissions" }).click();
        await expect(page.locator("[data-list=rules]")).toBeVisible();
        await expectNoHorizontalScroll(page);
        await page.getByRole("button", { name: "Viewers" }).first().click();
        await goTo(page, "Agents");
        await page.locator("[data-action=new-agent]").click();
        await expectNoHorizontalScroll(page);
    });

    test("cibles tactiles d'au moins 44 px sur le tableau de bord (mobile)", async ({ page }, info) => {
        test.skip(info.project.name === "desktop", "mobile uniquement");
        await login(page);
        await expect(page.locator("[data-connection=live]")).toBeVisible();
        await grantSelf(page);
        await goTo(page, "Agents");
        const sizes = await page.locator(".san-page .btn").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
        expect(sizes.length).toBeGreaterThan(0);
        for (const height of sizes) {
            expect(height).toBeGreaterThanOrEqual(44);
        }
    });

});
