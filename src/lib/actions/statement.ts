/**
 * Uploading a statement, and turning the rows you ticked into bills.
 *
 * Two actions, deliberately far apart. `uploadStatement` writes the file, parses it
 * once to find out how big it is, and records the batch — it adds no bills at all.
 * `commitStatement` is the only thing here that writes to `bills`, and it only writes
 * what you ticked on the review screen. Nothing in this file inserts a bill you have
 * not seen.
 *
 * The commit re-parses the stored file rather than trusting the screen for the rows.
 * The form says which lines to take and carries your corrections to four fields; the
 * line *set* comes from the file. That means a stale screen — one left open while the
 * same batch was committed in another tab of the app's navigation stack — can change
 * what a row says but cannot invent a row, and a batch committed twice is impossible
 * because `committed_at` is checked inside the transaction.
 *
 * ---
 *
 * **The web app's `src/lib/actions/statement.ts`, with four changes.** Three of them
 * are the same three changes every action in this directory makes, and the fourth is
 * about a hash.
 *
 * **1. Navigation comes back as a value.** The web ended `uploadStatement` with
 * ``redirect(`/journal/statement/${batchId}${existingBatch ? "?seen=1" : ""}`)`` and
 * `commitStatement` with a redirect carrying a *problem code* in the query string. A
 * module here has no router, so `uploadStatement` returns `{ savedId, seenBefore }`
 * and `commitStatement` returns a `CommitResult`. The screens navigate.
 *
 * The web's reason for sending a code rather than a message survives the change and
 * is worth restating, because it is easy to read the result type below as a needless
 * indirection: *"a message in a URL is a message an attacker can choose, and this
 * screen is about to ask you to trust what it says."* The URL is gone, but the
 * property it protected is the one that matters — the sentences live on the screen
 * that shows them, in `app/statement/[id].tsx`'s `problemText`, and this module only
 * ever names an outcome.
 *
 * **2. Dialect.** `$n` → `?n` and `now()` → `datetime('now')`. Both of the web's
 * `RETURNING` clauses stay, which is the opposite of what the other action modules
 * here did — they each note replacing it with `lastInsertRowId`, and this one does
 * not, for a reason worth writing down rather than looking like an oversight.
 *
 * `lastInsertRowId` is only reachable through a `Result`, which means `c.query` inside
 * `tx`; `q1` returns rows and nothing else. `goals.ts` and `holdings.ts` were already
 * inside a transaction for other reasons, so taking the id from the connection cost
 * them nothing. The batch insert here is one statement with nothing to be atomic with,
 * and wrapping it in an exclusive transaction purely to read a counter would be the
 * tail wagging the dog. `deleteBatch` has no choice at all: it needs a column from the
 * row it is deleting, which is what the web used `RETURNING` for too.
 *
 * Neither is the dangerous case the other modules are guarding against. That case is
 * `INSERT … SELECT`, where a missing source row inserts nothing and leaves
 * `lastInsertRowId` holding the *previous* insert's value — a real but unrelated id
 * reported as success. These two statements have no SELECT to come up empty.
 *
 * **3. `File` → `PickedFile`.** `fd.get("file") instanceof File` becomes
 * `pickedFiles(fd, "file")[0]`, and the bytes are not in hand: a picker gives a
 * `file://` URI. So `saveStatement` copies and `src/lib/statement/parse.ts` takes a
 * `StatementSource` that has already been read the right way for its format. See that
 * file's header for why its input is a discriminated union rather than bytes.
 *
 * **4. The digest is of the base64 text, not of the bytes.** Documented at length on
 * `digest()` below, because it is the one place where the same file produces a
 * different value on the two platforms.
 */

import * as Crypto from "expo-crypto";
import { q1, tx } from "@/lib/db";
import {
  deleteUpload, readPickedBase64, readUploadBase64, readUploadText, saveStatement,
  type PickedFile, type SavedFile,
} from "@/lib/files";
import { FormData } from "@/lib/form-data";
import { getCategories } from "@/lib/queries/bills";
import { existingSignatures, getBatch, getBatchBySha, learnedCategories } from "@/lib/queries/statements";
import { parseStatementAmount } from "@/lib/statement/amount";
import { parseStatement, statementFormat, type StatementSource } from "@/lib/statement/parse";
import { forgetPassword, recallPassword, rememberPassword } from "@/lib/statement/password";
import { fail, invalidToState, optInt, pickedFiles, refreshAll, str, type FormState } from "./shared";
import type { Kind, StatementBatch } from "@/lib/types";

/**
 * What a commit did, for the review screen to turn into words.
 *
 * `problem` is a name, never a sentence — see point 1 of the file header. The five
 * names are the web's five query-string codes plus one it did not need: `stale`
 * stands for the two cases the web handled by redirecting to the same screen and
 * letting it re-render, which a screen that navigates nowhere has to be told about
 * instead. Those two cases are "already imported" and "the file is gone", and the
 * review screen has its own card for each.
 */
export type CommitResult =
  | { ok: true; added: number; skipped: number }
  | { ok: false; problem: "gone" | "stale" | "none" | "unusable" | "failed"; skipped: number };

/**
 * SHA-256 of a picked file, before it has been copied anywhere.
 *
 * **This is not the same number the web computes for the same file, and that is
 * fine.** `createHash("sha256").update(bytes)` there hashes the file's bytes; there is
 * no byte-array hash on this platform, so this hashes the *base64 text* of those
 * bytes. Same file, same string, same digest — but a different digest from the web's,
 * for the same PDF.
 *
 * It costs nothing because of what the value is actually for. `sha256` is only ever
 * compared against `statement_batches.sha256` in the same SQLite database on the same
 * phone, to answer "have I already stored this exact file?". It is not an identifier
 * anything outside this app has ever seen, it is not in a backup's cross-platform
 * contract, and it is not a checksum anyone verifies by hand. A digest only has to be
 * stable and collision-resistant over its own population, and hashing a bijective
 * encoding of the bytes is both.
 *
 * It is read from `file.uri` rather than from the stored copy, which is what lets the
 * duplicate check happen *before* `saveStatement` writes anything — the same order the
 * web uses, and the reason uploading the same statement twice does not leave two
 * copies of a 6 MB PDF in the app's sandbox. That URI comes from the picker with
 * `copyToCacheDirectory`, so it is already a readable `file://` path and does not go
 * through `resolveStored`'s gate: nothing of ours is at that name yet.
 *
 * The base64 of a large PDF is a long string — a 6 MB file is an 8 MB one. That is
 * within the 12 MB cap `files.ts` enforces, it exists for one statement at a time, and
 * it is the same string the PDF reader is about to be handed anyway.
 */
async function digest(uri: string): Promise<string> {
  const base64 = await readPickedBase64(uri);
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, base64);
}

/**
 * Reads a stored statement the way its format needs.
 *
 * The web passed `{ buf, mimeType }` and let `extract` decide. Here the decision has
 * to come first, because the two formats are different *reads*: a PDF has to arrive
 * base64-encoded, because that is what crosses into the WebView, and a CSV has to
 * arrive as text, because `readCsv` splits characters. `statementFormat` refuses
 * anything else with the web's sentence, so an unsupported type fails here rather than
 * producing an empty parse.
 */
async function sourceFor(fileName: string, mimeType: string): Promise<StatementSource> {
  const format = statementFormat(mimeType);
  return format === "pdf"
    ? { format, base64: await readUploadBase64(fileName) }
    : { format, text: await readUploadText(fileName) };
}

/**
 * Stores one statement and records it, then hands back the batch to review.
 *
 * The parse happens here as well as on review — once to learn the page and row count,
 * and because a file that cannot be read should say so on the screen you uploaded it
 * from, not on the next one. A failure takes the written file back out with it.
 */
export async function uploadStatement(_prev: FormState, fd: FormData): Promise<FormState> {
  const file: PickedFile | undefined = pickedFiles(fd, "file")[0];
  if (!file) {
    return fail("Choose a statement file to upload.", { file: "No file chosen." });
  }
  const password = str(fd, "password", 200);

  // The same file again. Nothing is written a second time — the existing batch is
  // either still waiting to be reviewed, in which case this is where you were going,
  // or it was already committed, and the review screen is where it says so.
  let existingBatch: StatementBatch | null = null;
  let saved: SavedFile | null = null;
  let batchId = 0;
  try {
    const sha256 = await digest(file.uri);

    existingBatch = await getBatchBySha(sha256);
    if (!existingBatch) {
      saved = await saveStatement(file);

      const [categories, learned, existing] = await Promise.all([
        getCategories(),
        learnedCategories(),
        existingSignatures(),
      ]);
      const parsed = await parseStatement({
        source: await sourceFor(saved.file_name, saved.mime_type),
        password: password || undefined,
        categories,
        learned,
        existing,
      });

      const ins = await q1<{ id: number }>(
        `INSERT INTO statement_batches
           (file_name, original_name, mime_type, size_bytes, sha256, page_count, row_count)
         VALUES (?1,?2,?3,?4,?5,?6,?7) RETURNING id`,
        [saved.file_name, saved.original_name, saved.mime_type, saved.size_bytes, sha256,
         parsed.page_count, parsed.rows.length],
      );
      if (!ins) throw new Error("The statement could not be recorded.");
      batchId = ins.id;
    } else {
      batchId = existingBatch.id;
    }

    await rememberPassword(batchId, password);
  } catch (e) {
    if (saved) await deleteUpload(saved.file_name);
    return invalidToState(e);
  }

  refreshAll();
  return { savedId: batchId, seenBefore: existingBatch !== null };
}

/**
 * Supplies the password for a PDF that turned out to be locked, or that was uploaded
 * with the wrong one.
 *
 * Returns nothing, exactly as on the web, and for the same reason: there is no state to
 * report. If the password was right the screen reloads with the rows on it, and if it
 * was wrong the screen reloads with the same "wrong password" message it already had.
 * `refreshAll()` is what makes "reloads" happen — every screen's `useLive` re-runs its
 * loader, and this screen's loader is the parse.
 */
export async function unlockStatement(batchId: number, fd: FormData): Promise<void> {
  await rememberPassword(batchId, str(fd, "password", 200));
  refreshAll();
}

/**
 * Turns the ticked rows into bills.
 *
 * Per-row fields are keyed by the line number the row came from, so the form stays
 * correct even though the rows themselves are never stored: `on-7`, `merchant-7`,
 * `date-7`, `amount-7`, `kind-7`, `category-7`.
 *
 * The review screen builds that `FormData` from its own edit state at the moment you
 * submit. It is the web's form, assembled by hand because there is no `<form>` to
 * serialise — and keeping the shape means every reader below is the web's code,
 * including the four `str(fd, …)` calls and the `optInt` for the category.
 *
 * A row that is ticked but still broken — no date, an amount that will not parse — is
 * counted as skipped rather than failing the whole import, because one unreadable
 * line out of two hundred should not cost you the other hundred and ninety-nine.
 */
export async function commitStatement(batchId: number, fd: FormData): Promise<CommitResult> {
  try {
    const batch = await getBatch(batchId);
    if (!batch) return { ok: false, problem: "gone", skipped: 0 };
    // The review screen says both of these for itself when it reloads — an
    // already-imported batch and a vanished file each have their own card there.
    if (batch.committed_at || !batch.file_name) return { ok: false, problem: "stale", skipped: 0 };

    return await addTickedRows(batchId, batch.file_name, batch.mime_type, fd);
  } catch (e) {
    // Worth a line in the log: unlike a row that would not parse, this is the app
    // failing rather than the file being awkward.
    console.error("commitStatement", e);
    return { ok: false, problem: "failed", skipped: 0 };
  } finally {
    // In the `finally` rather than after each return, because every one of the five
    // outcomes above wants it: the counts on the batch list change on success, and on
    // failure the review screen has to re-render whatever it now says.
    refreshAll();
  }
}

/**
 * The commit itself, split out only so the error handling above stays one level deep.
 *
 * The web split it for a sharper reason — `redirect()` worked by throwing, so calling
 * it inside the try would have landed in the catch and been reported as a failure of
 * the thing that had just succeeded. Nothing throws to navigate here, so the split is
 * now only about length.
 */
async function addTickedRows(
  batchId: number,
  fileName: string,
  mimeType: string,
  fd: FormData,
): Promise<CommitResult> {
  let skipped = 0;
  const holding_id = optInt(fd, "holding_id");

  const [categories, learned, existing] = await Promise.all([
    getCategories(),
    learnedCategories(),
    existingSignatures(),
  ]);
  const parsed = await parseStatement({
    source: await sourceFor(fileName, mimeType),
    password: await recallPassword(batchId),
    categories,
    learned,
    existing,
  });

  const kindOf = new Map(categories.map((c) => [c.id, c.kind]));

  type Insert = {
    merchant: string; amount_minor: number; txn_date: string; kind: Kind;
    category_id: number | null; notes: string;
  };
  const inserts: Insert[] = [];

  for (const row of parsed.rows) {
    if (str(fd, `on-${row.line}`, 10) === "") {
      // Unticked: a duplicate you left alone, or a line you did not want.
      continue;
    }

    const merchant = str(fd, `merchant-${row.line}`, 200) || row.merchant;
    const date = str(fd, `date-${row.line}`, 10) || row.txn_date || "";
    const amountRaw = str(fd, `amount-${row.line}`, 30);
    const amount_minor = amountRaw ? parseStatementAmount(amountRaw)?.minor ?? 0 : row.amount_minor;
    const kind: Kind = str(fd, `kind-${row.line}`, 10) === "income" ? "income" : "expense";

    const chosen = optInt(fd, `category-${row.line}`);
    // A category belongs to one side of the ledger. If the row's direction was
    // corrected after the category was chosen, drop the category rather than file
    // a refund under Salary.
    const category_id = chosen !== null && kindOf.get(chosen) === kind ? chosen : null;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || amount_minor <= 0 || !merchant) {
      skipped++;
      continue;
    }

    inserts.push({
      merchant,
      amount_minor,
      txn_date: date,
      kind,
      category_id,
      // The statement's own words, kept verbatim. This is what lets a row you do
      // not recognise be identified later; the merchant is only ever a reading of it.
      notes: row.narration.slice(0, 2000),
    });
  }

  // Nothing to do, and nothing claimed: the batch is left uncommitted so the same
  // screen can be corrected and submitted again.
  if (inserts.length === 0) {
    return { ok: false, problem: skipped > 0 ? "unusable" : "none", skipped };
  }

  await tx(async (c) => {
    // Re-checked inside the transaction: two submits racing each other both pass
    // the check above, and only one of them can pass this one.
    const claim = await c.query(
      "UPDATE statement_batches SET committed_at = datetime('now') WHERE id = ?1 AND committed_at IS NULL",
      [batchId],
    );
    if (claim.rowCount === 0) throw new Error("That statement has already been imported.");

    for (const r of inserts) {
      await c.query(
        `INSERT INTO bills (merchant, amount_minor, txn_date, due_date, status, kind,
                            category_id, notes, recurrence, source, holding_id, statement_batch_id)
         VALUES (?1,?2,?3,NULL,'paid',?4,?5,?6,'none','manual',?7,?8)`,
        [r.merchant, r.amount_minor, r.txn_date, r.kind, r.category_id, r.notes, holding_id, batchId],
      );
    }

    await c.query("UPDATE statement_batches SET added_count = ?2 WHERE id = ?1", [batchId, inserts.length]);
  });

  await forgetPassword(batchId);
  return { ok: true, added: inserts.length, skipped };
}

/**
 * Forgets an import. The bills it created stay — `statement_batch_id` is ON DELETE
 * SET NULL — because a row you have already checked and kept is yours, not the
 * importer's. Only the record of the file and the file itself go.
 */
export async function deleteBatch(id: number): Promise<void> {
  const row = await q1<{ file_name: string | null }>(
    "DELETE FROM statement_batches WHERE id = ?1 RETURNING file_name",
    [id],
  );
  if (row?.file_name) await deleteUpload(row.file_name);
  await forgetPassword(id);
  refreshAll();
}
