/**
 * Goal reads — `Finance/src/lib/queries/goals.ts`, in SQLite.
 *
 * Dialect only, and less of it than elsewhere: SQLite has had window functions
 * since 3.25 and `NULLS LAST` since 3.30, so `goalCumulative`'s running sum and
 * `listGoals`' ordering survive as written. What changed:
 *
 *   - `$1` → `?1`, `::bigint` / `::int` dropped.
 *   - `to_char(txn_date, 'YYYY-MM')` → `substr(txn_date, 1, 7)`. The column is
 *     already a 'YYYY-MM-DD' string, so this is a prefix, not a format call.
 *   - `NOT g.archived` → `g.archived = 0`.
 *
 * `GROUP BY g.id` with bare `g.*` in the select list is legal here for the same
 * reason it was legal in Postgres — `id` is the primary key, so every other
 * column is functionally dependent on it. SQLite is laxer still and would allow
 * it regardless, but the grouping is doing real work: it is what makes one row
 * per goal out of the contributions join.
 */

import { b, q, q1 } from "../db";
import type { ISODate } from "../date";
import { monthBounds, type MonthKey } from "../date";
import type { Contribution, GoalRow } from "../types";

const GOAL_SELECT = `
  SELECT g.*,
         COALESCE(SUM(gc.amount_minor), 0) AS saved_minor,
         count(gc.id)                      AS contribution_count
  FROM goals g
  LEFT JOIN goal_contributions gc ON gc.goal_id = g.id`;

export async function listGoals(includeArchived = false): Promise<GoalRow[]> {
  const rows = await q<GoalRow>(
    `${GOAL_SELECT}
     ${includeArchived ? "" : "WHERE g.archived = 0"}
     GROUP BY g.id
     ORDER BY g.archived, g.target_date NULLS LAST, g.id`,
  );
  return rows.map((r) => ({ ...r, archived: b(r.archived) }));
}

export async function getGoal(id: number): Promise<GoalRow | null> {
  const row = await q1<GoalRow>(`${GOAL_SELECT} WHERE g.id = ?1 GROUP BY g.id`, [id]);
  return row ? { ...row, archived: b(row.archived) } : null;
}

export async function goalContributions(goalId: number): Promise<Contribution[]> {
  return q<Contribution>(
    `SELECT id, amount_minor, txn_date, note
     FROM goal_contributions WHERE goal_id = ?1
     ORDER BY txn_date DESC, id DESC`,
    [goalId],
  );
}

/** Total into all goals within a month — the green ring. */
export async function goalFundedInMonth(mk: MonthKey, startDay = 1): Promise<number> {
  const { start, end } = monthBounds(mk, startDay);
  const row = await q1<{ total: number }>(
    `SELECT COALESCE(SUM(amount_minor), 0) AS total
     FROM goal_contributions WHERE txn_date BETWEEN ?1 AND ?2`,
    [start, end],
  );
  return row?.total ?? 0;
}

/** Monthly totals for the goal-funding trend. */
export async function goalFundingByMonth(
  from: ISODate,
): Promise<{ month: MonthKey; total_minor: number }[]> {
  return q(
    `SELECT substr(txn_date, 1, 7) AS month,
            SUM(amount_minor)      AS total_minor
     FROM goal_contributions WHERE txn_date >= ?1
     GROUP BY 1 ORDER BY 1`,
    [from],
  );
}

/** Cumulative saved per goal over time, for the sparkline on a goal's page. */
export async function goalCumulative(
  goalId: number,
): Promise<{ txn_date: ISODate; cumulative_minor: number }[]> {
  return q(
    `SELECT txn_date,
            SUM(amount_minor) OVER (ORDER BY txn_date, id) AS cumulative_minor
     FROM goal_contributions WHERE goal_id = ?1
     ORDER BY txn_date, id`,
    [goalId],
  );
}

/**
 * Per-goal contribution totals over a window, and how many months they span.
 *
 * One query for every goal rather than one per goal: the coaching brief needs a
 * recent rate for each, and N round trips to say "nothing went in" is a poor
 * trade. Goals with no contributions in the window are simply absent from the
 * result, which the caller reads as zero.
 */
export async function goalFundingRecent(
  from: ISODate,
): Promise<{ goal_id: number; total_minor: number; months: number }[]> {
  return q(
    `SELECT goal_id,
            SUM(amount_minor)                      AS total_minor,
            count(DISTINCT substr(txn_date, 1, 7)) AS months
     FROM goal_contributions
     WHERE txn_date >= ?1
     GROUP BY goal_id`,
    [from],
  );
}
