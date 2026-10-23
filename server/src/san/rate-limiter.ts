/**
 * Limiteur de débit en mémoire à fenêtre glissante (SPEC §14).
 *
 * Une seule instance de processus : les compteurs n'ont pas à survivre à un
 * redémarrage (SPEC §5). L'horloge est injectable pour les tests.
 */
export interface RateLimiterOptions {
    /** Nombre de requêtes autorisées par fenêtre */
    limit: number;
    /** Largeur de la fenêtre en millisecondes */
    windowMs: number;
    /** Horloge (ms) */
    now?: () => number;
}

export interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    /** Secondes avant qu'une nouvelle requête soit acceptée (0 si autorisée) */
    retryAfterS: number;
}

export class RateLimiter {

    protected readonly _hits = new Map<string, number[]>();
    protected readonly _now: () => number;
    protected _calls = 0;

    constructor(protected readonly _options: RateLimiterOptions) {
        this._now = _options.now ?? Date.now;
    }

    /** Enregistre une requête pour `key` si la limite le permet */
    public hit(key: string): RateLimitResult {
        const now = this._now();
        const cutoff = now - this._options.windowMs;
        const recent = (this._hits.get(key) ?? []).filter((time) => time > cutoff);
        let result: RateLimitResult;
        if (recent.length >= this._options.limit) {
            const retryMs = recent[0]! + this._options.windowMs - now;
            result = { allowed: false, remaining: 0, retryAfterS: Math.max(1, Math.ceil(retryMs / 1000)) };
        } else {
            recent.push(now);
            result = { allowed: true, remaining: this._options.limit - recent.length, retryAfterS: 0 };
        }
        this._hits.set(key, recent);
        if (++this._calls % 1000 === 0) {
            this.prune();
        }
        return result;
    }

    /** Oublie `key` (ex. après un succès) */
    public reset(key: string): void {
        this._hits.delete(key);
    }

    /** Supprime les clés dont toutes les requêtes sont sorties de la fenêtre */
    public prune(): void {
        const cutoff = this._now() - this._options.windowMs;
        for (const [key, times] of this._hits) {
            if (times.every((time) => time <= cutoff)) {
                this._hits.delete(key);
            }
        }
    }

    /** Nombre de clés suivies (tests) */
    public get size(): number {
        return this._hits.size;
    }

}
