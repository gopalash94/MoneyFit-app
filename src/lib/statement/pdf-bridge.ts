/**
 * The wire between `pdf.ts` and the WebView that pdf.js runs in.
 *
 * Deliberately not a hook and not a component. `readPdf` is called from
 * `parseStatement`, which is called from an action, which is called from a form
 * submit — three layers below anything that could hold a ref — so the registry has
 * to live at module scope. The component in `src/components/PdfBridge.tsx` does
 * nothing but hand its `postMessage` to `attachBridge` on mount and feed
 * `receiveMessage` from `onMessage`; every rule about what a message means lives
 * here, where it can be read without React in the way.
 *
 * **Requests are keyed on an id, which is the whole point.** A promise per call,
 * resolved by the message carrying the same id. Without that, two uploads a second
 * apart — a double tap on the button is enough — would race, and the losing one
 * would resolve with the winner's rows: an import of the wrong statement, with no
 * error anywhere and nothing on screen to say so. The id makes that impossible
 * rather than unlikely.
 *
 * **Everything here fails loudly.** This is the one path in the migration that
 * cannot be verified without a device, so the failure modes are enumerated and each
 * one rejects with a sentence naming it: the WebView never mounted, it mounted but
 * pdf.js never loaded, it loaded but a parse took too long, the view was torn down
 * mid-parse. There is no path that simply leaves a promise pending — a spinner that
 * never stops is the single worst outcome available here, because it is the one the
 * user cannot act on and the one a log will not explain.
 *
 * No user-facing copy lives in this file either. The strings below describe what
 * went wrong mechanically; `pdf.ts` wraps them in the sentence the reader sees,
 * including the way out (import the CSV instead).
 */

/** One text run as pdf.js reported it, with the transform matrix already read. */
export type RawItem = {
  str: string;
  /** `transform[4]` — the left edge, in PDF user space. */
  x: number;
  /** `transform[5]` — the baseline. `pdf.ts` buckets rows on this. */
  y: number;
  width: number;
};

export type RawPage = {
  /** 1-based, as `doc.getPage(p)` numbers them. */
  page: number;
  items: RawItem[];
};

export type PdfTextResponse = {
  page_count: number;
  pages: RawPage[];
};

/**
 * pdf.js threw. The three fields it is worth reading off one of its exceptions,
 * carried across untranslated so that `pdf.ts` can apply the web app's own four
 * sentences to them — which is how a wrong password still produces the wrong-password
 * message rather than "the bridge failed".
 */
export class PdfJsError extends Error {
  constructor(readonly detail: { name?: string; code?: number; message?: string }) {
    super(detail.message ?? "pdf.js reported an error with no message.");
    this.name = "PdfJsError";
  }
}

/** The bridge itself failed: no WebView, no pdf.js, or no answer in time. */
export class PdfBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfBridgeError";
  }
}

/**
 * How long to wait for the WebView to report that pdf.js is loaded.
 *
 * It starts loading when the app starts, not when a file is picked, so by the time
 * anyone has navigated to the import screen and chosen a file this has almost
 * always already happened and the wait is zero. The timeout exists for the cold
 * case — first launch, file picker opened immediately — and for the one that must
 * not hang: a build where the pdf.js asset is missing, where the WebView never
 * reports anything at all.
 */
const READY_TIMEOUT_MS = 20_000;

/**
 * How long one parse may take. Generous on purpose: a 40-page statement on a slow
 * phone inside a WebView is seconds, not milliseconds, and a timeout that fires on
 * a file that would have worked is worse than one that fires late.
 */
const PARSE_TIMEOUT_MS = 120_000;

/**
 * The largest base64 payload to put across the bridge.
 *
 * **A divergence from the web, and the reason for it.** `postMessage` into a WebView
 * is not a byte channel — the string is handed to the platform as JavaScript source
 * — so a very large one is slow, memory-hungry and, on Android, capable of taking
 * the whole app down with it. `MAX_UPLOAD_BYTES` is 12 MB, which base64 inflates to
 * about 16 MB of characters, and that is too much to send this way.
 *
 * 8 million characters is roughly a 6 MB PDF. A text-layer bank statement is a few
 * hundred kilobytes — thirty pages of one is still under half a megabyte — so this
 * is an order of magnitude above the realistic worst case, and anything above it is
 * almost certainly a scanned statement, which `pdf.ts` would refuse a moment later
 * anyway for having no text in it. Refusing it here, by size, with a sentence that
 * names the CSV path, is better than an unresponsive app.
 */
const MAX_PDF_BASE64_CHARS = 8 * 1024 * 1024;

type Pending = {
  resolve: (value: PdfTextResponse) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Waiter = {
  resolve: () => void;
  reject: (reason: unknown) => void;
};

/** `absent` → no WebView mounted; `loading` → mounted, pdf.js not ready yet. */
type State = "absent" | "loading" | "ready" | "broken";

const pending = new Map<number, Pending>();
const waiters = new Set<Waiter>();

let nextId = 1;
let post: ((message: string) => void) | null = null;
let state: State = "absent";
let brokenReason = "";

/** Rejects everything outstanding. Used on teardown and on an unrecoverable failure. */
function failAll(reason: PdfBridgeError): void {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.reject(reason);
  }
  pending.clear();
  for (const w of waiters) w.reject(reason);
  waiters.clear();
}

/**
 * Called by `PdfBridge` on mount with the WebView's `postMessage`. Returns the
 * teardown, which the effect's cleanup calls.
 *
 * Attaching does not mean ready — the WebView still has to load pdf.js and say so.
 * Until then requests wait rather than fail, because the common case is exactly that
 * overlap: the app has just started and somebody is already picking a file.
 */
export function attachBridge(send: (message: string) => void): () => void {
  post = send;
  state = "loading";
  brokenReason = "";
  return () => {
    if (post !== send) return; // A newer mount already took over; leave it alone.
    post = null;
    state = "absent";
    failAll(new PdfBridgeError("The PDF reader was closed while the file was being read."));
  };
}

/** The WebView reported that pdf.js is loaded and listening. */
function markReady(): void {
  state = "ready";
  for (const w of waiters) w.resolve();
  waiters.clear();
}

/**
 * The WebView cannot be used — it failed to load, its render process was killed, or
 * pdf.js itself threw while starting up. Exported because the component's `onError`
 * and `onRenderProcessGone` are the only places some of those are visible.
 */
export function markBroken(reason: string): void {
  state = "broken";
  brokenReason = reason;
  failAll(new PdfBridgeError(reason));
}

/** Resolves once pdf.js is loaded, or rejects saying why it never will be. */
function waitForReady(): Promise<void> {
  if (state === "ready") return Promise.resolve();
  if (state === "broken") return Promise.reject(new PdfBridgeError(brokenReason));

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(waiter);
      reject(
        new PdfBridgeError(
          state === "absent"
            ? "It never started. Close the app completely and open it again; if that does not help, the app needs reinstalling."
            : "It did not finish starting up. Close the app completely and open it again.",
        ),
      );
    }, READY_TIMEOUT_MS);

    const waiter: Waiter = {
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
      reject: (reason) => {
        clearTimeout(timer);
        reject(reason);
      },
    };
    waiters.add(waiter);
  });
}

/**
 * Hands a message from the WebView to whoever is waiting for it.
 *
 * Wrapped in its own try/catch because it runs on React Native's message callback,
 * where a throw is an unhandled exception in the bridge rather than a rejected
 * promise anybody can see. A message that cannot be understood is ignored and the
 * request it belonged to is left to its timeout, which is the only behaviour that
 * cannot make things worse.
 */
export function receiveMessage(raw: string): void {
  let msg: {
    type?: unknown;
    id?: unknown;
    ok?: unknown;
    page_count?: unknown;
    pages?: unknown;
    error?: unknown;
    message?: unknown;
  };
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  if (msg.type === "ready") {
    markReady();
    return;
  }

  if (msg.type === "fatal") {
    markBroken(typeof msg.message === "string" && msg.message ? msg.message : "It failed to start.");
    return;
  }

  if (msg.type !== "result" || typeof msg.id !== "number") return;

  const entry = pending.get(msg.id);
  if (!entry) return; // Already timed out, or a stale reply from a torn-down view.
  pending.delete(msg.id);
  clearTimeout(entry.timer);

  if (msg.ok === true && Array.isArray(msg.pages) && typeof msg.page_count === "number") {
    entry.resolve({ page_count: msg.page_count, pages: msg.pages as RawPage[] });
    return;
  }

  // The per-item shape is checked by `pdf.ts`'s own guard, not here; what matters at
  // this boundary is that a reply which is neither a usable success nor a reported
  // failure still rejects, rather than resolving with nothing.
  if (msg.ok === false) {
    const detail = (typeof msg.error === "object" && msg.error !== null ? msg.error : {}) as {
      name?: string;
      code?: number;
      message?: string;
    };
    entry.reject(new PdfJsError(detail));
    return;
  }

  entry.reject(new PdfBridgeError("It sent back a reply that could not be understood."));
}

/**
 * The one function `pdf.ts` calls. Posts the file in, resolves with the text runs.
 *
 * The password is passed through and never stored anywhere: it exists as an argument
 * here, as a property on one JSON string, and as a local inside the WebView for the
 * length of one `getDocument` call. It is not written to SQLite, not put in a route
 * param and not logged — see `src/lib/statement/password.ts` for where it is held
 * between the prompt and this call, and why that is a module variable rather than
 * storage.
 */
export async function requestPdfText(base64: string, password?: string): Promise<PdfTextResponse> {
  if (base64.length > MAX_PDF_BASE64_CHARS) {
    throw new PdfBridgeError(
      `This PDF is about ${Math.round((base64.length * 3) / 4 / 1048576)} MB, which is too large to read on a phone — a statement with selectable text is rarely more than a megabyte, so this is most likely a scan.`,
    );
  }

  await waitForReady();

  const send = post;
  if (!send) throw new PdfBridgeError("It stopped running before the file could be sent.");

  const id = nextId++;
  return new Promise<PdfTextResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new PdfBridgeError("It did not finish reading the file in two minutes."));
    }, PARSE_TIMEOUT_MS);

    pending.set(id, { resolve, reject, timer });

    try {
      send(JSON.stringify({ type: "parse", id, base64, password: password ?? null }));
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      reject(new PdfBridgeError(`The file could not be handed to it: ${(err as Error)?.message ?? "unknown error"}.`));
    }
  });
}

/**
 * Whether a PDF can be read right now. The import screen uses it to say so up
 * front — "PDF reading is unavailable on this build, import a CSV instead" before a
 * file is picked beats the same sentence after a two-minute wait.
 *
 * Synchronous on purpose, like `apiKeyConfigured()`: it is read during render.
 */
export function pdfReaderState(): { ready: boolean; broken: boolean; reason: string } {
  return { ready: state === "ready", broken: state === "broken", reason: brokenReason };
}
