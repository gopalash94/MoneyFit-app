/**
 * Facts about attachments, independent of where they are stored.
 *
 * Split out from files.ts in the web app because that module imported node:fs and
 * the picker was a client component. The split is kept here for a different
 * reason: these constants describe the *name and the limits*, and the pickers, the
 * AI extractor and the attachment rows all need them without pulling in
 * expo-file-system and expo-sharing.
 */

/** 12 MB. Comfortably above a phone photo, well under the API's 32 MB PDF cap. */
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

/** Which Claude content block a file can become. HEIC is stored but not sent. */
export function isAiReadable(mime: string): boolean {
  return isPdf(mime) || ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime);
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
