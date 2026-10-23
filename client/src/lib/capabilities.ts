import { ViewerCapabilities } from "@san/shared/src/api/types";

/** Durée maximale d'un message vocal envoyé depuis le navigateur (s) */
export const MAX_RECORDING_S = 30;

/** Types MIME d'enregistrement, par ordre de préférence (DESIGN §5) ; `audio/mp4` pour Safari iOS */
export const RECORDING_TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/ogg", "audio/mp4"] as const;

/** Nom de format déclaré dans `audio_in.formats` pour un type MIME d'enregistrement */
function recordingFormat(type: string): string {
    if (type.startsWith("audio/ogg")) {
        return "ogg";
    }
    return type.startsWith("audio/mp4") ? "mp4" : "webm";
}

export interface CapabilityEnv {
    mediaRecorder?: { isTypeSupported(type: string): boolean } | null;
    hasGetUserMedia: boolean;
    screenWidth?: number;
    screenHeight?: number;
}

/** Environnement réel du navigateur */
export function browserEnv(): CapabilityEnv {
    const recorder = typeof MediaRecorder === "undefined" ? null : MediaRecorder;
    return {
        mediaRecorder: recorder,
        hasGetUserMedia: typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function",
        screenWidth: typeof window === "undefined" ? undefined : window.screen?.width,
        screenHeight: typeof window === "undefined" ? undefined : window.screen?.height
    };
}

/** Premier type d'enregistrement pris en charge, ou `null` */
export function recordingType(env: CapabilityEnv): string | null {
    if (env.mediaRecorder == null) {
        return null;
    }
    return RECORDING_TYPES.find((type) => env.mediaRecorder?.isTypeSupported(type) === true) ?? null;
}

/**
 * Capacités du viewer web (DESIGN §5, SPEC §7.1) : sortie audio mp3/ogg/pcm,
 * écran à grand `max_detail_chars`, entrée audio seulement si le navigateur sait enregistrer.
 */
export function buildCapabilities(env: CapabilityEnv = browserEnv(), notifications = false): ViewerCapabilities {
    const capabilities: ViewerCapabilities = {
        protocol_version: 1,
        firmware: "san-web 0.1.0",
        display: { width: env.screenWidth ?? 360, height: env.screenHeight ?? 640, color: true, max_detail_chars: 500 },
        audio_out: { formats: ["mp3", "ogg", "pcm_s16le"] },
        nudge: notifications ? ["screen", "notification", "vibrate"] : ["screen", "vibrate"],
        input: ["touch"]
    };
    const type = recordingType(env);
    if (env.hasGetUserMedia && type != null) {
        capabilities.audio_in = { formats: [recordingFormat(type)], max_duration_s: MAX_RECORDING_S };
    }
    return capabilities;
}
