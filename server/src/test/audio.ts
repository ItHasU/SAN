import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface SineOptions {
    seconds: number;
    rate?: number;
    channels?: number;
    codec?: string;
    /** Conteneur ffmpeg (`wav`, `mp3`, `ogg`, `webm`) */
    format?: string;
    /** Options de sortie supplémentaires */
    extra?: string[];
}

/** Génère un fichier audio avec ffmpeg (`-f lavfi -i sine=…`) */
export async function sine(options: SineOptions): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), "san-test-audio-"));
    try {
        const out = join(dir, "out");
        await run("ffmpeg", [
            "-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=${options.rate ?? 44100}:duration=${options.seconds}`,
            "-ac", String(options.channels ?? 1), "-c:a", options.codec ?? "pcm_s16le", ...(options.extra ?? []), "-f", options.format ?? "wav", out
        ]);
        return await readFile(out);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

export interface Probed {
    codec: string;
    rate: number;
    channels: number;
    duration: number;
    formatName: string;
}

/** Inspecte un fichier audio avec ffprobe */
export async function probeBuffer(data: Buffer): Promise<Probed> {
    const dir = await mkdtemp(join(tmpdir(), "san-test-probe-"));
    try {
        const file = join(dir, "in");
        await writeFile(file, data);
        const { stdout } = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
        const parsed = JSON.parse(stdout);
        const stream = parsed.streams[0];
        return {
            codec: stream.codec_name, rate: Number(stream.sample_rate), channels: Number(stream.channels),
            duration: Number(parsed.format.duration), formatName: parsed.format.format_name
        };
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}
