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
 *   JSONB               → TEXT      — so queries/ask.ts must JSON.parse, and does
 *
 * Everything else survives: every CHECK, the partial index on upcoming bills,
 * the lower(merchant) expression index and the two-expression unique index on
 * budgets all work in SQLite exactly as written. The single genuine break is
 * the month regex — SQLite has no `~`, so the equivalent GLOB pattern stands in.
 *
 * `AUTOINCREMENT` is deliberate rather than habit. Without it SQLite reuses the
 * highest deleted rowid, so deleting a bill and adding another could hand out
 * the id a stale route param still refers to. With it, ids are never reused.
 *
 * One place this file is *simpler* than the web's. `bills.holding_id` and
 * `bills.statement_batch_id` are declared inline above, pointing at two tables
 * created further down this same script. SQLite resolves a foreign key when a
 * row is written, not when the table is declared, so a parent table may be
 * created after its child. Postgres cannot do that, which is why the web app
 * had to bolt both columns on afterwards in `db/070_statements.sql` and explain
 * itself while doing it. Here they can simply be part of the table.
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
  --
  -- The web app dropped this column (\`db/060_drop_ai.sql\`) once it had no AI left
  -- to set it to 'ai' — a column with one reachable value is not information. Here
  -- it stays, because the camera scan stayed: on a phone it is the one input method
  -- a desktop has no equivalent of, so 'ai' is still a value this column really
  -- takes and still worth knowing months later.
  source         TEXT    NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ai')),
  -- Which account it was paid from. Optional, and ON DELETE SET NULL: closing a
  -- bank account must not delete the history of what you spent through it.
  holding_id     INTEGER REFERENCES holdings(id) ON DELETE SET NULL,
  -- Which imported statement it arrived in, so a row you do not recognise later
  -- can be traced back to the file. SET NULL for the same reason: deleting the
  -- record of an import must not delete the bills it created.
  statement_batch_id INTEGER REFERENCES statement_batches(id) ON DELETE SET NULL,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX bills_txn_date_idx  ON bills (txn_date DESC);
CREATE INDEX bills_category_idx  ON bills (category_id);
CREATE INDEX bills_upcoming_idx  ON bills (status, due_date) WHERE status = 'upcoming';
CREATE INDEX bills_merchant_idx  ON bills (lower(merchant));
CREATE INDEX bills_holding_idx   ON bills (holding_id);
CREATE INDEX bills_statement_batch_idx
  ON bills (statement_batch_id) WHERE statement_batch_id IS NOT NULL;

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

-- Subscriptions the statistical detector found that you have told it to stop
-- suggesting. Keyed by the normalised merchant name it groups on.
CREATE TABLE detection_dismissals (
  signature  TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- -------------------------------------------------------------- scan_drafts
-- A photographed bill that has been read but not yet confirmed.
--
-- This replaces the old general-purpose \`ai_cache\`, which was carrying two
-- unrelated jobs: caching insight and coaching answers, and holding scan
-- drafts. The first job is gone — both are computed locally now, in
-- src/lib/analytics/ — so what is left is one narrow thing, named for it.
--
-- \`file_name\` is the key, and the key is the point. The draft carries across
-- the navigation from the camera to the new-bill form without a route param
-- big enough to hold it, and because the form reads the file metadata back
-- from here rather than from its own state, the attachment a bill adopts
-- cannot be swapped for a different file by editing the form.
--
-- No fingerprint column, unlike the cache it replaces. A fresh file name per
-- photo means this row is written once and read once, so there is nothing for
-- a freshness check to compare against.
--
-- \`payload\` is the ScanDraft as JSON — see getScanDraft in queries/scan.ts,
-- which treats a row that will not parse as absent rather than as an error.
CREATE TABLE scan_drafts (
  file_name  TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  model      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- --------------------------------------------------------- statement_batches
-- One row per statement file you imported — \`Finance/db/070_statements.sql\`.
--
-- Deliberately *not* a copy of the rows it contained: the parse is
-- deterministic and the file is kept, so the review screen re-reads and
-- re-parses it rather than storing a second version of the same facts that
-- could drift from the first.
--
-- \`sha256\` is the whole point of the table. Statement ranges overlap — you
-- import January to March, then February to April — and without a record of
-- what has already been through, "have I imported this?" is unanswerable. The
-- hash catches the same *file* twice; per-transaction duplicate detection
-- (date + amount + merchant, against \`bills\`) catches the same *transaction*
-- arriving in a different file, and the review screen shows both before
-- anything is written.
--
-- \`committed_at\` is the one-way door. A batch that has been committed cannot
-- be committed again, which is what stops a double-tap or a back-gesture from
-- duplicating every bill in it.
CREATE TABLE statement_batches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The stored file in the app's documents directory, or NULL once it has been
  -- cleaned up. Not a foreign key into \`attachments\`: a statement covers many
  -- bills and belongs to none of them.
  file_name     TEXT,
  original_name TEXT    NOT NULL,
  mime_type     TEXT    NOT NULL,
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT    NOT NULL UNIQUE,
  page_count    INTEGER NOT NULL DEFAULT 0,
  row_count     INTEGER NOT NULL DEFAULT 0,
  added_count   INTEGER NOT NULL DEFAULT 0,
  committed_at  TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX statement_batches_created_idx ON statement_batches (created_at DESC);

-- ----------------------------------------------------------------- ask_turns
-- The Ask thread: one row per question you have typed — \`db/080_ask.sql\`.
--
-- Why a table rather than React state. Three reasons, in order of weight:
--
--  1. **It is the audit log.** Ask is the only feature here that opens an
--     outbound connection. \`question\` is the text that left this phone, and
--     \`model\` is what it was sent to. Nothing else did. Figures never leave:
--     the SQL comes back and is executed locally, on the query_only connection.
--  2. A conversation held in component state is the one screen in the app that
--     forgets itself when you navigate away — every other screen reads SQL.
--  3. A wrong answer is worth keeping. \`sql_text\` is the model's working, and
--     the only way to tell a bad question from a bad query is to read it.
--
-- Nothing here is a foreign key into anything. An answer is a snapshot of what
-- the figures said when you asked, and editing a bill afterwards must not
-- change what the thread claims was true — or quietly delete the question
-- through a cascade.
CREATE TABLE ask_turns (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  question     TEXT NOT NULL,
  -- answered: rows came back. refused: the model would not write SQL for it, or
  -- wrote something the validator rejected. failed: the network or the database
  -- said no. All three are kept — "this went wrong" is part of the thread.
  status       TEXT NOT NULL CHECK (status IN ('answered', 'refused', 'failed')),
  -- The SELECT exactly as the model wrote it, before the row cap was wrapped
  -- around it. Displayed, so an answer can always be checked rather than trusted.
  sql_text     TEXT,
  model        TEXT,
  -- The model's own sentence when it declines, or the reason the attempt failed.
  note         TEXT,
  -- The next two have no counterpart in \`db/080_ask.sql\`, because the web's answer
  -- is a sentence and a table and this one is richer: \`ai/sql.ts\` also gets back up
  -- to three \`assumptions\` and an optional \`chart\`. Dropping them on the way into
  -- the thread would have made the persisted answer poorer than the live one, and
  -- then the screen would have needed two renderers — one for the turn you just
  -- asked and one for every turn after a reload.
  --
  -- \`chart\` holds the *series*, not just the two column names the model chose:
  -- \`{ kind, label, value, labels: string[], values: number[] }\`. It has to. The
  -- rows beside it are rendered strings — "₹12,345" cannot be plotted — so a chart
  -- rebuilt from them would be a chart of NaN. Storing the numbers makes the turn
  -- self-contained, which is the same argument this table already makes for storing
  -- rendered rows rather than re-running the query.
  assumptions  TEXT,
  chart        TEXT,
  -- Column names in order, and the rows as arrays of rendered strings. These
  -- were JSONB on Postgres and are TEXT holding JSON here, so recordTurn
  -- stringifies and listTurns parses — see src/lib/queries/ask.ts.
  --
  -- Stored *rendered* because a column's type is a property of the query, not
  -- of the app: the screen cannot know whether column 3 is money, a month or a
  -- merchant, so formatting happens once, where the row is still next to its SQL.
  result_cols  TEXT,
  result_rows  TEXT,
  row_count    INTEGER NOT NULL DEFAULT 0,
  -- 1 when the query matched more rows than the cap, so the screen can say so
  -- instead of silently showing a prefix as if it were the whole answer.
  truncated    INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  ms           INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX ask_turns_created_idx ON ask_turns (created_at DESC);
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
