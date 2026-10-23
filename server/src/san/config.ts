/**
 * Configuration propre à SAN, lue dans l'environnement (DESIGN §6) en plus de
 * celle de Dagda (APP_PORT, APP_BASE_URL, APP_DATABASE_URL, APP_SECRET).
 */
export interface SanConfig {
    /** Demandes d'enrôlement par heure et par IP (`SAN_REGISTER_RATE_PER_HOUR`) */
    registerRatePerHour: number;
    /** Plafond de viewers `pending` (`SAN_MAX_PENDING`) */
    maxPending: number;
    /** Valeur du réglage Express « trust proxy » (`SAN_TRUST_PROXY`) */
    trustProxy: number | boolean;
    /** Requêtes par minute et par jeton (`SAN_RATE_PER_MINUTE`) */
    ratePerMinute: number;
    /** Authentifications échouées par minute et par IP avant blocage (`SAN_AUTH_FAILURES_PER_MINUTE`) */
    authFailuresPerMinute: number;
    /** Taille maximale d'un corps JSON */
    jsonLimit: string;
    /** Âge au-delà duquel un viewer pending est purgé, en jours (SPEC §4.3) */
    pendingMaxAgeDays: number;
    /** Période des tâches de purge, en millisecondes (DESIGN §3) */
    purgeIntervalMs: number;
    /** Période des commentaires de battement des flux SSE, en millisecondes (SPEC : 25 s) */
    sseHeartbeatMs: number;
    /** Répertoire des fichiers audio (`DATA_DIR`) */
    dataDir: string;
}

export const DEFAULT_SAN_CONFIG: SanConfig = {
    registerRatePerHour: 5,
    maxPending: 20,
    trustProxy: 1,
    ratePerMinute: 300,
    authFailuresPerMinute: 30,
    jsonLimit: "64kb",
    pendingMaxAgeDays: 7,
    purgeIntervalMs: 10 * 60 * 1000,
    sseHeartbeatMs: 25_000,
    dataDir: "./data"
};

function positiveInt(name: string, raw: string | undefined, fallback: number): number {
    if (raw == null || raw === "") {
        return fallback;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
        throw new Error(`${name} doit être un entier strictement positif (reçu « ${raw} »).`);
    }
    return value;
}

function parseTrustProxy(raw: string | undefined, fallback: number | boolean): number | boolean {
    if (raw == null || raw === "") {
        return fallback;
    }
    if (raw === "true") {
        return true;
    }
    if (raw === "false" || raw === "0") {
        return false;
    }
    return positiveInt("SAN_TRUST_PROXY", raw, 1);
}

/** Lit la configuration depuis `env`, les valeurs de `overrides` l'emportant (tests) */
export function readSanConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<SanConfig> = {}): SanConfig {
    const d = DEFAULT_SAN_CONFIG;
    return {
        ...d,
        registerRatePerHour: positiveInt("SAN_REGISTER_RATE_PER_HOUR", env["SAN_REGISTER_RATE_PER_HOUR"], d.registerRatePerHour),
        maxPending: positiveInt("SAN_MAX_PENDING", env["SAN_MAX_PENDING"], d.maxPending),
        trustProxy: parseTrustProxy(env["SAN_TRUST_PROXY"], d.trustProxy),
        ratePerMinute: positiveInt("SAN_RATE_PER_MINUTE", env["SAN_RATE_PER_MINUTE"], d.ratePerMinute),
        authFailuresPerMinute: positiveInt("SAN_AUTH_FAILURES_PER_MINUTE", env["SAN_AUTH_FAILURES_PER_MINUTE"], d.authFailuresPerMinute),
        dataDir: env["DATA_DIR"] || d.dataDir,
        ...overrides
    };
}
