import { AppTypes } from "@san/shared/src/app/types";
import { HelloPage } from "./pages/hello/hello.page";

export type AppPages = {
    "hello": HelloPage;
};

export interface ClientAppTypes extends AppTypes {
    pages: AppPages;
    /** Aucune fonction de modèle : SAN passe par l'API REST */
    model: {};
}
