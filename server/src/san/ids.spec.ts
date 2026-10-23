import { describe, expect, it } from "vitest";
import { newClipId, newPairingCode, newViewerId, PAIRING_CODE_RE } from "./ids";

describe("identifiants", () => {
    it("génère des identifiants de viewer v_ + 10 caractères base32 minuscules", () => {
        const ids = new Set(Array.from({ length: 200 }, () => newViewerId()));
        expect(ids.size).toBe(200);
        for (const id of ids) {
            expect(id).toMatch(/^v_[a-z2-7]{10}$/);
        }
    });

    it("génère des codes d'appairage lisibles sans 0/O/1/I", () => {
        for (let i = 0; i < 500; i++) {
            const code = newPairingCode();
            expect(code).toMatch(PAIRING_CODE_RE);
            expect(code).not.toMatch(/[01OI]/);
        }
    });

    it("génère des identifiants de clip de 26 caractères Crockford, triables par date", () => {
        const early = newClipId(1_000_000_000_000);
        const late = newClipId(1_800_000_000_000);
        expect(early).toMatch(/^c_[0-9A-HJKMNP-TV-Z]{26}$/);
        expect(early.slice(2, 12) < late.slice(2, 12)).toBe(true);
    });
});
