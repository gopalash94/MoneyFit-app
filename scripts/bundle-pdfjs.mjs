// Copies pdf.js out of node_modules and into assets/pdfjs/ as two .pdfjs files.
//
//   npm run bundle-pdfjs
//
// It also runs from `postinstall`, so a fresh clone needs no extra step. Run it again
// by hand after changing the `pdfjs-dist` version.
//
// ## Why this script exists at all
//
// The two files it writes are about 2.4 MB of minified JavaScript, and they are
// gitignored. Committing a vendored copy of something npm can fetch means carrying it
// in every clone and every diff, and letting the version actually in use drift away
// from the one pinned in `package.json` with nothing to notice.
//
// But the paths cannot simply be absent either, because Metro resolves asset imports
// when it builds the bundle: a missing `assets/pdfjs/pdf.min.pdfjs` is not a broken PDF
// importer, it is a resolution error that stops the entire app from starting and does
// not mention PDFs. So when `pdfjs-dist` is not installed this script writes
// `scripts/pdfjs-placeholder.js` to both paths instead of failing.
// `src/lib/statement/pdfjs-shim.ts` length-checks what it reads at runtime and names
// this script if it finds a placeholder, which turns the whole thing into one legible
// sentence on the import screen with the CSV path still working.
//
// ## Why the version is pinned, and pinned to 3.x
//
// `pdfjs-dist` is pinned to 3.11.174 in devDependencies — the last release with a UMD
// build. A UMD bundle is a classic script that assigns `window.pdfjsLib`, which is what
// `pdfjs-shim.ts` evaluates and then looks for. Everything from 4.x on ships ES modules
// only, and a module script inside a WebView document that has no real origin has to be
// loaded through a blob URL, where fetch rules treat an opaque origin as grounds to
// refuse. The API the shim uses is unchanged in 4.x and 5.x, so this pin is about how
// the file loads and nothing else. Moving off it means rewriting the shim's loader, not
// just bumping a number.
//
// `legacy/` rather than the default build: it is transpiled further down, and the
// Android System WebView on an old phone is the oldest browser this app will meet.
//
// ## Why the extension is .pdfjs
//
// So that Metro treats it as an asset instead of a source module — see the comment in
// `metro.config.js`. The contents are ordinary JavaScript.

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "assets", "pdfjs");

const FILES = [
  { from: join("legacy", "build", "pdf.min.js"), to: "pdf.min.pdfjs" },
  { from: join("legacy", "build", "pdf.worker.min.js"), to: "pdf.worker.min.pdfjs" },
];

// Anything smaller than this is not pdf.js. The same threshold the shim applies at
// runtime, checked here so the problem is found at install time instead.
const MIN_BYTES = 100_000;

const src = join(root, "node_modules", "pdfjs-dist");
mkdirSync(outDir, { recursive: true });

let installed = true;
try {
  statSync(src);
} catch {
  installed = false;
}

if (!installed) {
  // Not an error worth failing an install over: `npm install --omit=dev` legitimately
  // has no pdfjs-dist. Writing the placeholder to both paths keeps the app bundling,
  // and the shim's runtime length check is what tells anyone who then tries a PDF.
  const placeholder = join(root, "scripts", "pdfjs-placeholder.js");
  for (const file of FILES) copyFileSync(placeholder, join(outDir, file.to));
  console.warn(
    "bundle-pdfjs: node_modules/pdfjs-dist is not installed, so assets/pdfjs/ now holds placeholders.\n" +
      "              PDF statement import will be unavailable; CSV import is unaffected.\n" +
      "              Run `npm install` (including devDependencies), then `npm run bundle-pdfjs`.",
  );
  process.exit(0);
}

const version = JSON.parse(readFileSync(join(src, "package.json"), "utf8")).version;

for (const file of FILES) {
  const from = join(src, file.from);

  let size;
  try {
    size = statSync(from).size;
  } catch {
    console.error(
      `bundle-pdfjs: pdfjs-dist@${version} has no ${file.from}.\n` +
        "              Only the 3.x line ships a UMD build under legacy/build/. If the version in\n" +
        "              package.json was changed to 4.x or later, src/lib/statement/pdfjs-shim.ts has\n" +
        "              to be reworked to load ES modules before that can work — read its header first.",
    );
    process.exit(1);
  }

  if (size < MIN_BYTES) {
    console.error(`bundle-pdfjs: ${from} is only ${size} bytes, which cannot be right. Reinstall pdfjs-dist.`);
    process.exit(1);
  }

  const to = join(outDir, file.to);
  copyFileSync(from, to);

  // The digest is printed so that two machines can be compared without diffing two
  // megabytes of minified source — which is the only practical way to answer "is the
  // file in this build the one I think it is?".
  const digest = createHash("sha256").update(readFileSync(to)).digest("hex").slice(0, 16);
  console.log(`bundle-pdfjs: assets/pdfjs/${file.to}  ${(size / 1024).toFixed(0)} KB  sha256:${digest}`);
}

console.log(`bundle-pdfjs: done, from pdfjs-dist@${version}.`);
