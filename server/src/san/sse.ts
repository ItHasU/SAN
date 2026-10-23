import { Request, Response } from "express";
import { EventBus, BusMessage } from "./bus";
import { getCursor } from "./cursors";
import { Db } from "./db";
import { computeConfig, configHash, trackedAgents, ViewerConfig } from "./viewer-config";
import { fetchStates, fetchViewerEvents, SYNC_PAGE_SIZE } from "./viewer-events";

/** Flux SSE `GET /viewer/events` (SPEC §10.3, DESIGN §2) */

export const DEFAULT_HEARTBEAT_MS = 25_000;

/** Une connexion SSE : événements, états, changements de configuration d'un viewer */
class SseConnection {

    protected _config: ViewerConfig | null = null;
    protected _hash = "";
    protected _capabilities: any = null;
    protected _lastId = 0;
    protected _needEvents = true;
    protected _configDirty = false;
    protected _states = new Set<string>();
    protected _running = false;
    protected _again = false;
    protected _closed = false;
    protected _heartbeat: NodeJS.Timeout | null = null;
    protected _unsubscribe: (() => void) | null = null;

    constructor(
        protected readonly _db: Db,
        protected readonly _bus: EventBus,
        protected readonly _req: Request,
        protected readonly _res: Response,
        protected readonly _viewerId: string,
        protected readonly _heartbeatMs: number,
        protected readonly _onClose: (connection: SseConnection) => void
    ) { }

    public async open(): Promise<void> {
        // L'écoute est active avant la première lecture : aucun événement n'est manqué entre les deux
        await this._bus.start();
        const res = this._res;
        res.status(200);
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();
        this._req.socket.setNoDelay(true);
        this._req.socket.setTimeout(0);
        this._req.on("close", () => this.close());

        if (!await this._reloadConfig() || this._closed) {
            return;
        }
        const header = this._req.header("last-event-id");
        const parsed = header != null && /^\d+$/.test(header.trim()) ? Number(header.trim()) : null;
        this._lastId = parsed ?? await getCursor(this._db, "viewer", this._viewerId);
        if (this._closed) {
            return;
        }
        this._write(`event: hello\ndata: ${JSON.stringify({ config_hash: this._hash })}\n\n`);
        // Abonné après le chargement initial : la première passe relit configuration et événements,
        // ce qui couvre tout ce qui a pu arriver entre-temps
        this._configDirty = true;
        this._unsubscribe = this._bus.subscribe((message) => this._onMessage(message));
        this._heartbeat = setInterval(() => {
            this._write(`:\n\n`);
            // Filet de sécurité si une notification s'est perdue
            this._needEvents = true;
            this._configDirty = true;
            this._schedule();
        }, this._heartbeatMs);
        this._heartbeat.unref();
        this._schedule();
    }

    public close(): void {
        if (this._closed) {
            return;
        }
        this._closed = true;
        this._unsubscribe?.();
        if (this._heartbeat != null) {
            clearInterval(this._heartbeat);
        }
        if (!this._res.writableEnded) {
            this._res.end();
        }
        this._onClose(this);
    }

    protected _write(chunk: string): void {
        if (!this._closed && !this._res.writableEnded) {
            this._res.write(chunk);
        }
    }

    protected async _reloadConfig(): Promise<boolean> {
        const viewer = await this._db.get<{ status: string, capabilities: any }>(`SELECT status, capabilities FROM viewers WHERE id = $1`, this._viewerId);
        if (viewer == null || viewer.status !== "active") {
            this.close();
            return false;
        }
        this._capabilities = viewer.capabilities;
        this._config = await computeConfig(this._db, this._viewerId);
        this._hash = configHash(this._config);
        return true;
    }

    protected _onMessage(message: BusMessage): void {
        switch (message.type) {
            case "event":
                if (message.direction === "to_viewers") {
                    this._needEvents = true;
                }
                break;
            case "state":
                this._states.add(message.agent);
                break;
            case "config":
                if (message.viewer == null || message.viewer === this._viewerId) {
                    this._configDirty = true;
                }
                break;
            case "reconnect":
                this._needEvents = true;
                this._configDirty = true;
                break;
        }
        this._schedule();
    }

    /** Un seul traitement à la fois ; les signaux arrivés pendant l'exécution déclenchent un nouveau tour */
    protected _schedule(): void {
        if (this._closed) {
            return;
        }
        if (this._running) {
            this._again = true;
            return;
        }
        this._running = true;
        void this._pump().catch((error: unknown) => {
            console.error("SSE pump failed:", error);
        }).finally(() => {
            this._running = false;
            if (this._again && !this._closed) {
                this._again = false;
                this._schedule();
            }
        });
    }

    protected async _pump(): Promise<void> {
        if (this._configDirty) {
            this._configDirty = false;
            const before = new Set(trackedAgents(this._config!).map((agent) => agent.agent));
            const oldHash = this._hash;
            if (!await this._reloadConfig()) {
                return;
            }
            if (this._hash !== oldHash) {
                this._write(`event: config\ndata: ${JSON.stringify({ config_hash: this._hash })}\n\n`);
                // Un agent nouvellement suivi : son état courant est envoyé (SPEC §9.2)
                const gained = trackedAgents(this._config!).map((agent) => agent.agent).filter((slug) => !before.has(slug));
                for (const slug of gained) {
                    this._states.add(slug);
                }
                this._needEvents = true;
            }
        }
        if (this._states.size > 0) {
            const wanted = new Set(this._states);
            this._states.clear();
            const slugs = trackedAgents(this._config!).map((agent) => agent.agent).filter((slug) => wanted.has(slug));
            for (const state of await fetchStates(this._db, slugs, this._capabilities)) {
                this._write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
            }
        }
        while (this._needEvents && !this._closed) {
            this._needEvents = false;
            for (;;) {
                const page = await fetchViewerEvents(this._db, this._config!, this._capabilities, this._lastId, SYNC_PAGE_SIZE);
                for (const event of page.events) {
                    this._write(`id: ${event.id}\nevent: event\ndata: ${JSON.stringify(event)}\n\n`);
                    this._lastId = event.id;
                }
                if (!page.has_more) {
                    break;
                }
            }
        }
    }

}

/** Ensemble des connexions SSE ouvertes (arrêt propre du serveur) */
export class SseHub {

    protected readonly _connections = new Set<SseConnection>();

    constructor(
        protected readonly _db: Db,
        protected readonly _bus: EventBus,
        protected readonly _heartbeatMs: number = DEFAULT_HEARTBEAT_MS
    ) { }

    public get size(): number {
        return this._connections.size;
    }

    public async handle(req: Request, res: Response, viewerId: string): Promise<void> {
        const connection = new SseConnection(this._db, this._bus, req, res, viewerId, this._heartbeatMs, (c) => this._connections.delete(c));
        this._connections.add(connection);
        await connection.open();
    }

    public closeAll(): void {
        for (const connection of [...this._connections]) {
            connection.close();
        }
    }

}
