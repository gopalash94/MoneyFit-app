/**
 * Aggregate reads — `Finance/src/lib/queries/stats.ts`, in SQLite.
 *
 * Four translations carry this file:
 *
 *   - **`generate_series($1::date, $2::date, interval '1 day')` → a recursive
 *     CTE.** ISO dates are strings that sort correctly, so `date(day, '+1 day')`
 *     steps and `day < ?2` stops. The anchor carries `WHERE ?1 <= ?2` so an
 *     inverted range yields no rows, which is what generate_series did — the
 *     recursion alone would still have emitted the first day.
 *   - **`FULL OUTER JOIN` → a LEFT JOIN plus the rows it missed.** SQLite has
 *     supported FULL OUTER JOIN since 3.39, but the version on a given Android
 *     build is whatever that build shipped, and nobody here can run it. The
 *     UNION ALL form works on every version, and `categoryMoM` is the one place
 *     that needed it.
 *   - **Repeated parameters stay single parameters.** `budgetStatus` references
 *     `?3` in its select list *before* `?1` and `?2` appear, and again in its
 *     EXISTS; `overallBudget` uses `?1` twice. With bare `?` both would have
 *     needed the array reordered and duplicated. Numbered placeholders mean the
 *     parameter arrays below are byte-identical to the originals.
 *   - **`to_char(d, 'YYYY-MM')` → `substr(d, 1, 7)`**, and
 *     `to_char(d, 'YYYY-MM-DD')` → the column itself: it is already that string.
 *
 * `SUM(...) OVER (ORDER BY day)` in `burnDown` and `ORDER BY 5 DESC` in
 * `budgetStatus` are both fine as written — SQLite has had window functions since
 * 3.25 and has always ordered by output ordinal.
 */

import { q, q1 } from "../db";
import { monthBounds, type ISODate, type MonthKey } from "../date";

/** Total paid expense in a month — the blue ring's numerator. */
export async function spentInMonth(mk: MonthKey, startDay = 1): Promise<number> {
  const { start, end } = monthBounds(mk, startDay);
  const row = await q1<{ total: number }>(
    `SELECT COALESCE(SUM(amount_minor), 0) AS total
     FROM bills
     WHERE kind = 'expense' AND status = 'paid' AND txn_date BETWEEN ?1 AND ?2`,
    [start, end],
  );
  return row?.total ?? 0;
}

/**
 * Spend per day across a range, with zero-spend days present.
 *
 * The LEFT JOIN onto the day spine is what puts the gaps in: without it a quiet
 * Tuesday simply vanishes and the bar chart silently compresses time.
 */
export async function dailySpend(
  start: ISODate,
  end: ISODate,
): Promise<{ day: ISODate; total_minor: number }[]> {
  return q(
    `WITH RECURSIVE days(day) AS (
       SELECT ?1 WHERE ?1 <= ?2
       UNION ALL
       SELECT date(day, '+1 day') FROM days WHERE day < ?2
     )
     SELECT d.day AS day,
            COALESCE(SUM(b.amount_minor), 0) AS total_minor
     FROM days d
     LEFT JOIN bills b
            ON b.txn_date = d.day AND b.kind = 'expense' AND b.status = 'paid'
     GROUP BY d.day ORDER BY d.day`,
    [start, end],
  );
}

/** Category totals for a month, biggest first. */
export async function categoryBreakdown(
  mk: MonthKey,
  startDay = 1,
): Promise<
  { category_id: number | null; name: string; color: string; icon: string; total_minor: number; txn_count: number }[]
> {
  const { start, end } = monthBounds(mk, startDay);
  return q(
    `SELECT b.category_id,
            COALESCE(c.name, 'Uncategorised') AS name,
            COALESCE(c.color, '#80868B')      AS color,
            COALESCE(c.icon, 'receipt')       AS icon,
            SUM(b.amount_minor)               AS total_minor,
            count(*)                          AS txn_count
     FROM bills b
     LEFT JOIN categories c ON c.id = b.category_id
     WHERE b.kind = 'expense' AND b.status = 'paid' AND b.txn_date BETWEEN ?1 AND ?2
     GROUP BY b.category_id, c.name, c.color, c.icon
     ORDER BY total_minor DESC`,
    [start, end],
  );
}

/**
 * This month vs last month, per category, with the delta already computed.
 *
 * A full outer join rather than a left one: a category you spent on last month
 * and not this month is exactly the row you want to see (a -100% change), and a
 * LEFT JOIN from this month would drop it. Here that is spelled out as a LEFT
 * JOIN plus, unioned on, the previous-month rows with no current-month partner.
 *
 * `name` is `COALESCE(c.name, 'Uncategorised')` and so is never NULL, which is
 * what makes `NOT IN` safe — and what lets `COALESCE(cur.name, pre.name)`
 * collapse to the single `name` column each branch already supplies.
 */
export async function categoryMoM(
  mk: MonthKey,
  prev: MonthKey,
  startDay = 1,
): Promise<{ name: string; color: string; this_minor: number; prev_minor: number; delta_minor: number }[]> {
  const a = monthBounds(mk, startDay);
  const b = monthBounds(prev, startDay);
  return q(
    `WITH cur AS (
       SELECT COALESCE(c.name, 'Uncategorised') AS name, COALESCE(c.color, '#80868B') AS color,
              SUM(b.amount_minor) AS total
       FROM bills b LEFT JOIN categories c ON c.id = b.category_id
       WHERE b.kind = 'expense' AND b.status = 'paid' AND b.txn_date BETWEEN ?1 AND ?2
       GROUP BY 1, 2
     ), pre AS (
       SELECT COALESCE(c.name, 'Uncategorised') AS name, COALESCE(c.color, '#80868B') AS color,
              SUM(b.amount_minor) AS total
       FROM bills b LEFT JOIN categories c ON c.id = b.category_id
       WHERE b.kind = 'expense' AND b.status = 'paid' AND b.txn_date BETWEEN ?3 AND ?4
       GROUP BY 1, 2
     ), joined AS (
       SELECT cur.name AS name, cur.color AS color,
              cur.total AS cur_total, pre.total AS pre_total
       FROM cur LEFT JOIN pre ON pre.name = cur.name
       UNION ALL
       SELECT pre.name AS name, pre.color AS color,
              NULL AS cur_total, pre.total AS pre_total
       FROM pre WHERE pre.name NOT IN (SELECT name FROM cur)
     )
     SELECT name,
            color,
            COALESCE(cur_total, 0) AS this_minor,
            COALESCE(pre_total, 0) AS prev_minor,
            (COALESCE(cur_total, 0) - COALESCE(pre_total, 0)) AS delta_minor
     FROM joined
     ORDER BY abs(COALESCE(cur_total, 0) - COALESCE(pre_total, 0)) DESC`,
    [a.start, a.end, b.start, b.end],
  );
}

/** Income vs expense per month over a window. */
export async function cashflowByMonth(
  from: ISODate,
): Promise<{ month: MonthKey; income_minor: number; expense_minor: number; net_minor: number }[]> {
  return q(
    `SELECT substr(txn_date, 1, 7) AS month,
            COALESCE(SUM(CASE WHEN kind = 'income'  THEN amount_minor END), 0) AS income_minor,
            COALESCE(SUM(CASE WHEN kind = 'expense' THEN amount_minor END), 0) AS expense_minor,
            (COALESCE(SUM(CASE WHEN kind = 'income'  THEN amount_minor END), 0)
           - COALESCE(SUM(CASE WHEN kind = 'expense' THEN amount_minor END), 0)) AS net_minor
     FROM bills
     WHERE status = 'paid' AND txn_date >= ?1
     GROUP BY 1 ORDER BY 1`,
    [from],
  );
}

/** Total spend per month, for the trend line and the burn-rate forecast. */
export async function spendByMonth(
  from: ISODate,
): Promise<{ month: MonthKey; total_minor: number }[]> {
  return q(
    `SELECT substr(txn_date, 1, 7) AS month, SUM(amount_minor) AS total_minor
     FROM bills
     WHERE kind = 'expense' AND status = 'paid' AND txn_date >= ?1
     GROUP BY 1 ORDER BY 1`,
    [from],
  );
}

/**
 * Running total through the month — the budget burn-down line.
 * A window function over the daily series, so the chart gets a point per day
 * even on days with no spend.
 */
export async function burnDown(
  mk: MonthKey,
  startDay = 1,
): Promise<{ day: ISODate; cumulative_minor: number }[]> {
  const { start, end } = monthBounds(mk, startDay);
  return q(
    // RECURSIVE covers the whole WITH list; `daily` is an ordinary CTE that
    // happens to sit beside a recursive one, which SQLite allows.
    `WITH RECURSIVE days(day) AS (
       SELECT ?1 WHERE ?1 <= ?2
       UNION ALL
       SELECT date(day, '+1 day') FROM days WHERE day < ?2
     ), daily AS (
       SELECT d.day AS day, COALESCE(SUM(b.amount_minor), 0) AS total
       FROM days d
       LEFT JOIN bills b ON b.txn_date = d.day AND b.kind = 'expense' AND b.status = 'paid'
       GROUP BY d.day
     )
     SELECT day,
            SUM(total) OVER (ORDER BY day) AS cumulative_minor
     FROM daily ORDER BY day`,
    [start, end],
  );
}

/** Per-category budget vs actual for a month, month override beating the default. */
export async function budgetStatus(
  mk: MonthKey,
  startDay = 1,
): Promise<
  { category_id: number; name: string; color: string; limit_minor: number; spent_minor: number }[]
> {
  const { start, end } = monthBounds(mk, startDay);
  return q(
    // ?3 is the month key, read twice and out of order. The parameter array is
    // unchanged from the Postgres version because ?NNN is positional by number,
    // not by where it appears in the text.
    `SELECT c.id AS category_id, c.name, c.color,
            COALESCE(
              (SELECT limit_minor FROM budgets WHERE category_id = c.id AND month = ?3),
              (SELECT limit_minor FROM budgets WHERE category_id = c.id AND month IS NULL)
            ) AS limit_minor,
            COALESCE((SELECT SUM(amount_minor) FROM bills
                      WHERE category_id = c.id AND kind = 'expense' AND status = 'paid'
                        AND txn_date BETWEEN ?1 AND ?2), 0) AS spent_minor
     FROM categories c
     WHERE c.archived = 0 AND c.kind = 'expense'
       AND EXISTS (SELECT 1 FROM budgets
                   WHERE category_id = c.id AND (month = ?3 OR month IS NULL))
     ORDER BY 5 DESC`,
    [start, end, mk],
  );
}

/** The overall monthly budget, month override first, then default, then the ring target. */
export async function overallBudget(mk: MonthKey, fallbackMinor: number): Promise<number> {
  const row = await q1<{ limit_minor: number | null }>(
    `SELECT COALESCE(
       (SELECT limit_minor FROM budgets WHERE category_id IS NULL AND month = ?1),
       (SELECT limit_minor FROM budgets WHERE category_id IS NULL AND month IS NULL)
     ) AS limit_minor`,
    [mk],
  );
  return row?.limit_minor ?? fallbackMinor;
}

/** Biggest single expenses in a month — the "where did it go" answer. */
export async function largestExpenses(
  mk: MonthKey,
  startDay = 1,
  limit = 5,
): Promise<{ id: number; merchant: string; amount_minor: number; txn_date: ISODate; name: string | null }[]> {
  const { start, end } = monthBounds(mk, startDay);
  return q(
    `SELECT b.id, b.merchant, b.amount_minor, b.txn_date, c.name
     FROM bills b LEFT JOIN categories c ON c.id = b.category_id
     WHERE b.kind = 'expense' AND b.status = 'paid' AND b.txn_date BETWEEN ?1 AND ?2
     ORDER BY b.amount_minor DESC LIMIT ?3`,
    [start, end, limit],
  );
}

/**
 * All-time totals for Profile's "your numbers".
 *
 * Six scalar subqueries rather than joins: these count rows in five unrelated
 * tables, and joining them would multiply every row against every other. It is
 * still one round trip, and SQLite — like Postgres — plans each subquery
 * independently. A SELECT with no FROM is legal in both.
 */
export async function lifetimeTotals(): Promise<{
  bills: number;
  attachments: number;
  expense_minor: number;
  income_minor: number;
  goal_saved_minor: number;
  contributed_minor: number;
}> {
  const row = await q1<{
    bills: number;
    attachments: number;
    expense_minor: number;
    income_minor: number;
    goal_saved_minor: number;
    contributed_minor: number;
  }>(
    `SELECT
       (SELECT count(*) FROM bills WHERE status = 'paid') AS bills,
       (SELECT count(*) FROM attachments) AS attachments,
       (SELECT COALESCE(SUM(amount_minor), 0) FROM bills
         WHERE status = 'paid' AND kind = 'expense') AS expense_minor,
       (SELECT COALESCE(SUM(amount_minor), 0) FROM bills
         WHERE status = 'paid' AND kind = 'income') AS income_minor,
       (SELECT COALESCE(SUM(amount_minor), 0) FROM goal_contributions) AS goal_saved_minor,
       -- Asset side only: money drawn down on a loan is not money you put away.
       (SELECT COALESCE(SUM(hc.amount_minor), 0) FROM holding_contributions hc
          JOIN holdings h ON h.id = hc.holding_id
         WHERE h.side = 'asset') AS contributed_minor`,
  );
  return (
    row ?? {
      bills: 0, attachments: 0, expense_minor: 0,
      income_minor: 0, goal_saved_minor: 0, contributed_minor: 0,
    }
  );
}

/** How many months actually contain data — guards every "last N months" average. */
export async function dataSpan(): Promise<{ first: ISODate | null; last: ISODate | null; months: number }> {
  const row = await q1<{ first: ISODate | null; last: ISODate | null; months: number }>(
    `SELECT min(txn_date) AS first, max(txn_date) AS last,
            COALESCE(count(DISTINCT substr(txn_date, 1, 7)), 0) AS months
     FROM bills WHERE status = 'paid'`,
  );
  return row ?? { first: null, last: null, months: 0 };
}

/**
 * Per-category totals over a window, with the number of months each one actually
 * appears in.
 *
 * The month count is per category rather than per window on purpose: a category
 * you started using two months ago should be averaged over two months, not over
 * six. Dividing by the window length instead is how "typical monthly spend on
 * school fees" ends up a third of the real figure.
 */
export async function categoryTotalsSince(
  from: ISODate,
): Promise<{ name: string; color: string; total_minor: number; months: number }[]> {
  return q(
    `SELECT COALESCE(c.name, 'Uncategorised') AS name,
            COALESCE(c.color, '#80868B')      AS color,
            SUM(b.amount_minor)              AS total_minor,
            count(DISTINCT substr(b.txn_date, 1, 7)) AS months
     FROM bills b
     LEFT JOIN categories c ON c.id = b.category_id
     WHERE b.kind = 'expense' AND b.status = 'paid' AND b.txn_date >= ?1
     GROUP BY 1, 2
     ORDER BY total_minor DESC`,
    [from],
  );
}
