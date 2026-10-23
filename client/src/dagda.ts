import { ClientDagda } from "@dagda/client/src/app/dagda";
import { ClientAppTypes } from "./services";

/**
 * The running application's services, viewed through this application's own
 * type (FEATURES §0) — same instance as the framework's own `dagda`
 * (`@dagda/client/src/app/dagda`), just narrowed.
 *
 * The narrowing is not cosmetic: the framework's own export stays typed on
 * its own loose `ClientAppTypes` (`contexts: unknown`, from
 * `@dagda/client/src/app/index.ts`), so `entities.getHandler().fetch(...)`
 * compiles against *any* shape there. Reached through this file instead, a
 * page fetching the `project` context — the one with options (ROADMAP
 * tranche 5, EurekAI risk #1) — gets `projectId` checked at compile time:
 * forget it, and `npm run typecheck` catches it before a reviewer has to.
 *
 * Nothing of this application's own hangs off it (no service like
 * MQTTToolbox2's `mqtt`), so this stays a type-only wrapper around
 * `ClientDagda` rather than a subclass — `bootstrap/server/src/dagda.ts` is
 * the sibling to read when an application *does* have one.
 */
export let dagda: ClientDagda<ClientAppTypes>;

/** @internal set by `index.ts`'s `buildDagda`, synchronously with the framework's own `_setDagda` */
export function _setDagda(instance: ClientDagda<ClientAppTypes>): void {
    dagda = instance;
}
