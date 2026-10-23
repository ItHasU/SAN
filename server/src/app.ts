import { RequestOptions } from "@dagda/server/src/api";
import { AbstractServerApp } from "@dagda/server/src/app";
import { Migration } from "@dagda/server/src/sql/migrations";
import { UserInfo } from "@dagda/shared/src/auth/types";
import { Data } from "@dagda/shared/src/entities/tools/adapters";
import { AppTypes } from "@san/shared/src/app/types";
import { AppContexts } from "@san/shared/src/entities/contexts";
import { AppEntityTypes } from "@san/shared/src/entities/types";
import { Express, Request, Response } from "express";
import { createApiRouter, ApiRouter } from "./san/api";
import { MediaTools } from "./san/audio/ffmpeg";
import { AudioService } from "./san/audio/service";
import { FakeTts, PiperHttpTts, TtsEngine } from "./san/audio/tts";
import { TtsQueue } from "./san/audio/tts-queue";
import { EventBus } from "./san/bus";
import { readSanConfig, SanConfig } from "./san/config";
import { SAN_MIGRATIONS } from "./san/migrations";
import { startPeriodicTasks } from "./san/purge";

/** Préfixe de l'API REST (SPEC §10) */
export const API_PREFIX = "/api/v1";

export class ServerApp extends AbstractServerApp<AppTypes> {

    public readonly sanConfig: SanConfig;
    protected readonly _api: ApiRouter;
    protected readonly _bus: EventBus;
    protected readonly _audio: AudioService;
    protected readonly _tts: TtsQueue;
    protected _stopPeriodicTasks: (() => void) | null = null;

    /**
     * @param sanOverrides valeurs de configuration SAN qui l'emportent sur l'environnement (tests)
     */
    public constructor(
        ...args: [...ConstructorParameters<typeof AbstractServerApp<AppTypes>>, sanOverrides?: Partial<SanConfig>]
    ) {
        const sanOverrides = args.length > 6 ? args.pop() as Partial<SanConfig> : undefined;
        super(...(args as ConstructorParameters<typeof AbstractServerApp<AppTypes>>));
        this.sanConfig = readSanConfig(process.env, sanOverrides);
        this._app.set("trust proxy", this.sanConfig.trustProxy);

        this._bus = new EventBus({ connectionString: this._config.dbURL });
        const cfg = this.sanConfig;
        const media = new MediaTools({ ffmpegPath: cfg.ffmpegPath, ffprobePath: cfg.ffprobePath, timeoutMs: cfg.mediaTimeoutMs, concurrency: cfg.mediaConcurrency });
        this._audio = new AudioService(this._db, media, cfg.dataDir);
        const engine: TtsEngine = cfg.ttsEngine === "piper" ? new PiperHttpTts(cfg.ttsUrl!, cfg.ttsTimeoutMs) : new FakeTts(media);
        this._tts = new TtsQueue(this._db, this._audio, engine, cfg.maxClipDurationS);
        this._api = createApiRouter({
            db: this._db,
            bus: this._bus,
            audio: this._audio,
            tts: this._tts,
            config: this.sanConfig,
            resolveAdmin: (req, res) => this._resolveAdmin(req, res),
            audit: (userId, action, details) => this._recordAudit(userId, "action", `admin.${action}`, details)
        });
        this._mountApi(this._api);
    }

    /** @inheritdoc */
    protected override _migrations(): Migration[] {
        return SAN_MIGRATIONS;
    }

    /** SAN ne charge aucune entité Dagda : l'API passe par /api/v1 */
    protected override async _fetch(_context: AppContexts, _request: RequestOptions): Promise<Data<AppEntityTypes>> {
        return {};
    }

    /** L'application Express (tests : `http.createServer(app.handler)`) */
    public get handler(): Express {
        return this._app;
    }

    public override async listen(): Promise<void> {
        await super.listen();
        await this._bus.start();
        // Reprise des clips TTS restés `pending`
        this._tts.resume();
        this._stopPeriodicTasks = startPeriodicTasks(this._db, this.sanConfig);
    }

    /** Arrête les tâches périodiques et ferme le pool PostgreSQL */
    public async close(): Promise<void> {
        this._stopPeriodicTasks?.();
        this._stopPeriodicTasks = null;
        this._api.hub.closeAll();
        await this._tts.stop();
        await this._bus.stop();
        await this._db.close();
    }

    /** Stockage audio et file TTS (tests) */
    public get audio(): AudioService {
        return this._audio;
    }

    public get tts(): TtsQueue {
        return this._tts;
    }

    /** Bus interne (tests) */
    public get bus(): EventBus {
        return this._bus;
    }

    /** Limiteurs de débit en mémoire (tests) */
    public get limiters(): ApiRouter["limiters"] {
        return this._api.limiters;
    }

    /**
     * Monte `/api/v1` sur le routeur public de Dagda (`_publicRouter`), placé
     * avant les parseurs de corps globaux et la porte de session : un jeton
     * Bearer n'y rencontre donc jamais la redirection vers /login. Les routes
     * `/admin` et `/web` rejouent elles-mêmes l'analyseur de session de Dagda
     * (`_resolveAdmin`).
     */
    protected _mountApi(api: ApiRouter): void {
        this._publicRouter.use(API_PREFIX, api.router);
    }

    /** Session administrateur Dagda de la requête, ou null */
    protected async _resolveAdmin(req: Request, res: Response): Promise<UserInfo | null> {
        await new Promise<void>((resolve, reject) => {
            this._auth.sessionParser(req, res, (error?: unknown) => error == null ? resolve() : reject(error));
        });
        // `session` est typé par la copie d'express de Dagda, pas par celle de SAN
        const userId = (req as unknown as { session?: { userId?: number } }).session?.userId;
        if (userId == null) {
            return null;
        }
        const user = await this._users.getById(userId);
        return user != null && user.enabled ? user : null;
    }

}
