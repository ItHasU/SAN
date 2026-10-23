/**
 * Erreurs JSON de l'API (DESIGN §4) : `{ "error": "code_court", "message": "texte" }`.
 */
export class ApiError extends Error {

    constructor(
        public readonly status: number,
        public readonly code: string,
        message: string,
        /** Champs additionnels fusionnés dans le corps (ex. configuration courante d'un 409) */
        public readonly extra?: Record<string, unknown>
    ) {
        super(message);
        this.name = "ApiError";
    }

    /** Corps JSON renvoyé au client */
    public toBody(): Record<string, unknown> {
        return { error: this.code, message: this.message, ...this.extra };
    }

}

export const badRequest = (message: string, code = "invalid_request"): ApiError => new ApiError(400, code, message);
export const unauthorized = (message = "Jeton inconnu, expiré ou révoqué."): ApiError => new ApiError(401, "unauthorized", message);
export const forbidden = (message: string, code = "forbidden"): ApiError => new ApiError(403, code, message);
export const notFound = (message = "Ressource introuvable."): ApiError => new ApiError(404, "not_found", message);
export const conflict = (message: string, code = "conflict", extra?: Record<string, unknown>): ApiError => new ApiError(409, code, message, extra);
export const payloadTooLarge = (message = "Charge utile trop volumineuse."): ApiError => new ApiError(413, "payload_too_large", message);
export const upgradeRequired = (message: string): ApiError => new ApiError(426, "unsupported_protocol_version", message);
export const tooManyRequests = (message: string, code = "rate_limited", retryAfterS?: number): ApiError =>
    new ApiError(429, code, message, retryAfterS == null ? undefined : { retry_after_s: retryAfterS });
