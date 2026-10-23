/**
 * What the global setup provides to the specs.
 *
 * The framework declares the same thing next to its own fixture, but a module
 * augmentation is bound to the `vitest` package the declaring file resolves —
 * and the framework, being linked from another repository, resolves its own.
 * The two are the same version and still distinct as far as TypeScript is
 * concerned, so the declaration has to be repeated here.
 */
declare module "vitest" {
    interface ProvidedContext {
        /** False when no PostgreSQL server answered, so the tests that need one are skipped */
        databaseAvailable: boolean;
    }
}

export { };
