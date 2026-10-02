# `assets/pdfjs/`

pdf.js, as an app asset rather than part of the JavaScript bundle. Read once, inside
the off-screen WebView in `src/components/PdfBridge.tsx`, so that the statement
importer can read a PDF's text layer without the app ever fetching anything.

## Nothing here is committed

`*.pdfjs` is gitignored. The two files are about 2.4 MB together, npm can fetch them,
and a vendored copy would sit in every clone and drift from the version pinned in
`package.json` with nothing to notice. They are written by:

```bash
npm run bundle-pdfjs
```

`scripts/bundle-pdfjs.mjs` copies them out of `node_modules/pdfjs-dist`, and it also
runs from `postinstall`, so a fresh `npm install` normally leaves nothing to do.

When `pdfjs-dist` is not installed — `npm install --omit=dev`, or an install that has
not happened yet — the same script writes `scripts/pdfjs-placeholder.js` to both paths
instead of failing. **PDF import is then unavailable and the import screen says so up
front. CSV import is unaffected** — it is the same importer with a different reader in
front of it, and none of pdf.js is involved.

## Why a placeholder rather than nothing

Metro resolves asset imports when it builds the bundle. `pdfjs-shim.ts` imports both
paths at the top level, so if the files are absent the *app does not start* — which
turns "one feature needs a build step" into "nothing works, with a resolution error
that does not mention PDFs". With a placeholder present the bundle builds, the shim
notices at runtime that what it read is far too short, and the failure arrives as a
sentence naming the command above.

## Why `.pdfjs` and not `.js`

So that Metro treats them as assets. A `.js` file under `assets/` is a source module,
and Metro would bundle two megabytes of PDF parser into the app's JavaScript — loaded
at startup, for one screen, inside a WebView that cannot see the bundle anyway. The
extension is registered in `metro.config.js` and typed in `src/types/assets.d.ts`.
The contents are ordinary JavaScript; only the name differs.

## Why the version is pinned to 3.11.174

It is the last `pdfjs-dist` with a UMD build, which is a classic script that assigns
`window.pdfjsLib`. 4.x and later are ES-modules-only, and a module script in a
document with no real origin has to come from a blob URL, where an opaque origin is
grounds for refusal. The pdf.js API the shim uses did not change; the way it loads
did. `src/lib/statement/pdfjs-shim.ts` explains this at length — read its header
before changing the version.
