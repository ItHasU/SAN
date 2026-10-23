/**
 * Component templates are plain HTML files imported as strings.
 *
 * Historically they were read through `require("./x.html").default`, which only
 * works inside a webpack bundle and made every component untestable in isolation.
 * A standard `import` works with webpack (html-loader), with tsc, and with the
 * test runner, which resolves it through its own loader.
 *
 * Any package holding client-side components needs a copy of this declaration.
 * See `@dagda/client/src/templates.d.ts` for the framework's own copy.
 */
declare module "*.html" {
    const content: string;
    export default content;
}
