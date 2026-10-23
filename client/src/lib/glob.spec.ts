import { describe, expect, it } from "vitest";
import { globMatches, patternError, slugError } from "./glob";

describe("validation glob (même liste blanche que le serveur)", () => {
    it.each(["*", "perso-*", "travail/ci/*", "build-?", "a/b-c", "x".repeat(128)])("accepte %s", (pattern) => {
        expect(patternError(pattern)).toBeNull();
    });
    it.each(["", "A*", "a b", "a%b", "a_b", "a\\b", "a;b", "a'b", "a\"b", "é", "x".repeat(129), "a.b"])("refuse %j", (pattern) => {
        expect(patternError(pattern)).not.toBeNull();
    });
    it("valide les slugs (pas de joker, segments séparés par /)", () => {
        expect(slugError("travail/ci-1")).toBeNull();
        expect(slugError("a*")).not.toBeNull();
        expect(slugError("/a")).not.toBeNull();
        expect(slugError("a//b")).not.toBeNull();
        expect(slugError("")).not.toBeNull();
    });
    it("évalue les jokers", () => {
        expect(globMatches("perso-*", "perso-jean")).toBe(true);
        expect(globMatches("perso-*", "pro-jean")).toBe(false);
        expect(globMatches("build-?", "build-1")).toBe(true);
        expect(globMatches("build-?", "build-12")).toBe(false);
        expect(globMatches("travail/*", "travail/ci/x")).toBe(true);
        expect(globMatches("*", "n-importe")).toBe(true);
        expect(globMatches("a%", "a1")).toBe(false);
    });
});
