import express, { NextFunction, Request, RequestHandler, Response, Router } from "express";
import { AudioService } from "../audio/service";
import {
    AGENT_INPUT_TYPES, baseMimeType, formatInfo, InputKind, isRenditionFormat, PIVOT_SAMPLE_RATE, VIEWER_INPUT_TYPES
} from "../audio/formats";
import { TtsQueue } from "../audio/tts-queue";
import { SanConfig } from "../config";
import { Db } from "../db";
import { badRequest, forbidden, gone, notAcceptable, notFound, unsupportedMediaType } from "../errors";
import { insertEvent, VOICE_TTL_S } from "../events";
import { agentOf, viewerOf } from "../http";
import { newClipId } from "../ids";
import { RULE_COVERS_AGENT_SQL } from "../permissions";
import { asObject, optionalEnum, optionalInt, optionalString, requiredString } from "../validate";
import { computeConfig } from "../viewer-config";
import { chooseAudioFormat } from "../viewer-events";
import { PRIORITIES } from "./agent";

/** Routes audio (SPEC §9.4, §10.1, §10.3, DESIGN §5, §11) */

const CLIP_ID_RE = /^c_[0-9A-Z]{26}$/;
/** Formats que l'agent peut demander (`?format=`), toujours à 16 kHz */
const AGENT_DOWNLOAD_FORMATS = ["wav", "mp3", "ogg"] as const;

function queryString(req: Request, name: string): string | undefined {
    const value = req.query[name];
    if (value === undefined || value === "") {
        return undefined;
    }
    if (typeof value !== "string") {
        throw badRequest(`${name} ne doit être donné qu'une fois.`);
    }
    return value;
}

function queryPositiveInt(req: Request, name: string, max: number): number | undefined {
    const raw = queryString(req, name);
    if (raw === undefined) {
        return undefined;
    }
    if (!/^\d{1,10}$/.test(raw) || Number(raw) < 1 || Number(raw) > max) {
        throw badRequest(`${name} doit être un entier entre 1 et ${max}.`);
    }
    return Number(raw);
}

/** Valide le `Content-Type` avant de lire le corps (415) et retient la nature du fichier */
const requireAudioType = (accepted: Record<string, InputKind>): RequestHandler => (req, res, next) => {
    const type = baseMimeType(req.header("content-type"));
    const kind = accepted[type];
    if (kind == null) {
        next(unsupportedMediaType(`Content-Type « ${type || "absent"} » non accepté (${Object.keys(accepted).join(", ")}).`));
        return;
    }
    res.locals["inputKind"] = kind;
    next();
};

/** Corps binaire brut : le type est déjà validé, `express.raw` ne sert qu'à lire et borner */
const rawAudio = (config: SanConfig): RequestHandler => express.raw({ type: () => true, limit: config.audioLimit });

function audioBody(req: Request): Buffer {
    const body = req.body as unknown;
    if (!Buffer.isBuffer(body) || body.length === 0) {
        throw badRequest("Le corps audio est vide.", "invalid_audio");
    }
    return body;
}

/** Envoie un fichier de clip : `Content-Type`, `Content-Length`, `Cache-Control: private`, `Range` géré par Express */
async function sendClipFile(res: Response, file: string, contentType: string): Promise<void> {
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private, max-age=3600");
    await new Promise<void>((resolve, reject) => {
        res.sendFile(file, { dotfiles: "allow", cacheControl: false, lastModified: false }, (error) => {
            if (error == null) {
                resolve();
            } else if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                reject(gone("Le fichier audio n'est plus disponible."));
            } else {
                reject(error);
            }
        });
    });
}

export function voiceRoutes(db: Db, config: SanConfig, audio: AudioService, tts: TtsQueue): Router {
    const router = Router();

    /** Supprime les fichiers d'un clip dont l'enregistrement a échoué après la réception */
    const cleanup = async <T>(clipId: string, work: () => Promise<T>): Promise<T> => {
        try {
            return await work();
        } catch (error) {
            await audio.discard(clipId).catch(() => undefined);
            throw error;
        }
    };

    //#region Agent ---------------------------------------------------------------

    /** TTS : le clip est `pending`, l'événement ne sera inscrit qu'une fois la synthèse faite */
    router.post("/agent/say", async (req, res) => {
        const agent = agentOf(res);
        const body = asObject(req.body);
        const text = requiredString(body, "text", config.ttsMaxChars);
        const priority = optionalEnum(body, "priority", PRIORITIES) ?? "normal";
        const ttlS = optionalInt(body, "ttl_s", 1, 365 * 24 * 3600);
        const clipId = await tts.submit(agent.slug, { text, priority, ttlS: Math.min(ttlS ?? VOICE_TTL_S, VOICE_TTL_S) });
        res.status(202).json({ clip_id: clipId, status: "pending" });
    });

    router.post("/agent/voice", requireAudioType(AGENT_INPUT_TYPES), rawAudio(config), async (req, res) => {
        const agent = agentOf(res);
        const priority = optionalEnum({ priority: queryString(req, "priority") }, "priority", PRIORITIES) ?? "normal";
        const ttlS = queryPositiveInt(req, "ttl_s", 365 * 24 * 3600);
        const text = optionalString({ text: queryString(req, "text") }, "text", config.ttsMaxChars);
        const data = audioBody(req);
        const clipId = newClipId();
        const ingested = await audio.ingest(clipId, data, res.locals["inputKind"] as InputKind, config.maxClipDurationS);
        const eventId = await cleanup(clipId, async () => {
            await audio.createReadyClip(db, clipId, "agent_upload", ingested);
            await audio.prepareForAudience(agent.slug, clipId);
            const event = await insertEvent(db, {
                direction: "to_viewers", agentSlug: agent.slug, kind: "voice", text: text ?? null, priority, clipId,
                ttlS: Math.min(ttlS ?? VOICE_TTL_S, VOICE_TTL_S)
            });
            return event.id;
        });
        res.status(201).json({ clip_id: clipId, event_id: eventId });
    });

    /** Message vocal reçu d'un viewer : seulement un clip envoyé à CET agent (événement `to_agent`) */
    router.get("/agent/voice/:clip", async (req, res) => {
        const agent = agentOf(res);
        const clipId = String(req.params["clip"]);
        const format = optionalEnum({ format: queryString(req, "format") }, "format", AGENT_DOWNLOAD_FORMATS) ?? "wav";
        const row = CLIP_ID_RE.test(clipId)
            ? await db.get<{ expired: boolean }>(
                `SELECT (e.expires_at <= now()) AS expired FROM events e JOIN voice_clips c ON c.id = e.clip_id
                 WHERE e.direction = 'to_agent' AND e.agent_slug = $1 AND e.clip_id = $2 AND c.status = 'ready'
                 ORDER BY e.id DESC LIMIT 1`, agent.slug, clipId)
            : null;
        if (row == null) {
            throw notFound("Message vocal introuvable.");
        }
        if (row.expired) {
            throw gone("Ce message vocal a expiré.");
        }
        const rendition = await audio.ensureRendition(clipId, format, PIVOT_SAMPLE_RATE);
        await sendClipFile(res, rendition.file, rendition.contentType);
    });

    //#endregion

    //#region Viewer --------------------------------------------------------------

    /** Clip d'un événement `to_viewers`, dans le format adapté aux capacités du viewer */
    router.get("/viewer/voice/:clip", async (req, res) => {
        const viewer = viewerOf(res);
        const clipId = String(req.params["clip"]);
        const row = CLIP_ID_RE.test(clipId)
            ? await db.get<{ expired: boolean, capabilities: any }>(
                `SELECT (e.expires_at <= now()) AS expired, v.capabilities
                 FROM events e JOIN voice_clips c ON c.id = e.clip_id
                 JOIN agents a ON a.slug = e.agent_slug AND a.revoked_at IS NULL
                 JOIN viewers v ON v.id = $1
                 WHERE e.direction = 'to_viewers' AND e.clip_id = $2 AND c.status = 'ready'
                   AND EXISTS (SELECT 1 FROM permission_rules r WHERE r.viewer_id = v.id AND ${RULE_COVERS_AGENT_SQL})
                 ORDER BY e.id DESC LIMIT 1`, viewer.id, clipId)
            : null;
        if (row == null) {
            throw notFound("Message vocal introuvable.");
        }
        if (row.expired) {
            throw gone("Ce message vocal a expiré.");
        }
        const choice = chooseAudioFormat(row.capabilities);
        if (choice == null || !isRenditionFormat(choice.format)) {
            throw notAcceptable("Ce viewer ne déclare aucun format de sortie audio pris en charge.", "no_audio_output");
        }
        const rendition = await audio.ensureRendition(clipId, choice.format, choice.sample_rate);
        res.setHeader("X-Audio-Format", `${choice.format}; rate=${choice.sample_rate}`);
        await sendClipFile(res, rendition.file, formatInfo(choice.format).contentType);
    });

    /**
     * Message vocal d'un viewer vers un agent. Le droit (`can_send_voice` effectif :
     * règle + `audio_in` déclaré) est vérifié avant de lire le corps.
     */
    const voicePermission: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const viewer = viewerOf(res);
            const to = queryString(req, "to");
            if (to === undefined) {
                throw badRequest("Le paramètre to (slug de l'agent destinataire) est obligatoire.");
            }
            const view = await computeConfig(db, viewer.id);
            // Agent inconnu ou invisible : même réponse, pour ne pas révéler son existence
            if (view.agents.find((agent) => agent.agent === to)?.can_send_voice !== true) {
                throw forbidden("Envoi de message vocal non autorisé vers cet agent (can_send_voice et audio_in requis).", "voice_not_allowed");
            }
            const caps = await db.get<{ capabilities: any }>(`SELECT capabilities FROM viewers WHERE id = $1`, viewer.id);
            const declared = caps?.capabilities?.audio_in?.max_duration_s;
            res.locals["voiceTo"] = to;
            res.locals["maxDurationS"] = Number.isInteger(declared) && declared > 0 ? Math.min(declared, config.maxClipDurationS) : config.maxClipDurationS;
            next();
        } catch (error) {
            next(error);
        }
    };

    router.post("/viewer/voice", voicePermission, requireAudioType(VIEWER_INPUT_TYPES), rawAudio(config), async (req, res) => {
        const viewer = viewerOf(res);
        const to = res.locals["voiceTo"] as string;
        const data = audioBody(req);
        const clipId = newClipId();
        const ingested = await audio.ingest(clipId, data, res.locals["inputKind"] as InputKind, res.locals["maxDurationS"] as number);
        const eventId = await cleanup(clipId, async () => {
            await audio.createReadyClip(db, clipId, "viewer_upload", ingested);
            const event = await insertEvent(db, {
                direction: "to_agent", agentSlug: to, fromViewerId: viewer.id, kind: "voice", clipId, ttlS: VOICE_TTL_S
            });
            return event.id;
        });
        res.status(201).json({ clip_id: clipId, event_id: eventId });
    });

    //#endregion

    return router;
}

