import { Client, Notification } from "pg";
import { NOTIFY_CHANNEL } from "./events";

/** Message du bus (charge utile des `NOTIFY san_events`, sans le schéma) */
export type BusMessage =
    | { type: "event", id: number, direction: "to_viewers" | "to_agent", agent: string }
    | { type: "state", agent: string }
    | { type: "config", viewer: string | null }
    | { type: "reconnect" };

export type BusListener = (message: BusMessage) => void;

export interface BusOptions {
    connectionString: string;
    /** Délais de reconnexion min/max en ms (défaut 500 / 15000) */
    reconnectMinMs?: number;
    reconnectMaxMs?: number;
    log?: (message: string) => void;
}

/**
 * Bus interne (DESIGN §3) : un client `pg` dédié fait `LISTEN san_events` et
 * relaie les notifications à des écouteurs en mémoire, qui réveillent les flux
 * SSE et les long-polls. Reconnexion automatique avec attente exponentielle ;
 * après chaque reconnexion les écouteurs reçoivent `{type: "reconnect"}` pour
 * relire la base (des notifications ont pu être manquées).
 *
 * Un `NOTIFY` est global à la base : les messages d'un autre schéma (suites de
 * tests parallèles) sont ignorés.
 */
export class EventBus {

    protected readonly _listeners = new Set<BusListener>();
    protected _client: Client | null = null;
    protected _schema: string | null = null;
    protected _starting: Promise<void> | null = null;
    protected _stopped = false;
    protected _retryTimer: NodeJS.Timeout | null = null;
    protected _retryDelay: number;

    constructor(protected readonly _options: BusOptions) {
        this._retryDelay = _options.reconnectMinMs ?? 500;
    }

    /** Démarre l'écoute (idempotent) ; résolu quand `LISTEN` est actif */
    public start(): Promise<void> {
        this._stopped = false;
        this._starting ??= this._connect().catch((error: unknown) => {
            this._starting = null;
            this._scheduleReconnect(error);
        });
        return this._starting;
    }

    /** Abonne un écouteur ; renvoie la fonction de désabonnement */
    public subscribe(listener: BusListener): () => void {
        this._listeners.add(listener);
        return () => {
            this._listeners.delete(listener);
        };
    }

    /** Diffusion locale (utilisable par les tests ou pour un signal sans NOTIFY) */
    public emit(message: BusMessage): void {
        for (const listener of [...this._listeners]) {
            try {
                listener(message);
            } catch (error) {
                console.error("Bus listener failed:", error);
            }
        }
    }

    public async stop(): Promise<void> {
        this._stopped = true;
        if (this._retryTimer != null) {
            clearTimeout(this._retryTimer);
            this._retryTimer = null;
        }
        const client = this._client;
        this._client = null;
        this._starting = null;
        this._listeners.clear();
        if (client != null) {
            client.removeAllListeners();
            client.on("error", () => undefined);
            await client.end().catch(() => undefined);
        }
    }

    /** Coupe la connexion d'écoute comme le ferait une panne réseau (tests) */
    public simulateConnectionLoss(): void {
        (this._client as unknown as { connection: { stream: { destroy(): void } } } | null)?.connection.stream.destroy();
    }

    protected async _connect(): Promise<void> {
        const client = new Client({ connectionString: this._options.connectionString });
        const lost = (error?: unknown): void => {
            if (this._client === client) {
                this._client = null;
                this._starting = null;
                client.removeAllListeners();
                client.on("error", () => undefined);
                client.end().catch(() => undefined);
                this._scheduleReconnect(error);
            }
        };
        client.on("error", lost);
        client.on("end", () => lost());
        client.on("notification", (notification) => this._onNotification(notification));
        await client.connect();
        const schema = await client.query<{ schema: string }>(`SELECT current_schema() AS schema`);
        this._schema = schema.rows[0]!.schema;
        await client.query(`LISTEN ${NOTIFY_CHANNEL}`);
        if (this._stopped) {
            await client.end();
            return;
        }
        this._client = client;
        const recovering = this._retryDelay > (this._options.reconnectMinMs ?? 500) || this._hasConnectedBefore;
        this._hasConnectedBefore = true;
        this._retryDelay = this._options.reconnectMinMs ?? 500;
        if (recovering) {
            this.emit({ type: "reconnect" });
        }
    }

    protected _hasConnectedBefore = false;

    protected _scheduleReconnect(error?: unknown): void {
        if (this._stopped || this._retryTimer != null) {
            return;
        }
        (this._options.log ?? console.error)(`Bus san_events : connexion perdue (${error instanceof Error ? error.message : String(error ?? "fin")}), nouvelle tentative dans ${this._retryDelay} ms.`);
        this._retryTimer = setTimeout(() => {
            this._retryTimer = null;
            this.start();
        }, this._retryDelay);
        this._retryTimer.unref();
        this._retryDelay = Math.min(this._retryDelay * 2, this._options.reconnectMaxMs ?? 15_000);
    }

    protected _onNotification(notification: Notification): void {
        if (notification.channel !== NOTIFY_CHANNEL || notification.payload == null) {
            return;
        }
        let payload: Record<string, unknown>;
        try {
            payload = JSON.parse(notification.payload) as Record<string, unknown>;
        } catch {
            return;
        }
        if (payload["schema"] !== this._schema) {
            return;
        }
        delete payload["schema"];
        if (typeof payload["type"] === "string") {
            this.emit(payload as unknown as BusMessage);
        }
    }

}
