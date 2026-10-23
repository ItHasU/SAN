import { Request, Response, Router } from "express";
import { Db } from "../db";
import { SanConfig } from "../config";
import { RateLimiter } from "../rate-limiter";
import { asObject, requiredString } from "../validate";
import { clientIp, viewerOf } from "../http";
import { tooManyRequests } from "../errors";
import { registerDevice, validateCapabilities } from "../viewers";

/** `POST /device/register` : public, limité en débit par IP (SPEC §4.3) */
export function deviceRegisterHandler(db: Db, config: SanConfig, limiter: RateLimiter) {
    return async (req: Request, res: Response): Promise<void> => {
        const verdict = limiter.hit(clientIp(req));
        if (!verdict.allowed) {
            throw tooManyRequests("Trop de demandes d'enrôlement depuis cette adresse.", "rate_limited", verdict.retryAfterS);
        }
        const body = asObject(req.body);
        const hardwareId = requiredString(body, "hardware_id", 128);
        const model = requiredString(body, "model", 64);
        const capabilities = validateCapabilities(body["capabilities"]);

        const result = await registerDevice(db, { hardwareId, model, capabilities, ip: clientIp(req) }, config);
        res.status(201).json({ token: result.token, pairing_code: result.pairing_code, status: "pending", viewer_id: result.viewer_id });
    };
}

/** Routes d'enrôlement accessibles avec un jeton de viewer, y compris pending */
export function deviceRoutes(db: Db): Router {
    const router = Router();
    router.get("/device/status", async (_req, res) => {
        const viewer = viewerOf(res);
        await db.run(`UPDATE viewers SET last_seen_at = now() WHERE id = $1`, viewer.id);
        res.json({ status: viewer.status });
    });
    return router;
}
