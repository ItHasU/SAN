import { badRequest } from "./errors";

/**
 * Slugs et motifs glob (SPEC §5, §6.1).
 *
 * Liste blanche stricte : motifs et slugs partagent le même alphabet
 * `[a-z0-9/-]`, le motif y ajoutant `*` et `?`. 128 caractères au plus.
 */

export const MAX_SLUG_LENGTH = 128;

const SLUG_RE = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;
const PATTERN_RE = /^[a-z0-9/*?-]+$/;

export function isValidSlug(value: unknown): value is string {
    return typeof value === "string" && value.length <= MAX_SLUG_LENGTH && SLUG_RE.test(value);
}

export function isValidPattern(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= MAX_SLUG_LENGTH && PATTERN_RE.test(value);
}

/** @throws ApiError 400 si le slug est invalide */
export function assertSlug(value: unknown, field = "slug"): string {
    if (!isValidSlug(value)) {
        throw badRequest(`${field} invalide : ${MAX_SLUG_LENGTH} caractères au plus, segments [a-z0-9-] séparés par « / ».`, "invalid_slug");
    }
    return value;
}

/** @throws ApiError 400 si le motif contient un caractère hors liste blanche */
export function assertPattern(value: unknown, field = "pattern"): string {
    if (!isValidPattern(value)) {
        throw badRequest(`${field} invalide : uniquement [a-z0-9/*?-], 128 caractères au plus.`, "invalid_pattern");
    }
    return value;
}

/**
 * Traduit un motif glob en motif SQL `LIKE` (à comparer avec `ESCAPE '\'`).
 *
 * `*` → `%`, `?` → `_`. Défense en profondeur : `%`, `_` et `\` sont échappés,
 * même si la liste blanche les exclut déjà (la fonction valide donc aussi son entrée).
 */
export function globToLike(pattern: string): string {
    assertPattern(pattern);
    let like = "";
    for (const char of pattern) {
        if (char === "*") {
            like += "%";
        } else if (char === "?") {
            like += "_";
        } else if (char === "%" || char === "_" || char === "\\") {
            like += "\\" + char;
        } else {
            like += char;
        }
    }
    return like;
}

/** Évaluation de référence d'un glob en JavaScript (sensible à la casse), pour les tests et l'aperçu */
export function globMatches(pattern: string, slug: string): boolean {
    assertPattern(pattern);
    const source = [...pattern].map((char) => char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")).join("");
    return new RegExp(`^${source}$`, "s").test(slug);
}
