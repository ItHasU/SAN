import { Request, Response, Router } from "express";
import { EventBus } from "../bus";
import { MAX_INBOX_WAIT_S, pollInbox } from "../inbox";
import { AGENT_STATUSES, AgentStatus, setAgentState } from "../agents";
import { SanConfig } from "../config";
import { Db } from "../db";
import { ApiError, tooManyRequests } from "../errors";
import { registerAgent } from "../enrollment";
import { assertSlug } from "../glob";
import { RateLimiter } from "../rate-limiter";
import { insertEvent, NUDGE_TTL_S } from "../events";
import { badRequest } from "../errors";
import { agentOf, clientIp } from "../http";
import { asObject, optionalEnum, optionalInt, optionalString, queryInt } from "../validate";

export const MAX_DETAIL_CHARS = 500;
export const MAX_NUDGE_TEXT_CHARS = 500;
export const NUDGE_TYPES = ["start", "notification", "question", "done", "error"] as const;
/**
 * État fixé par un nudge (SPEC §10.1) : `question` → waiting (« ? »), `error` → error (« ! »),
 * `done` → done (coche), `start` → working (réflexion) ; `notification` ne change pas l'état.
 */
export const NUDGE_STATE: Partial<Record<typeof NUDGE_TYPES[number], AgentStatus>> = {
    start: "working", question: "waiting", error: "error", done: "done"
};
export const PRIORITIES = ["normal", "high"] as const;

/** Corps JSON de `POST /agent/register` : trois champs courts, 4 Ko suffisent (SPEC §4bis) */
export const AGENT_REGISTER_BODY_LIMIT = "4kb";
/** Seule route accessible à un agent `pending` (SPEC §4bis) */
export const PENDING_AGENT_ALLOWED_PATH = "/agent/status";
const AGENT_NAME_MAX = 100;
/** Un jeton d'enrôlement fait 4 + 43 caractères ; la marge évite de traiter des valeurs absurdes */
const ENROLLMENT_TOKEN_MAX = 128;

/**
 * `POST /agent/register` : public, limité en débit par IP (SPEC §4bis). Sans
 * jeton d'enrôlement, l'agent est `pending` (5 demandes/h/IP par défaut) ; avec
 * un jeton valide, il est `active` dans le groupe du jeton (60/h/IP par défaut).
 */
export function agentRegisterHandler(
    db: Db, config: SanConfig, limiters: { agentRegister: RateLimiter, agentEnroll: RateLimiter, authFailures: RateLimiter }, log: (message: string) => void
) {
    return async (req: Request, res: Response): Promise<void> => {
        const ip = clientIp(req);
        const body = asObject(req.body);
        const rawToken = body["enrollment_token"];
        if (rawToken !== undefined && rawToken !== null && (typeof rawToken !== "string" || rawToken === "" || rawToken.length > ENROLLMENT_TOKEN_MAX)) {
            throw badRequest("enrollment_token doit être une chaîne non vide.");
        }
        const enrollmentToken = typeof rawToken === "string" ? rawToken : undefined;
        if (limiters.authFailures.isBlocked(ip)) {
            throw tooManyRequests("Trop d'échecs d'authentification depuis cette adresse.", "rate_limited", 60);
        }
        const verdict = (enrollmentToken === undefined ? limiters.agentRegister : limiters.agentEnroll).hit(ip);
        if (!verdict.allowed) {
            throw tooManyRequests("Trop de demandes d'enrôlement d'agent depuis cette adresse.", "rate_limited", verdict.retryAfterS);
        }
        const slug = assertSlug(body["slug"]);
        const name = optionalString(body, "name", AGENT_NAME_MAX, 1) ?? slug;
        try {
            const result = await registerAgent(db, { slug, name, enrollmentToken, ip }, config);
            log(`Enrôlement d'agent : « ${slug} » ${result.status}${result.group == null ? "" : ` dans le groupe « ${result.group} » (jeton d'enrôlement #${result.enrollment_token_id})`} depuis ${ip}.`);
            res.status(201).json({ slug: result.slug, status: result.status, token: result.token, ...(result.group == null ? {} : { group: result.group }) });
        } catch (error) {
            if (error instanceof ApiError && error.status === 401) {
                limiters.authFailures.hit(ip);
                log(`Enrôlement d'agent refusé : jeton d'enrôlement invalide pour « ${slug} » depuis ${ip}.`);
            }
            throw error;
        }
    };
}

/** Routes réservées aux agents (SPEC §10.1) : l'identité vient du jeton */
export function agentRoutes(db: Db, bus: EventBus): Router {
    const router = Router();

    /** Statut d'enrôlement : seule route permise à un agent `pending` (un agent révoqué reçoit `401`) */
    router.get(PENDING_AGENT_ALLOWED_PATH, (_req, res) => {
        const agent = agentOf(res);
        res.json({ slug: agent.slug, status: agent.status });
    });

    router.post("/agent/state", async (req, res) => {
        const agent = agentOf(res);
        const body = asObject(req.body);
        const status = optionalEnum(body, "status", AGENT_STATUSES);
        if (status === undefined) {
            throw badRequest(`status est obligatoire (${AGENT_STATUSES.join("|")}).`);
        }
        const detail = optionalString(body, "detail", MAX_DETAIL_CHARS);
        const progress = optionalInt(body, "progress", 0, 100);
        const ttlS = optionalInt(body, "ttl_s", 1, 365 * 24 * 3600);
        const { updated_at } = await setAgentState(db, agent.slug, { status: status!, detail, progress, ttlS });
        res.json({ ok: true, updated_at });
    });

    router.post("/agent/nudge", async (req, res) => {
        const agent = agentOf(res);
        const body = asObject(req.body);
        const text = optionalString(body, "text", MAX_NUDGE_TEXT_CHARS);
        const priority = optionalEnum(body, "priority", PRIORITIES) ?? "normal";
        const nudgeType = optionalEnum(body, "type", NUDGE_TYPES) ?? "notification";
        const ttlS = optionalInt(body, "ttl_s", 1, 365 * 24 * 3600);
        // Une durée plus courte que le défaut est acceptée ; une plus longue est ramenée au défaut (SPEC §9.3)
        const effectiveTtl = Math.min(ttlS ?? NUDGE_TTL_S, NUDGE_TTL_S);
        const event = await insertEvent(db, {
            direction: "to_viewers", agentSlug: agent.slug, kind: "nudge", text, priority, nudgeType, ttlS: effectiveTtl
        });
        const status = NUDGE_STATE[nudgeType];
        if (status !== undefined) {
            await setAgentState(db, agent.slug, { status, detail: text });
        }
        res.status(201).json({ id: event.id, expires_at: event.expires_at });
    });

    /**
     * Messages reçus des viewers, en long-poll : `ack` acquitte avant lecture,
     * `wait` (≤ 60 s) attend un événement si la boîte est vide (SPEC §10.1).
     */
    router.get("/agent/inbox", async (req, res) => {
        const agent = agentOf(res);
        const ack = queryInt(req.query["ack"], "ack");
        const waitS = queryInt(req.query["wait"], "wait", MAX_INBOX_WAIT_S) ?? 0;
        const abort = new AbortController();
        res.on("close", () => abort.abort());
        const result = await pollInbox(db, bus, agent.slug, { ack, waitS, signal: abort.signal });
        if (!abort.signal.aborted) {
            res.json(result);
        }
    });

    return router;
}
