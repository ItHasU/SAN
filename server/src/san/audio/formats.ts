/**
 * Formats audio de SAN (DESIGN §5) : pivot, renditions et types d'entrée.
 * Module pur, sans dépendance : utilisable par le choix de format des viewers.
 */

/** Fréquence du pivot : WAV PCM s16le mono 16 kHz */
export const PIVOT_SAMPLE_RATE = 16000;

/** Formats de rendition connus (clé du cache `voice_renditions`) */
export const RENDITION_FORMATS = ["pcm_s16le", "ima_adpcm", "wav", "mp3", "ogg"] as const;
export type RenditionFormat = typeof RENDITION_FORMATS[number];

export const isRenditionFormat = (value: string): value is RenditionFormat => (RENDITION_FORMATS as readonly string[]).includes(value);

export interface FormatInfo {
    extension: "wav" | "mp3" | "ogg";
    contentType: string;
    /** Options ffmpeg de sortie, hors `-ar` */
    codecArgs: string[];
    /** Fréquences acceptées par le codec (null : toute fréquence 4000-48000) */
    rates: readonly number[] | null;
}

const FORMATS: Record<RenditionFormat, FormatInfo> = {
    pcm_s16le: { extension: "wav", contentType: "audio/wav", codecArgs: ["-c:a", "pcm_s16le", "-f", "wav"], rates: null },
    ima_adpcm: { extension: "wav", contentType: "audio/wav", codecArgs: ["-c:a", "adpcm_ima_wav", "-f", "wav"], rates: null },
    // Format « agent » : toujours le pivot (16 kHz)
    wav: { extension: "wav", contentType: "audio/wav", codecArgs: ["-c:a", "pcm_s16le", "-f", "wav"], rates: [PIVOT_SAMPLE_RATE] },
    mp3: { extension: "mp3", contentType: "audio/mpeg", codecArgs: ["-c:a", "libmp3lame", "-b:a", "48k", "-f", "mp3"], rates: [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000] },
    // Opus n'accepte que ces fréquences
    ogg: { extension: "ogg", contentType: "audio/ogg", codecArgs: ["-c:a", "libopus", "-b:a", "32k", "-application", "voip", "-f", "ogg"], rates: [8000, 12000, 16000, 24000, 48000] }
};

export const formatInfo = (format: RenditionFormat): FormatInfo => FORMATS[format];

/** La fréquence est-elle produite pour ce format ? */
export function isSupportedRate(format: RenditionFormat, rate: number): boolean {
    const rates = FORMATS[format].rates;
    return rates == null ? Number.isInteger(rate) && rate >= 4000 && rate <= 48000 : rates.includes(rate);
}

/** Ramène à 16 kHz une fréquence que le codec ne sait pas produire (mp3, ogg) */
export function normalizeSampleRate(format: string, rate: number): number {
    return isRenditionFormat(format) && !isSupportedRate(format, rate) ? PIVOT_SAMPLE_RATE : rate;
}

/** Nom de fichier d'une rendition : `<format>-<rate>.<ext>` */
export const renditionFileName = (format: RenditionFormat, rate: number): string => `${format}-${rate}.${FORMATS[format].extension}`;

//#region Entrées --------------------------------------------------------------

/** Nature du fichier reçu ; fixe le démultiplexeur ffmpeg (jamais détecté par sondage) */
export type InputKind = "wav" | "mp3" | "ogg" | "webm" | "mp4" | "aac";

export const INPUT_EXTENSIONS: Record<InputKind, string> = { wav: "wav", mp3: "mp3", ogg: "ogg", webm: "webm", mp4: "mp4", aac: "aac" };
/** Démultiplexeur forcé (`-f`) : évite qu'un contenu forgé soit pris pour une playlist ou un script */
export const INPUT_DEMUXERS: Record<InputKind, string> = { wav: "wav", mp3: "mp3", ogg: "ogg", webm: "matroska", mp4: "mov", aac: "aac" };

const WAV_TYPES = ["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"];

/** Types acceptés d'un agent (SPEC §10.1) */
export const AGENT_INPUT_TYPES: Record<string, InputKind> = {
    ...Object.fromEntries(WAV_TYPES.map((type) => [type, "wav" as const])),
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg"
};

/** Types acceptés d'un viewer (DESIGN §5) : WAV de la carte, WebM/Ogg/MP4 (Safari iOS) de MediaRecorder */
export const VIEWER_INPUT_TYPES: Record<string, InputKind> = {
    ...Object.fromEntries(WAV_TYPES.map((type) => [type, "wav" as const])),
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mp4": "mp4",
    "audio/x-m4a": "mp4",
    "audio/m4a": "mp4",
    "audio/aac": "aac"
};

/** Type MIME sans paramètres (`audio/webm;codecs=opus` → `audio/webm`) */
export function baseMimeType(header: string | undefined): string {
    return (header ?? "").split(";")[0]!.trim().toLowerCase();
}

//#endregion
