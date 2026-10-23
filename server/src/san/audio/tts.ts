import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaTools } from "./ffmpeg";

/** Synthèse vocale (DESIGN §5) */

export class TtsError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TtsError";
    }
}

export interface TtsEngine {
    /** @returns un fichier WAV PCM */
    synthesize(text: string): Promise<Buffer>;
}

/** Taille maximale acceptée d'une réponse du service TTS */
const MAX_TTS_RESPONSE_BYTES = 32 * 1024 * 1024;

/** Service HTTP maison autour de Piper (`tts/README.md`) : `POST /` `{"text"}` → WAV PCM mono */
export class PiperHttpTts implements TtsEngine {

    public constructor(protected readonly _url: string, protected readonly _timeoutMs = 60_000) {
    }

    public async synthesize(text: string): Promise<Buffer> {
        let response: Response;
        try {
            response = await fetch(this._url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ text }),
                signal: AbortSignal.timeout(this._timeoutMs)
            });
        } catch (error) {
            const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
            throw new TtsError(timeout ? `Service TTS : délai de ${this._timeoutMs} ms dépassé.` : `Service TTS injoignable (${error instanceof Error ? error.message : String(error)}).`);
        }
        if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            throw new TtsError(`Service TTS : réponse HTTP ${response.status}.`);
        }
        let data: Buffer;
        try {
            data = Buffer.from(await response.arrayBuffer());
        } catch (error) {
            throw new TtsError(`Service TTS : réponse interrompue (${error instanceof Error ? error.message : String(error)}).`);
        }
        if (data.length > MAX_TTS_RESPONSE_BYTES) {
            throw new TtsError("Service TTS : réponse trop volumineuse.");
        }
        if (data.length < 44 || data.toString("latin1", 0, 4) !== "RIFF" || data.toString("latin1", 8, 12) !== "WAVE") {
            throw new TtsError("Service TTS : la réponse n'est pas un fichier WAV.");
        }
        return data;
    }

}

/** Durée d'un bip : proportionnelle au texte, bornée (0,5 s à 25 s) */
export function fakeTtsDurationS(text: string): number {
    return Math.min(25, Math.max(0.5, Array.from(text).length * 0.05));
}

/** Moteur de test et de développement sans Piper : un bip sinusoïdal ffmpeg, WAV mono 22 050 Hz comme Piper */
export class FakeTts implements TtsEngine {

    public constructor(protected readonly _media: MediaTools) {
    }

    public async synthesize(text: string): Promise<Buffer> {
        const directory = await mkdtemp(join(tmpdir(), "san-faketts-"));
        try {
            const out = join(directory, "bip.wav");
            await this._media.ffmpeg([
                "-f", "lavfi", "-i", `sine=frequency=880:sample_rate=22050:duration=${fakeTtsDurationS(text)}`,
                "-ac", "1", "-c:a", "pcm_s16le", "-f", "wav", `file:${out}`
            ]);
            return await readFile(out);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }

}
