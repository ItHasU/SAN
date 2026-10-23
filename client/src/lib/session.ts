import { SyncResponse, EventView } from "@san/shared/src/api/types";
import { ApiError, ViewerApi } from "./api";
import { SseParser } from "./sse";
import { DashboardStore } from "./store";

export interface SessionOptions {
    /** Appelé pour chaque événement reçu en direct (hors chargement initial) */
    onLiveEvent?: (event: EventView) => void;
    /** Délais de reconnexion (ms) : doublés jusqu'au plafond, avec gigue */
    backoffMs?: { initial: number, max: number };
    random?: () => number;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    /** Délai avant d'envoyer un acquittement groupé (ms) */
    ackDelayMs?: number;
    isVisible?: () => boolean;
}

/** Attente interruptible */
function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(done, ms);
        function done(): void {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
        }
        signal.addEventListener("abort", done);
    });
}

/**
 * Cycle de vie du viewer web : enregistrement, capacités, synchronisation,
 * flux SSE lu par `fetch` + `ReadableStream` avec reconnexion (backoff,
 * `Last-Event-ID`), resynchronisation au retour de visibilité ou de réseau,
 * acquittements groupés.
 */
export class ViewerSession {

    protected _abort: AbortController | null = null;
    protected _running = false;
    protected _live = false;
    protected _seen = 0;
    protected _acked = 0;
    protected _ackTimer: ReturnType<typeof setTimeout> | null = null;
    protected readonly _backoff: { initial: number, max: number };
    protected readonly _sleep: (ms: number, signal: AbortSignal) => Promise<void>;

    constructor(protected readonly _api: ViewerApi, public readonly store: DashboardStore, protected readonly _options: SessionOptions = {}) {
        this._backoff = _options.backoffMs ?? { initial: 1000, max: 30_000 };
        this._sleep = _options.sleep ?? defaultSleep;
    }

    /** Démarre (idempotent) : la boucle tourne jusqu'à `stop()` */
    public start(): void {
        if (this._running) {
            return;
        }
        this._running = true;
        this._live = false;
        this._abort = new AbortController();
        document.addEventListener("visibilitychange", this._onVisibility);
        window.addEventListener("online", this._onOnline);
        void this._loop(this._abort.signal);
    }

    public stop(): void {
        this._running = false;
        this._abort?.abort();
        document.removeEventListener("visibilitychange", this._onVisibility);
        window.removeEventListener("online", this._onOnline);
        if (this._ackTimer != null) {
            clearTimeout(this._ackTimer);
            this._ackTimer = null;
        }
    }

    protected readonly _onVisibility = (): void => {
        if (document.visibilityState === "visible") {
            this._flushAck();
            this.resync();
        }
    };

    protected readonly _onOnline = (): void => this.resync();

    /** Coupe le flux courant : la boucle resynchronise puis rouvre le flux sans attendre */
    public resync(): void {
        if (this._running && this._streamAbort != null) {
            this._skipBackoff = true;
            this._streamAbort.abort();
        }
    }

    protected _streamAbort: AbortController | null = null;
    protected _skipBackoff = false;

    protected async _loop(signal: AbortSignal): Promise<void> {
        let delay = this._backoff.initial;
        while (!signal.aborted) {
            const streamAbort = new AbortController();
            this._streamAbort = streamAbort;
            const onStop = (): void => streamAbort.abort();
            signal.addEventListener("abort", onStop);
            try {
                this.store.setConnection("connecting");
                await this._api.ensureRegistered();
                await this._api.putCapabilities();
                await this._syncAll();
                this._live = true;
                const opened = await this._stream(streamAbort.signal);
                if (opened) {
                    delay = this._backoff.initial;
                }
            } catch (error) {
                if (!signal.aborted && !(error instanceof DOMException && error.name === "AbortError")) {
                    // Jamais de jeton dans les journaux : seul le message d'erreur est consigné
                    console.warn("Flux SAN interrompu :", error instanceof Error ? error.message : "erreur");
                }
            } finally {
                signal.removeEventListener("abort", onStop);
                this._streamAbort = null;
            }
            if (signal.aborted) {
                break;
            }
            this.store.setConnection("offline");
            if (this._skipBackoff) {
                this._skipBackoff = false;
                continue;
            }
            const jitter = 0.5 + (this._options.random ?? Math.random)() * 0.5;
            await this._sleep(delay * jitter, signal);
            delay = Math.min(delay * 2, this._backoff.max);
        }
    }

    /** Synchronise jusqu'à épuisement des pages */
    protected async _syncAll(): Promise<void> {
        for (let page = 0; page < 20; page++) {
            const response: SyncResponse = await this._api.sync({ ack: this._acked > 0 ? this._acked : undefined, config_hash: this.store.config == null ? undefined : this._api.configHash });
            const fresh = this.store.applySync(response);
            if (this._live) {
                this._notify(fresh);
            }
            if (!response.has_more) {
                return;
            }
        }
    }

    protected _notify(events: EventView[]): void {
        for (const event of events) {
            this._options.onLiveEvent?.(event);
        }
    }

    /** Lit le flux jusqu'à sa fin ; rend `true` si la connexion a bien été établie */
    protected async _stream(signal: AbortSignal): Promise<boolean> {
        const lastId = this.store.maxEventId > 0 ? String(this.store.maxEventId) : undefined;
        const response = await this._api.events(signal, lastId);
        if (!response.ok || response.body == null) {
            throw new ApiError(response.status, "stream_failed", `Flux SSE refusé (${response.status})`);
        }
        const parser = new SseParser();
        const decoder = new TextDecoder();
        const reader = response.body.getReader();
        this.store.setConnection("live");
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) {
                    return true;
                }
                for (const message of parser.feed(decoder.decode(value, { stream: true }))) {
                    await this._handle(message);
                }
            }
        } finally {
            reader.cancel().catch(() => { /* flux déjà fermé */ });
        }
    }

    protected async _handle(message: { event: string, data: string, id?: string }): Promise<void> {
        const result = this.store.applyMessage(message);
        if (result.configHash != null && result.configHash !== this._api.configHash) {
            const view = await this._api.getConfig();
            this.store.setConfig(view.config);
        }
        if (result.event != null) {
            this._notify([result.event]);
        }
    }

    //#region Acquittement --------------------------------------------------------

    /** L'événement a été affiché ou lu : l'acquittement partira groupé (curseur, donc « jusqu'à cet identifiant ») */
    public markSeen(eventId: number): void {
        this._seen = Math.max(this._seen, eventId);
        if (this._seen <= this._acked || this._ackTimer != null) {
            return;
        }
        this._ackTimer = setTimeout(() => this._flushAck(), this._options.ackDelayMs ?? 800);
    }

    protected _flushAck(): void {
        if (this._ackTimer != null) {
            clearTimeout(this._ackTimer);
            this._ackTimer = null;
        }
        const visible = (this._options.isVisible ?? (() => document.visibilityState !== "hidden"))();
        if (!visible || this._seen <= this._acked) {
            return;
        }
        const target = this._seen;
        this._api.ack(target).then(() => {
            this._acked = Math.max(this._acked, target);
        }).catch(() => { /* réessayé au prochain événement vu */ });
    }

    //#endregion

}
