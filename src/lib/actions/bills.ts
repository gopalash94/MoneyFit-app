/**
 * Everything that writes a bill — `Finance/src/lib/actions/bills.ts`.
 *
 * All seven exports keep their names, their parameter lists and their validation.
 * `saveBill` is still bound as `saveBill.bind(null, id)`, still reads the same
 * fourteen fields through the same helpers, still claims a scan draft with a
 * `DELETE … RETURNING`, still puts the adopted file first, and still unlinks whatever
 * it uploaded if the transaction fails. The differences are the dialect and who
 * navigates.
 *
 * **Navigation comes back as a value.** The web ended `saveBill` with
 * `redirect(`/journal/${billId}`)` and `duplicateBill` with
 * `redirect(`/journal/${row.id}/edit`)`. `redirect()` threw, which is why those
 * functions are typed as returning something they never actually return. There is no
 * router in a module here, so `saveBill` returns `{ savedId }` and `duplicateBill`
 * returns the new id (or `null`), and the screen does the `router.replace`. The
 * destinations are `/bill/[id]` and `/bill/[id]/edit` — the app's route layout — not
 * `/journal/[id]`; the Journal is a tab, and a tab cannot also be a stack of bill
 * screens. `deleteBill` returns `void` and its screen goes back to the Journal.
 *
 * **`fd.getAll("files").filter(f => f instanceof File && f.size > 0)`** appears twice
 * on the web and is `pickedFiles(fd)` both times — same filter, against `PickedFile`,
 * written once in `shared.ts`. And `FormData` is imported, not the global: see the
 * header of `lib/form-data.ts` for what happens to a module that forgets.
 *
 * **Four dialect edits.** `$n` → `?n`; the new bill's id comes from
 * `lastInsertRowId` instead of `RETURNING id`; `CURRENT_DATE` → `date('now','localtime')`,
 * because SQLite's is UTC and a bill duplicated at 1am IST would land on yesterday;
 * and the claimed `ai_cache.payload` goes through `j()`, since that column is TEXT
 * here rather than `jsonb` with `pg` parsing it on the way out.
 *
 * Two statements deliberately keep `RETURNING` rather than taking the cheaper route,
 * and both would be bugs the other way:
 *
 *   - `markPaid` needs seven columns of the row *as updated*, which only `RETURNING`
 *     can give, and its `UPDATE … WHERE status = 'upcoming'` is also the lock: a
 *     second tap matches nothing, returns no row, and rolls nothing.
 *   - `duplicateBill`'s `INSERT … SELECT` inserts nothing when the source bill is
 *     gone. `lastInsertRowId` is a property of the *connection*, so on a zero-row
 *     insert it still holds whatever the previous insert left there — it would hand
 *     back a real but unrelated bill id. `RETURNING id` through `q1` gives null,
 *     which is exactly what the web's `q1` gave.
 */

import { j, q, q1, tx } from "@/lib/db";
import { nextOccurrence, type Recurrence } from "@/lib/recurrence";
import { deleteUpload, saveUpload, type SavedFile } from "@/lib/files";
import { FormData } from "@/lib/form-data";
import {
  done, fail, invalidToState, optDate, optInt, optStr, pick, pickedFiles,
  refreshAll, reqAmount, reqDate, reqText, str, type FormState,
} from "./shared";
import type { ScanDraft } from "@/lib/queries/scan";
import { STORED_NAME } from "@/lib/upload-meta";
import type { Attachment, BillStatus, Kind } from "@/lib/types";

const RECURRENCES = ["none", "weekly", "monthly", "quarterly", "yearly"] as const;
const STATUSES = ["paid", "upcoming"] as const;
const KINDS = ["expense", "income"] as const;

/**
 * Create (id === null) or update one bill, plus any newly attached files.
 *
 * Bound as `saveBill.bind(null, id)` so the signature matches what `<Form>` calls.
 */
export async function saveBill(
  id: number | null,
  _prev: FormState,
  fd: FormData,
): Promise<FormState> {
  const errs: Record<string, string> = {};

  const merchant = reqText(fd, "merchant", errs, "Merchant", 200);
  const amount_minor = reqAmount(fd, "amount", errs);
  const status = pick<BillStatus>(fd, "status", STATUSES);
  const kind = pick<Kind>(fd, "kind", KINDS);
  const recurrence = pick<Recurrence>(fd, "recurrence", RECURRENCES);
  const txn_date = reqDate(fd, "txn_date", errs, "Date");
  let due_date = optDate(fd, "due_date", errs, "Due date");
  const category_id = optInt(fd, "category_id");
  const notes = optStr(fd, "notes", 2000);

  // An upcoming bill with no due date cannot be chased, sorted or forecast, so
  // the transaction date stands in as the date it is expected on.
  if (status === "upcoming" && !due_date) due_date = txn_date;

  const files = pickedFiles(fd);

  // A scanned bill arrives with its file already stored — the upload happened
  // before the extraction, so this form adopts that file rather than uploading it
  // again. Only ever on create: editing a bill must not rewrite its provenance.
  const scan = id === null ? str(fd, "scan", 64) : "";

  const saved: SavedFile[] = [];
  try {
    done(errs);

    for (const f of files) saved.push(await saveUpload(f));

    // The transaction returns the id rather than assigning an outer `let`, which is
    // the one structural change in this function. `redirect()` used to be the last
    // statement and it threw, so the web could leave `billId` as `number | null` and
    // interpolate it; a caller that has to *navigate* with the id needs a `number`,
    // and taking it as the transaction's result is how it gets one without an
    // assertion.
    const billId = await tx(async (c): Promise<number> => {
      // Claiming the draft with a DELETE … RETURNING is what makes a double submit
      // safe. Two bills adopting one file would each own an attachment row for it,
      // and deleting either would unlink the file out from under the other.
      let adopted: SavedFile | null = null;
      if (scan && STORED_NAME.test(scan)) {
        const claim = await c.query<{ payload: string | null }>(
          "DELETE FROM ai_cache WHERE kind = 'scan' AND scope = ?1 RETURNING payload",
          [scan],
        );
        adopted = j<ScanDraft>(claim.rows[0]?.payload)?.file ?? null;
      }

      let rowId: number;
      if (id === null) {
        const ins = await c.query(
          `INSERT INTO bills (merchant, amount_minor, txn_date, due_date, status, kind,
                              category_id, notes, recurrence, source)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`,
          [merchant, amount_minor, txn_date, due_date, status, kind, category_id, notes, recurrence,
           adopted ? "ai" : "manual"],
        );
        rowId = ins.lastInsertRowId;
      } else {
        const row = await c.query(
          `UPDATE bills SET merchant=?2, amount_minor=?3, txn_date=?4, due_date=?5, status=?6,
                            kind=?7, category_id=?8, notes=?9, recurrence=?10
           WHERE id=?1`,
          [id, merchant, amount_minor, txn_date, due_date, status, kind, category_id, notes, recurrence],
        );
        if (row.rowCount === 0) throw new Error("That bill no longer exists.");
        rowId = id;
      }

      // The scanned file goes first, so the bill's cover image is the one that was
      // actually read rather than whatever else got dropped in afterwards.
      for (const f of adopted ? [adopted, ...saved] : saved) {
        await c.query(
          `INSERT INTO attachments (bill_id, file_name, original_name, mime_type, size_bytes)
           VALUES (?1,?2,?3,?4,?5)`,
          [rowId, f.file_name, f.original_name, f.mime_type, f.size_bytes],
        );
      }

      return rowId;
    });

    refreshAll();
    return { savedId: billId };
  } catch (e) {
    // The attachments directory is not transactional: anything written before the
    // failure has to be taken back by hand, or it sits in the app's sandbox until
    // the app is uninstalled. The adopted scan is deliberately not in this list —
    // its claim rolled back with the transaction, so the draft still owns it.
    await Promise.all(saved.map((f) => deleteUpload(f.file_name)));
    return invalidToState(e);
  }
}

/** Attach files to a bill that already exists — the detail screen's picker. */
export async function addAttachments(
  billId: number,
  _prev: FormState,
  fd: FormData,
): Promise<FormState> {
  const files = pickedFiles(fd);
  if (files.length === 0) return fail("Choose at least one file to attach.");

  const saved: SavedFile[] = [];
  try {
    for (const f of files) saved.push(await saveUpload(f));
    await tx(async (c) => {
      for (const f of saved) {
        await c.query(
          `INSERT INTO attachments (bill_id, file_name, original_name, mime_type, size_bytes)
           VALUES (?1,?2,?3,?4,?5)`,
          [billId, f.file_name, f.original_name, f.mime_type, f.size_bytes],
        );
      }
    });
  } catch (e) {
    await Promise.all(saved.map((f) => deleteUpload(f.file_name)));
    return invalidToState(e);
  }

  refreshAll();
  return null;
}

export async function deleteAttachment(id: number): Promise<void> {
  const row = await q1<Attachment>("DELETE FROM attachments WHERE id = ?1 RETURNING *", [id]);
  if (row) await deleteUpload(row.file_name);
  refreshAll();
}

/**
 * Marks a bill paid and, when it recurs, writes the next occurrence.
 *
 * This is the only place the app manufactures a bill row. It is deliberately
 * idempotent: if the next occurrence already exists — a double tap, or a
 * previous roll — nothing is inserted.
 */
export async function markPaid(id: number): Promise<void> {
  await tx(async (c) => {
    const bill = await c.query<{
      due_date: string | null; txn_date: string; recurrence: Recurrence;
      merchant: string; amount_minor: number; kind: Kind; category_id: number | null;
      notes: string | null;
    }>(
      `UPDATE bills
          SET status = 'paid',
              -- A bill paid on its due date is what the journal should show; the
              -- original txn_date was only ever the date it was entered.
              txn_date = COALESCE(due_date, txn_date)
        WHERE id = ?1 AND status = 'upcoming'
        RETURNING due_date, txn_date, recurrence, merchant, amount_minor, kind, category_id, notes`,
      [id],
    );
    const b = bill.rows[0];
    if (!b || b.recurrence === "none") return;

    const next = nextOccurrence(b.due_date ?? b.txn_date, b.recurrence);
    if (!next) return;

    const exists = await c.query(
      "SELECT 1 FROM bills WHERE parent_bill_id = ?1 AND due_date = ?2",
      [id, next],
    );
    if (exists.rowCount) return;

    await c.query(
      `INSERT INTO bills (merchant, amount_minor, txn_date, due_date, status, kind,
                          category_id, notes, recurrence, parent_bill_id)
       VALUES (?1,?2,?3,?3,'upcoming',?4,?5,?6,?7,?8)`,
      [b.merchant, b.amount_minor, next, b.kind, b.category_id, b.notes, b.recurrence, id],
    );
  });
  refreshAll();
}

/** Undo — back to upcoming, without deleting the occurrence that was rolled. */
export async function markUpcoming(id: number): Promise<void> {
  await q("UPDATE bills SET status = 'upcoming', due_date = COALESCE(due_date, txn_date) WHERE id = ?1", [id]);
  refreshAll();
}

export async function deleteBill(id: number): Promise<void> {
  // The rows go with the bill via ON DELETE CASCADE; the files do not.
  const files = await q<{ file_name: string }>(
    "SELECT file_name FROM attachments WHERE bill_id = ?1",
    [id],
  );
  await q("DELETE FROM bills WHERE id = ?1", [id]);
  await Promise.all(files.map((f) => deleteUpload(f.file_name)));
  refreshAll();
}

/**
 * Duplicate, for the "same bill again" case. The copy lands on today, unpaid
 * recurrence cleared, and opens in the editor — a duplicate you cannot see
 * before it is saved is just a surprise row in the journal.
 *
 * Returns the new id for the screen to navigate to, or `null` when the bill being
 * copied has already been deleted — the caller falls back to the Journal, which is
 * what `redirect(row ? … : "/journal")` did.
 */
export async function duplicateBill(id: number): Promise<number | null> {
  const row = await q1<{ id: number }>(
    `INSERT INTO bills (merchant, amount_minor, txn_date, due_date, status, kind,
                        category_id, notes, recurrence, source)
     SELECT merchant, amount_minor, date('now','localtime'), NULL, 'paid', kind,
            category_id, notes, 'none', 'manual'
       FROM bills WHERE id = ?1
     RETURNING id`,
    [id],
  );
  refreshAll();
  return row?.id ?? null;
}
