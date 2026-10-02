/**
 * Reading a bill with Gemini, and throwing the resulting draft away —
 * `Finance/src/lib/actions/scan.ts`.
 *
 * **Both halves are here now.** This file held only `discardScan` until phase 11,
 * because `scanBill` needs `aiConfigured`, `AiError` and `extractBill`, and none of
 * those existed yet. The promise made then is kept: the names, the
 * signatures and the error sentences of both functions are the web's. Exactly one
 * sentence had to change — the missing-key one, which used to say "Set the API key in
 * .env, then restart the stack" and now names Settings, because that is where the key
 * lives on a phone.
 *
 * Two sentences changed again when the provider did, and both are about what can be
 * sent rather than about who sends it: the missing-key line names Gemini, and the
 * unreadable-type line no longer offers GIF, which is not among the image types Gemini
 * accepts. A GIF is still perfectly attachable to a bill typed in by hand — see
 * `isAiReadable` in `upload-meta.ts` for why those two lists differ on purpose.
 *
 * `scanBill`'s shape is the web's step for step, and the order of the steps is the
 * design: validate before any bytes move, save the file *before* calling the API, read
 * it back as base64, ask for the fields, turn the category *name* into an id here, and
 * write the result to `scan_drafts` as a draft. Nothing is ever saved as a bill without
 * a person looking at it — the draft lands on the ordinary new-bill form with the fields
 * filled in and the confidence stated.
 *
 * Four edits, all forced by the platform and none of them touching that order:
 *
 * **`File` → `PickedFile`.** The web's
 * `fd.getAll("files").find(f => f instanceof File && f.size > 0)` becomes
 * `pickedFiles(fd)[0]`; the declared type is `mimeType`, not `type`; and `size` is
 * optional on a picked file, so the too-large gate tolerates `undefined` and leans on
 * `saveUpload`, which measures the real file and throws `UploadError`.
 *
 * **No `redirect()`.** The web ended with ``redirect(`/journal/new?scan=${…}`)``, which
 * threw, which is why it sat outside the `try`. Here the success case returns
 * `{ scan: saved.file_name }` and the screen navigates. A `return` does not throw, so it
 * can live *inside* the `try` — which also removes the non-null assertion the web needed
 * on `saved`, since narrowing does not survive a `try`/`catch`.
 *
 * **No `isControlFlow(e)` rethrow.** Nothing here throws for control flow; the header of
 * `shared.ts` explains why that helper was deleted rather than stubbed.
 *
 * **The unwind is unchanged and still matters.** A failure after the file is saved
 * deletes it again, because the upload is not transactional and a stored file nobody can
 * reach is litter. That delete is `.catch(() => {})` for the same reason it is in
 * `discardScan`.
 *
 * `discardScan` itself is the web's function with two edits:
 *
 * **`$1` → `?1`**, the same dialect edit as everywhere else.
 *
 * **No `redirect("/journal")`.** The web ended with one, which threw, so the function
 * never returned. Here it returns `void` and the screen that called it navigates —
 * `app/bill/new.tsx` does `router.replace("/journal")` right after awaiting it. Same
 * destination, chosen by the thing that owns the router.
 *
 * What did *not* change is the order of the three steps, and it matters: the draft is
 * read before anything is deleted, the file is unlinked before the draft row goes, and
 * the unlink is `.catch(() => {})` because a missing file must not leave the row behind
 * to be re-offered forever. The `STORED_NAME` gate is the same one `getScanDraft` and
 * `saveBill`'s claim use — a hand-edited file name can only ever name a draft that
 * does not exist.
 */

import { aiConfigured, AiError } from "@/lib/ai/gemini";
import { extractBill } from "@/lib/ai/extract";
import { today } from "@/lib/date";
import { q } from "@/lib/db";
import { deleteUpload, readUploadBase64, saveUpload, type SavedFile } from "@/lib/files";
import { FormData } from "@/lib/form-data";
import { getCategories } from "@/lib/queries/bills";
import { getScanDraft, type ScanDraft } from "@/lib/queries/scan";
import type { BillStatus } from "@/lib/types";
import { isAiReadable, MAX_UPLOAD_BYTES, STORED_NAME } from "@/lib/upload-meta";
import { fail, pickedFiles, refreshAll, type FormState } from "./shared";

/**
 * Reads one uploaded bill and leaves a draft for the new-bill form to adopt.
 *
 * The file is saved first and the API is called second, deliberately. A rate limit or a
 * timeout then still leaves the file stored and only the typing to do, which is a far
 * better failure than losing the photo as well.
 */
export async function scanBill(_prev: FormState, fd: FormData): Promise<FormState> {
  if (!aiConfigured()) {
    return fail("Reading bills needs a Gemini API key. Add one in Settings, then try again.");
  }

  const file = pickedFiles(fd)[0];
  if (!file) return fail("Choose a photo or a PDF of the bill first.", { files: "Nothing selected." });

  if (!isAiReadable(file.mimeType)) {
    return fail(
      file.mimeType === "image/heic"
        ? "HEIC photos can be stored but not read. Share it as JPEG, or add the bill by hand."
        : "That file type cannot be read. Use a PNG, JPEG, WebP or PDF.",
      { files: "Unsupported type." },
    );
  }
  // A picker's size is a claim and may be absent entirely, so this is the cheap check and
  // `saveUpload` does the real one against the copied file.
  if (file.size !== undefined && file.size > MAX_UPLOAD_BYTES) {
    return fail("That file is too large to read. Keep it under 12 MB.", { files: "Too large." });
  }

  let saved: SavedFile | undefined;
  try {
    saved = await saveUpload(file);

    const [base64, categories] = await Promise.all([
      readUploadBase64(saved.file_name),
      getCategories(),
    ]);

    const { value: x, model } = await extractBill({
      base64,
      mimeType: saved.mime_type,
      originalName: saved.original_name,
      categories: categories.map((c) => c.name),
      today: today(),
    });

    // Name → id happens here, not in the model: it is given names and returns a name, so
    // a hallucinated id is impossible. No match simply means the field is left empty.
    const wanted = x.category?.trim().toLowerCase();
    const matched = wanted ? categories.find((c) => c.name.trim().toLowerCase() === wanted) : undefined;

    const due = iso(x.due_date);
    const txn = iso(x.txn_date) ?? due ?? today();
    const status: BillStatus = x.already_paid ? "paid" : "upcoming";

    const draft: ScanDraft = {
      file: saved,
      values: {
        merchant: x.merchant.trim().slice(0, 200) || "Unknown",
        // Rupees → paise, once, here. A negative or non-finite reading becomes zero
        // rather than a constraint violation: amount_minor has a CHECK (>= 0).
        amount_minor: Math.max(0, Math.round((Number.isFinite(x.amount) ? x.amount : 0) * 100)),
        txn_date: txn,
        due_date: status === "upcoming" ? (due ?? txn) : due,
        status,
        kind: x.kind,
        category_id: matched?.id ?? null,
        notes: x.reference ? `Ref ${x.reference}` : null,
        // Always "none": one bill is not evidence of a pattern, and the form offers the
        // choice right there if it is in fact a monthly one.
        recurrence: "none",
      },
      confidence: x.confidence,
      caveat: x.caveat,
    };

    // `saveUpload` generates a fresh name per file, so the conflict clause can only
    // fire when the same stored file is scanned twice — a retry, where overwriting
    // the older draft is exactly what is wanted.
    await q(
      `INSERT INTO scan_drafts (file_name, payload, model) VALUES (?1, ?2, ?3)
       ON CONFLICT (file_name) DO UPDATE SET
         payload    = excluded.payload,
         model      = excluded.model,
         created_at = datetime('now')`,
      [saved.file_name, JSON.stringify(draft), model],
    );

    return { scan: saved.file_name };
  } catch (e) {
    // The volume is not transactional, so the file has to be taken back by hand.
    if (saved) await deleteUpload(saved.file_name).catch(() => {});
    return fail(e instanceof AiError ? e.message : `Could not read that bill: ${msg(e)}`);
  }
}

/**
 * A date the model read off a page, or null.
 *
 * The year window is the part that earns its keep: a bill dated 1998 or 2043 is a misread
 * digit, and an out-by-a-century date silently lands the bill in a month no page ever
 * shows.
 */
function iso(v: string | null): string | null {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const [y, m, d] = v.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const year = Number(today().slice(0, 4));
  if (y < year - 30 || y > year + 2) return null;
  return v;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Deletes the pending draft and the file it was read from.
 *
 * Safe to call twice: the second call finds no draft, deletes no file, and the
 * `DELETE` matches nothing.
 */
export async function discardScan(fileName: string): Promise<void> {
  if (STORED_NAME.test(fileName)) {
    const draft = await getScanDraft(fileName);
    if (draft) await deleteUpload(draft.file.file_name).catch(() => {});
    await q("DELETE FROM scan_drafts WHERE file_name = ?1", [fileName]);
  }
  refreshAll();
}
