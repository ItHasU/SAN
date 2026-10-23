import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Db, Sql } from "../db";
import { RULE_COVERS_AGENT_SQL } from "../permissions";
import { badRequest, notFound, payloadTooLarge } from "../errors";
import { clipDirectory } from "../purge";
import { chooseAudioFormat } from "../viewer-events";
import {
    formatInfo, INPUT_DEMUXERS, INPUT_EXTENSIONS, InputKind, isRenditionFormat, isSupportedRate, PIVOT_SAMPLE_RATE, RenditionFormat,
    renditionFileName
} from "./formats";
import { MediaTools, MediaToolError } from "./ffmpeg";

/**
 * Stockage et conversion des clips audio (SPEC §9.4, DESIGN §5).
 *
 * Disposition : `DATA_DIR/clips/<clip>/original.<ext>` (fichier tel que reçu),
 * `wav-16000.wav` (pivot) et les renditions `<format>-<rate>.<ext>`. Les chemins
 * enregistrés en base sont relatifs à `DATA_DIR`.
 */

export const PIVOT_FORMAT: RenditionFormat = "wav";

export interface IngestResult {
    durationMs: number;
    /** Chemins relatifs à `DATA_DIR` */
    originalPath: string;
    pivotPath: string;
    pivotSize: number;
}

export interface Rendition {
    format: RenditionFormat;
    sampleRate: number;
    /** Chemin absolu du fichier */
    file: string;
    size: number;
    contentType: string;
}

export class AudioService {

    protected readonly _dataDir: string;
    protected readonly _inflight = new Map<string, Promise<Rendition>>();
    /** Nombre de productions réellement lancées par ffmpeg (tests du cache) */
    public productions = 0;

    public constructor(protected readonly _db: Db, public readonly media: MediaTools, dataDir: string, protected readonly _log: (message: string) => void = console.error) {
        this._dataDir = resolve(dataDir);
    }

    public get dataDir(): string {
        return this._dataDir;
    }

    //#region Réception ---------------------------------------------------------

    /**
     * Stocke l'original, le décode en pivot WAV PCM s16le mono 16 kHz et vérifie
     * la durée **après décodage** (ffprobe). Le décodage est borné à
     * `maxDurationS + 1` secondes : un fichier plus long est rejeté sans être
     * décodé en entier.
     * @throws ApiError 400 (audio illisible ou vide), 413 (trop long)
     */
    public async ingest(clipId: string, data: Buffer, kind: InputKind, maxDurationS: number): Promise<IngestResult> {
        const directory = clipDirectory(this._dataDir, clipId);
        const original = `original.${INPUT_EXTENSIONS[kind]}`;
        const pivotName = renditionFileName(PIVOT_FORMAT, PIVOT_SAMPLE_RATE);
        const temp = join(directory, `.pivot-${randomBytes(4).toString("hex")}.tmp`);
        await mkdir(directory, { recursive: true });
        try {
            await writeFile(join(directory, original), data);
            try {
                await this.media.ffmpeg([
                    "-f", INPUT_DEMUXERS[kind], "-i", `file:${join(directory, original)}`,
                    "-map", "0:a:0", "-vn", "-sn", "-t", String(maxDurationS + 1),
                    "-ac", "1", "-ar", String(PIVOT_SAMPLE_RATE), "-c:a", "pcm_s16le", "-f", "wav", `file:${temp}`
                ]);
            } catch (error) {
                throw this._decodeError(error);
            }
            const probe = await this.media.probe(temp).catch((error) => { throw this._decodeError(error); });
            const durationMs = Math.round(probe.duration_s * 1000);
            if (durationMs <= 0) {
                throw badRequest("Le fichier audio est vide.", "invalid_audio");
            }
            if (probe.duration_s > maxDurationS) {
                throw payloadTooLarge(`Le clip dépasse la durée maximale de ${maxDurationS} s.`, "audio_too_long");
            }
            await rename(temp, join(directory, pivotName));
            const size = (await stat(join(directory, pivotName))).size;
            const relative = (name: string): string => join("clips", clipId, name);
            return { durationMs, originalPath: relative(original), pivotPath: relative(pivotName), pivotSize: size };
        } catch (error) {
            await this.discard(clipId);
            throw error;
        }
    }

    protected _decodeError(error: unknown): Error {
        if (error instanceof MediaToolError && error.kind === "failed") {
            return badRequest("Fichier audio illisible ou format non pris en charge.", "invalid_audio");
        }
        return error instanceof Error ? error : new Error(String(error));
    }

    /** Supprime les fichiers d'un clip (échec de réception, nettoyage) */
    public async discard(clipId: string): Promise<void> {
        await rm(clipDirectory(this._dataDir, clipId), { recursive: true, force: true });
    }

    //#endregion

    //#region Base de données ----------------------------------------------------

    /** Insère un clip prêt et sa rendition pivot */
    public async createReadyClip(sql: Sql, clipId: string, source: "agent_upload" | "viewer_upload", ingested: IngestResult): Promise<void> {
        await sql.run(
            `INSERT INTO voice_clips (id, source, status, duration_ms, original_path) VALUES ($1, $2, 'ready', $3::int, $4)`,
            clipId, source, ingested.durationMs, ingested.originalPath
        );
        await this._storeRendition(sql, clipId, PIVOT_FORMAT, PIVOT_SAMPLE_RATE, ingested.pivotPath, ingested.pivotSize);
    }

    /** Passe un clip `pending` (TTS) à `ready` */
    public async markReady(sql: Sql, clipId: string, ingested: IngestResult): Promise<void> {
        await sql.run(
            `UPDATE voice_clips SET status = 'ready', duration_ms = $2::int, original_path = $3 WHERE id = $1`,
            clipId, ingested.durationMs, ingested.originalPath
        );
        await this._storeRendition(sql, clipId, PIVOT_FORMAT, PIVOT_SAMPLE_RATE, ingested.pivotPath, ingested.pivotSize);
    }

    protected async _storeRendition(sql: Sql, clipId: string, format: RenditionFormat, rate: number, path: string, size: number): Promise<void> {
        await sql.run(
            `INSERT INTO voice_renditions (clip_id, format, sample_rate, path, size) VALUES ($1, $2, $3::int, $4, $5::int)
             ON CONFLICT (clip_id, format, sample_rate) DO UPDATE SET path = EXCLUDED.path, size = EXCLUDED.size`,
            clipId, format, rate, path, size
        );
    }

    //#endregion

    //#region Renditions ---------------------------------------------------------

    /**
     * Rendition `format`/`rate` d'un clip, produite si besoin à partir du pivot.
     * Deux demandes identiques simultanées partagent une seule production.
     * @throws ApiError 404 si le clip (ou son pivot) n'existe pas ; Error si le format/la fréquence est inconnu
     */
    public ensureRendition(clipId: string, format: string, sampleRate: number): Promise<Rendition> {
        if (!isRenditionFormat(format) || !isSupportedRate(format, sampleRate)) {
            return Promise.reject(new Error(`Rendition non prise en charge : ${format} ${sampleRate} Hz.`));
        }
        const key = `${clipId}/${format}-${sampleRate}`;
        let pending = this._inflight.get(key);
        if (pending == null) {
            pending = this._produce(clipId, format, sampleRate).finally(() => this._inflight.delete(key));
            this._inflight.set(key, pending);
        }
        return pending;
    }

    protected async _produce(clipId: string, format: RenditionFormat, sampleRate: number): Promise<Rendition> {
        const info = formatInfo(format);
        const directory = clipDirectory(this._dataDir, clipId);
        const name = renditionFileName(format, sampleRate);
        const file = join(directory, name);
        const rendition = (size: number): Rendition => ({ format, sampleRate, file, size, contentType: info.contentType });

        const cached = await this._db.get<{ size: number }>(
            `SELECT size FROM voice_renditions WHERE clip_id = $1 AND format = $2 AND sample_rate = $3::int`, clipId, format, sampleRate
        );
        if (cached != null) {
            const present = await stat(file).catch(() => null);
            if (present?.isFile() === true && present.size === cached.size) {
                return rendition(cached.size);
            }
        }
        const pivot = join(directory, renditionFileName(PIVOT_FORMAT, PIVOT_SAMPLE_RATE));
        if (format === PIVOT_FORMAT) {
            // Le pivot ne se reconstruit pas : il est produit à la réception
            throw notFound("Fichier audio introuvable.");
        }
        if (await stat(pivot).catch(() => null) == null) {
            throw notFound("Fichier audio introuvable.");
        }
        const temp = join(directory, `.${name}.${randomBytes(4).toString("hex")}.tmp`);
        this.productions++;
        try {
            await this.media.ffmpeg([
                "-f", "wav", "-i", `file:${pivot}`, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", String(sampleRate), ...info.codecArgs, `file:${temp}`
            ]);
            const size = (await stat(temp)).size;
            await rename(temp, file);
            await this._storeRendition(this._db, clipId, format, sampleRate, join("clips", clipId, name), size);
            return rendition(size);
        } catch (error) {
            await rm(temp, { force: true });
            throw error;
        }
    }

    /**
     * Prépare, à l'émission d'un message vocal, les renditions dont les viewers
     * qui voient l'agent auront besoin (format choisi selon leurs capacités),
     * pour que `size` figure dans la synchronisation. Un échec n'est pas fatal :
     * la rendition sera produite à la demande.
     */
    public async prepareForAudience(agentSlug: string, clipId: string): Promise<void> {
        const rows = await this._db.all<{ capabilities: unknown }>(
            `SELECT DISTINCT v.capabilities FROM viewers v, agents a
             WHERE a.slug = $1 AND v.status = 'active' AND v.capabilities IS NOT NULL
               AND EXISTS (SELECT 1 FROM permission_rules r WHERE r.viewer_id = v.id AND ${RULE_COVERS_AGENT_SQL})`,
            agentSlug
        );
        const wanted = new Map<string, { format: string, sample_rate: number }>();
        for (const row of rows) {
            const choice = chooseAudioFormat(row.capabilities as Record<string, any>);
            if (choice != null) {
                wanted.set(`${choice.format}-${choice.sample_rate}`, choice);
            }
        }
        for (const choice of wanted.values()) {
            try {
                await this.ensureRendition(clipId, choice.format, choice.sample_rate);
            } catch (error) {
                this._log(`Rendition ${choice.format}/${choice.sample_rate} du clip ${clipId} non préparée : ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    //#endregion

}


