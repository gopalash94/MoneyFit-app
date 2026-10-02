/**
 * Getting positioned text out of a PDF, and refusing the ones that have none.
 *
 * The naive way to read a PDF is to ask for its text and get back a string. That
 * string is useless for a statement, because a table flattened to text has lost the
 * only thing that said which number was a withdrawal and which was a balance.
 *
 * So this module does not flatten. `getTextContent()` hands back every run of
 * glyphs with its position in PDF user space, and that is what travels onward:
 * runs grouped into visual lines by their y coordinate, each run keeping its left
 * and right edge so `table.ts` can work out where the columns are. Reconstructing a
 * table from coordinates is the whole reason a non-AI importer can be accurate
 * rather than merely plausible.
 *
 * Nothing here renders, rasterises or fetches: no canvas, no font files, no
 * network. pdf.js is bundled with the app and runs locally, which is why adding it
 * puts no network call behind the importer. `/ask` is the only place in MoneyFit
 * where one exists, and a statement never goes near it.
 *
 * The hard limit is honest and stated rather than papered over: a **scanned**
 * statement has no text layer at all, and no amount of coordinate work invents one.
 * Those are detected and refused with an explanation. OCR is out of scope.
 *
 * ---
 *
 * **This is the one real rewrite in this directory.** The other ten files are the
 * web app's, unchanged.
 *
 * pdf.js is a browser library. It wants `DOMMatrix`, `ImageData`, `atob`, a
 * `Worker`, `URL.createObjectURL` and a dozen other things Hermes does not have, and
 * the shims required to run it on React Native are the kind of code that works on
 * the version you tested and breaks on the next one. So it is not run here. It runs
 * inside a `<WebView>` that is mounted off-screen for the life of the app
 * (`src/components/PdfBridge.tsx`), where it has a real browser underneath it and
 * needs no shims at all — and because that WebView has `originWhitelist={[]}` and is
 * handed its own source rather than a URL, it is a JavaScript sandbox rather than a
 * browser window: it can reach nothing, and nothing can reach it.
 *
 * **The division of labour is deliberate, and it is the reason this file still
 * looks like its source.** Everything that encodes a decision taken against real
 * statements — the 2.5pt baseline tolerance, the grow-the-rows bucketing, the two
 * sorts, the character tally, the scanned-PDF refusal and every word of
 * `translate()` — stays here, in TypeScript, where it can be read against the web's
 * copy line by line. What crosses into the WebView is the part that genuinely needs
 * a browser and nothing more: open the document, walk the pages, hand back each
 * text run's `str`, `x`, `y` and `width`. The shim counts nothing, sorts nothing,
 * buckets nothing and contains no user-facing copy; when pdf.js throws, the
 * exception's `name`, `code` and `message` come back untouched and are translated
 * *here*, by the same four sentences the web uses.
 *
 * That split matters because this is the one path in the whole migration that
 * cannot be verified without a device. Keeping the unverifiable part to "a loop that
 * copies four fields" is the only honest way to make it small.
 *
 * `Glyph`, `Line` and `PdfText` are structurally identical to the web's, which is
 * the contract `table.ts` is written against — its `import type { Line } from
 * "./pdf"` is untouched, and it has no idea any of this happened.
 */

import { PdfBridgeError, PdfJsError, requestPdfText, type RawItem } from "./pdf-bridge";
import { StatementError } from "./types";

/** One run of glyphs, positioned. `right` is the right edge, which right-aligned numbers need. */
export type Glyph = {
  text: string;
  x: number;
  right: number;
};

/** One visual row of a page: everything that sat at the same height. */
export type Line = {
  page: number;
  y: number;
  items: Glyph[];
};

export type PdfText = {
  lines: Line[];
  page_count: number;
};

/** Two runs are on the same line if their baselines are within this many points. */
const Y_TOLERANCE = 2.5;

/**
 * Below this much text in total, the file is a picture of a statement rather than a
 * statement. Deliberately generous: a scanned page yields a handful of characters
 * at most (a stamp, a page number), while the thinnest real statement page carries
 * hundreds.
 */
const MIN_CHARS_PER_PAGE = 120;

/**
 * On the web this guarded against pdfjs's `TextMarkedContent` items, which have no
 * `str` and share the array with the real ones. The shim already drops those, so
 * this is now the second line of defence rather than the first — and it is worth
 * keeping, because the items arrive through `JSON.parse`, where the compiler's word
 * for their shape is a promise rather than a fact. A malformed message produces no
 * rows and a legible "no transaction rows were found", not `NaN` coordinates
 * silently poisoning the column reconstruction.
 */
function isTextItem(item: unknown): item is RawItem {
  if (typeof item !== "object" || item === null) return false;
  const i = item as { str?: unknown; x?: unknown; y?: unknown; width?: unknown };
  return (
    typeof i.str === "string" &&
    typeof i.x === "number" &&
    Number.isFinite(i.x) &&
    typeof i.y === "number" &&
    Number.isFinite(i.y)
  );
}

/**
 * Translates pdfjs's exceptions into something a person reading an upload form can
 * act on. Indian bank statements are routinely password-protected — the password is
 * usually a PAN and a date of birth jammed together — so this is the single most
 * likely failure, not an edge case.
 *
 * It takes the same three fields it took on the web (`name`, `code`, `message`),
 * because that is all it ever read off a pdfjs exception and all three survive the
 * trip back from the WebView. The four sentences below are the web's, word for word;
 * none of them lives in the shim.
 */
function translate(err: unknown): never {
  const e = err as { name?: string; code?: number; message?: string };
  if (e?.name === "PasswordException") {
    throw new StatementError(
      e.code === 2
        ? "That password did not open the file. Bank statements usually want your PAN followed by your date of birth, with no spaces — check the covering email for the exact format."
        : "This PDF is password-protected. Enter the password the bank emailed you and upload it again.",
    );
  }
  if (e?.name === "InvalidPDFException") {
    throw new StatementError("That file is not a readable PDF. If you downloaded it from net banking, try downloading it again.");
  }
  throw new StatementError(`The PDF could not be opened: ${e?.message ?? "unknown error"}`);
}

/**
 * Takes the file base64-encoded rather than as bytes, because that is what crosses
 * into the WebView and what `expo-file-system` hands back for a binary file. The
 * web took a Node `Buffer` and copied it into a `Uint8Array`; `parse.ts` is the only
 * caller and it was changed to match in the same one place.
 *
 * The document is opened, read and destroyed inside the WebView — `page.cleanup()`
 * and `doc.destroy()` are the shim's `finally`, because that is where the document
 * exists. Nothing is held open across a call, so two uploads in a row cannot share
 * state.
 */
export async function readPdf(base64: string, password?: string): Promise<PdfText> {
  let doc;
  try {
    doc = await requestPdfText(base64, password);
  } catch (err) {
    // An exception pdf.js itself threw: the four sentences above, unchanged.
    if (err instanceof PdfJsError) translate(err.detail);
    // The reader never answered. Said plainly, with the way out: the CSV path is
    // the whole importer in pure TypeScript and does not involve any of this.
    if (err instanceof PdfBridgeError) {
      throw new StatementError(
        `The PDF reader could not be used, so this file was not read. ${err.message} If your bank also offers a CSV or Excel export of the same period, that imports without the PDF reader.`,
      );
    }
    throw err;
  }

  const lines: Line[] = [];
  let chars = 0;

  for (const page of doc.pages) {
    // Bucket by baseline. A map keyed on the rounded y would merge rows that sit
    // 1.2pt apart into neither bucket consistently, so rows are grown instead:
    // each run joins the open row whose baseline it is within tolerance of.
    const rows: Line[] = [];
    for (const item of Array.isArray(page.items) ? page.items : []) {
      if (!isTextItem(item)) continue;
      if (!item.str || !item.str.trim()) continue;
      chars += item.str.trim().length;

      // `transform[4]` and `transform[5]` on the other side of the bridge; the shim
      // reads them off the matrix and posts them under their own names, because
      // "the fifth element of a six-element array" is not a thing to send over a
      // wire and expect to still be right in a year.
      const x = item.x;
      const y = item.y;
      const glyph: Glyph = { text: item.str, x, right: x + (item.width || 0) };

      const row = rows.find((r) => Math.abs(r.y - y) <= Y_TOLERANCE);
      if (row) row.items.push(glyph);
      else rows.push({ page: page.page, y, items: [glyph] });
    }

    // Top of the page downwards: PDF y grows upwards, so descending y is reading
    // order. Within a row, left to right.
    rows.sort((a, b) => b.y - a.y);
    for (const r of rows) r.items.sort((a, b) => a.x - b.x);
    lines.push(...rows);
  }

  if (chars < MIN_CHARS_PER_PAGE * Math.max(1, doc.page_count)) {
    throw new StatementError(
      "This PDF has no text in it — it is a scan or a photo of a statement, so there is nothing to read without character recognition. Download the statement again as a PDF from net banking (not a printout), or export it as CSV/Excel instead.",
    );
  }

  return { lines, page_count: doc.page_count };
}
