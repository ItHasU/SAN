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
    /** Taille maximale d'un corps audio (SPEC §14 : 2 Mo) */
    audioLimit: string;
    /** Durée maximale d'un clip, en secondes (SPEC §9.4 : 30 s) */
    maxClipDurationS: number;
    /** Longueur maximale d'un texte TTS (SPEC §9.4 : 500 caractères) */
    ttsMaxChars: number;
    /** Moteur TTS (`TTS_ENGINE`, DESIGN §6) : `piper` si `TTS_URL` est défini, sinon `fake` */
    ttsEngine: "piper" | "fake";
    /** URL du service TTS (`TTS_URL`) */
    ttsUrl: string | null;
    /** Délai maximal d'une synthèse, en millisecondes */
    ttsTimeoutMs: number;
    /** Chemins de ffmpeg / ffprobe (`FFMPEG_PATH`, `FFPROBE_PATH`) */
    ffmpegPath: string;
    ffprobePath: string;
    /** Délai maximal d'un appel à ffmpeg / ffprobe, en millisecondes */
    mediaTimeoutMs: number;
    /** Nombre maximal de processus ffmpeg simultanés */
    mediaConcurrency: number;
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
    dataDir: "./data",
    audioLimit: "2mb",
    maxClipDurationS: 30,
    ttsMaxChars: 500,
    ttsEngine: "fake",
    ttsUrl: null,
    ttsTimeoutMs: 60_000,
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    mediaTimeoutMs: 30_000,
    mediaConcurrency: 2
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
    const ttsUrl = env["TTS_URL"] || null;
    const engine = env["TTS_ENGINE"] || (ttsUrl != null ? "piper" : "fake");
    if (engine !== "piper" && engine !== "fake") {
        throw new Error(`TTS_ENGINE doit valoir « piper » ou « fake » (reçu « ${engine} »).`);
    }
    if (engine === "piper" && ttsUrl == null) {
        throw new Error("TTS_ENGINE=piper exige TTS_URL.");
    }
    return {
        ...d,
        registerRatePerHour: positiveInt("SAN_REGISTER_RATE_PER_HOUR", env["SAN_REGISTER_RATE_PER_HOUR"], d.registerRatePerHour),
        maxPending: positiveInt("SAN_MAX_PENDING", env["SAN_MAX_PENDING"], d.maxPending),
        trustProxy: parseTrustProxy(env["SAN_TRUST_PROXY"], d.trustProxy),
        ratePerMinute: positiveInt("SAN_RATE_PER_MINUTE", env["SAN_RATE_PER_MINUTE"], d.ratePerMinute),
        authFailuresPerMinute: positiveInt("SAN_AUTH_FAILURES_PER_MINUTE", env["SAN_AUTH_FAILURES_PER_MINUTE"], d.authFailuresPerMinute),
        dataDir: env["DATA_DIR"] || d.dataDir,
        ttsEngine: engine,
        ttsUrl,
        ffmpegPath: env["FFMPEG_PATH"] || d.ffmpegPath,
        ffprobePath: env["FFPROBE_PATH"] || d.ffprobePath,
        ...overrides
    };
}
