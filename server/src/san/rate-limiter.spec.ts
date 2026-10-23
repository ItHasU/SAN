import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limiter";

describe("RateLimiter", () => {
    it("bloque au-delà de la limite puis libère quand la fenêtre glisse", () => {
        let now = 0;
        const limiter = new RateLimiter({ limit: 3, windowMs: 60_000, now: () => now });
        expect(limiter.hit("ip").allowed).toBe(true);
        now += 10_000;
        expect(limiter.hit("ip").allowed).toBe(true);
        expect(limiter.hit("ip")).toMatchObject({ allowed: true, remaining: 0 });

        const blocked = limiter.hit("ip");
        expect(blocked.allowed).toBe(false);
        expect(blocked.retryAfterS).toBe(50);

        now += 50_001;
        // la première requête est sortie de la fenêtre, les deux autres comptent encore
        expect(limiter.hit("ip").allowed).toBe(true);
        expect(limiter.hit("ip").allowed).toBe(false);
    });

    it("compte les clés séparément et sait oublier une clé", () => {
        const limiter = new RateLimiter({ limit: 1, windowMs: 1000, now: () => 0 });
        expect(limiter.hit("a").allowed).toBe(true);
        expect(limiter.hit("b").allowed).toBe(true);
        expect(limiter.hit("a").allowed).toBe(false);
        limiter.reset("a");
        expect(limiter.hit("a").allowed).toBe(true);
    });

    it("purge les clés expirées", () => {
        let now = 0;
        const limiter = new RateLimiter({ limit: 5, windowMs: 1000, now: () => now });
        limiter.hit("a");
        limiter.hit("b");
        now = 5000;
        limiter.prune();
        expect(limiter.size).toBe(0);
    });
});
