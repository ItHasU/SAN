import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeBuffer, sine } from "../../test/audio";
import { MediaTools } from "./ffmpeg";
import { fakeTtsDurationS, FakeTts, PiperHttpTts, TtsError } from "./tts";

describe("PiperHttpTts contre un faux service HTTP", () => {
    let server: Server;
    let url: string;
    let wav: Buffer;
    const requests: Array<{ method?: string, url?: string, type?: string, body: string }> = [];
    let handler: (req: IncomingMessage, res: ServerResponse, body: string) => void;

    beforeAll(async () => {
        wav = await sine({ seconds: 1, rate: 22050 });
        server = createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (chunk) => chunks.push(chunk));
            req.on("end", () => {
                const body = Buffer.concat(chunks).toString("utf8");
                requests.push({ method: req.method, url: req.url, type: req.headers["content-type"], body });
                handler(req, res, body);
            });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("envoie POST / {text} en JSON et renvoie le WAV", async () => {
        handler = (_req, res) => {
            res.writeHead(200, { "content-type": "audio/wav" });
            res.end(wav);
        };
        const result = await new PiperHttpTts(url, 5000).synthesize("Bonjour tout le monde");
        expect(result.equals(wav)).toBe(true);
        expect(requests.at(-1)).toMatchObject({ method: "POST", url: "/", type: "application/json" });
        expect(JSON.parse(requests.at(-1)!.body)).toEqual({ text: "Bonjour tout le monde" });
    });

    it("signale une erreur HTTP, une réponse qui n'est pas du WAV, un service injoignable et un délai dépassé", async () => {
        handler = (_req, res) => {
            res.writeHead(500);
            res.end("boom");
        };
        await expect(new PiperHttpTts(url, 5000).synthesize("x")).rejects.toThrow(/HTTP 500/);

        handler = (_req, res) => {
            res.writeHead(200, { "content-type": "audio/wav" });
            res.end("pas un wav, mais assez long pour dépasser l'en-tête de quarante-quatre octets");
        };
        await expect(new PiperHttpTts(url, 5000).synthesize("x")).rejects.toThrow(/WAV/);

        await expect(new PiperHttpTts("http://127.0.0.1:1", 2000).synthesize("x")).rejects.toBeInstanceOf(TtsError);

        handler = () => undefined; // ne répond jamais
        await expect(new PiperHttpTts(url, 150).synthesize("x")).rejects.toThrow(/délai/);
    });
});

describe("FakeTts", () => {
    it("produit un WAV mono 22 050 Hz dont la durée est proportionnelle au texte", async () => {
        const fake = new FakeTts(new MediaTools());
        const short = await probeBuffer(await fake.synthesize("a".repeat(20)));
        const long = await probeBuffer(await fake.synthesize("a".repeat(100)));
        expect(short).toMatchObject({ codec: "pcm_s16le", rate: 22050, channels: 1 });
        expect(short.duration).toBeCloseTo(fakeTtsDurationS("a".repeat(20)), 1);
        expect(long.duration).toBeCloseTo(5, 1);
        expect(long.duration).toBeGreaterThan(short.duration * 4);
        // 500 caractères restent sous la limite de 30 s
        expect(fakeTtsDurationS("a".repeat(500))).toBeLessThanOrEqual(25);
    });
});
