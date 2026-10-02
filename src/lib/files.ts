/**
 * Attachment storage — `Finance/src/lib/files.ts`, on the device.
 *
 * Files live in `${documentDirectory}attachments/`. That directory is private to
 * the app, is not scanned by the media gallery, and survives upgrades; the cache
 * directory would not, and Android reclaims it under storage pressure, which for
 * a bill photo means the row is there and the image is gone.
 *
 * The database still stores only the generated `file_name`, and the original name
 * is still kept separately as an inert string for display. **Nothing in the app
 * ever builds a path from user input** — that property is the whole point of this
 * module and it is unchanged.
 *
 * Three things are different from the web version:
 *
 *   - **`File` becomes `PickedFile`.** React Native has no `File`, and the two
 *     pickers return a URI plus metadata. So the caller hands over what the picker
 *     gave it and this module does the copying.
 *   - **The size is checked twice.** A picker's `size`/`fileSize` is *declared* and
 *     optional, so the cheap check happens first and the real one happens after
 *     the copy via `getInfoAsync` — a file over the limit is deleted again before
 *     the error is thrown, because a rejected upload must not leave bytes behind.
 *   - **`readUpload` is gone.** It returned a `Buffer`, which does not exist here.
 *     In its place are two reads that each return what one caller wants —
 *     `readUploadBase64` for the camera scan and for a PDF statement,
 *     `readUploadText` for a CSV one — and the `/api/attachments/[id]` route it
 *     also served no longer exists, because screens read the file directly, still
 *     only ever by database id.
 *
 * `expo-file-system/legacy` rather than the newer `File`/`Paths` class API: its
 * surface is unambiguous, and being sure of a signature matters more than being
 * current when nobody here can run the result.
 */

import * as Crypto from "expo-crypto";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { EXT_BY_MIME, MAX_UPLOAD_BYTES, statementType, STORED_NAME } from "./upload-meta";

/**
 * `documentDirectory` is typed nullable because it is null on web. This app is
 * Android-only, where it is always a `file:///data/.../files/` URI, but the guard
 * is here so the failure is one legible sentence rather than the string "null" in
 * the middle of a path.
 */
function baseDir(): string {
  const dir = FileSystem.documentDirectory;
  if (!dir) throw new UploadError("No document directory on this platform.");
  return `${dir}attachments/`;
}

export type SavedFile = {
  file_name: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
};

/**
 * What both pickers can be reduced to. `expo-image-picker` calls the size
 * `fileSize` and `expo-document-picker` calls it `size`; the caller normalises
 * before handing it over, which keeps the picker-specific shapes out of here.
 *
 * `uri` must be a `file://` URI this process can read — pass
 * `copyToCacheDirectory: true` to DocumentPicker (its default) so a `content://`
 * URI has already been materialised into the cache by the time it arrives.
 */
export type PickedFile = {
  uri: string;
  name: string;
  mimeType: string;
  size?: number;
};

export class UploadError extends Error {}

/**
 * Copies one picked file in and returns the row to insert. The stored name is a
 * UUID plus an extension derived from the *declared* type, never from the
 * picker's filename — so a file called `../../etc/passwd` is simply stored as
 * `<uuid>.png`, and its original name is kept as an inert string for display.
 */
export async function saveUpload(file: PickedFile): Promise<SavedFile> {
  const mime = file.mimeType || "application/octet-stream";
  const ext = EXT_BY_MIME[mime];
  const what = file.name || "That file";
  if (!ext) {
    throw new UploadError(`${what} is a ${mime}. Attach a PNG, JPEG, WebP, GIF, HEIC or PDF.`);
  }
  // The declared size: free, and rejects the obvious case before any bytes move.
  // It is optional, so `=== 0` rather than `!file.size` — undefined is "unknown",
  // not "empty", and the real check below covers it either way.
  if (file.size === 0) throw new UploadError(`${what} is empty.`);
  if (file.size !== undefined && file.size > MAX_UPLOAD_BYTES) {
    throw new UploadError(
      `${what} is ${(file.size / 1048576).toFixed(1)} MB. The limit is ${MAX_UPLOAD_BYTES / 1048576} MB.`,
    );
  }

  return write(file, ext, mime);
}

/**
 * The same thing for a bank statement, against its own list of accepted types.
 *
 * A separate entry point rather than a parameter on `saveUpload`, because the two
 * differ in more than their allow-list: a statement is typed by its *extension*
 * (see `statementType`) and its declared mime is replaced by the canonical one, so
 * the parser dispatches on a single value whatever the picker claimed. On Android
 * that matters more than it does in a browser — a file manager will hand back
 * `application/octet-stream` for a perfectly ordinary `.csv`.
 *
 * The file is kept after import, which is what lets the review screen re-parse
 * rather than store a second copy of the rows — and lets a row you do not recognise
 * months later be traced back to the statement it came from.
 */
export async function saveStatement(file: PickedFile): Promise<SavedFile> {
  const what = file.name || "That file";
  const kind = statementType(file.name || "", file.mimeType || "");
  if (!kind) {
    const lower = what.toLowerCase();
    if (lower.endsWith(".xls") || lower.endsWith(".xlsx")) {
      throw new UploadError(
        `${what} is an Excel workbook. Open it and use File → Save as → CSV, then upload that — the figures are identical and a CSV imports more accurately than a PDF.`,
      );
    }
    throw new UploadError(`${what} is not a statement file. Upload the PDF or the CSV your bank gives you.`);
  }
  if (file.size === 0) throw new UploadError(`${what} is empty.`);
  if (file.size !== undefined && file.size > MAX_UPLOAD_BYTES) {
    throw new UploadError(
      `${what} is ${(file.size / 1048576).toFixed(1)} MB. The limit is ${MAX_UPLOAD_BYTES / 1048576} MB.`,
    );
  }

  return write(file, kind.ext, kind.mime);
}

/**
 * The copy itself, shared by both entry points above, which have already decided
 * what the file is and what it will be stored as.
 *
 * The web's `write` is three lines because `file.size` is authoritative there. Here
 * it is not: a picker's size is *declared* and optional, so the real one is taken
 * after the copy, and a file that turns out to be over the limit has its copy undone
 * before the error surfaces. A rejected upload must not leave bytes behind.
 */
async function write(file: PickedFile, ext: string, mime: string): Promise<SavedFile> {
  const what = file.name || "That file";
  const dir = baseDir();
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  const fileName = `${Crypto.randomUUID()}.${ext}`;
  const to = `${dir}${fileName}`;
  await FileSystem.copyAsync({ from: file.uri, to });

  const info = await FileSystem.getInfoAsync(to);
  const size = info.exists ? info.size : 0;
  if (size === 0 || size > MAX_UPLOAD_BYTES) {
    await FileSystem.deleteAsync(to, { idempotent: true });
    throw new UploadError(
      size === 0
        ? `${what} is empty.`
        : `${what} is ${(size / 1048576).toFixed(1)} MB. The limit is ${MAX_UPLOAD_BYTES / 1048576} MB.`,
    );
  }

  return {
    file_name: fileName,
    original_name: what.slice(0, 200),
    mime_type: mime,
    size_bytes: size,
  };
}

/**
 * Only names this module generated can be read back. Every caller already looks
 * attachments up by database id, so this is belt-and-braces — but it costs
 * nothing and means a hand-edited row, or a `?scan=` parameter, can never become
 * a path traversal.
 */
function resolveStored(fileName: string): string {
  if (!STORED_NAME.test(fileName)) throw new UploadError("Not a stored attachment name.");
  return `${baseDir()}${fileName}`;
}

/**
 * The URI to hand `<Image source={{ uri }}>`. Goes through the same gate as every
 * other read, which is why it is a function and not string concatenation at the
 * call site.
 */
export function attachmentUri(fileName: string): string {
  return resolveStored(fileName);
}

/**
 * Base64 of a file that has *not* been stored yet — the one read that takes a URI
 * rather than a stored name, and so the one that does not go through
 * `resolveStored`.
 *
 * It exists for exactly one caller: `actions/statement.ts` hashes the file you picked
 * before `saveStatement` copies it, so that uploading the same statement twice does
 * not write a second copy of a 6 MB PDF. That ordering is the web's, where the bytes
 * were already in a `Buffer` by the time the action started and hashing them cost
 * nothing.
 *
 * Taking a URI is why it is named differently and documented here rather than being
 * a flag on `readUploadBase64`. The gate that function applies is the module's whole
 * point, and a boolean that switched it off would be a hole with a nice name. What
 * makes this safe is not a check but provenance: the URI comes straight back from
 * `DocumentPicker`, in the same breath, and is never stored, logged or rebuilt from
 * anything a row or a route could carry.
 */
export async function readPickedBase64(uri: string): Promise<string> {
  return FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
}

/** Base64 for a Gemini `inlineData` part — a photo or a PDF, the same way either way. */
export async function readUploadBase64(fileName: string): Promise<string> {
  return FileSystem.readAsStringAsync(resolveStored(fileName), {
    encoding: FileSystem.EncodingType.Base64,
  });
}

/**
 * Text, for a CSV or TSV statement. The other half of the pair the web app did
 * not need: there `readUpload` returned a `Buffer` and the caller chose between
 * `buf.toString("utf8")` and passing the bytes on, so one read served both.
 *
 * Here the two reads are genuinely different calls — `src/lib/statement/parse.ts`
 * explains why its input is a discriminated union rather than bytes plus a mime
 * type — and the choice is made by `statementFormat(mime)` before either runs.
 *
 * UTF-8 with no fallback. A bank's CSV export is UTF-8 or ASCII; the one real
 * variation is a byte-order mark, which `csv.ts` strips from the first field for
 * exactly this reason.
 */
export async function readUploadText(fileName: string): Promise<string> {
  return FileSystem.readAsStringAsync(resolveStored(fileName), {
    encoding: FileSystem.EncodingType.UTF8,
  });
}

/**
 * Hands a PDF to whatever the phone uses to read PDFs. This replaces the web
 * app's `<a href="/api/attachments/[id]">` — there is no browser to navigate, and
 * a share sheet is the platform's own answer to "open this elsewhere".
 *
 * Returns false when sharing is unavailable so the caller can disable the button
 * rather than show an error after the tap.
 */
export async function openAttachment(fileName: string, mime?: string): Promise<boolean> {
  const uri = resolveStored(fileName);
  if (!(await Sharing.isAvailableAsync())) return false;
  await Sharing.shareAsync(uri, mime ? { mimeType: mime, UTI: mime } : undefined);
  return true;
}

/**
 * Deletes the file behind a row. Swallows a missing file — `idempotent` does that
 * for us — for the reason the web version gave: the row is going either way, and
 * an attachment you cannot remove is worse than an orphaned byte range.
 */
export async function deleteUpload(fileName: string): Promise<void> {
  try {
    await FileSystem.deleteAsync(resolveStored(fileName), { idempotent: true });
  } catch (e) {
    // A name that fails STORED_NAME lands here too, which is correct: there is
    // nothing of ours at that name to delete.
    console.error("[files] could not delete", fileName, e);
  }
}
