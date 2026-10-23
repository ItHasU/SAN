import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Type de jeton, matérialisé par un préfixe pour faciliter le diagnostic (SPEC §3.2) */
export type TokenKind = "agt" | "dev" | "web";

export const TOKEN_KINDS: readonly TokenKind[] = ["agt", "dev", "web"];

/** 32 octets aléatoires en base64url = 43 caractères */
const TOKEN_BYTES = 32;

export interface GeneratedToken {
    /** Valeur en clair, affichée une seule fois */
    token: string;
    /** `sha256(token)`, seule valeur stockée */
    hash: Buffer;
}

/** Génère un jeton `<kind>_<32 octets base64url>` et son empreinte (DESIGN §4) */
export function generateToken(kind: TokenKind): GeneratedToken {
    const token = `${kind}_${randomBytes(TOKEN_BYTES).toString("base64url")}`;
    return { token, hash: hashToken(token) };
}

/** Empreinte SHA-256 d'un jeton */
export function hashToken(token: string): Buffer {
    return createHash("sha256").update(token, "utf8").digest();
}

/** Comparaison en temps constant de deux empreintes (faux si les longueurs diffèrent) */
export function hashesEqual(a: Buffer, b: Buffer): boolean {
    return a.length === b.length && timingSafeEqual(a, b);
}

/** @returns le type d'un jeton d'après son préfixe, ou null s'il est mal formé */
export function tokenKind(token: string): TokenKind | null {
    const match = /^(agt|dev|web)_[A-Za-z0-9_-]{43}$/.exec(token);
    return match == null ? null : match[1] as TokenKind;
}

/** Extrait le jeton d'un en-tête `Authorization: Bearer <token>`, ou null */
export function parseBearer(header: string | undefined): string | null {
    if (header == null) {
        return null;
    }
    const match = /^Bearer +(\S+)$/i.exec(header.trim());
    return match == null ? null : match[1]!;
}

/** `caps_hash` / `config_hash` : 16 premiers caractères hex de sha256 (DESIGN §4) */
export function shortHash(data: string | Buffer): string {
    return createHash("sha256").update(data).digest("hex").slice(0, 16);
}
