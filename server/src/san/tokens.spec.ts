import { describe, expect, it } from "vitest";
import { generateToken, hashesEqual, hashToken, parseBearer, shortHash, tokenKind } from "./tokens";

describe("tokens", () => {

    it("génère un jeton préfixé de 32 octets base64url", () => {
        for (const kind of ["agt", "dev", "web", "enr"] as const) {
            const { token, hash } = generateToken(kind);
            expect(token).toMatch(new RegExp(`^${kind}_[A-Za-z0-9_-]{43}$`));
            expect(tokenKind(token)).toBe(kind);
            expect(hash).toHaveLength(32);
            expect(hashesEqual(hash, hashToken(token))).toBe(true);
        }
    });

    it("ne génère pas deux fois le même jeton", () => {
        expect(generateToken("agt").token).not.toBe(generateToken("agt").token);
    });

    it("compare les empreintes sans lever d'erreur sur des longueurs différentes", () => {
        const { hash } = generateToken("dev");
        expect(hashesEqual(hash, Buffer.alloc(5))).toBe(false);
        expect(hashesEqual(hash, hashToken("autre"))).toBe(false);
    });

    it("rejette les jetons mal formés", () => {
        expect(tokenKind("agt_court")).toBeNull();
        expect(tokenKind("xxx_" + "a".repeat(43))).toBeNull();
        expect(tokenKind("")).toBeNull();
    });

    it("extrait le jeton d'un en-tête Bearer", () => {
        expect(parseBearer("Bearer abc")).toBe("abc");
        expect(parseBearer("bearer abc")).toBe("abc");
        expect(parseBearer("Basic abc")).toBeNull();
        expect(parseBearer("Bearer")).toBeNull();
        expect(parseBearer("Bearer a b")).toBeNull();
        expect(parseBearer(undefined)).toBeNull();
    });

    it("tronque les empreintes de configuration à 16 caractères hex", () => {
        expect(shortHash("{}")).toMatch(/^[0-9a-f]{16}$/);
        expect(shortHash("a")).not.toBe(shortHash("b"));
    });

});
