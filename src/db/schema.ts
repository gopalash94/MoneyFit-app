/**
 * MoneyFit schema — `Finance/db/010_schema.sql`, in SQLite.
 *
 * Money rule, unchanged: every amount is an integer count of *paise* named
 * `*_minor`. Nothing here is a float. Formatting to "₹1,23,456" happens once,
 * at the display edge, in src/lib/money.ts.
 *
 * The type translation, in full:
 *   SERIAL PRIMARY KEY  → INTEGER PRIMARY KEY AUTOINCREMENT
 *   BIGINT              → INTEGER   (SQLite integers are 64-bit already)
 *   DATE, CHAR(7)       → TEXT      ('YYYY-MM-DD' / 'YYYY-MM' strings, as before)
 *   TIMESTAMPTZ         → TEXT      (datetime('now') — UTC, as now() was)
 *   BOOLEAN             → INTEGER   0/1 — see the `b()` helper in lib/db.ts
 *   NUMERIC(20, 6)      → REAL      (units only; never an amount)
 *   JSONB               → TEXT      — so readCache must JSON.parse, and does
 *
 * Everything else survives: every CHECK, the partial index on upcoming bills,
 * the lower(merchant) expression index and the two-expression unique index on
 * budgets all work in SQLite exactly as written. The single genuine break is
 * the month regex — SQLite has no `~`, so the equivalent GLOB pattern stands in.
 *
 * `AUTOINCREMENT` is deliberate rather than habit. Without it SQLite reuses the
 * highest deleted rowid, so deleting a bill and adding another could hand out
 * the id an `ai_cache` scope or a stale route param still refers to. With it,
 * ids are never reused.
 */

export const SCHEMA_SQL = `
-- ---------------------------------------------------------------- categories
CREATE TABLE categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,
  icon        TEXT    NOT NULL DEFAULT 'receipt',
  color       TEXT    NOT NULL DEFAULT '#1a73e8',
  kind        TEXT    NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense', 'income')),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  archived    INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
);

-- --------------------------------------------------------------------- bills
-- One row per bill / transaction. \`kind\` lets income live here too, which is
-- what makes an income-vs-expense chart possible from a single table.
CREATE TABLE bills (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant       TEXT    NOT NULL,
  amount_minor   INTEGER NOT NULL CHECK (amount_minor >= 0),
  txn_date       TEXT    NOT NULL,
  due_date       TEXT,
  status         TEXT    NOT NULL DEFAULT 'paid'    CHECK (status IN ('paid', 'upcoming')),
  kind           TEXT    NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense', 'income')),
  category_id    INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  notes          TEXT,
  recurrence     TEXT    NOT NULL DEFAULT 'none'
                         CHECK (recurrence IN ('none', 'weekly', 'monthly', 'quarterly', 'yearly')),
  -- Set on an auto-generated next occurrence, pointing at the bill it came from.
  parent_bill_id INTEGER REFERENCES bills(id) ON DELETE SET NULL,
  -- Provenance: 'manual' or 'ai' when the fields came from bill extraction.
  source         TEXT    NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ai')),
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX bills_txn_date_idx  ON bills (txn_date DESC);
CREATE INDEX bills_category_idx  ON bills (category_id);
CREATE INDEX bills_upcoming_idx  ON bills (status, due_date) WHERE status = 'upcoming';
CREATE INDEX bills_merchant_idx  ON bills (lower(merchant));

-- --------------------------------------------------------------- attachments
-- Its own table, not a column on bills: a bill and its payment receipt are two
-- files for one record. \`file_name\` is the generated name inside the app's
-- documents directory; \`original_name\` is what the user recognises.
CREATE TABLE attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id       INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  file_name     TEXT    NOT NULL UNIQUE,
  original_name TEXT    NOT NULL,
  mime_type     TEXT    NOT NULL,
  size_bytes    INTEGER NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX attachments_bill_idx ON attachments (bill_id);

-- ------------------------------------------------------------------- budgets
-- category_id NULL = the overall monthly budget. month NULL = the default that
-- applies to every month with no explicit override.
CREATE TABLE budgets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
  month       TEXT    CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  limit_minor INTEGER NOT NULL CHECK (limit_minor >= 0)
);

-- At most one row per (category, month), counting "no category" and "no month"
-- as values in their own right. A plain UNIQUE would not do it, because NULL is
-- never equal to NULL in SQL, so NULLs are folded onto sentinels that the
-- column constraints make unreachable as real data (ids start at 1, and the
-- CHECK above rejects the month '0000-00').
CREATE UNIQUE INDEX budgets_scope_uq
  ON budgets (COALESCE(category_id, 0), COALESCE(month, '0000-00'));

-- --------------------------------------------------------------------- goals
CREATE TABLE goals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  target_minor INTEGER NOT NULL CHECK (target_minor > 0),
  target_date  TEXT,
  icon         TEXT    NOT NULL DEFAULT 'flag',
  color        TEXT    NOT NULL DEFAULT '#0f9d58',
  notes        TEXT,
  archived     INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  -- Start of the pace line. Explicit rather than created_at so a goal you have
  -- been saving toward for a year can be entered honestly today.
  started_on   TEXT    NOT NULL DEFAULT (date('now', 'localtime')),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE goal_contributions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id      INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  amount_minor INTEGER NOT NULL,
  txn_date     TEXT    NOT NULL DEFAULT (date('now', 'localtime')),
  note         TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX goal_contrib_idx ON goal_contributions (goal_id, txn_date);

-- ------------------------------------------------------------------ holdings
-- \`side\` makes net worth real: assets minus liabilities. A home loan is a
-- holding whose latest valuation is the outstanding balance.
CREATE TABLE holdings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  side        TEXT    NOT NULL DEFAULT 'asset' CHECK (side IN ('asset', 'liability')),
  asset_type  TEXT    NOT NULL DEFAULT 'other'
                      CHECK (asset_type IN ('equity', 'mutual_fund', 'ppf', 'epf', 'nps',
                                            'fd', 'gold', 'real_estate', 'crypto', 'bonds',
                                            'cash', 'loan', 'credit_card', 'other')),
  units       REAL,
  institution TEXT,
  notes       TEXT,
  archived    INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Cost basis is DERIVED from these rows, never stored. The dated series here is
-- exactly XIRR's input; a cached cost_minor column would drift out of step.
CREATE TABLE holding_contributions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  holding_id   INTEGER NOT NULL REFERENCES holdings(id) ON DELETE CASCADE,
  amount_minor INTEGER NOT NULL,  -- negative = withdrawal / redemption
  txn_date     TEXT    NOT NULL DEFAULT (date('now', 'localtime')),
  note         TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX holding_contrib_idx ON holding_contributions (holding_id, txn_date);

-- Manual value snapshots. One per holding per day.
CREATE TABLE valuations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  holding_id  INTEGER NOT NULL REFERENCES holdings(id) ON DELETE CASCADE,
  as_of       TEXT    NOT NULL,
  value_minor INTEGER NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (holding_id, as_of)
);

CREATE INDEX valuations_holding_idx ON valuations (holding_id, as_of DESC);

-- ------------------------------------------------------------------ settings
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ------------------------------------------------------------------ ai_cache
-- AI answers are cached so opening Home does not bill an API call every time.
-- \`fingerprint\` is a hash of the inputs; a stale row is simply ignored.
-- \`payload\` was JSONB and is now TEXT, so writeCache stringifies and readCache
-- parses — the one place the port has to do work Postgres used to do.
CREATE TABLE ai_cache (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT '',
  fingerprint TEXT NOT NULL,
  payload     TEXT NOT NULL,
  model       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, scope)
);

-- Subscriptions the statistical detector found that you have told it to stop
-- suggesting. Keyed by the normalised merchant name it groups on.
CREATE TABLE detection_dismissals (
  signature  TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

/**
 * Defaults only — `Finance/db/020_seed.sql`, verbatim but for the dialect.
 *
 * No sample transactions: Settings has a "Load sample data" button for that, so
 * a real install never starts out polluted.
 */
export const SEED_SQL = `
INSERT INTO categories (name, icon, color, kind, sort_order) VALUES
  ('Rent',            'home',       '#1A73E8', 'expense',  10),
  ('Groceries',       'cart',       '#1E8E3E', 'expense',  20),
  ('Electricity',     'bolt',       '#F9AB00', 'expense',  30),
  ('Water',           'droplet',    '#12B5CB', 'expense',  40),
  ('Gas',             'flame',      '#E8710A', 'expense',  50),
  ('Internet',        'wifi',       '#9334E6', 'expense',  60),
  ('Mobile',          'phone',      '#3F51B5', 'expense',  70),
  ('Transport',       'car',        '#00897B', 'expense',  80),
  ('Fuel',            'fuel',       '#D93025', 'expense',  90),
  ('Dining',          'utensils',   '#EA4335', 'expense', 100),
  ('Subscriptions',   'repeat',     '#7B1FA2', 'expense', 110),
  ('Health',          'heart',      '#C5221F', 'expense', 120),
  ('Insurance',       'shield',     '#0B8043', 'expense', 130),
  ('Education',       'book',       '#1967D2', 'expense', 140),
  ('Shopping',        'bag',        '#F06292', 'expense', 150),
  ('Entertainment',   'film',       '#AB47BC', 'expense', 160),
  ('Travel',          'plane',      '#039BE5', 'expense', 170),
  ('Household',       'wrench',     '#795548', 'expense', 180),
  ('Gifts',           'gift',       '#FF7043', 'expense', 190),
  ('Fees & Charges',  'receipt',    '#5F6368', 'expense', 200),
  ('Taxes',           'landmark',   '#455A64', 'expense', 210),
  ('Other',           'receipt',    '#80868B', 'expense', 999),
  ('Salary',          'wallet',     '#1E8E3E', 'income',   10),
  ('Interest',        'percent',    '#00897B', 'income',   20),
  ('Dividends',       'coins',      '#F9AB00', 'income',   30),
  ('Refunds',         'undo',       '#12B5CB', 'income',   40),
  ('Other income',    'wallet',     '#80868B', 'income',  999);

-- Monthly ring targets, in paise. The three rings on Home scale against these.
INSERT INTO settings (key, value) VALUES
  ('currency',                   'INR'),
  ('display_name',               'You'),
  ('monthly_budget_minor',       '5000000'),
  ('monthly_goal_target_minor',  '1500000'),
  ('monthly_invest_target_minor','2000000'),
  ('month_start_day',            '1'),
  ('theme',                      'system');

-- The overall default budget mirrors the ring target so the two never disagree
-- on a fresh install.
INSERT INTO budgets (category_id, month, limit_minor) VALUES (NULL, NULL, 5000000);
`;
