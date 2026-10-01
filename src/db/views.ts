/**
 * The analytics views — `Finance/db/030_analytics_views.sql`, in SQLite.
 *
 * These eleven views are the ONLY surface the natural-language query feature can
 * reach. On Postgres that was enforced by a role with SELECT on the `analytics`
 * schema and nothing else. SQLite has no roles, no GRANT and no schemas, so the
 * same boundary is rebuilt out of three things that do exist:
 *
 *   1. the `analytics_` name prefix, since one database is all there is;
 *   2. `ANALYTICS_VIEWS` below, which `validateSql` uses as an **allowlist** —
 *      every FROM/JOIN target must be one of these eleven names. That is
 *      strictly stronger than the cross-schema regex it replaces: a pattern can
 *      be satisfied by a name nobody wrote, an allowlist cannot;
 *   3. a separate connection running `PRAGMA query_only = ON` (see lib/db.ts).
 *
 * Amounts are exposed in rupees as well as paise, exactly as before: it keeps
 * generated SQL readable and stops the model dividing by 100 in half the
 * answers. The consequence for the app's own code is unchanged too — a
 * `*_rupees` column must never reach `fmtWhole`, which assumes paise.
 *
 * Dialect notes, in the order they appear:
 *   to_char(d,'YYYY-MM')        → substr(d, 1, 7)
 *   extract(year FROM d)::int   → CAST(substr(d, 1, 4) AS INTEGER)
 *   to_char(d,'Day')            → CASE strftime('%w', d) — see day_of_week
 *   LEFT/CROSS JOIN LATERAL     → a correlated scalar subquery in a subselect
 *   generate_series + date_trunc → WITH RECURSIVE over 'YYYY-MM-01' strings
 *   COMMENT ON VIEW             → VIEW_NOTES at the foot of this file
 * `round(x, 2)` and the aggregates work as written.
 */

/**
 * Every view name, and the allowlist `validateSql` enforces.
 *
 * Order matters only for readability. Keep it in step with VIEWS_SQL: a view
 * created but missing from here is unreachable by /ask, and a name here with no
 * view behind it makes the model write SQL that fails.
 */
export const ANALYTICS_VIEWS = [
  "analytics_transactions",
  "analytics_monthly_spend",
  "analytics_monthly_cashflow",
  "analytics_budget_status",
  "analytics_goal_progress",
  "analytics_goal_contributions",
  "analytics_holdings_current",
  "analytics_holding_contributions",
  "analytics_valuations",
  "analytics_net_worth_monthly",
  "analytics_categories",
] as const;

export type AnalyticsView = (typeof ANALYTICS_VIEWS)[number];

/**
 * `to_char(txn_date, 'Day')`, without the locale.
 *
 * Postgres padded the name to nine characters — 'Monday   ' — which meant
 * generated SQL comparing against 'Monday' silently matched nothing. The port
 * drops the padding, so that comparison now works. The names themselves are
 * hardcoded English for the same reason `date.ts` hardcodes its month names:
 * Hermes' Intl support varies by Android build, and a chart axis is not the
 * place to discover it.
 */
const DAY_OF_WEEK = `CASE strftime('%w', b.txn_date)
    WHEN '0' THEN 'Sunday'   WHEN '1' THEN 'Monday' WHEN '2' THEN 'Tuesday'
    WHEN '3' THEN 'Wednesday' WHEN '4' THEN 'Thursday' WHEN '5' THEN 'Friday'
    WHEN '6' THEN 'Saturday'
  END`;

export const VIEWS_SQL = `
-- Every bill and every income line, flattened with its category.
CREATE VIEW analytics_transactions AS
SELECT
  b.id,
  b.merchant,
  b.amount_minor,
  round(b.amount_minor / 100.0, 2)          AS amount_rupees,
  b.txn_date,
  substr(b.txn_date, 1, 7)                  AS month,
  CAST(substr(b.txn_date, 1, 4) AS INTEGER) AS year,
  ${DAY_OF_WEEK}                            AS day_of_week,
  b.due_date,
  b.status,
  b.kind,
  COALESCE(c.name, 'Uncategorised')         AS category,
  b.recurrence,
  b.notes
FROM bills b
LEFT JOIN categories c ON c.id = b.category_id;

-- Spend per category per month, expenses only, paid only.
CREATE VIEW analytics_monthly_spend AS
SELECT
  substr(b.txn_date, 1, 7)           AS month,
  COALESCE(c.name, 'Uncategorised')  AS category,
  count(*)                           AS txn_count,
  sum(b.amount_minor)                AS spend_minor,
  round(sum(b.amount_minor) / 100.0, 2) AS spend_rupees
FROM bills b
LEFT JOIN categories c ON c.id = b.category_id
WHERE b.kind = 'expense' AND b.status = 'paid'
GROUP BY 1, 2;

-- Income vs expense per month, with the resulting savings rate.
CREATE VIEW analytics_monthly_cashflow AS
SELECT
  substr(txn_date, 1, 7) AS month,
  round(sum(CASE WHEN kind = 'income'  THEN amount_minor ELSE 0 END) / 100.0, 2) AS income_rupees,
  round(sum(CASE WHEN kind = 'expense' THEN amount_minor ELSE 0 END) / 100.0, 2) AS expense_rupees,
  round((sum(CASE WHEN kind = 'income'  THEN amount_minor ELSE 0 END)
       - sum(CASE WHEN kind = 'expense' THEN amount_minor ELSE 0 END)) / 100.0, 2) AS net_rupees
FROM bills
WHERE status = 'paid'
GROUP BY 1;

-- Budget vs actual. Month-specific limits win over the default (month IS NULL).
-- Both lookups are correlated scalar subqueries, which SQLite runs as written;
-- an uncategorised row has category_id NULL, and \`category_id = NULL\` is never
-- true, so it finds no limit — the same outcome Postgres gave.
CREATE VIEW analytics_budget_status AS
WITH spend AS (
  SELECT substr(txn_date, 1, 7) AS month, category_id, sum(amount_minor) AS spent_minor
  FROM bills
  WHERE kind = 'expense' AND status = 'paid'
  GROUP BY 1, 2
)
SELECT
  s.month,
  COALESCE(c.name, 'Uncategorised') AS category,
  round(COALESCE(
    (SELECT limit_minor FROM budgets WHERE category_id = s.category_id AND month = s.month),
    (SELECT limit_minor FROM budgets WHERE category_id = s.category_id AND month IS NULL)
  ) / 100.0, 2) AS limit_rupees,
  round(s.spent_minor / 100.0, 2) AS spent_rupees
FROM spend s
LEFT JOIN categories c ON c.id = s.category_id;

-- Goals with money saved and completion percentage.
CREATE VIEW analytics_goal_progress AS
SELECT
  g.id,
  g.name                                       AS goal,
  round(g.target_minor / 100.0, 2)             AS target_rupees,
  round(COALESCE(sum(gc.amount_minor), 0) / 100.0, 2) AS saved_rupees,
  round(100.0 * COALESCE(sum(gc.amount_minor), 0) / g.target_minor, 1) AS pct_complete,
  g.started_on,
  g.target_date,
  g.archived
FROM goals g
LEFT JOIN goal_contributions gc ON gc.goal_id = g.id
GROUP BY g.id;

CREATE VIEW analytics_goal_contributions AS
SELECT g.name AS goal, gc.txn_date, round(gc.amount_minor / 100.0, 2) AS amount_rupees, gc.note
FROM goal_contributions gc
JOIN goals g ON g.id = gc.goal_id;

-- Each holding with invested cost (summed contributions) against its most
-- recent manual valuation. Postgres reached the latest valuation with a
-- LEFT JOIN LATERAL … ORDER BY as_of DESC LIMIT 1; SQLite has no LATERAL, so
-- the three derived amounts are computed once in a subselect and read back by
-- name — repeating the subquery four times in one SELECT would give the same
-- answer far less legibly.
CREATE VIEW analytics_holdings_current AS
SELECT
  x.id,
  x.name,
  x.side,
  x.asset_type,
  x.institution,
  round(x.invested_minor / 100.0, 2) AS invested_rupees,
  round(x.value_minor    / 100.0, 2) AS current_value_rupees,
  round((x.value_minor - x.invested_minor) / 100.0, 2) AS gain_rupees,
  CASE WHEN x.invested_minor > 0
       THEN round(100.0 * (x.value_minor - x.invested_minor) / x.invested_minor, 2)
  END AS gain_pct,
  x.last_valued_on,
  x.archived
FROM (
  SELECT
    h.id, h.name, h.side, h.asset_type, h.institution, h.archived,
    COALESCE((SELECT sum(amount_minor) FROM holding_contributions
               WHERE holding_id = h.id), 0) AS invested_minor,
    COALESCE((SELECT value_minor FROM valuations
               WHERE holding_id = h.id ORDER BY as_of DESC LIMIT 1), 0) AS value_minor,
    (SELECT as_of FROM valuations
      WHERE holding_id = h.id ORDER BY as_of DESC LIMIT 1) AS last_valued_on
  FROM holdings h
) x;

CREATE VIEW analytics_holding_contributions AS
SELECT h.name AS holding, hc.txn_date, round(hc.amount_minor / 100.0, 2) AS amount_rupees, hc.note
FROM holding_contributions hc
JOIN holdings h ON h.id = hc.holding_id;

CREATE VIEW analytics_valuations AS
SELECT h.name AS holding, v.as_of, round(v.value_minor / 100.0, 2) AS value_rupees
FROM valuations v
JOIN holdings h ON h.id = v.holding_id;

-- Net worth at the end of every month since the first valuation, carrying each
-- holding's last known value forward.
--
-- Postgres built the month spine with generate_series over date_trunc'd dates;
-- here it is a recursive CTE over 'YYYY-MM-01' strings, which sort and compare
-- correctly as text, with date(m, '+1 month') doing the stepping. The anchor's
-- WHERE keeps the spine empty when there are no valuations at all, instead of
-- producing one NULL month.
--
-- The CROSS JOIN LATERAL was an inner join, so a holding with no valuation at or
-- before month end contributed nothing. The IS NOT NULL filter below is what
-- preserves that: without it those holdings would arrive as zeroes and a
-- liability would read as if it had been paid off.
CREATE VIEW analytics_net_worth_monthly AS
WITH RECURSIVE months(m) AS (
  SELECT substr((SELECT min(as_of) FROM valuations), 1, 7) || '-01'
  WHERE (SELECT min(as_of) FROM valuations) IS NOT NULL
  UNION ALL
  SELECT date(m, '+1 month') FROM months
  WHERE m < strftime('%Y-%m', 'now', 'localtime') || '-01'
)
SELECT
  substr(x.m, 1, 7) AS month,
  round(sum(CASE WHEN x.side = 'asset'     THEN x.value_minor ELSE 0 END) / 100.0, 2) AS assets_rupees,
  round(sum(CASE WHEN x.side = 'liability' THEN x.value_minor ELSE 0 END) / 100.0, 2) AS liabilities_rupees,
  round(sum(CASE WHEN x.side = 'asset'     THEN x.value_minor ELSE -x.value_minor END) / 100.0, 2) AS net_worth_rupees
FROM (
  SELECT
    mo.m    AS m,
    h.side  AS side,
    (SELECT value_minor FROM valuations
      WHERE holding_id = h.id
        AND as_of <= date(mo.m, '+1 month', '-1 day')
      ORDER BY as_of DESC LIMIT 1) AS value_minor
  FROM months mo
  CROSS JOIN holdings h
) x
WHERE x.value_minor IS NOT NULL
GROUP BY x.m
ORDER BY x.m;

CREATE VIEW analytics_categories AS
SELECT name, kind, archived FROM categories;
`;

/**
 * Dropped before being recreated, so a migration can change a view's shape
 * without touching a byte of data. Reverse order of creation, which costs
 * nothing and keeps the habit for the day one view reads another.
 */
export const DROP_VIEWS_SQL = [...ANALYTICS_VIEWS]
  .reverse()
  .map((v) => `DROP VIEW IF EXISTS ${v};`)
  .join("\n");

/**
 * What each view is for, in one line — Postgres' `COMMENT ON VIEW`.
 *
 * Only `analytics.transactions` carried a real COMMENT; the rest were `--` notes
 * above their definitions, and they are reproduced here because the model needs
 * them just as much. `describeSchema()` pairs each of these with
 * `PRAGMA table_info` to build the schema block in the /ask system prompt.
 *
 * Two lines say "1 = yes" because `pg` used to parse booleans for us and now
 * nothing does: a view column that was `true` is the integer 1. SQLite does
 * accept `archived = false`, but only saying so stops the model guessing.
 */
export const VIEW_NOTES: Record<AnalyticsView, string> = {
  analytics_transactions:
    "One row per bill or income entry. kind is expense|income, status is paid|upcoming.",
  analytics_monthly_spend:
    "Spend per category per month. Expenses only, and only ones already paid.",
  analytics_monthly_cashflow:
    "Income against expense for each month, with the net left over.",
  analytics_budget_status:
    "Budget limit against actual spend per category per month. A month-specific limit wins over the default one; limit_rupees is null where no budget is set.",
  analytics_goal_progress:
    "One row per savings goal with the amount saved and percent complete. archived is 1 when the goal is archived.",
  analytics_goal_contributions: "Every individual contribution paid into a goal.",
  analytics_holdings_current:
    "One row per investment or liability: what was put in, what it is worth at its latest valuation, and the gain. archived is 1 when the holding is archived.",
  analytics_holding_contributions:
    "Every amount invested into a holding. Negative amounts are withdrawals.",
  analytics_valuations: "Every manual value snapshot recorded for a holding.",
  analytics_net_worth_monthly:
    "Assets, liabilities and net worth at the end of each month since the first valuation.",
  analytics_categories: "The category list. archived is 1 when hidden from pickers.",
};
