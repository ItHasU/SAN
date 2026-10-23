import { Router } from "express";
import { advanceCursor } from "../cursors";
import { Db } from "../db";
import { conflict, badRequest } from "../errors";
import { notifyConfigChanged } from "../events";
import { viewerOf } from "../http";
import { SseHub } from "../sse";
import { syncViewer, SyncQuery } from "../sync";
import { asObject, queryInt } from "../validate";
import { applySubscriptions, computeConfig, ConfigView, configHash, consultConfig, parseSubscriptions } from "../viewer-config";
import { storeCapabilities } from "../viewers";

function queryHash(value: unknown, name: string): string | undefined {
    if (value === undefined || value === "") {
        return undefined;
    }
    if (typeof value !== "string" || !/^[0-9a-zA-Z]{1,64}$/.test(value)) {
        throw badRequest(`${name} invalide.`);
    }
    return value;
}

/** Routes réservées aux viewers actifs (SPEC §10.3) */
export function viewerRoutes(db: Db, hub: SseHub): Router {
    const router = Router();

    /** Synchronisation (SPEC §10.4) : `ack`, `config_hash` et `caps_hash` peuvent être absents */
    router.get("/viewer/sync", async (req, res) => {
        const viewer = viewerOf(res);
        const query: SyncQuery = {
            ack: queryInt(req.query["ack"], "ack"),
            config_hash: queryHash(req.query["config_hash"], "config_hash"),
            caps_hash: queryHash(req.query["caps_hash"], "caps_hash"),
            battery: queryInt(req.query["battery"], "battery", 100)
        };
        res.json(await syncViewer(db, viewer.id, query));
    });

    router.post("/viewer/ack", async (req, res) => {
        const viewer = viewerOf(res);
        const upTo = (asObject(req.body))["up_to"];
        if (typeof upTo !== "number" || !Number.isInteger(upTo) || upTo < 0) {
            throw badRequest("up_to doit être un entier positif ou nul.");
        }
        res.json({ ack: await advanceCursor(db, "viewer", viewer.id, upTo) });
    });

    /** Le hash est calculé sur le corps brut tel que reçu (DESIGN §4) */
    router.put("/viewer/capabilities", async (req, res) => {
        const viewer = viewerOf(res);
        const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
        if (raw == null || raw.length === 0) {
            throw badRequest("Le corps doit être un document JSON de capacités (Content-Type: application/json).");
        }
        res.json(await storeCapabilities(db, viewer.id, raw));
    });

    router.get("/viewer/config", async (_req, res) => {
        const viewer = viewerOf(res);
        res.json(await db.withTransaction((conn) => consultConfig(conn, viewer.id)));
    });

    router.put("/viewer/config", async (req, res) => {
        const viewer = viewerOf(res);
        const body = asObject(req.body);
        const baseHash = body["base_hash"];
        if (typeof baseHash !== "string" || baseHash === "") {
            throw badRequest("base_hash est obligatoire (config_hash de la configuration sur laquelle le viewer s'est basé).");
        }
        const patches = parseSubscriptions(body["subscriptions"]);
        const view = await db.withTransaction(async (conn): Promise<ConfigView> => {
            await conn.run(`SELECT 1 FROM viewers WHERE id = $1 FOR UPDATE`, viewer.id);
            const current = await computeConfig(conn, viewer.id);
            const currentHash = configHash(current);
            if (currentHash !== baseHash) {
                throw conflict("La configuration a changé côté serveur : adoptez la configuration renvoyée.", "config_conflict",
                    { config_hash: currentHash, config: current });
            }
            await applySubscriptions(conn, viewer.id, patches, "forbidden");
            const config = await computeConfig(conn, viewer.id);
            await notifyConfigChanged(conn, viewer.id);
            return { config_hash: configHash(config), config };
        });
        res.json(view);
    });

    /** Flux SSE (DESIGN §2) : le client web le lit avec `fetch()` + Bearer */
    router.get("/viewer/events", async (req, res) => {
        const viewer = viewerOf(res);
        await hub.handle(req, res, viewer.id);
    });

    return router;
}
