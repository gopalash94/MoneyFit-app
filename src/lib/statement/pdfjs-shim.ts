/**
 * The document that runs inside the WebView: pdf.js, plus the forty lines that talk
 * to it.
 *
 * This file builds one HTML string. Nothing in it is fetched — pdf.js and its worker
 * are read out of the app's own asset table, the same place the launcher icon comes
 * from, and the page that loads them references no URL at all. The app's claim that
 * `/ask` is the only thing that leaves the phone stays true with the PDF importer
 * switched on, and that is a requirement rather than a nicety: a CDN `<script src>`
 * here would mean uploading nothing but still announcing, to a third party, every
 * time you looked at a bank statement.
 *
 * ## Why the sources travel as string literals
 *
 * Both files are embedded as JavaScript string literals and then evaluated, rather
 * than written as `<script>` bodies. The reason is narrow and worth stating, because
 * the obvious version looks simpler and fails rarely enough to ship: HTML has no
 * escaping inside a `<script>` element, so a minified bundle that happens to contain
 * the six characters `</scr` + `ipt` anywhere — in a regex, in a string, in a
 * comment that survived minification — silently ends the script early and leaves the
 * rest of pdf.js as text on the page. `JSON.stringify` plus an escape of every `<`
 * removes that class of failure entirely, and this is a path that cannot be tested
 * here, so removing a class of failure is worth more than the lines it costs.
 *
 * The evaluation is `(0, eval)(…)`, which runs in global scope — pdf.js's UMD
 * wrapper assigns `globalThis.pdfjsLib` and needs real global scope to do it, which
 * `new Function` would not give it. This is the one `eval` in the project and it is
 * evaluating a file that shipped inside the APK, in a sandbox with no network and no
 * access to anything, having never touched the network. It is not a remote-code path
 * and nothing about it is dynamic: the same bytes every launch.
 *
 * ## Why pdf.js is pinned to the 3.x line
 *
 * `scripts/bundle-pdfjs.mjs` copies from `pdfjs-dist@3.11.174`, the last release
 * that ships a UMD build (`legacy/build/pdf.min.js`). A UMD bundle loads as a
 * classic script and announces itself on `window`. Everything from 4.x on is
 * ES-modules-only, which inside a document with no real origin means a dynamic
 * `import()` of a blob URL — and module scripts, unlike classic ones, are subject to
 * fetch rules that treat an opaque origin as a reason to refuse. The 3.x API this
 * uses (`getDocument`, `numPages`, `getPage`, `getTextContent`, `item.transform`,
 * `item.width`, `PasswordException.code`) is identical in 4.x and 5.x, so the pin
 * costs nothing but is a pin, and `scripts/bundle-pdfjs.mjs` says so too.
 *
 * ## What the shim is not allowed to do
 *
 * It copies four fields per text run — `str`, `transform[4]`, `transform[5]`,
 * `width` — and posts them. It does not bucket rows, does not sort, does not count
 * characters, does not decide anything about columns, and contains no sentence a
 * person will ever read. All of that is in `pdf.ts`, in TypeScript, where it can be
 * diffed against the web app's copy. If a future change is tempted to move work in
 * here because it would be convenient, the thing being given up is the only
 * verification this path has.
 *
 * Flattening is the specific temptation to refuse. `items.map(i => i.str).join(" ")`
 * would produce something that looks like a statement and has thrown away the only
 * evidence of which number was a withdrawal and which was a balance. Positions, or
 * nothing.
 */

import * as FileSystem from "expo-file-system/legacy";
import { Asset } from "expo-asset";

import PDFJS_LIB_ASSET from "../../../assets/pdfjs/pdf.min.pdfjs";
import PDFJS_WORKER_ASSET from "../../../assets/pdfjs/pdf.worker.min.pdfjs";

/**
 * Below this, the asset is the placeholder that is committed to the repository
 * rather than the real thing. pdf.js minified is about 1.1 MB and its worker about
 * 1.3 MB, so 100,000 characters cannot be either.
 *
 * This check exists because of how the failure would otherwise present: a
 * placeholder loads, `window.pdfjsLib` is undefined, and the user is told the PDF
 * reader failed to start — which is true and useless. Checking the length names the
 * actual problem and the one command that fixes it.
 */
const MIN_SOURCE_CHARS = 100_000;

/**
 * A fake origin for the document, so that it has one.
 *
 * `loadDataWithBaseURL` with no base URL gives the page an opaque origin, and an
 * opaque origin is where blob URLs, `Worker` construction and module scripts start
 * behaving differently from a browser — which is exactly the kind of difference that
 * cannot be discovered without a device. Giving it a real-looking origin makes the
 * sandbox behave like the browser pdf.js is written for.
 *
 * `.invalid` is reserved by RFC 2606 and guaranteed never to resolve, so this is an
 * origin that exists as far as the DOM is concerned and cannot exist as far as the
 * network is concerned. Nothing in the page references it; `originWhitelist={[]}` on
 * the WebView blocks navigation to it regardless.
 */
export const SHIM_BASE_URL = "https://moneyfit.invalid/";

/**
 * Embeds a JavaScript source file as a JavaScript string literal that is safe to put
 * inside an HTML `<script>` element.
 *
 *   - `JSON.stringify` handles quotes, backslashes, newlines and control characters.
 *   - Replacing every `<` with its backslash-u escape makes the characters that close
 *     a script element unrepresentable in the output, which is the only way a string
 *     literal can escape the element it sits in.
 *   - U+2028 and U+2029 are line terminators in JavaScript but not in JSON, so
 *     `JSON.stringify` leaves them raw and they would break the literal. Modern
 *     engines allow them unescaped inside strings; older ones do not, and escaping
 *     them is free.
 *
 * The two line separators are matched through a regex built with `fromCharCode`
 * rather than written out, so that every byte of this file stays ASCII. Written as
 * themselves they are invisible in an editor and a diff; written as backslash-u
 * escapes inside a regex literal they are one well-meaning "normalise unicode
 * escapes" autofix away from becoming themselves. Neither is a sound way to store the
 * one thing here whose whole job is to survive being copied around.
 */
const LINE_SEPARATORS = new RegExp("[" + String.fromCharCode(0x2028, 0x2029) + "]", "g");

function literal(source: string): string {
  return JSON.stringify(source)
    .replace(/</g, "\\u003c")
    .replace(LINE_SEPARATORS, (c) => (c.charCodeAt(0) === 0x2028 ? "\\u2028" : "\\u2029"));
}

/**
 * Reads one bundled asset as text.
 *
 * `downloadAsync()` is what makes this work in a release build: a bundled asset
 * lives inside the APK, where `readAsStringAsync` cannot reach it, and
 * `downloadAsync` copies it out to the cache directory and sets `localUri` to a
 * `file://` path. In development it fetches the same file from the Metro server
 * instead. Either way `localUri` is a readable file afterwards, and if it is not,
 * that is said rather than guessed at.
 */
async function assetText(mod: number, name: string): Promise<string> {
  const asset = Asset.fromModule(mod);
  await asset.downloadAsync();
  if (!asset.localUri) {
    throw new Error(`assets/pdfjs/${name} could not be unpacked from the app.`);
  }

  const source = await FileSystem.readAsStringAsync(asset.localUri, {
    encoding: FileSystem.EncodingType.UTF8,
  });

  if (source.length < MIN_SOURCE_CHARS) {
    throw new Error(
      `assets/pdfjs/${name} is a placeholder, not pdf.js — it is ${source.length} characters and the real file is over a million. Run "npm run bundle-pdfjs" to copy it out of node_modules, then rebuild.`,
    );
  }

  return source;
}

/**
 * The shim itself: ES5, no template literals, no `${`, no backticks, because it is
 * embedded in a template literal below and the next person to edit it should not
 * have to think about that. No imports and no build step — it is a string.
 *
 * Pages are read one at a time through a promise chain rather than with
 * `Promise.all`, for two reasons: a forty-page statement does not hold forty pages
 * of glyphs in memory at once, and `pages` ends up in page order, which is what
 * `pdf.ts` assumes when it walks the array.
 */
const SHIM_JS = `
(function () {
  "use strict";

  function start() {
    var RN = window.ReactNativeWebView;

    function send(obj) {
      RN.postMessage(JSON.stringify(obj));
    }

    function fatal(message) {
      send({ type: "fatal", message: message });
    }

    // pdf.js and its worker, evaluated in global scope. The UMD wrappers assign
    // window.pdfjsLib and window.pdfjsWorker respectively.
    try {
      (0, eval)(window.__MF_PDFJS__);
    } catch (e) {
      fatal("pdf.js could not be loaded: " + (e && e.message ? e.message : "unknown error") + ".");
      return;
    }
    if (!window.pdfjsLib || typeof window.pdfjsLib.getDocument !== "function") {
      fatal("pdf.js loaded but did not start.");
      return;
    }

    // Two routes to the worker, because which one is available depends on the
    // Android System WebView underneath and that is not knowable from here.
    //
    //   1. Evaluating the worker source in the page defines window.pdfjsWorker,
    //      which is the global pdf.js looks for when it runs the worker on the main
    //      thread. Harmless if it is never used.
    //   2. A blob URL in GlobalWorkerOptions.workerSrc, which pdf.js prefers: it
    //      constructs a real Worker from it, and if the WebView refuses, its own
    //      fallback loads the same blob as a script and finds route 1 waiting.
    //
    // Statements are small and this is not a rendering pipeline, so a main-thread
    // worker costs a second at most. Neither route touches the network.
    try {
      (0, eval)(window.__MF_WORKER__);
    } catch (e) {
      // Route 2 may still work. Nothing to report yet.
    }
    try {
      var blob = new Blob([window.__MF_WORKER__], { type: "application/javascript" });
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
    } catch (e) {
      if (!window.pdfjsWorker) {
        fatal("the PDF worker could not be prepared: " + (e && e.message ? e.message : "unknown error") + ".");
        return;
      }
    }

    // Two megabytes of source, no longer needed. Released before the first file
    // arrives rather than after, because the file is itself large.
    window.__MF_PDFJS__ = null;
    window.__MF_WORKER__ = null;

    function toBytes(base64) {
      var raw = atob(base64);
      var out = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
      return out;
    }

    function readPage(doc, p, pages) {
      return function () {
        return doc.getPage(p).then(function (page) {
          return page.getTextContent().then(function (content) {
            var items = [];
            var list = content && content.items ? content.items : [];
            for (var i = 0; i < list.length; i++) {
              var it = list[i];
              // TextMarkedContent entries share the array and have no str.
              if (!it || typeof it.str !== "string") continue;
              if (!it.str.trim()) continue;
              var tr = it.transform;
              if (!tr || tr.length < 6) continue;
              items.push({ str: it.str, x: tr[4], y: tr[5], width: it.width || 0 });
            }
            pages.push({ page: p, items: items });
            try {
              page.cleanup();
            } catch (e) {
              // Reclaiming memory early is an optimisation, not a step.
            }
          });
        });
      };
    }

    function parse(msg) {
      var id = msg.id;
      var opened = null;

      window.pdfjsLib
        .getDocument({
          data: toBytes(msg.base64),
          password: msg.password || undefined,
          isEvalSupported: false,
          useSystemFonts: false,
          disableFontFace: true,
        })
        .promise.then(function (doc) {
          opened = doc;
          var pages = [];
          var chain = Promise.resolve();
          for (var p = 1; p <= doc.numPages; p++) chain = chain.then(readPage(doc, p, pages));
          return chain.then(function () {
            send({ type: "result", id: id, ok: true, page_count: doc.numPages, pages: pages });
          });
        })
        .catch(function (err) {
          // name, code and message, untranslated. pdf.ts owns every sentence.
          send({
            type: "result",
            id: id,
            ok: false,
            error: {
              name: err && err.name ? String(err.name) : "",
              code: err && typeof err.code === "number" ? err.code : undefined,
              message: err && err.message ? String(err.message) : "",
            },
          });
        })
        .then(function () {
          if (!opened) return;
          try {
            opened.destroy();
          } catch (e) {
            // Nothing is held across calls either way.
          }
        });
    }

    function onMessage(event) {
      var msg = null;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      if (!msg || msg.type !== "parse" || typeof msg.id !== "number") return;
      try {
        parse(msg);
      } catch (e) {
        send({
          type: "result",
          id: msg.id,
          ok: false,
          error: { name: "", message: e && e.message ? String(e.message) : "unknown error" },
        });
      }
    }

    // Android delivers postMessage to document, iOS to window. Both are registered
    // so neither platform is a special case, and both before "ready" is sent so a
    // file cannot arrive before there is anything listening for it.
    document.addEventListener("message", onMessage);
    window.addEventListener("message", onMessage);
    send({ type: "ready" });
  }

  // window.ReactNativeWebView is installed by the host, and on Android that has
  // been observed to land after the page's own scripts run. Waiting beats racing;
  // giving up after five seconds beats polling forever, and the host has its own
  // timeout either way.
  if (window.ReactNativeWebView) {
    start();
    return;
  }
  var tries = 0;
  var waiting = setInterval(function () {
    if (window.ReactNativeWebView) {
      clearInterval(waiting);
      start();
    } else if (++tries > 100) {
      clearInterval(waiting);
    }
  }, 50);
})();
`;

/**
 * Builds the page. Called once per app launch, from `PdfBridge`'s mount effect.
 *
 * Throws rather than returning a broken document: the caller turns the message into
 * the bridge's broken state, which the import screen reads so it can say "PDF
 * reading is unavailable, import a CSV instead" before a file is picked rather than
 * after a long wait.
 */
export async function buildShimHtml(): Promise<string> {
  const [lib, worker] = await Promise.all([
    assetText(PDFJS_LIB_ASSET, "pdf.min.pdfjs"),
    assetText(PDFJS_WORKER_ASSET, "pdf.worker.min.pdfjs"),
  ]);

  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>pdf</title></head>
<body>
<script>window.__MF_PDFJS__ = ${literal(lib)};</script>
<script>window.__MF_WORKER__ = ${literal(worker)};</script>
<script>${SHIM_JS}</script>
</body>
</html>`;
}
