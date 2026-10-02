/**
 * Ambient types for the non-standard asset extensions Metro is told about in
 * `metro.config.js`.
 *
 * Metro resolves `import x from "./thing.pdfjs"` to a module id — the same number
 * `require("./icon.png")` gives — which `Asset.fromModule()` turns into something
 * with a local file URI. TypeScript knows nothing about that, so without this file
 * the import is an error ("cannot find module or its corresponding type
 * declarations") and `npm run typecheck` fails on a project that bundles perfectly.
 *
 * **`.pdfjs` is pdf.js's own JavaScript, renamed.** Not because the extension means
 * anything, but because it must *not* mean anything: a file called `pdf.min.js`
 * sitting under `assets/` would be picked up by Metro as a source module and bundled
 * into the app's JavaScript, which is the one thing this arrangement exists to
 * avoid. Giving it an extension Metro only knows as an asset is what keeps two
 * megabytes of parser out of the bundle and in the APK's asset table, where it is
 * read once, inside the WebView, by the only thing that needs it.
 *
 * `number` rather than `any` on purpose: it is a module id and nothing else should
 * be done with it.
 */

declare module "*.pdfjs" {
  const asset: number;
  export default asset;
}
