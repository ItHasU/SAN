import { Db } from "../db";
import { insertEvent, VOICE_TTL_S } from "../events";
import { newClipId } from "../ids";
import { AudioService } from "./service";
import { TtsEngine } from "./tts";

/**
 * File de jobs TTS (DESIGN §5, SPEC §9.4). La file est la table `tts_jobs` :
 * un job est écrit avec son clip `pending` dans la même transaction, ce qui
 * rend la reprise au démarrage triviale. Concurrence 1, traitement en mémoire.
 * L'événement n'est inscrit qu'une fois le clip prêt.
 */

export interface TtsJobInput {
    text: string;
    priority: string;
    ttlS: number;
}

interface JobRow {
    clip_id: string;
    agent_slug: string;
    text: string;
    priority: string | null;
    ttl_s: number;
    status: string;
}

export class TtsQueue {

    protected _running: Promise<void> | null = null;
    protected _again = false;
    protected _stopped = false;

    public constructor(
        protected readonly _db: Db,
        protected readonly _audio: AudioService,
        /** Remplaçable (tests) */
        public engine: TtsEngine,
        protected readonly _maxDurationS: number,
        protected readonly _log: (message: string) => void = console.error
    ) {
    }

    /** Crée le clip `pending` et son job, puis réveille la file. @returns l'identifiant du clip */
    public async submit(agentSlug: string, job: TtsJobInput): Promise<string> {
        const clipId = newClipId();
        await this._db.withTransaction(async (conn) => {
            await conn.run(`INSERT INTO voice_clips (id, source, status) VALUES ($1, 'tts', 'pending')`, clipId);
            await conn.run(
                `INSERT INTO tts_jobs (clip_id, agent_slug, text, priority, ttl_s) VALUES ($1, $2, $3, $4, $5::int)`,
                clipId, agentSlug, job.text, job.priority, job.ttlS
            );
        });
        this.kick();
        return clipId;
    }

    /** Reprend les jobs restés en attente (démarrage du serveur) */
    public resume(): void {
        this.kick();
    }

    /** Réveille la boucle ; un seul traitement à la fois */
    public kick(): void {
        if (this._stopped) {
            return;
        }
        if (this._running != null) {
            this._again = true;
            return;
        }
        this._running = this._loop().finally(() => {
            this._running = null;
            if (this._again && !this._stopped) {
                this._again = false;
                this.kick();
            }
        });
    }

    /** Attend que la file soit vide (tests) */
    public async idle(): Promise<void> {
        while (this._running != null) {
            await this._running;
        }
    }

    /** Arrête la file après le job en cours */
    public async stop(): Promise<void> {
        this._stopped = true;
        await this._running;
    }

    protected async _loop(): Promise<void> {
        this._again = false;
        while (!this._stopped) {
            let job: JobRow | null;
            try {
                job = await this._db.get<JobRow>(
                    `SELECT j.clip_id, j.agent_slug, j.text, j.priority, j.ttl_s, c.status
                     FROM tts_jobs j JOIN voice_clips c ON c.id = j.clip_id
                     ORDER BY j.created_at, j.clip_id LIMIT 1`
                );
            } catch (error) {
                this._log(`File TTS : lecture impossible (${error instanceof Error ? error.message : String(error)}).`);
                return;
            }
            if (job == null) {
                return;
            }
            try {
                await this._process(job);
            } catch (error) {
                this._log(`TTS : clip ${job.clip_id} en échec (${error instanceof Error ? error.message : String(error)}).`);
                try {
                    await this._fail(job.clip_id);
                } catch (failure) {
                    this._log(`File TTS : état « failed » non enregistré (${failure instanceof Error ? failure.message : String(failure)}).`);
                    return;
                }
            }
        }
    }

    protected async _process(job: JobRow): Promise<void> {
        const agent = await this._db.get(`SELECT 1 FROM agents WHERE slug = $1 AND revoked_at IS NULL AND status = 'active'`, job.agent_slug);
        if (agent == null) {
            throw new Error(`agent « ${job.agent_slug} » absent ou révoqué`);
        }
        if (job.status === "pending") {
            const wav = await this.engine.synthesize(job.text);
            const ingested = await this._audio.ingest(job.clip_id, wav, "wav", this._maxDurationS);
            await this._db.withTransaction((conn) => this._audio.markReady(conn, job.clip_id, ingested));
        }
        // Idempotent : une reprise après un arrêt entre « prêt » et « événement » n'émet qu'une fois
        const emitted = await this._db.get(`SELECT 1 FROM events WHERE clip_id = $1`, job.clip_id);
        if (emitted == null) {
            await this._audio.prepareForAudience(job.agent_slug, job.clip_id);
            await insertEvent(this._db, {
                direction: "to_viewers", agentSlug: job.agent_slug, kind: "voice", text: job.text,
                priority: job.priority ?? "normal", clipId: job.clip_id, ttlS: Math.min(job.ttl_s, VOICE_TTL_S)
            });
        }
        await this._db.run(`DELETE FROM tts_jobs WHERE clip_id = $1`, job.clip_id);
    }

    protected async _fail(clipId: string): Promise<void> {
        const failed = await this._db.withTransaction(async (conn) => {
            const rows = await conn.all(`UPDATE voice_clips SET status = 'failed' WHERE id = $1 AND status = 'pending' RETURNING id`, clipId);
            await conn.run(`DELETE FROM tts_jobs WHERE clip_id = $1`, clipId);
            return rows.length > 0;
        });
        if (failed) {
            await this._audio.discard(clipId);
        }
    }

}
