/**
 * What the importer needs to know about what is already in the database.
 *
 * Three of these four reads exist to make the parse smarter rather than to render a
 * screen. `learnedCategories` is the whole reason the importer can file a row without
 * being told to: the bills already entered by hand are a better categorisation model
 * than any rule table, because they were labelled by the person whose spending it is.
 * `existingSignatures` is what makes a re-upload of an overlapping period survivable.
 *
 * Both are read in full rather than queried per row. A statement is a few hundred
 * lines and the bills table is a few hundred rows; a round trip each would be hundreds
 * of queries to answer a question two scans of memory can answer.
 *
 * ---
 *
 * The web app's `src/lib/queries/statements.ts`, with the SQL in SQLite's dialect:
 * `$1` becomes `?`, and `count(*)::int` becomes `count(*)` — SQLite has one integer
 * type and `count` already returns it, where Postgres's `count` is a `bigint` the web
 * has to cast so `pg` hands back a number instead of a string. Nothing else changes;
 * the two `GROUP BY` shapes and both tie-breaks are the web's.
 */

import { q, q1 } from "../db";
import { learnedKey, type LearnedMap } from "../statement/categorise";
import { signature } from "../statement/dedupe";
import type { ISODate } from "../date";
import type { Kind, StatementBatch } from "../types";

export async function getBatch(id: number): Promise<StatementBatch | null> {
  return q1<StatementBatch>("SELECT * FROM statement_batches WHERE id = ?", [id]);
}

export async function getBatchBySha(sha256: string): Promise<StatementBatch | null> {
  return q1<StatementBatch>("SELECT * FROM statement_batches WHERE sha256 = ?", [sha256]);
}

export async function listBatches(limit = 20): Promise<StatementBatch[]> {
  return q<StatementBatch>("SELECT * FROM statement_batches ORDER BY created_at DESC LIMIT ?", [limit]);
}

/**
 * How many bills came from a batch.
 *
 * Unused on the web, and wired up here: the batch list shows it, because on a phone
 * the list is the only place an import is visible afterwards and "43 transactions"
 * next to a filename is the difference between a record and a row of dates. The
 * `WHERE statement_batch_id = ?` index added in migration rung 2 is partial
 * (`WHERE statement_batch_id IS NOT NULL`), which is exactly the shape this needs.
 */
export async function batchBillCount(id: number): Promise<number> {
  const row = await q1<{ n: number }>("SELECT count(*) AS n FROM bills WHERE statement_batch_id = ?", [id]);
  return row?.n ?? 0;
}

/**
 * Every merchant you have categorised, reduced to one answer each.
 *
 * The grouping is done in SQL and the *choosing* in TypeScript, because the key is
 * `normaliseMerchant`, which SQL cannot compute — "NETFLIX.COM 4432" and
 * "Netflix India" have to collapse to the same key as the statement's own spelling of
 * it, and that normaliser already exists in one place for recurring-payment
 * detection. Reimplementing it as SQL would be a second copy free to drift.
 *
 * Ties are broken on the most recent use, so moving Swiggy from Dining to Groceries
 * takes effect as soon as the counts are level rather than after you have outvoted
 * your own history.
 */
export async function learnedCategories(): Promise<LearnedMap> {
  const rows = await q<{
    merchant: string;
    kind: Kind;
    category_id: number;
    n: number;
    last_used: ISODate;
  }>(
    `SELECT merchant, kind, category_id, count(*) AS n, max(txn_date) AS last_used
       FROM bills
      WHERE category_id IS NOT NULL
      GROUP BY merchant, kind, category_id`,
  );

  const best = new Map<string, { id: number; n: number; last: ISODate }>();
  for (const r of rows) {
    const key = learnedKey(r.kind, r.merchant);
    // An empty key means the merchant normalised away to nothing — a row called
    // "UPI" or "payment". It cannot identify anything, so it must not teach anything.
    if (key.endsWith(":")) continue;
    const held = best.get(key);
    if (!held || r.n > held.n || (r.n === held.n && r.last_used > held.last)) {
      best.set(key, { id: r.category_id, n: r.n, last: r.last_used });
    }
  }

  const out: LearnedMap = new Map();
  for (const [key, v] of best) out.set(key, v.id);
  return out;
}

/**
 * Signature → the id of the bill that already covers it.
 *
 * Built from every bill rather than only the statement's own date range, because the
 * range is not known until the file has been parsed and the whole table is small
 * enough that narrowing it would be a false economy. Where two bills share a
 * signature the later id wins, which is arbitrary and harmless: the review screen
 * only uses it to say "this looks like one you already have".
 */
export async function existingSignatures(): Promise<Map<string, number>> {
  const rows = await q<{ id: number; txn_date: ISODate; amount_minor: number; merchant: string }>(
    "SELECT id, txn_date, amount_minor, merchant FROM bills",
  );
  const out = new Map<string, number>();
  for (const r of rows) out.set(signature(r.txn_date, r.amount_minor, r.merchant), r.id);
  return out;
}
