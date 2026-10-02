// Expo's defaults, plus one asset extension.
//
// The schema and the eleven analytics views are TypeScript template strings rather
// than .sql assets, so nothing here is needed for those. The one thing that does need
// Metro's help is pdf.js: `assets/pdfjs/*.pdfjs` is pdf.js's own JavaScript, renamed
// so that Metro treats it as an *asset* instead of a source module.
//
// That rename is the whole trick, and the reason is worth keeping written down. A file
// called `pdf.min.js` under `assets/` would be resolved as a module and bundled into
// the app's JavaScript — two megabytes of PDF parser loaded at startup by every screen,
// to be used by one of them, inside a WebView that cannot see the bundle anyway. As an
// asset it sits in the APK's asset table instead, is read once as text by
// `src/lib/statement/pdfjs-shim.ts`, and costs nothing until a PDF is imported.
//
// `src/types/assets.d.ts` is the matching half of this: it tells TypeScript that
// importing a `.pdfjs` file yields the module id Metro gives it.
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

config.resolver.assetExts.push("pdfjs");

module.exports = config;
