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
import { readSanConfig, SanConfig } from "./san/config";
import { SAN_MIGRATIONS } from "./san/migrations";
import { startPeriodicTasks } from "./san/purge";

/** Préfixe de l'API REST (SPEC §10) */
export const API_PREFIX = "/api/v1";

export class ServerApp extends AbstractServerApp<AppTypes> {

    public readonly sanConfig: SanConfig;
    protected readonly _api: ApiRouter;
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

        this._api = createApiRouter({
            db: this._db,
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
        this._stopPeriodicTasks = startPeriodicTasks(this._db, this.sanConfig);
    }

    /** Arrête les tâches périodiques et ferme le pool PostgreSQL */
    public async close(): Promise<void> {
        this._stopPeriodicTasks?.();
        this._stopPeriodicTasks = null;
        await this._db.close();
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
