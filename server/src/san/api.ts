import { UserInfo } from "@dagda/shared/src/auth/types";
import express, { NextFunction, Request, RequestHandler, Response, Router } from "express";
import { authenticateToken } from "./auth";
import { SanConfig } from "./config";
import { Db } from "./db";
import { notFound, tooManyRequests, unauthorized, forbidden } from "./errors";
import { apiErrorHandler, clientIp, principalOf } from "./http";
import { EventBus } from "./bus";
import { RateLimiter } from "./rate-limiter";
import { SseHub } from "./sse";
import { adminRoutes, AuditFn, webRegisterRoutes } from "./routes/admin";
import { agentRoutes } from "./routes/agent";
import { deviceRegisterHandler, deviceRoutes } from "./routes/device";
import { viewerRoutes } from "./routes/viewer";
import { hashToken, parseBearer } from "./tokens";

export interface ApiDeps {
    db: Db;
    config: SanConfig;
    /** Résout la session administrateur Dagda de la requête ; null si absente ou invalide */
    resolveAdmin: (req: Request, res: Response) => Promise<UserInfo | null>;
    /** Journal d'audit (Dagda) : (userId, action, détails) */
    audit: (userId: number, action: string, details: unknown) => Promise<void>;
    /** Bus LISTEN/NOTIFY qui réveille SSE et long-polls */
    bus: EventBus;
    /** Horloge injectable (limiteurs) */
    now?: () => number;
}

export interface ApiRouter {
    router: Router;
    limiters: { register: RateLimiter, requests: RateLimiter, authFailures: RateLimiter };
    /** Connexions SSE ouvertes */
    hub: SseHub;
}

/** Chemin accessible à un viewer encore `pending` (SPEC §4.2) */
const PENDING_ALLOWED_PATH = "/device/status";

/**
 * Router `/api/v1` : authentification Bearer, limites de taille et de débit,
 * erreurs JSON. N'utilise pas la session Dagda, sauf `/admin/*` et `/web/register`.
 */
export function createApiRouter(deps: ApiDeps): ApiRouter {
    const { db, config } = deps;
    const now = deps.now;
    const limiters = {
        register: new RateLimiter({ limit: config.registerRatePerHour, windowMs: 3600_000, now }),
        requests: new RateLimiter({ limit: config.ratePerMinute, windowMs: 60_000, now }),
        authFailures: new RateLimiter({ limit: config.authFailuresPerMinute, windowMs: 60_000, now })
    };
    // `rawBody` : le hash des capacités porte sur le corps exact reçu (DESIGN §4)
    const jsonBody = express.json({
        limit: config.jsonLimit,
        type: "application/json",
        verify: (req, _res, buf) => {
            (req as unknown as { rawBody?: Buffer }).rawBody = buf;
        }
    });
    const hub = new SseHub(db, deps.bus, config.sseHeartbeatMs);

    const router = Router();
    router.use((_req, res, next) => {
        res.setHeader("Cache-Control", "no-store");
        next();
    });

    // -- Public ------------------------------------------------------------
    router.post("/device/register", jsonBody, deviceRegisterHandler(db, config, limiters.register));

    // -- Session administrateur Dagda --------------------------------------
    const audit: AuditFn = (req, action, details) => deps.audit((req.user as UserInfo).id, action, details);
    const adminOnly: RequestHandler = async (req, res, next) => {
        const user = await deps.resolveAdmin(req, res);
        if (user == null) {
            next(unauthorized("Session administrateur requise."));
            return;
        }
        req.user = user;
        next();
    };
    router.use("/admin", adminOnly, jsonBody, adminRoutes(db, audit));
    router.use("/web", adminOnly, jsonBody, webRegisterRoutes(db, audit));

    // -- Jeton Bearer ------------------------------------------------------
    const bearer: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
        const ip = clientIp(req);
        if (limiters.authFailures.isBlocked(ip)) {
            next(tooManyRequests("Trop d'échecs d'authentification depuis cette adresse.", "rate_limited", 60));
            return;
        }
        const token = parseBearer(req.header("authorization"));
        const principal = token == null ? null : await authenticateToken(db, token);
        if (token == null || principal == null) {
            limiters.authFailures.hit(ip);
            next(unauthorized());
            return;
        }
        const verdict = limiters.requests.hit(hashToken(token).toString("hex"));
        if (!verdict.allowed) {
            next(tooManyRequests("Limite de débit atteinte pour ce jeton.", "rate_limited", verdict.retryAfterS));
            return;
        }
        res.locals["principal"] = principal;
        if (principal.type === "viewer" && principal.status === "pending" && req.path !== PENDING_ALLOWED_PATH) {
            next(forbidden("Ce viewer est en attente d'activation par un administrateur.", "viewer_pending"));
            return;
        }
        next();
    };
    const authenticated = Router();
    authenticated.use(bearer, jsonBody);
    authenticated.use(deviceRoutes(db));
    authenticated.use(agentRoutes(db, deps.bus));
    authenticated.use(viewerRoutes(db, hub));
    router.use(authenticated);

    router.use((_req, _res, next) => next(notFound("Route inconnue.")));
    router.use(apiErrorHandler);
    return { router, limiters, hub };
}

export { principalOf };
