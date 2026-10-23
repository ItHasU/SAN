import { randomBytes, randomInt } from "node:crypto";

const BASE32_LOWER = "abcdefghijklmnopqrstuvwxyz234567";
/** Alphabet de Crockford (sans I, L, O, U) */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** `v_` + 10 caractères base32 minuscules (DESIGN §4) */
export function newViewerId(): string {
    const bytes = randomBytes(10);
    let id = "v_";
    for (const byte of bytes) {
        id += BASE32_LOWER[byte % 32];
    }
    return id;
}

/** Lettres lisibles : sans O ni I */
const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
/** Chiffres lisibles : sans 0 ni 1 */
const CODE_DIGITS = "23456789";

export const PAIRING_CODE_RE = /^[A-HJ-NP-Z][2-9A-HJ-NP-Z]-[2-9]{2}$/;

/** Code d'appairage lisible, ex. `K7-42` (DESIGN §4). L'unicité parmi les pending est garantie par l'appelant. */
export function newPairingCode(): string {
    const first = CODE_LETTERS[randomInt(CODE_LETTERS.length)]!;
    const alphabet = CODE_LETTERS + CODE_DIGITS;
    const second = alphabet[randomInt(alphabet.length)]!;
    const digits = CODE_DIGITS[randomInt(CODE_DIGITS.length)]! + CODE_DIGITS[randomInt(CODE_DIGITS.length)]!;
    return `${first}${second}-${digits}`;
}

/**
 * Identifiant de clip : `c_` + 26 caractères Crockford, ULID-like (48 bits d'horodatage
 * en millisecondes puis 80 bits aléatoires), donc triable par date de création.
 */
export function newClipId(now: number = Date.now()): string {
    let time = "";
    let remaining = now;
    for (let i = 0; i < 10; i++) {
        time = CROCKFORD[remaining % 32] + time;
        remaining = Math.floor(remaining / 32);
    }
    const random = randomBytes(16);
    let suffix = "";
    for (let i = 0; i < 16; i++) {
        suffix += CROCKFORD[random[i]! % 32];
    }
    return `c_${time}${suffix}`;
}
