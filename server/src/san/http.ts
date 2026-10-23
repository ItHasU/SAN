import { NextFunction, Request, RequestHandler, Response } from "express";
import { ApiError, payloadTooLarge, badRequest } from "./errors";
import { Principal, AgentPrincipal, ViewerPrincipal } from "./auth";

/** Principal de la requête, posé par le middleware Bearer */
export function principalOf(res: Response): Principal {
    return res.locals["principal"] as Principal;
}

export function agentOf(res: Response): AgentPrincipal {
    const principal = principalOf(res);
    if (principal.type !== "agent") {
        throw new ApiError(403, "forbidden", "Cette route est réservée aux agents.");
    }
    return principal;
}

export function viewerOf(res: Response): ViewerPrincipal {
    const principal = principalOf(res);
    if (principal.type !== "viewer") {
        throw new ApiError(403, "forbidden", "Cette route est réservée aux viewers.");
    }
    return principal;
}

/** Adresse IP du client, en tenant compte de « trust proxy » */
export function clientIp(req: Request): string {
    return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

/** Middleware d'erreur de l'API : tout est renvoyé en JSON `{error, message}` (DESIGN §4) */
export const apiErrorHandler = (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    let apiError: ApiError;
    if (err instanceof ApiError) {
        apiError = err;
    } else if (isBodyParserError(err, "entity.too.large")) {
        apiError = _req.is("audio/*")
            ? payloadTooLarge("Le corps audio dépasse la limite de 2 Mo.")
            : payloadTooLarge("Le corps JSON dépasse la limite de 64 Ko.");
    } else if (isBodyParserError(err, "entity.parse.failed") || isBodyParserError(err, "encoding.unsupported") || isBodyParserError(err, "charset.unsupported")) {
        apiError = badRequest("Corps JSON invalide.", "invalid_json");
    } else {
        console.error("Unhandled error in /api/v1:", err);
        apiError = new ApiError(500, "internal_error", "Erreur interne du serveur.");
    }
    if (apiError.status === 429 && typeof apiError.extra?.["retry_after_s"] === "number") {
        res.setHeader("Retry-After", String(apiError.extra["retry_after_s"]));
    }
    res.status(apiError.status).json(apiError.toBody());
};

function isBodyParserError(err: unknown, type: string): boolean {
    return typeof err === "object" && err != null && (err as { type?: string }).type === type;
}

export type AsyncHandler = RequestHandler;
