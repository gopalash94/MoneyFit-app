/**
 * Facts about attachments, independent of where they are stored.
 *
 * Split out from files.ts in the web app because that module imported node:fs and
 * the picker was a client component. The split is kept here for a different
 * reason: these constants describe the *name and the limits*, and the pickers, the
 * AI extractor and the attachment rows all need them without pulling in
 * expo-file-system and expo-sharing.
 */

/**
 * 12 MB. Comfortably above a phone photo, and inside the inline-request limit of
 * the API the scan sends to — which is the number that moved when the provider did.
 * Anthropic allowed 32 MB for a PDF; Gemini allows 20 MB for the *whole request*
 * before a file has to go through its separate upload API. Base64 costs a third, so
 * 12 MB of file is about 16 MB on the wire: still inside, with less headroom than
 * the old figure implied. Raising this limit means implementing that upload API.
 */
export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

/**
 * What a bill can carry, mime → stored extension. Deliberately narrow: these are
 * the types the AI extractor can actually read, so accepting a .docx would only
 * produce a file that silently never extracts.
 */
export const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "application/pdf": "pdf",
};

export const ACCEPT_ATTR = Object.keys(EXT_BY_MIME).join(",");

export function isImage(mime: string): boolean {
  return mime.startsWith("image/");
}

export function isPdf(mime: string): boolean {
  return mime === "application/pdf";
}

/**
 * Whether the scan can send this file to the model.
 *
 * Narrower than what can be *stored*, and that gap is the point: HEIC has always
 * been attachable but unsendable, and `image/gif` joined it when the provider
 * changed — Gemini's supported image types are PNG, JPEG, WEBP and HEIC/HEIF, with
 * no GIF among them. So a GIF is still a perfectly good receipt to keep on a bill;
 * it is only the camera scan that will say it cannot read it, which is a sentence
 * the user gets before the upload rather than a request that fails after it.
 *
 * (HEIC stays out despite being on Gemini's list, because it is a conversion step
 * this app does not do: `expo-image-picker` hands back HEIC on an iPhone, and the
 * scan is an Android feature.)
 */
export function isAiReadable(mime: string): boolean {
  return isPdf(mime) || ["image/png", "image/jpeg", "image/webp"].includes(mime);
}

/**
 * What the statement importer accepts. A separate list from `EXT_BY_MIME`, and
 * deliberately so: that one is "what can be attached to a bill", which the AI
 * extractor's abilities define, and this one is "what the statement parser can
 * read", which `src/lib/statement/` defines. A CSV belongs in exactly one of them.
 *
 * Statements are matched on the **file extension** rather than the declared type,
 * which is the opposite of how attachments are handled and is the right way round
 * here. Android's document picker is as unreliable about CSV as a browser is:
 * depending on the file manager and whether Sheets is installed, the same file
 * arrives as `text/csv`, `application/vnd.ms-excel`, `text/plain`,
 * `application/octet-stream` or nothing at all. The extension, meanwhile, is
 * exactly what the bank's export named it.
 */
export const STATEMENT_MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  txt: "text/csv",
};

/**
 * What to hand `DocumentPicker.getDocumentAsync({ type })`.
 *
 * The web's equivalent is `STATEMENT_ACCEPT_ATTR = ".pdf,.csv,.tsv,.txt"` — an
 * `<input accept>` attribute, which takes extensions. Android's picker takes mime
 * types instead, and this is the same intent in its dialect, widened at both ends
 * for the reason above: `application/vnd.ms-excel` is on the list because that is
 * what a CSV is routinely announced as once a spreadsheet app has claimed the
 * extension, and a wildcard type is the last entry because a picker that cannot offer the
 * file at all is worse than one that offers too much. Whatever comes back is
 * checked by `statementType` on the extension, so a wrong type here costs nothing
 * and a missing one costs the feature.
 */
export const STATEMENT_PICKER_TYPES = [
  "application/pdf",
  "text/csv",
  "text/tab-separated-values",
  "text/plain",
  "text/comma-separated-values",
  "application/vnd.ms-excel",
  "*/*",
];

/**
 * Decides what a picked statement is, or null if it is not one. `mime` is the
 * canonical type the parser dispatches on, `ext` is what the file is stored as.
 */
export function statementType(fileName: string, declaredMime: string): { ext: string; mime: string } | null {
  const ext = (fileName.split(".").pop() ?? "").toLowerCase();
  const byExt = STATEMENT_MIME_BY_EXT[ext];
  if (byExt) return { ext, mime: byExt };
  // No usable extension: fall back to the declared type, which does at least
  // identify a PDF reliably.
  if (declaredMime === "application/pdf") return { ext: "pdf", mime: "application/pdf" };
  if (declaredMime === "text/csv") return { ext: "csv", mime: "text/csv" };
  return null;
}

/**
 * The shape every stored file name has: a UUID plus an extension this module
 * chose. Lives here rather than in files.ts because it is a fact about the name,
 * not about the filesystem, and anything that accepts a stored name from outside
 * — a URL, a cache scope — needs to check it before using it.
 */
export const STORED_NAME = /^[0-9a-f-]{36}\.[a-z]{3,4}$/;

/** "1.4 MB", "812 KB" — attachment rows show this next to the name. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
