/**
 * Validation des slugs et motifs glob, avec la même liste blanche que le
 * serveur (SPEC §6.1, `server/src/san/glob.ts`) : le serveur reste l'autorité,
 * ceci n'évite qu'un aller-retour.
 */

export const MAX_SLUG_LENGTH = 128;
const SLUG_RE = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;
const PATTERN_RE = /^[a-z0-9/*?-]+$/;

/** Message d'erreur, ou `null` si le slug est valide */
export function slugError(value: string): string | null {
    if (value === "") {
        return "Le slug est obligatoire.";
    }
    if (value.length > MAX_SLUG_LENGTH) {
        return `${MAX_SLUG_LENGTH} caractères au plus.`;
    }
    if (!SLUG_RE.test(value)) {
        return "Segments [a-z0-9-] séparés par « / » (minuscules, chiffres, tirets).";
    }
    return null;
}

/** Message d'erreur, ou `null` si le motif est valide */
export function patternError(value: string): string | null {
    if (value === "") {
        return "Le motif est obligatoire.";
    }
    if (value.length > MAX_SLUG_LENGTH) {
        return `${MAX_SLUG_LENGTH} caractères au plus.`;
    }
    if (!PATTERN_RE.test(value)) {
        return "Caractères autorisés : a-z 0-9 / - et les jokers * (suite) et ? (un caractère).";
    }
    return null;
}

/** Le motif valide couvre-t-il ce slug ? (aperçu local ; sensible à la casse) */
export function globMatches(pattern: string, slug: string): boolean {
    if (patternError(pattern) != null) {
        return false;
    }
    const source = [...pattern].map((char) => char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")).join("");
    return new RegExp(`^${source}$`, "s").test(slug);
}
