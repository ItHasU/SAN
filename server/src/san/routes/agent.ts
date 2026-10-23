import { Router } from "express";
import { AGENT_STATUSES, setAgentState } from "../agents";
import { Db } from "../db";
import { insertEvent, NUDGE_TTL_S } from "../events";
import { badRequest } from "../errors";
import { agentOf } from "../http";
import { asObject, optionalEnum, optionalInt, optionalString } from "../validate";

export const MAX_DETAIL_CHARS = 500;
export const MAX_NUDGE_TEXT_CHARS = 500;
export const PRIORITIES = ["normal", "high"] as const;

/** Routes réservées aux agents (SPEC §10.1) : l'identité vient du jeton */
export function agentRoutes(db: Db): Router {
    const router = Router();

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
        const ttlS = optionalInt(body, "ttl_s", 1, 365 * 24 * 3600);
        // Une durée plus courte que le défaut est acceptée ; une plus longue est ramenée au défaut (SPEC §9.3)
        const effectiveTtl = Math.min(ttlS ?? NUDGE_TTL_S, NUDGE_TTL_S);
        const event = await insertEvent(db, {
            direction: "to_viewers", agentSlug: agent.slug, kind: "nudge", text, priority, ttlS: effectiveTtl
        });
        res.status(201).json({ id: event.id, expires_at: event.expires_at });
    });

    return router;
}
