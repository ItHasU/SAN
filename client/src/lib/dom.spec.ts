import { describe, expect, it } from "vitest";
import { h, setChildren } from "./dom";

const EVIL = "<img src=x onerror=\"window.__pwned=1\"><script>window.__pwned=1</script>";

describe("construction du DOM", () => {
    it("rend un texte contenant du HTML comme du texte, sans créer d'éléments", () => {
        const host = document.createElement("div");
        setChildren(host, h("p", { text: EVIL }), h("p", {}, EVIL), h("input", { value: EVIL }));
        expect(host.querySelector("img")).toBeNull();
        expect(host.querySelector("script")).toBeNull();
        expect(host.querySelectorAll("p")[0]!.textContent).toBe(EVIL);
        expect(host.querySelectorAll("p")[1]!.textContent).toBe(EVIL);
        expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    });

    it("n'interprète pas non plus les attributs destinés aux données", () => {
        const element = h("div", { data: { agent: "\"><img onerror=x>" }, title: EVIL });
        expect(element.querySelector("img")).toBeNull();
        expect(element.dataset["agent"]).toBe("\"><img onerror=x>");
    });
});
