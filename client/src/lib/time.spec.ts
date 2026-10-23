import { describe, expect, it } from "vitest";
import { formatClock, formatRelative } from "./time";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const ago = (s: number): string => new Date(NOW - s * 1000).toISOString();

describe("formatRelative", () => {
    it.each([
        [0, "à l'instant"], [3, "à l'instant"], [5, "il y a 5 s"], [59, "il y a 59 s"],
        [60, "il y a 1 min"], [3599, "il y a 59 min"], [3600, "il y a 1 h"], [86399, "il y a 23 h"],
        [86400, "il y a 1 j"], [86400 * 10, "il y a 10 j"]
    ])("il y a %i s", (seconds, expected) => {
        expect(formatRelative(ago(seconds), NOW)).toBe(expected);
    });
    it("gère le futur (prochain réveil)", () => {
        expect(formatRelative(ago(-120), NOW)).toBe("dans 2 min");
        expect(formatRelative(ago(-2), NOW)).toBe("dans un instant");
    });
    it("rend un tiret pour une valeur absente ou invalide", () => {
        expect(formatRelative(null, NOW)).toBe("—");
        expect(formatRelative("pas une date", NOW)).toBe("—");
    });
});

describe("formatClock", () => {
    it("formate m:ss", () => {
        expect(formatClock(0)).toBe("0:00");
        expect(formatClock(4200)).toBe("0:04");
        expect(formatClock(65_000)).toBe("1:05");
        expect(formatClock(null)).toBe("0:00");
    });
});
