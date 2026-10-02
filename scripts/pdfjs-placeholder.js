// PLACEHOLDER. This is not pdf.js.
//
// `scripts/bundle-pdfjs.mjs` writes this file to both assets/pdfjs/pdf.min.pdfjs and
// assets/pdfjs/pdf.worker.min.pdfjs when node_modules/pdfjs-dist is not installed, so
// that the two asset paths the app imports always exist. Install devDependencies and
// run it again to get the real thing:
//
//     npm install
//     npm run bundle-pdfjs
//
// While this is in place, PDF statement import is unavailable and the import screen
// says so before a file is picked. CSV import is unaffected — it is the same importer
// with a different reader in front of it, and none of pdf.js is involved.
//
// Something has to be here because Metro resolves asset imports when it builds the
// bundle: with these paths missing, the app does not start at all, and the error names
// a module rather than a missing build step. With a placeholder present the bundle
// builds, src/lib/statement/pdfjs-shim.ts notices that what it read is far too short,
// and the failure arrives as one sentence naming the command above.
throw new Error("assets/pdfjs: placeholder, not pdf.js. Run: npm run bundle-pdfjs");
