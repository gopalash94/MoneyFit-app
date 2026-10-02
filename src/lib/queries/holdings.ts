/**
 * Holding reads — `Finance/src/lib/queries/holdings.ts`, in SQLite.
 *
 * This is the module the dialect gap actually bites in. Six of its statements
 * used `LATERAL` to reach one holding's newest valuation, and SQLite has no
 * LATERAL. Each becomes a **correlated scalar subquery**, which is the same
 * thing expressed differently: it can see the outer row, and `ORDER BY as_of
 * DESC LIMIT 1` inside it picks the same value.
 *
 * Two consequences worth reading before editing anything here:
 *
 *   - **A LEFT JOIN LATERAL becomes the subquery directly** (it yields NULL when
 *     nothing matches, which is exactly what the left join did).
 *   - **A CROSS JOIN LATERAL was an *inner* join**, so a holding with no
 *     valuation at or before a given date contributed no row at all. A subquery
 *     yields NULL instead, which would arrive at `SUM` as zero — and a liability
 *     silently reading zero looks like a debt that has been paid off. So both
 *     carry-forward series compute the value in a subselect and then filter
 *     `WHERE value_minor IS NOT NULL` in the outer query. That filter is not
 *     tidying; it is the join semantics.
 *
 * `generate_series` + `date_trunc` + `make_interval` became a `WITH RECURSIVE`
 * spine over 'YYYY-MM-01' strings. ISO dates sort and compare correctly as text,
 * so `mo < ?2` terminates it, and `date(mo, '+1 month', '-1 day')` gives month end
 * without any interval type. **Neither end of that spine is a clock.** It used to
 * anchor on `date('now','localtime','start of month')`; the year screen needs a window
 * that does not end today, so both bounds are parameters and the clock lives in
 * `netWorthSeries`, in JS. `CURRENT_DATE` was avoided deliberately whichever way round:
 * in SQLite it is UTC, which in India is yesterday for five and a half hours every day.
 */

import { b, q, q1 } from "../db";
import type { ISODate, MonthKey } from "../date";
import { addMonthKey, monthBounds, thisMonth } from "../date";
import type { Contribution, HoldingRow, PaymentAccount, Valuation } from "../types";

// invested_minor is derived from the contribution rows every time. There is no
// stored cost column to fall out of step with them.
const HOLDING_SELECT = `
  SELECT h.*,
         COALESCE(ct.invested_minor, 0) AS invested_minor,
         COALESCE((SELECT value_minor FROM valuations
                    WHERE holding_id = h.id ORDER BY as_of DESC LIMIT 1), 0) AS value_minor,
         (SELECT as_of FROM valuations
           WHERE holding_id = h.id ORDER BY as_of DESC LIMIT 1) AS last_valued_on,
         COALESCE(vc.n, 0) AS valuation_count
  FROM holdings h
  LEFT JOIN (SELECT holding_id, SUM(amount_minor) AS invested_minor
             FROM holding_contributions GROUP BY 1) ct ON ct.holding_id = h.id
  LEFT JOIN (SELECT holding_id, count(*) AS n FROM valuations GROUP BY 1) vc ON vc.holding_id = h.id`;

export async function listHoldings(includeArchived = false): Promise<HoldingRow[]> {
  const rows = await q<HoldingRow>(
    // The original ordered by `COALESCE(lv.value_minor, 0)`; that alias is gone,
    // so this orders by the output column of the same name, which SQLite allows
    // and which holds precisely that expression. Keeping the WHERE clause
    // appendable is why HOLDING_SELECT is not itself wrapped in a subselect.
    `${HOLDING_SELECT}
     ${includeArchived ? "" : "WHERE h.archived = 0"}
     ORDER BY h.side, h.archived, value_minor DESC`,
  );
  return rows.map((r) => ({ ...r, archived: b(r.archived) }));
}

export async function getHolding(id: number): Promise<HoldingRow | null> {
  const row = await q1<HoldingRow>(`${HOLDING_SELECT} WHERE h.id = ?1`, [id]);
  return row ? { ...row, archived: b(row.archived) } : null;
}

/**
 * The holdings a bill can be paid from — cards, wallets and loans.
 *
 * Deliberately not every holding: tagging a grocery bill to a PPF account is a
 * mistake the picker should make impossible rather than validate. `other` is in
 * because that is where a bank account with no better type lands.
 */
export async function listPaymentAccounts(): Promise<PaymentAccount[]> {
  return q(
    // `NOT archived` became `archived = 0`, the same translation the rest of this
    // directory makes. The returned columns are all text or integer, so unlike
    // `listHoldings` there is no boolean to map back through `b()`.
    `SELECT id, name, asset_type FROM holdings
      WHERE archived = 0 AND asset_type IN ('credit_card', 'cash', 'loan', 'other')
      ORDER BY asset_type, name`,
  );
}

export async function holdingContributions(holdingId: number): Promise<Contribution[]> {
  return q<Contribution>(
    `SELECT id, amount_minor, txn_date, note FROM holding_contributions
     WHERE holding_id = ?1 ORDER BY txn_date, id`,
    [holdingId],
  );
}

export async function holdingValuations(holdingId: number): Promise<Valuation[]> {
  return q<Valuation>(
    `SELECT id, as_of, value_minor FROM valuations
     WHERE holding_id = ?1 ORDER BY as_of`,
    [holdingId],
  );
}

/** Money into investments within a month — the amber ring. Withdrawals net off. */
export async function investedInMonth(mk: MonthKey, startDay = 1): Promise<number> {
  const { start, end } = monthBounds(mk, startDay);
  const row = await q1<{ total: number }>(
    `SELECT COALESCE(SUM(hc.amount_minor), 0) AS total
     FROM holding_contributions hc
     JOIN holdings h ON h.id = hc.holding_id
     WHERE h.side = 'asset' AND hc.txn_date BETWEEN ?1 AND ?2`,
    [start, end],
  );
  return row?.total ?? 0;
}

export type NetWorthPoint = {
  month: MonthKey;
  assets_minor: number;
  liabilities_minor: number;
  net_minor: number;
};

/**
 * Net worth at each month end across [from, to], carrying every holding's most
 * recent valuation forward.
 *
 * The carry-forward is the whole trick: for each (month, holding) pair it grabs
 * the newest valuation dated at or before that month's end. A holding you valued
 * once in January therefore still counts in June, which is what a net worth
 * chart has to do — but a holding you had not bought yet contributes nothing,
 * which is what the `IS NOT NULL` filter preserves now that the inner join is a
 * subquery. That is also what makes this correct for a *past* year: ask for 2025
 * and anything acquired in 2026 is absent from it rather than back-dated into it.
 *
 * Closed holdings are excluded from every month, not just the recent ones. That
 * restates history when you sell something, which is a real cost — but the
 * alternative is worse: their last valuation would otherwise be carried forward
 * forever, so the final point of this line would disagree with the net worth
 * figure printed beside it. A chart that contradicts its own headline is not a
 * chart anyone can use.
 *
 * **The spine took both bounds when the year screen arrived.** It used to anchor on
 * `date('now','localtime','start of month')` and count backwards, which can only ever
 * produce a window ending now — no use to a screen showing 2025. Both ends are
 * parameters now, and the clock moved out of SQL into `netWorthSeries` below, where it
 * is the same `thisMonth()` Home, Profile and Invest already use.
 */
export async function netWorthByMonth(from: MonthKey, to: MonthKey): Promise<NetWorthPoint[]> {
  return q(
    // The spine: every month-start from `from` to `to` inclusive. The anchor carries
    // `WHERE ?1 <= ?2` for the reason `queries/stats.ts` gives — an inverted range must
    // yield no rows, as `generate_series` did, and the recursion alone would still have
    // emitted the first month.
    `WITH RECURSIVE m(mo) AS (
       SELECT ?1 WHERE ?1 <= ?2
       UNION ALL
       SELECT date(mo, '+1 month') FROM m WHERE mo < ?2
     )
     SELECT substr(x.mo, 1, 7) AS month,
            SUM(CASE WHEN x.side = 'asset'     THEN x.value_minor ELSE 0 END) AS assets_minor,
            SUM(CASE WHEN x.side = 'liability' THEN x.value_minor ELSE 0 END) AS liabilities_minor,
            SUM(CASE WHEN x.side = 'asset'     THEN x.value_minor ELSE -x.value_minor END) AS net_minor
     FROM (
       SELECT m.mo AS mo,
              h.side AS side,
              -- Newest valuation at or before this month's end.
              (SELECT value_minor FROM valuations
                WHERE holding_id = h.id
                  AND as_of <= date(m.mo, '+1 month', '-1 day')
                ORDER BY as_of DESC LIMIT 1) AS value_minor
       FROM m
       CROSS JOIN holdings h
       WHERE h.archived = 0
     ) x
     WHERE x.value_minor IS NOT NULL
     GROUP BY x.mo ORDER BY x.mo`,
    [`${from}-01`, `${to}-01`],
  );
}

/**
 * The rolling window every month-anchored screen wants: the last `months` months
 * ending with the current one.
 *
 * The anchor is the app's `thisMonth()` rather than SQL's
 * `date('now','localtime')`, which is where it used to live. Same clock either way —
 * the phone's, as `date.ts` explains — and it now matches Home, Profile and Invest,
 * which all work out their own month in JS and would otherwise be able to disagree
 * with this query across a midnight.
 */
export async function netWorthSeries(months = 12): Promise<NetWorthPoint[]> {
  const to = thisMonth();
  return netWorthByMonth(addMonthKey(to, -(months - 1)), to);
}

/** Current totals for the Profile net-worth hero. */
export async function netWorthNow(): Promise<{
  assets_minor: number;
  liabilities_minor: number;
  net_minor: number;
  invested_minor: number;
}> {
  const row = await q1<{
    assets_minor: number;
    liabilities_minor: number;
    net_minor: number;
    invested_minor: number;
  }>(
    `WITH latest AS (
       SELECT h.id, h.side,
              COALESCE((SELECT value_minor FROM valuations
                         WHERE holding_id = h.id ORDER BY as_of DESC LIMIT 1), 0) AS value_minor,
              COALESCE(ct.invested_minor, 0) AS invested_minor
       FROM holdings h
       LEFT JOIN (SELECT holding_id, SUM(amount_minor) AS invested_minor
                  FROM holding_contributions GROUP BY 1) ct ON ct.holding_id = h.id
       WHERE h.archived = 0
     )
     SELECT COALESCE(SUM(CASE WHEN side = 'asset'     THEN value_minor END), 0) AS assets_minor,
            COALESCE(SUM(CASE WHEN side = 'liability' THEN value_minor END), 0) AS liabilities_minor,
            COALESCE(SUM(CASE WHEN side = 'asset' THEN value_minor ELSE -value_minor END), 0) AS net_minor,
            COALESCE(SUM(CASE WHEN side = 'asset'     THEN invested_minor END), 0) AS invested_minor
     FROM latest`,
  );
  return row ?? { assets_minor: 0, liabilities_minor: 0, net_minor: 0, invested_minor: 0 };
}

/**
 * Every asset-side contribution, dated — the input to portfolio-wide XIRR.
 *
 * Closed holdings are left out here too, and must be: XIRR pairs these flows
 * against the portfolio's current value, so counting money paid into something
 * no longer in that value would report a loss that never happened.
 */
export async function allAssetContributions(): Promise<{ txn_date: ISODate; amount_minor: number }[]> {
  return q(
    `SELECT hc.txn_date, hc.amount_minor
     FROM holding_contributions hc
     JOIN holdings h ON h.id = hc.holding_id
     WHERE h.side = 'asset' AND h.archived = 0
     ORDER BY hc.txn_date`,
  );
}

/**
 * Total portfolio value on each date any holding was valued, carrying others
 * forward. This is the series max-drawdown runs over — a per-holding drawdown
 * would miss the fact that the whole portfolio fell together.
 */
export async function portfolioValueSeries(): Promise<{ as_of: ISODate; value_minor: number }[]> {
  return q(
    // Same inner-join-to-subquery treatment as netWorthByMonth: unqualified
    // `as_of` inside the subquery is the valuations column, `d.as_of` the
    // outer one, exactly as the LATERAL read.
    `WITH d AS (SELECT DISTINCT as_of FROM valuations)
     SELECT x.as_of AS as_of, SUM(x.value_minor) AS value_minor
     FROM (
       SELECT d.as_of AS as_of,
              (SELECT value_minor FROM valuations
                WHERE holding_id = h.id AND as_of <= d.as_of
                ORDER BY as_of DESC LIMIT 1) AS value_minor
       FROM d
       CROSS JOIN holdings h
       WHERE h.side = 'asset' AND h.archived = 0
     ) x
     WHERE x.value_minor IS NOT NULL
     GROUP BY x.as_of ORDER BY x.as_of`,
  );
}

/** Current value grouped by asset type, for the allocation donut and drift table. */
export async function allocation(): Promise<
  { asset_type: string; value_minor: number; invested_minor: number }[]
> {
  return q(
    // Restructured rather than translated in place: the original's HAVING
    // referred to the LATERAL's column, and once that becomes a subquery the
    // per-holding value has to be named before it can be grouped. SUM ignoring
    // NULLs reproduces the LEFT JOIN exactly, so the totals are unchanged.
    `SELECT x.asset_type AS asset_type,
            COALESCE(SUM(x.value_minor), 0)    AS value_minor,
            COALESCE(SUM(x.invested_minor), 0) AS invested_minor
     FROM (
       SELECT h.asset_type AS asset_type,
              (SELECT value_minor FROM valuations
                WHERE holding_id = h.id ORDER BY as_of DESC LIMIT 1) AS value_minor,
              ct.invested_minor AS invested_minor
       FROM holdings h
       LEFT JOIN (SELECT holding_id, SUM(amount_minor) AS invested_minor
                  FROM holding_contributions GROUP BY 1) ct ON ct.holding_id = h.id
       WHERE h.side = 'asset' AND h.archived = 0
     ) x
     GROUP BY x.asset_type
     HAVING COALESCE(SUM(x.value_minor), 0) > 0
     ORDER BY 2 DESC`,
  );
}
