/**
 * Bill reads — `Finance/src/lib/queries/bills.ts`, in SQLite.
 *
 * Every function keeps its name, its parameters and its return type. What changed
 * is only dialect:
 *
 *   - **`$1` became `?1`.** SQLite's `?NNN` form is numbered exactly like
 *     Postgres', so the translation is one character and a parameter used twice
 *     stays one parameter — which is what `listBills`' search clause needs. Plain
 *     `?` would have meant recounting positions by hand in every statement, and a
 *     miscount is a silent wrong answer, not an error.
 *   - **`::int` / `::bigint` dropped.** SQLite has no cast syntax to translate and
 *     needs none: `count(*)` and `sum()` over INTEGER already arrive as numbers.
 *   - **`NOT archived` became `archived = 0`.** `NOT 0` is in fact 1 in SQLite, so
 *     the original would have worked, but a column holding 0/1 reads better
 *     compared than negated now that it is not a real boolean.
 *   - **`ILIKE` became `LIKE`**, which is already case-insensitive for ASCII.
 *
 * Rows come back with `archived` as 0/1, so `getCategories` maps through `b()`.
 * Bills have no boolean column, which is why nothing else here needs it.
 */

import { b, q, q1 } from "../db";
import type { ISODate, MonthKey } from "../date";
import { monthBounds, today } from "../date";
import type { Attachment, BillRow, BillStatus, Category } from "../types";

const BILL_SELECT = `
  SELECT b.*,
         c.name  AS category_name,
         c.color AS category_color,
         c.icon  AS category_icon,
         (SELECT count(*) FROM attachments a WHERE a.bill_id = b.id) AS attachment_count
  FROM bills b
  LEFT JOIN categories c ON c.id = b.category_id`;

export async function getCategories(includeArchived = false): Promise<Category[]> {
  const rows = await q<Category>(
    `SELECT * FROM categories ${includeArchived ? "" : "WHERE archived = 0"}
     ORDER BY kind, sort_order, name`,
  );
  return rows.map((r) => ({ ...r, archived: b(r.archived) }));
}

export async function getBill(id: number): Promise<BillRow | null> {
  return q1<BillRow>(`${BILL_SELECT} WHERE b.id = ?1`, [id]);
}

export async function getAttachments(billId: number): Promise<Attachment[]> {
  return q<Attachment>("SELECT * FROM attachments WHERE bill_id = ?1 ORDER BY id", [billId]);
}

export async function getAttachment(id: number): Promise<Attachment | null> {
  return q1<Attachment>("SELECT * FROM attachments WHERE id = ?1", [id]);
}

/**
 * The Journal query. `search` matches merchant or notes; an empty month means
 * "all time". Paid and upcoming are both returned — the Journal groups by day
 * and an upcoming bill belongs on its due date.
 */
export async function listBills(opts: {
  month?: MonthKey | null;
  monthStartDay?: number;
  search?: string;
  categoryId?: number | null;
  kind?: "expense" | "income" | null;
  status?: BillStatus | null;
  limit?: number;
  offset?: number;
}): Promise<BillRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (opts.month) {
    const { start, end } = monthBounds(opts.month, opts.monthStartDay ?? 1);
    params.push(start, end);
    where.push(`COALESCE(b.due_date, b.txn_date) BETWEEN ?${params.length - 1} AND ?${params.length}`);
  }
  if (opts.search?.trim()) {
    params.push(`%${opts.search.trim()}%`);
    // One parameter, two references — which numbered placeholders give for free.
    where.push(`(b.merchant LIKE ?${params.length} OR b.notes LIKE ?${params.length})`);
  }
  if (opts.categoryId) {
    params.push(opts.categoryId);
    where.push(`b.category_id = ?${params.length}`);
  }
  if (opts.kind) {
    params.push(opts.kind);
    where.push(`b.kind = ?${params.length}`);
  }
  if (opts.status) {
    params.push(opts.status);
    where.push(`b.status = ?${params.length}`);
  }

  params.push(opts.limit ?? 200, opts.offset ?? 0);
  return q<BillRow>(
    `${BILL_SELECT}
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY COALESCE(b.due_date, b.txn_date) DESC, b.id DESC
     LIMIT ?${params.length - 1} OFFSET ?${params.length}`,
    params,
  );
}

/** Next unpaid bills by due date. The Home "Upcoming" card and the forecast both use this. */
export async function listUpcoming(limit = 5): Promise<BillRow[]> {
  return q<BillRow>(
    `${BILL_SELECT}
     WHERE b.status = 'upcoming' AND b.due_date IS NOT NULL
     ORDER BY b.due_date ASC LIMIT ?1`,
    [limit],
  );
}

/** Overdue count, for the badge on the tab bar. */
export async function countOverdue(): Promise<number> {
  const row = await q1<{ n: number }>(
    "SELECT count(*) AS n FROM bills WHERE status = 'upcoming' AND due_date < ?1",
    [today()],
  );
  return row?.n ?? 0;
}

/** All recurring templates — the subscriptions page and the cashflow forecast. */
export async function listRecurring(): Promise<BillRow[]> {
  return q<BillRow>(
    `${BILL_SELECT} WHERE b.recurrence <> 'none' ORDER BY b.amount_minor DESC`,
  );
}

/**
 * The recurrence chain around one bill: the occurrence it was rolled from, and
 * every occurrence rolled from it.
 */
export async function listRelated(bill: { id: number; parent_bill_id: number | null }): Promise<BillRow[]> {
  return q<BillRow>(
    `${BILL_SELECT}
     WHERE b.parent_bill_id = ?1 OR b.id = ?2
     ORDER BY COALESCE(b.due_date, b.txn_date) DESC`,
    [bill.id, bill.parent_bill_id],
  );
}

/**
 * Previous bills from the same merchant. The detail page uses this to answer
 * "is this one more than usual?" without any modelling — `lower(merchant)`
 * matches the index, so it stays cheap.
 */
export async function listByMerchant(
  merchant: string,
  excludeId: number,
  limit = 6,
): Promise<BillRow[]> {
  return q<BillRow>(
    `${BILL_SELECT}
     WHERE lower(b.merchant) = lower(?1) AND b.id <> ?2 AND b.status = 'paid'
     ORDER BY b.txn_date DESC LIMIT ?3`,
    [merchant, excludeId, limit],
  );
}

/** Raw rows for the statistical subscription detector — 18 months is plenty of signal. */
export async function billsForDetection(since: ISODate): Promise<
  { merchant: string; amount_minor: number; txn_date: ISODate; category_id: number | null }[]
> {
  return q(
    `SELECT merchant, amount_minor, txn_date, category_id
     FROM bills
     WHERE kind = 'expense' AND txn_date >= ?1
     ORDER BY lower(merchant), txn_date`,
    [since],
  );
}
