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
 *   - **`readUpload` is gone.** It returned a `Buffer`, which does not exist here,
 *     and its only two callers were `readUploadBase64` and the
 *     `/api/attachments/[id]` route, which no longer exists — screens read the
 *     file directly, still only ever by database id.
 *
 * `expo-file-system/legacy` rather than the newer `File`/`Paths` class API: its
 * surface is unambiguous, and being sure of a signature matters more than being
 * current when nobody here can run the result.
 */

import * as Crypto from "expo-crypto";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { EXT_BY_MIME, MAX_UPLOAD_BYTES, STORED_NAME } from "./upload-meta";

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

  const dir = baseDir();
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  const fileName = `${Crypto.randomUUID()}.${ext}`;
  const to = `${dir}${fileName}`;
  await FileSystem.copyAsync({ from: file.uri, to });

  // The real size, now that there is a real file. A picker that under-reported —
  // or reported nothing — does not get to smuggle a 40 MB PDF past the limit, and
  // the copy is undone before the error surfaces so nothing is left orphaned.
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

/** Base64 for a Claude `image` or `document` content block. */
export async function readUploadBase64(fileName: string): Promise<string> {
  return FileSystem.readAsStringAsync(resolveStored(fileName), {
    encoding: FileSystem.EncodingType.Base64,
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
