import { spawn } from "node:child_process";

/**
 * Appels à ffmpeg / ffprobe (SPEC §2) : `child_process.spawn` sans shell,
 * arguments en tableau, délai maximal, nombre de processus simultanés borné.
 */

export class MediaToolError extends Error {
    constructor(message: string, public readonly kind: "failed" | "timeout" | "spawn", public readonly stderr = "") {
        super(message);
        this.name = "MediaToolError";
    }
}

export interface MediaToolsOptions {
    ffmpegPath?: string;
    ffprobePath?: string;
    timeoutMs?: number;
    concurrency?: number;
}

export interface StreamInfo {
    codec_name: string;
    sample_rate: number;
    channels: number;
}

export interface ProbeResult {
    duration_s: number;
    streams: StreamInfo[];
}

const STDOUT_LIMIT = 1024 * 1024;
const STDERR_LIMIT = 8 * 1024;

export class MediaTools {

    protected readonly _ffmpeg: string;
    protected readonly _ffprobe: string;
    protected readonly _timeoutMs: number;
    protected readonly _concurrency: number;
    protected _active = 0;
    protected readonly _waiting: Array<() => void> = [];

    public constructor(options: MediaToolsOptions = {}) {
        this._ffmpeg = options.ffmpegPath ?? "ffmpeg";
        this._ffprobe = options.ffprobePath ?? "ffprobe";
        this._timeoutMs = options.timeoutMs ?? 30_000;
        this._concurrency = Math.max(1, options.concurrency ?? 2);
    }

    /** Lance ffmpeg avec des options globales sûres ajoutées devant `args` */
    public async ffmpeg(args: string[]): Promise<void> {
        await this._run(this._ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-protocol_whitelist", "file", ...args]);
    }

    /** Durée et flux audio d'un fichier (ffprobe) */
    public async probe(file: string): Promise<ProbeResult> {
        const { stdout } = await this._run(this._ffprobe, [
            "-v", "error", "-protocol_whitelist", "file", "-print_format", "json", "-show_format", "-show_streams", `file:${file}`
        ]);
        let parsed: any;
        try {
            parsed = JSON.parse(stdout.toString("utf8"));
        } catch {
            throw new MediaToolError("Sortie de ffprobe illisible.", "failed");
        }
        const duration = Number(parsed?.format?.duration);
        const streams: StreamInfo[] = (Array.isArray(parsed?.streams) ? parsed.streams : [])
            .filter((stream: any) => stream?.codec_type === "audio")
            .map((stream: any): StreamInfo => ({
                codec_name: String(stream.codec_name), sample_rate: Number(stream.sample_rate), channels: Number(stream.channels)
            }));
        return { duration_s: Number.isFinite(duration) ? duration : 0, streams };
    }

    protected async _acquire(): Promise<void> {
        if (this._active < this._concurrency) {
            this._active++;
            return;
        }
        await new Promise<void>((resolve) => this._waiting.push(resolve));
    }

    protected _release(): void {
        const next = this._waiting.shift();
        if (next != null) {
            next();
        } else {
            this._active--;
        }
    }

    protected async _run(command: string, args: string[]): Promise<{ stdout: Buffer }> {
        await this._acquire();
        try {
            return await new Promise((resolve, reject) => {
                const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
                const out: Buffer[] = [];
                let outSize = 0;
                let stderr = "";
                let settled = false;
                const finish = (error: MediaToolError | null): void => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    clearTimeout(timer);
                    if (error != null) {
                        reject(error);
                    } else {
                        resolve({ stdout: Buffer.concat(out) });
                    }
                };
                const timer = setTimeout(() => {
                    child.kill("SIGKILL");
                    finish(new MediaToolError(`${command} : délai de ${this._timeoutMs} ms dépassé.`, "timeout", stderr));
                }, this._timeoutMs);
                child.stdout.on("data", (chunk: Buffer) => {
                    outSize += chunk.length;
                    if (outSize > STDOUT_LIMIT) {
                        child.kill("SIGKILL");
                        finish(new MediaToolError(`${command} : sortie trop volumineuse.`, "failed"));
                        return;
                    }
                    out.push(chunk);
                });
                child.stderr.on("data", (chunk: Buffer) => {
                    stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_LIMIT);
                });
                child.on("error", (error) => finish(new MediaToolError(`${command} : lancement impossible (${error.message}).`, "spawn")));
                child.on("close", (code) => {
                    finish(code === 0 ? null : new MediaToolError(`${command} a échoué (code ${code}) : ${stderr.trim().split("\n").slice(-3).join(" | ")}`, "failed", stderr));
                });
            });
        } finally {
            this._release();
        }
    }

}
