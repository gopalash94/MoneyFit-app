/**
 * The off-screen WebView that pdf.js lives in.
 *
 * Mounted once, from the root layout, for the life of the app. Not mounted when a
 * file is picked, which is the arrangement that looks tidier and does not work:
 * loading two megabytes of pdf.js takes a moment, and that moment would land exactly
 * when somebody has just chosen a statement and is waiting. Mounting at startup means
 * the bridge is almost always already warm by the time it is asked for anything, and
 * `requestPdfText` waits rather than failing when it is not.
 *
 * **It renders nothing.** A one-pixel view at `position: "absolute"` with
 * `opacity: 0`, `pointerEvents: "none"` and a negative offset, so it cannot be seen,
 * cannot be touched, and cannot change the layout of the screen it sits behind. Zero
 * width and height are avoided on purpose — a WebView with no box has, on some
 * Android versions, declined to run scripts at all.
 *
 * **It cannot take the app down with it.** Every outcome is funnelled into the
 * bridge's state rather than thrown: a missing asset, a WebView that fails to load, a
 * render process the system killed under memory pressure. The worst case is that
 * `pdfReaderState().broken` becomes true, the import screen says PDF reading is
 * unavailable and offers the CSV path, and the rest of the app does not notice. That
 * ordering matters because this component is mounted in the root layout, where a
 * throw is not a broken feature but a blank app.
 *
 * All the protocol is in `src/lib/statement/pdf-bridge.ts`. This file is wiring: hand
 * over `postMessage`, feed `onMessage` back, and report the three ways the view
 * itself can fail.
 */

import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { attachBridge, markBroken, receiveMessage } from "@/lib/statement/pdf-bridge";
import { SHIM_BASE_URL, buildShimHtml } from "@/lib/statement/pdfjs-shim";

export function PdfBridge() {
  const [html, setHtml] = useState<string | null>(null);
  const view = useRef<WebView | null>(null);

  // Build the document once. The two assets are read off disk and concatenated into
  // one string, which is slow enough to be worth not doing during a render and fast
  // enough not to need reporting on.
  useEffect(() => {
    let live = true;
    buildShimHtml()
      .then((built) => {
        if (live) setHtml(built);
      })
      .catch((err: unknown) => {
        if (!live) return;
        // The honest failure: the pdf.js asset is missing or is the committed
        // placeholder. `assetText` already wrote a sentence naming the fix, so it is
        // passed through rather than summarised.
        markBroken((err as Error)?.message ?? "The PDF reader could not be prepared.");
      });
    return () => {
      live = false;
    };
  }, []);

  // Registered only once there is a document to talk to, so that `attachBridge`'s
  // "loading" state never describes a WebView that was never going to exist. The
  // cleanup rejects anything still in flight — see `attachBridge`.
  useEffect(() => {
    if (!html) return;
    return attachBridge((message) => {
      const target = view.current;
      if (!target) throw new Error("the reader is no longer on screen");
      target.postMessage(message);
    });
  }, [html]);

  if (!html) return null;

  return (
    <View style={hidden} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <WebView
        ref={view}
        // The source is handed over as text with a base URL that cannot resolve. No
        // `uri`, so there is nothing to navigate to, and `originWhitelist={[]}`
        // refuses every navigation the page could attempt anyway — including one
        // from a crafted statement, which is the threat worth naming: a PDF is a
        // file from outside, and the only thing that ever reaches this page is its
        // bytes as a base64 string inside a JSON message.
        source={{ html, baseUrl: SHIM_BASE_URL }}
        originWhitelist={[]}
        javaScriptEnabled
        // Nothing is rendered, so none of the machinery for showing a page is needed.
        domStorageEnabled={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        // Nothing should be cached either: the document is the same bytes every
        // launch and is built from assets, so a cache can only ever serve a stale
        // copy of something that was free to rebuild.
        cacheEnabled={false}
        incognito
        onMessage={(e: WebViewMessageEvent) => receiveMessage(e.nativeEvent.data)}
        onError={({ nativeEvent }) =>
          markBroken(`It failed to load (${nativeEvent.description || nativeEvent.code || "no reason given"}).`)
        }
        onHttpError={() =>
          // Nothing is fetched, so this should be unreachable. If it fires, the page
          // is not the one this file built, and reading a PDF with it would be worse
          // than refusing to.
          markBroken("It tried to load something from the network, which it should never do.")
        }
        onRenderProcessGone={({ nativeEvent }) =>
          markBroken(
            nativeEvent.didCrash
              ? "It stopped unexpectedly, most likely because the file was too large for this phone."
              : "Android shut it down to free memory. Closing other apps and trying again may work.",
          )
        }
      />
    </View>
  );
}

/**
 * One pixel, invisible, out of the way. `left`/`top` are negative rather than relying
 * on `opacity: 0` alone so that nothing can be hit-tested even if a future change
 * drops `pointerEvents`.
 */
const hidden = {
  position: "absolute" as const,
  left: -1000,
  top: -1000,
  width: 1,
  height: 1,
  opacity: 0,
};
