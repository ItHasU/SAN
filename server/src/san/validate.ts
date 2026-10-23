import { badRequest } from "./errors";

/** Validation minimale de corps JSON : pas de dépendance, messages en français */

export type JsonObject = Record<string, unknown>;

export function asObject(body: unknown, what = "corps"): JsonObject {
    if (body == null || typeof body !== "object" || Array.isArray(body)) {
        throw badRequest(`Le ${what} doit être un objet JSON (Content-Type: application/json).`);
    }
    return body as JsonObject;
}

export function optionalString(obj: JsonObject, key: string, max: number, min = 0): string | undefined {
    const value = obj[key];
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== "string" || value.length > max || value.trim().length < min) {
        throw badRequest(`${key} doit être une chaîne de ${min > 0 ? `${min} à ` : "0 à "}${max} caractères.`);
    }
    return value;
}

export function requiredString(obj: JsonObject, key: string, max: number, min = 1): string {
    const value = optionalString(obj, key, max, min);
    if (value === undefined) {
        throw badRequest(`${key} est obligatoire.`);
    }
    return value;
}

export function optionalInt(obj: JsonObject, key: string, min: number, max: number): number | undefined {
    const value = obj[key];
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
        throw badRequest(`${key} doit être un entier entre ${min} et ${max}.`);
    }
    return value;
}

export function optionalEnum<T extends string>(obj: JsonObject, key: string, allowed: readonly T[]): T | undefined {
    const value = obj[key];
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
        throw badRequest(`${key} doit valoir l'une des valeurs : ${allowed.join(", ")}.`);
    }
    return value as T;
}
