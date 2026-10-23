import { describe, expect, it } from "vitest";
import { assertPattern, assertSlug, globMatches, globToLike, isValidPattern, isValidSlug } from "./glob";

describe("slugs", () => {
    it("accepte les slugs simples et hiérarchiques", () => {
        for (const slug of ["build-1", "a", "travail/ci/lint", "0-9"]) {
            expect(isValidSlug(slug), slug).toBe(true);
        }
    });

    it("refuse les slugs hors liste blanche ou mal structurés", () => {
        for (const slug of ["", "A", "a b", "a_b", "a%", "a*", "/a", "a/", "a//b", "a\\b", "a;b", "é", "a'b", "x".repeat(129)]) {
            expect(isValidSlug(slug), slug).toBe(false);
        }
        expect(isValidSlug(42)).toBe(false);
        expect(() => assertSlug("A")).toThrowError(expect.objectContaining({ status: 400, code: "invalid_slug" }));
    });
});

describe("motifs glob", () => {
    it("accepte la liste blanche [a-z0-9/*?-]", () => {
        for (const pattern of ["*", "perso-*", "travail/ci/*", "a?c", "x".repeat(128)]) {
            expect(isValidPattern(pattern), pattern).toBe(true);
        }
    });

    it("refuse tout autre caractère avec une 400", () => {
        for (const pattern of ["", "a b", "a%", "a_b", "a\\b", "a'b", "a\"b", "a;b", "A*", "a.b", "x".repeat(129), "a\nb"]) {
            expect(isValidPattern(pattern), JSON.stringify(pattern)).toBe(false);
        }
        expect(() => assertPattern("a%")).toThrowError(expect.objectContaining({ status: 400, code: "invalid_pattern" }));
    });

    it("traduit * en % et ? en _", () => {
        expect(globToLike("*")).toBe("%");
        expect(globToLike("perso-*")).toBe("perso-%");
        expect(globToLike("travail/ci/*")).toBe("travail/ci/%");
        expect(globToLike("a?c")).toBe("a_c");
        expect(globToLike("build-1")).toBe("build-1");
    });

    it("refuse de traduire un motif hors liste blanche (jamais de LIKE injecté)", () => {
        expect(() => globToLike("a%b")).toThrow();
        expect(() => globToLike("a_b")).toThrow();
        expect(() => globToLike("a'; DROP TABLE agents;--")).toThrow();
    });

    it("l'évaluation de référence est sensible à la casse et ancrée", () => {
        expect(globMatches("*", "n/importe/quoi")).toBe(true);
        expect(globMatches("perso-*", "perso-a")).toBe(true);
        expect(globMatches("perso-*", "x-perso-a")).toBe(false);
        expect(globMatches("a?c", "abc")).toBe(true);
        expect(globMatches("a?c", "ac")).toBe(false);
        expect(globMatches("travail/ci/*", "travail/ci/lint")).toBe(true);
        expect(globMatches("travail/ci/*", "travail/cj/lint")).toBe(false);
    });
});
