import { describe, expect, it } from "vitest";
import { AgentCard } from "../pages/dashboard/agent-card";
import { EventItem } from "../pages/dashboard/event-item";
import { progressBar, statusBadge } from "./common";
import { groupByViewer, impactBody, curlExample } from "./dialogs";

const EVIL = "<img src=x onerror=\"window.__pwned=1\">";
const NOW = Date.now();

describe("rendu sans injection (SPEC §14)", () => {
    it("la carte d'un agent affiche nom et detail malveillants comme du texte", () => {
        const card = new AgentCard({ canRecord: false, sendVoice: async () => undefined });
        card.update({
            config: { agent: "a", name: EVIL, subscribed: true, new: false, position: 0, muted: false, can_send_voice: false },
            state: { agent: "a", name: EVIL, status: "working", detail: EVIL, progress: 40, stale: false, updated_at: new Date(NOW).toISOString() }
        }, NOW);
        expect(card.element.querySelector("img")).toBeNull();
        expect(card.element.textContent).toContain(EVIL);
        expect(card.element.querySelector("[role=progressbar]")?.getAttribute("aria-valuenow")).toBe("40");
    });

    it("un nudge malveillant est affiché comme du texte, priorité high mise en évidence", () => {
        const item = new EventItem({ id: 1, agent: "a", kind: "nudge", priority: "high", text: EVIL, created_at: new Date(NOW).toISOString() },
            { agentName: () => EVIL, clip: async () => new Blob(), seen: () => undefined });
        expect(item.element.querySelector("img")).toBeNull();
        expect(item.element.textContent).toContain(EVIL);
        expect(item.element.dataset["priority"]).toBe("high");
        expect(item.element.textContent).toContain("Urgent");
    });

    it("un nudge affiche une icône et un libellé distincts par type ; notification et absent restent neutres", () => {
        const render = (type?: "start" | "notification" | "question" | "done" | "error") => new EventItem(
            { id: 3, agent: "a", kind: "nudge", ...(type == null ? {} : { type }), text: "x", created_at: new Date(NOW).toISOString() },
            { agentName: (s) => s, clip: async () => new Blob(), seen: () => undefined }).element;
        const icons = new Set<string>();
        for (const [type, label] of [["start", "Démarrage"], ["question", "Question"], ["done", "Terminé"], ["error", "Erreur"]] as const) {
            const element = render(type);
            expect(element.textContent).toContain(label);
            expect(element.dataset["type"]).toBe(type);
            icons.add(element.querySelector("i")!.className);
        }
        expect(icons.size).toBe(4);
        for (const neutral of [render(), render("notification")]) {
            expect(neutral.querySelector("i")!.className).toContain("ph-bell");
            expect(neutral.querySelector(".tag")).toBeNull();
        }
    });

    it("un message vocal sans clip rend le texte seul", () => {
        const item = new EventItem({ id: 2, agent: "a", kind: "voice", text: "Bonjour", created_at: new Date(NOW).toISOString() },
            { agentName: (s) => s, clip: async () => new Blob(), seen: () => undefined });
        expect(item.element.textContent).toContain("Bonjour");
        expect(item.element.querySelector("audio")).toBeNull();
    });

    it("pastille de statut : libellé et périmé", () => {
        const badge = statusBadge("error", true);
        expect(badge.textContent).toContain("Erreur");
        expect(badge.textContent).toContain("périmé");
        expect(statusBadge(EVIL, false).querySelector("img")).toBeNull();
    });

    it("borne la progression", () => {
        expect(progressBar(150)?.getAttribute("aria-valuenow")).toBe("100");
        expect(progressBar(-5)?.getAttribute("aria-valuenow")).toBe("0");
        expect(progressBar(null)).toBeNull();
    });

    it("le dialogue d'impact liste les viewers qui gagnent ou perdent l'accès, en texte", () => {
        const body = impactBody({
            gained: [{ viewer: "v1", viewer_name: EVIL, agent: "a" }, { viewer: "v1", viewer_name: EVIL, agent: "b" }],
            lost: [{ viewer: "v2", viewer_name: null, agent: "c" }]
        });
        expect(body.querySelector("img")).toBeNull();
        expect(body.querySelector("[data-impact=gained]")?.textContent).toContain("a, b");
        expect(body.querySelector("[data-impact=lost]")?.textContent).toContain("v2");
        expect(impactBody({ gained: [], lost: [] }).querySelector("[data-impact=none]")).not.toBeNull();
        expect(groupByViewer([{ viewer: "v", viewer_name: "n", agent: "a" }])).toEqual([{ viewer: "v", name: "n", agents: ["a"] }]);
    });

    it("l'exemple curl contient le jeton et l'URL de l'API", () => {
        const curl = curlExample("agt_xyz", "https://san.example");
        expect(curl).toContain("TOKEN=agt_xyz");
        expect(curl).toContain("API=https://san.example/api/v1");
        expect(curl).toContain("/agent/state");
    });
});
