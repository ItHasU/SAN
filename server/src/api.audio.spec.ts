import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { TtsEngine } from "./san/audio/tts";
import { runPeriodicTasks } from "./san/purge";
import { probeBuffer, sine } from "./test/audio";
import { createTestApp, TestApp } from "./test/app.fixture";
import { addRule, CAPS, createAgent, resetData } from "./test/helpers";

const WEB_CAPS = {
    protocol_version: 1, firmware: "web",
    display: { width: 400, height: 800, color: true, max_detail_chars: 200 },
    audio_out: { formats: ["mp3", "ogg", "pcm_s16le"], sample_rates: [16000, 48000] },
    audio_in: { formats: ["webm"], sample_rate: 48000, max_duration_s: 10 },
    nudge: ["screen"]
};
const CARD_CAPS = {
    ...CAPS,
    audio_out: { formats: ["ima_adpcm", "pcm_s16le"], sample_rates: [8000, 16000] },
    audio_in: { formats: ["pcm_s16le"], sample_rate: 16000, max_duration_s: 3 }
};

describe.runIf(inject("databaseAvailable"))("API audio", () => {
    let t: TestApp;
    let cookie: string;
    let robot: { token: string };

    beforeAll(async () => {
        t = await createTestApp("api_audio", { ratePerMinute: 100_000 });
        cookie = await t.loginAdmin();
    });
    afterAll(async () => {
        await t.close();
    });
    beforeEach(async () => {
        await resetData(t);
        robot = await createAgent(t, cookie, "robot", "Robot");
    });

    /** Viewer web actif (mode auto), règle `*` */
    async function webViewer(options: { voice?: boolean, caps?: unknown, pattern?: string } = {}) {
        const response = await t.api("POST", "/web/register", { cookie, body: { capabilities: options.caps ?? WEB_CAPS } });
        expect(response.status).toBe(201);
        await addRule(t, cookie, response.json.viewer_id, options.pattern ?? "*", "agent", options.voice ?? false);
        return response.json as { viewer_id: string, token: string };
    }
    const syncEvents = async (token: string) => (await t.api("GET", "/viewer/sync", { token })).json.events as any[];
    const postWav = (path: string, token: string, data: Buffer, type = "audio/wav") => t.api("POST", path, { token, binary: data, headers: { "content-type": type } });
    const clipFiles = async (clip: string) => (await readdir(join(t.dataDir, "clips", clip))).sort();

    describe("renditions", () => {
        it("convertit le pivot dans chaque format avec le bon codec, la bonne fréquence et un seul canal", async () => {
            // source : WAV 44,1 kHz stéréo → pivot WAV PCM s16le mono 16 kHz
            const source = await sine({ seconds: 2, rate: 44100, channels: 2 });
            const posted = await postWav("/agent/voice", robot.token, source);
            expect(posted.status).toBe(201);
            const clip = posted.json.clip_id as string;

            const expectations: Array<[string, number, string, string]> = [
                ["wav", 16000, "pcm_s16le", "wav"],
                ["pcm_s16le", 16000, "pcm_s16le", "wav"],
                ["pcm_s16le", 8000, "pcm_s16le", "wav"],
                ["ima_adpcm", 16000, "adpcm_ima_wav", "wav"],
                ["ima_adpcm", 8000, "adpcm_ima_wav", "wav"],
                ["mp3", 16000, "mp3", "mp3"],
                ["ogg", 16000, "opus", "ogg"]
            ];
            for (const [format, rate, codec, container] of expectations) {
                const rendition = await t.app.audio.ensureRendition(clip, format, rate);
                const info = await probeBuffer(await (await import("node:fs/promises")).readFile(rendition.file));
                expect(info, `${format}/${rate}`).toMatchObject({ codec, channels: 1 });
                expect(info.formatName).toContain(container);
                // Opus est toujours décodé à 48 kHz par ffprobe ; la fréquence demandée est celle du flux d'entrée
                if (codec !== "opus") {
                    expect(info.rate, `${format}/${rate}`).toBe(rate);
                }
                expect(info.duration).toBeGreaterThan(1.9);
                expect(info.duration).toBeLessThan(2.2);
                expect(rendition.size).toBe((await stat(rendition.file)).size);
            }
            // ima_adpcm est bien plus compact que le PCM
            const ima = await t.app.audio.ensureRendition(clip, "ima_adpcm", 8000);
            const pcm = await t.app.audio.ensureRendition(clip, "pcm_s16le", 8000);
            expect(ima.size).toBeLessThan(pcm.size / 3);
            // fréquence non produite par Opus ou format inconnu : refusés
            await expect(t.app.audio.ensureRendition(clip, "ogg", 11025)).rejects.toThrow();
            await expect(t.app.audio.ensureRendition(clip, "flac", 16000)).rejects.toThrow();
            const row = await t.db.runner.get<any>(`SELECT source, status, duration_ms FROM voice_clips WHERE id = $1`, clip);
            expect(row).toMatchObject({ source: "agent_upload", status: "ready" });
            expect(row.duration_ms).toBeGreaterThan(1900);
            expect(await clipFiles(clip)).toEqual(expect.arrayContaining(["original.wav", "wav-16000.wav", "mp3-16000.mp3", "ogg-16000.ogg", "ima_adpcm-8000.wav"]));
        });

        it("décode un WAV IMA ADPCM produit par ffmpeg, un MP3 et un Ogg Opus", async () => {
            for (const [type, data] of [
                ["audio/wav", await sine({ seconds: 1, rate: 8000, codec: "adpcm_ima_wav" })],
                ["audio/mpeg", await sine({ seconds: 1, rate: 22050, codec: "libmp3lame", format: "mp3" })],
                ["audio/ogg", await sine({ seconds: 1, rate: 48000, codec: "libopus", format: "ogg" })]
            ] as Array<[string, Buffer]>) {
                const posted = await postWav("/agent/voice", robot.token, data, type);
                expect(posted.status, type).toBe(201);
                const pivot = await t.app.audio.ensureRendition(posted.json.clip_id, "wav", 16000);
                const info = await probeBuffer(await (await import("node:fs/promises")).readFile(pivot.file));
                expect(info, type).toMatchObject({ codec: "pcm_s16le", rate: 16000, channels: 1 });
            }
            const imaOnly = await sine({ seconds: 1, rate: 8000, codec: "adpcm_ima_wav" });
            expect((await probeBuffer(imaOnly)).codec).toBe("adpcm_ima_wav");
        });

        it("ne produit qu'une fois une rendition demandée plusieurs fois en même temps, puis la sert depuis le cache", async () => {
            const posted = await postWav("/agent/voice", robot.token, await sine({ seconds: 1 }));
            const clip = posted.json.clip_id as string;
            const before = t.app.audio.productions;
            const results = await Promise.all(Array.from({ length: 6 }, () => t.app.audio.ensureRendition(clip, "mp3", 16000)));
            expect(t.app.audio.productions - before).toBe(1);
            expect(new Set(results.map((r) => r.file)).size).toBe(1);
            await t.app.audio.ensureRendition(clip, "mp3", 16000);
            expect(t.app.audio.productions - before).toBe(1);
            const rows = await t.db.runner.all<any>(`SELECT format, sample_rate, size, path FROM voice_renditions WHERE clip_id = $1 AND format = 'mp3'`, clip);
            expect(rows).toEqual([{ format: "mp3", sample_rate: 16000, size: results[0]!.size, path: join("clips", clip, "mp3-16000.mp3") }]);
            // fichier disparu : reproduit
            await (await import("node:fs/promises")).rm(results[0]!.file);
            await t.app.audio.ensureRendition(clip, "mp3", 16000);
            expect(t.app.audio.productions - before).toBe(2);
        });
    });

    describe("rejets à la réception", () => {
        it("refuse un clip de plus de 30 s (agent) ou de plus de audio_in.max_duration_s (viewer), sans rien conserver", async () => {
            const dirsBefore = (await readdir(join(t.dataDir, "clips")).catch(() => [] as string[])).length;
            const long = await postWav("/agent/voice", robot.token, await sine({ seconds: 31, rate: 8000 }));
            expect(long.status).toBe(413);
            expect(long.json.error).toBe("audio_too_long");
            const ok = await postWav("/agent/voice", robot.token, await sine({ seconds: 29, rate: 8000 }));
            expect(ok.status).toBe(201);

            const card = await webViewer({ voice: true, caps: { ...WEB_CAPS, audio_in: { formats: ["webm"], max_duration_s: 2 } } });
            const tooLong = await postWav("/viewer/voice?to=robot", card.token, await sine({ seconds: 3, rate: 8000 }));
            expect(tooLong.status).toBe(413);
            expect(tooLong.json.error).toBe("audio_too_long");
            expect((await postWav("/viewer/voice?to=robot", card.token, await sine({ seconds: 1.5, rate: 8000 }))).status).toBe(201);

            expect(await t.db.runner.get<any>(`SELECT count(*)::int AS n FROM voice_clips`)).toEqual({ n: 2 });
            // les rejets n'ont laissé aucun répertoire : seuls les deux clips acceptés existent
            expect(await readdir(join(t.dataDir, "clips"))).toHaveLength(dirsBefore + 2);
        });

        it("refuse un corps trop gros (413), un type non pris en charge (415), un corps vide ou illisible (400)", async () => {
            const huge = Buffer.alloc(2 * 1024 * 1024 + 10);
            const tooBig = await postWav("/agent/voice", robot.token, huge);
            expect(tooBig.status).toBe(413);
            expect(tooBig.json.message).toContain("2 Mo");

            for (const type of ["audio/flac", "application/octet-stream", "audio/webm"]) {
                const response = await postWav("/agent/voice", robot.token, await sine({ seconds: 1 }), type);
                expect(response.status, type).toBe(415);
                expect(response.json.error).toBe("unsupported_media_type");
            }
            const empty = await postWav("/agent/voice", robot.token, Buffer.alloc(0));
            expect(empty.status).toBe(400);
            const garbage = await postWav("/agent/voice", robot.token, Buffer.from("ceci n'est pas de l'audio, pas du tout".repeat(20)));
            expect(garbage.status).toBe(400);
            expect(garbage.json.error).toBe("invalid_audio");
            // un fichier qui se présente comme du WAV mais est un MP3 : le démultiplexeur est imposé, il est rejeté
            const mislabeled = await postWav("/agent/voice", robot.token, await sine({ seconds: 1, codec: "libmp3lame", format: "mp3" }), "audio/wav");
            expect(mislabeled.status).toBe(400);
            expect((await postWav("/agent/voice", "", await sine({ seconds: 1 }))).status).toBe(401);
            expect(await t.db.runner.get<any>(`SELECT count(*)::int AS n FROM voice_clips`)).toEqual({ n: 0 });
        });
    });

    describe("agent → viewers", () => {
        it("POST /agent/voice : événement visible en sync avec le clip complet, téléchargeable dans le format du viewer", async () => {
            const web = await webViewer();
            const card = await webViewer({ caps: { ...CARD_CAPS, audio_out: { formats: ["ima_adpcm", "pcm_s16le"], sample_rates: [8000] } } });
            const posted = await postWav("/agent/voice?priority=high&ttl_s=600&text=Bonjour%20%C3%A0%20tous", robot.token, await sine({ seconds: 2 }));
            expect(posted.status).toBe(201);
            expect(posted.json).toEqual({ clip_id: expect.stringMatching(/^c_[0-9A-Z]{26}$/), event_id: expect.any(Number) });

            const [event] = await syncEvents(web.token);
            expect(event).toMatchObject({ id: posted.json.event_id, agent: "robot", kind: "voice", priority: "high", text: "Bonjour à tous" });
            expect(event.clip).toEqual({ id: posted.json.clip_id, duration_ms: expect.any(Number), format: "mp3", sample_rate: 16000, size: expect.any(Number) });
            const lifetime = await t.db.runner.get<{ s: number }>(`SELECT extract(epoch FROM expires_at - created_at)::float AS s FROM events WHERE id = $1`, posted.json.event_id);
            expect(Math.round(lifetime!.s)).toBe(600);

            const download = await t.apiBinary("GET", `/viewer/voice/${event.clip.id}`, { token: web.token });
            expect(download.status).toBe(200);
            expect(download.headers.get("content-type")).toBe("audio/mpeg");
            expect(download.headers.get("cache-control")).toContain("private");
            expect(Number(download.headers.get("content-length"))).toBe(event.clip.size);
            expect(download.body.length).toBe(event.clip.size);
            expect((await probeBuffer(download.body)).codec).toBe("mp3");

            const [forCard] = await syncEvents(card.token);
            expect(forCard.clip).toMatchObject({ format: "ima_adpcm", sample_rate: 8000, size: expect.any(Number) });
            const cardDownload = await t.apiBinary("GET", `/viewer/voice/${forCard.clip.id}`, { token: card.token });
            expect(cardDownload.headers.get("content-type")).toBe("audio/wav");
            expect(await probeBuffer(cardDownload.body)).toMatchObject({ codec: "adpcm_ima_wav", rate: 8000, channels: 1 });
            expect(cardDownload.body.length).toBe(forCard.clip.size);
        });

        it("GET /viewer/voice/:clip gère Range, refuse sans accès (404), après expiration (410) et sans sortie audio (406)", async () => {
            const web = await webViewer();
            const other = await webViewer({ pattern: "autre" });
            const mute = await webViewer({ caps: { protocol_version: 1, display: { width: 1, height: 1, color: false } } });
            const posted = await postWav("/agent/voice", robot.token, await sine({ seconds: 2 }));
            const clip = posted.json.clip_id as string;
            const full = await t.apiBinary("GET", `/viewer/voice/${clip}`, { token: web.token });

            const part = await t.apiBinary("GET", `/viewer/voice/${clip}`, { token: web.token, headers: { range: "bytes=0-99" } });
            expect(part.status).toBe(206);
            expect(part.headers.get("content-range")).toBe(`bytes 0-99/${full.body.length}`);
            expect(part.body.equals(full.body.subarray(0, 100))).toBe(true);

            expect((await t.api("GET", `/viewer/voice/${clip}`, { token: other.token })).status).toBe(404);
            expect((await t.api("GET", `/viewer/voice/c_00000000000000000000000000`, { token: web.token })).status).toBe(404);
            expect((await t.api("GET", `/viewer/voice/..%2F..%2Fetc`, { token: web.token })).status).toBe(404);
            const noOutput = await t.api("GET", `/viewer/voice/${clip}`, { token: mute.token });
            expect(noOutput.status).toBe(406);
            expect(noOutput.json.error).toBe("no_audio_output");
            expect((await t.api("GET", `/viewer/voice/${clip}`, { token: robot.token })).status).toBe(403);

            await t.db.runner.run(`UPDATE events SET expires_at = now() - interval '1 second'`);
            expect((await t.api("GET", `/viewer/voice/${clip}`, { token: web.token })).status).toBe(410);
        });
    });

    describe("TTS", () => {
        it("say → 202 pending ; l'événement n'apparaît qu'une fois le clip prêt, avec le texte source, la taille et le format", async () => {
            const web = await webViewer();
            let release!: () => void;
            const gate = new Promise<void>((resolve) => { release = resolve; });
            const original = t.app.tts.engine;
            t.app.tts.engine = { synthesize: async (text) => { await gate; return original.synthesize(text); } };
            try {
                const response = await t.api("POST", "/agent/say", { token: robot.token, body: { text: "J'ai besoin de ta validation, s'il te plaît.", priority: "high", ttl_s: 3600 } });
                expect(response.status).toBe(202);
                expect(response.json).toEqual({ clip_id: expect.stringMatching(/^c_/), status: "pending" });
                const clip = response.json.clip_id as string;

                expect(await t.db.runner.get<any>(`SELECT status, source FROM voice_clips WHERE id = $1`, clip)).toEqual({ status: "pending", source: "tts" });
                expect(await t.db.runner.get<any>(`SELECT text, priority, ttl_s FROM tts_jobs WHERE clip_id = $1`, clip))
                    .toEqual({ text: "J'ai besoin de ta validation, s'il te plaît.", priority: "high", ttl_s: 3600 });
                expect(await syncEvents(web.token)).toEqual([]);

                release();
                await t.app.tts.idle();
                const [event] = await syncEvents(web.token);
                expect(event).toMatchObject({ agent: "robot", kind: "voice", priority: "high", text: "J'ai besoin de ta validation, s'il te plaît." });
                expect(event.clip).toEqual({ id: clip, duration_ms: expect.any(Number), format: "mp3", sample_rate: 16000, size: expect.any(Number) });
                expect(event.clip.duration_ms).toBeGreaterThan(2000);
                expect(await t.db.runner.get<any>(`SELECT status FROM voice_clips WHERE id = $1`, clip)).toEqual({ status: "ready" });
                expect(await t.db.runner.get<any>(`SELECT count(*)::int AS n FROM tts_jobs`)).toEqual({ n: 0 });
                const download = await t.apiBinary("GET", `/viewer/voice/${clip}`, { token: web.token });
                expect(download.body.length).toBe(event.clip.size);
            } finally {
                release();
                t.app.tts.engine = original;
            }
        });

        it("valide le texte (vide, > 500 caractères) et exige un jeton d'agent", async () => {
            const say = (body: unknown, token = robot.token) => t.api("POST", "/agent/say", { token, body });
            expect((await say({})).status).toBe(400);
            expect((await say({ text: "   " })).status).toBe(400);
            expect((await say({ text: "x".repeat(501) })).status).toBe(400);
            expect((await say({ text: "ok", priority: "urgent" })).status).toBe(400);
            expect((await say({ text: "x".repeat(500) })).status).toBe(202);
            await t.app.tts.idle();
            expect((await say({ text: "ok" }, "")).status).toBe(401);
        });

        it("synthèse en échec : clip failed, aucun événement, puis purge du clip et de ses fichiers", async () => {
            const web = await webViewer();
            const failing: TtsEngine = { synthesize: async () => { throw new Error("moteur en panne"); } };
            const original = t.app.tts.engine;
            t.app.tts.engine = failing;
            try {
                const response = await t.api("POST", "/agent/say", { token: robot.token, body: { text: "Perdu" } });
                expect(response.status).toBe(202);
                await t.app.tts.idle();
                const clip = response.json.clip_id as string;
                expect(await t.db.runner.get<any>(`SELECT status FROM voice_clips WHERE id = $1`, clip)).toEqual({ status: "failed" });
                expect(await t.db.runner.get<any>(`SELECT count(*)::int AS n FROM events`)).toEqual({ n: 0 });
                expect(await t.db.runner.get<any>(`SELECT count(*)::int AS n FROM tts_jobs`)).toEqual({ n: 0 });
                expect(await syncEvents(web.token)).toEqual([]);

                // un clip failed récent est conservé (délai de grâce), puis supprimé avec ses fichiers
                await runPeriodicTasks(t.db.runner, { pendingMaxAgeDays: 7, dataDir: t.dataDir });
                expect(await t.db.runner.get<any>(`SELECT count(*)::int AS n FROM voice_clips`)).toEqual({ n: 1 });
                await t.db.runner.run(`UPDATE voice_clips SET created_at = now() - interval '2 hours'`);
                const result = await runPeriodicTasks(t.db.runner, { pendingMaxAgeDays: 7, dataDir: t.dataDir });
                expect(result.orphanClips).toBe(1);
                expect(await t.db.runner.get<any>(`SELECT count(*)::int AS n FROM voice_clips`)).toEqual({ n: 0 });
                await expect(readdir(join(t.dataDir, "clips", clip))).rejects.toThrow();
            } finally {
                t.app.tts.engine = original;
            }
        });

        it("reprend au démarrage les clips pending (texte, priorité et durée de vie conservés) sans émettre deux fois", async () => {
            const web = await webViewer();
            const clip = "c_00000000000000000000000001";
            await t.db.runner.run(`INSERT INTO voice_clips (id, source, status) VALUES ($1, 'tts', 'pending')`, clip);
            await t.db.runner.run(`INSERT INTO tts_jobs (clip_id, agent_slug, text, priority, ttl_s) VALUES ($1, 'robot', 'Reprise après redémarrage', 'high', 900)`, clip);
            // le purge ne touche pas un clip pending dont le job existe
            await t.db.runner.run(`UPDATE voice_clips SET created_at = now() - interval '5 hours'`);
            expect((await runPeriodicTasks(t.db.runner, { pendingMaxAgeDays: 7, dataDir: t.dataDir })).orphanClips).toBe(0);

            t.app.tts.resume();
            await t.app.tts.idle();
            t.app.tts.resume();
            await t.app.tts.idle();
            const events = await syncEvents(web.token);
            expect(events).toHaveLength(1);
            expect(events[0]).toMatchObject({ kind: "voice", priority: "high", text: "Reprise après redémarrage", clip: { id: clip } });
            const lifetime = await t.db.runner.get<{ s: number }>(`SELECT extract(epoch FROM expires_at - created_at)::float AS s FROM events`);
            expect(Math.round(lifetime!.s)).toBe(900);
        });
    });

    describe("purge", () => {
        it("supprime les clips orphelins avec leurs renditions et leurs fichiers, et garde les clips référencés", async () => {
            const web = await webViewer();
            const kept = await postWav("/agent/voice", robot.token, await sine({ seconds: 1 }));
            const dropped = await postWav("/agent/voice", robot.token, await sine({ seconds: 1 }));
            await t.app.audio.ensureRendition(dropped.json.clip_id, "ogg", 16000);
            expect((await syncEvents(web.token))).toHaveLength(2);
            await t.db.runner.run(`DELETE FROM events WHERE id = $1`, dropped.json.event_id);
            await t.db.runner.run(`UPDATE voice_clips SET created_at = now() - interval '2 hours'`);
            const result = await runPeriodicTasks(t.db.runner, { pendingMaxAgeDays: 7, dataDir: t.dataDir });
            expect(result.orphanClips).toBe(1);
            await expect(readdir(join(t.dataDir, "clips", dropped.json.clip_id))).rejects.toThrow();
            expect(await t.db.runner.get<any>(`SELECT count(*)::int AS n FROM voice_renditions WHERE clip_id = $1`, dropped.json.clip_id)).toEqual({ n: 0 });
            expect((await clipFiles(kept.json.clip_id))).toContain("wav-16000.wav");
        });
    });

    describe("viewer → agent", () => {
        it("Safari iOS : audio/mp4 (AAC, MP4 fragmenté ou non), audio/x-m4a et audio/aac sont acceptés", async () => {
            const web = await webViewer({ voice: true });
            // Safari iOS : MediaRecorder produit de l'AAC dans du MP4 fragmenté
            const fragmented = ["-movflags", "frag_keyframe+empty_moov+default_base_moof"];
            const safari: Array<[string, Buffer]> = [
                ["audio/mp4", await sine({ seconds: 1.5, rate: 44100, codec: "aac", format: "mp4", extra: fragmented })],
                ["audio/mp4;codecs=mp4a.40.2", await sine({ seconds: 1.5, rate: 48000, codec: "aac", format: "mp4" })],
                ["audio/x-m4a", await sine({ seconds: 1.5, rate: 44100, codec: "aac", format: "ipod" })],
                ["audio/aac", await sine({ seconds: 1.5, rate: 44100, codec: "aac", format: "adts" })]
            ];
            for (const [type, data] of safari) {
                const response = await postWav("/viewer/voice?to=robot", web.token, data, type);
                expect(response.status, type).toBe(201);
                const wav = await t.apiBinary("GET", `/agent/voice/${response.json.clip_id}`, { token: robot.token });
                expect(await probeBuffer(wav.body), type).toMatchObject({ codec: "pcm_s16le", rate: 16000, channels: 1 });
                expect((await probeBuffer(wav.body)).duration, type).toBeGreaterThan(1.3);
            }
            expect(await t.db.runner.get<any>(`SELECT count(*)::int AS n FROM voice_clips`)).toEqual({ n: 4 });
            const wrong = await postWav("/viewer/voice?to=robot", web.token, await sine({ seconds: 1 }), "audio/mp4");
            expect(wrong.status).toBe(400);
            expect(wrong.json.error).toBe("invalid_audio");
        });

        it("web (audio/webm et audio/ogg) et carte (WAV PCM, IMA ADPCM) → inbox → téléchargement wav/mp3/ogg", async () => {
            const web = await webViewer({ voice: true });
            const sources: Array<[string, Buffer, string]> = [
                ["audio/webm;codecs=opus", await sine({ seconds: 1.5, rate: 48000, codec: "libopus", format: "webm" }), web.token],
                ["audio/ogg", await sine({ seconds: 1.5, rate: 48000, codec: "libopus", format: "ogg" }), web.token],
                ["audio/wav", await sine({ seconds: 1.5, rate: 16000 }), web.token],
                ["audio/wav", await sine({ seconds: 1.5, rate: 8000, codec: "adpcm_ima_wav" }), web.token]
            ];
            const posted: any[] = [];
            for (const [type, data, token] of sources) {
                const response = await postWav("/viewer/voice?to=robot", token, data, type);
                expect(response.status, type).toBe(201);
                posted.push(response.json);
            }
            const inbox = await t.api("GET", "/agent/inbox", { token: robot.token });
            expect(inbox.status).toBe(200);
            expect(inbox.json.events).toHaveLength(4);
            expect(inbox.json.events.map((e: any) => e.id)).toEqual(posted.map((p) => p.event_id));
            const first = inbox.json.events[0];
            expect(first).toMatchObject({ kind: "voice", from: { viewer: web.viewer_id }, clip: { id: posted[0].clip_id, url: `/api/v1/agent/voice/${posted[0].clip_id}` } });
            expect(first.clip.duration_ms).toBeGreaterThan(1400);

            const lifetime = await t.db.runner.get<{ s: number }>(`SELECT extract(epoch FROM expires_at - created_at)::float AS s FROM events WHERE id = $1`, posted[0].event_id);
            expect(Math.round(lifetime!.s)).toBe(7 * 24 * 3600);
            expect(await t.db.runner.get<any>(`SELECT direction, from_viewer_id FROM events WHERE id = $1`, posted[0].event_id)).toEqual({ direction: "to_agent", from_viewer_id: web.viewer_id });
            expect(await t.db.runner.get<any>(`SELECT source FROM voice_clips WHERE id = $1`, posted[0].clip_id)).toEqual({ source: "viewer_upload" });
            expect((await clipFiles(posted[0].clip_id))).toEqual(expect.arrayContaining(["original.webm", "wav-16000.wav"]));

            for (const p of posted) {
                const url = `/agent/voice/${p.clip_id}`;
                const wav = await t.apiBinary("GET", url, { token: robot.token });
                expect(wav.status).toBe(200);
                expect(wav.headers.get("content-type")).toBe("audio/wav");
                expect(Number(wav.headers.get("content-length"))).toBe(wav.body.length);
                expect(wav.headers.get("cache-control")).toContain("private");
                expect(await probeBuffer(wav.body)).toMatchObject({ codec: "pcm_s16le", rate: 16000, channels: 1 });
                const explicit = await t.apiBinary("GET", `${url}?format=wav`, { token: robot.token });
                expect(explicit.body.equals(wav.body)).toBe(true);
                const mp3 = await t.apiBinary("GET", `${url}?format=mp3`, { token: robot.token });
                expect(mp3.headers.get("content-type")).toBe("audio/mpeg");
                expect(await probeBuffer(mp3.body)).toMatchObject({ codec: "mp3", channels: 1 });
                const ogg = await t.apiBinary("GET", `${url}?format=ogg`, { token: robot.token });
                expect(ogg.headers.get("content-type")).toBe("audio/ogg");
                expect(await probeBuffer(ogg.body)).toMatchObject({ codec: "opus", channels: 1 });
            }
            expect((await t.api("GET", `/agent/voice/${posted[0].clip_id}?format=flac`, { token: robot.token })).status).toBe(400);
            // un autre agent, ou une session sans jeton d'agent : 404 / 403 / 401
            const stranger = await createAgent(t, cookie, "stranger");
            expect((await t.api("GET", `/agent/voice/${posted[0].clip_id}`, { token: stranger.token })).status).toBe(404);
            expect((await t.api("GET", `/agent/voice/${posted[0].clip_id}`, { token: web.token })).status).toBe(403);
            expect((await t.api("GET", `/agent/voice/${posted[0].clip_id}`)).status).toBe(401);
        });

        it("un clip envoyé par un agent à des viewers n'est pas téléchargeable par cet agent", async () => {
            await webViewer();
            const posted = await postWav("/agent/voice", robot.token, await sine({ seconds: 1 }));
            expect((await t.api("GET", `/agent/voice/${posted.json.clip_id}`, { token: robot.token })).status).toBe(404);
        });

        it("exige can_send_voice effectif : règle, audio_in déclaré, agent visible (403), avant même de lire le corps", async () => {
            const wav = await sine({ seconds: 1 });
            const noRule = await webViewer({ voice: false });
            const noAudioIn = await webViewer({ voice: true, caps: { ...WEB_CAPS, audio_in: undefined } });
            const ok = await webViewer({ voice: true });
            const other = await webViewer({ voice: true, pattern: "autre" });

            for (const token of [noRule.token, noAudioIn.token, other.token]) {
                const denied = await postWav("/viewer/voice?to=robot", token, wav);
                expect(denied.status).toBe(403);
                expect(denied.json.error).toBe("voice_not_allowed");
            }
            // 403 avant le 415 : le droit est vérifié en premier
            expect((await postWav("/viewer/voice?to=robot", noRule.token, wav, "audio/flac")).status).toBe(403);
            expect((await postWav("/viewer/voice?to=inconnu", ok.token, wav)).status).toBe(403);
            expect((await postWav("/viewer/voice", ok.token, wav)).status).toBe(400);
            expect((await postWav("/viewer/voice?to=robot", ok.token, wav, "audio/flac")).status).toBe(415);
            expect((await postWav("/viewer/voice?to=robot", robot.token, wav)).status).toBe(403);
            expect((await postWav("/viewer/voice?to=robot", ok.token, wav)).status).toBe(201);
            expect(await t.db.runner.get<any>(`SELECT count(*)::int AS n FROM events`)).toEqual({ n: 1 });
        });

        it("carte : IMA ADPCM jusqu'à audio_in.max_duration_s, puis rejet", async () => {
            const response = await t.api("POST", "/web/register", { cookie, body: { capabilities: CARD_CAPS } });
            await addRule(t, cookie, response.json.viewer_id, "robot", "agent", true);
            const token = response.json.token as string;
            const ok = await postWav("/viewer/voice?to=robot", token, await sine({ seconds: 2.5, rate: 8000, codec: "adpcm_ima_wav" }));
            expect(ok.status).toBe(201);
            const tooLong = await postWav("/viewer/voice?to=robot", token, await sine({ seconds: 4, rate: 8000, codec: "adpcm_ima_wav" }));
            expect(tooLong.status).toBe(413);
        });
    });
});
