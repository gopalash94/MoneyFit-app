/**
 * The migration ladder.
 *
 * The web app never needed one: Postgres ran `db/*.sql` once when the container
 * initialised its volume, and changing the schema meant `docker compose down -v`
 * and starting over. A phone has no such escape — the database on it holds the
 * only copy of your data, so every future schema change has to arrive as a step
 * that leaves it intact.
 *
 * `PRAGMA user_version` is SQLite's own four bytes of space for this, stored in
 * the file header. It starts at 0, which is what a fresh install looks like.
 *
 * Two properties worth keeping if you add a rung:
 *
 *   - **The whole run is one transaction.** SQLite's DDL is transactional, so a
 *     step that throws leaves the file exactly as it was and the next launch
 *     reports the same error rather than a confusing "table already exists" from
 *     a half-applied step.
 *   - **The views are dropped and recreated every time.** They hold no data, so
 *     this costs nothing and means changing a view — the thing most likely to
 *     change, since /ask reads them — needs no rung at all: bump the version and
 *     edit views.ts.
 */

import { database } from "@/lib/db";

import { SCHEMA_SQL, SEED_SQL } from "./schema";
import { DROP_VIEWS_SQL, VIEWS_SQL } from "./views";

/**
 * The version this build of the app expects.
 *
 * Bump it whenever `schema.ts` or `views.ts` changes, and add the matching rung
 * to STEPS below if the change touches tables.
 */
export const SCHEMA_VERSION = 2;

type Step = {
  /** The version reached once this has run. */
  readonly to: number;
  /** What it does, in the past tense, for the error message if it fails. */
  readonly what: string;
  /** DDL/DML to run. Multiple statements, separated by `;`. */
  readonly sql: string;
};

/**
 * Rung 2 — catching up with the web app.
 *
 * The web made these changes as three files (`060_drop_ai.sql`,
 * `070_statements.sql`, `080_ask.sql`) applied to a Postgres database that could
 * be thrown away and rebuilt. Here they have to land on a phone holding the only
 * copy, so each one is checked against what SQLite will actually allow.
 *
 * **`ai_cache` becomes `scan_drafts`.** The old table did two unrelated jobs:
 * caching insight and coaching answers, and holding the draft a photographed bill
 * produces while you confirm it. The first job is gone — both are computed locally
 * now, in `src/lib/analytics/` — but the second is not, because the camera scan
 * survives here. So rather than drop the table and break the scan, what is left of
 * it gets a table named for the one thing it still does. No table references
 * either, so neither the drop nor the create fires a cascade.
 *
 * The rows are not carried across. A scan draft is a bill you photographed and have
 * not confirmed yet, so the most this can cost is one un-reviewed photo needing to
 * be scanned again — the image itself is still in the documents directory. Copying
 * them over would mean trusting that a payload written by the old code parses
 * against the new type, for a row whose whole lifetime is a few seconds.
 *
 * **`bills.source` is NOT dropped**, and that is a deliberate departure from
 * `060_drop_ai.sql`. The web dropped it because with no AI left it could only ever
 * hold 'manual'. The camera scan survives here, so 'ai' is still a real value.
 * That is lucky as well as correct, because dropping it would have been genuinely
 * dangerous: SQLite refuses `ALTER TABLE ... DROP COLUMN` for a column named in a
 * CHECK constraint, so it would have meant the 12-step table rebuild — and
 * `DROP TABLE bills` with `PRAGMA foreign_keys = ON` (set in lib/db.ts before this
 * runs) fires the ON DELETE CASCADE on `attachments` and silently takes every
 * receipt with it. The pragma cannot be switched off inside the transaction this
 * migration already runs in, either. Nothing here needs a rebuild.
 *
 * **The two new `bills` columns are plain ADD COLUMNs.** SQLite allows
 * `ADD COLUMN ... REFERENCES` only when the new column defaults to NULL, which
 * both do; neither may be given NOT NULL or a default without rewriting this as a
 * rebuild. `statement_batches` is created before the ALTER that points at it.
 *
 * The CREATEs say `IF NOT EXISTS` and the two ALTERs cannot, because SQLite has no
 * `ADD COLUMN IF NOT EXISTS`. That asymmetry is safe rather than overlooked: a rung
 * runs only when `user_version` is below its `to`, inside one transaction, so it
 * runs exactly once or not at all. The `IF NOT EXISTS` clauses are there because
 * they cost nothing, not because anything depends on them.
 */
const STEP_2 = `
DROP TABLE IF EXISTS ai_cache;

CREATE TABLE IF NOT EXISTS scan_drafts (
  file_name  TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  model      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS statement_batches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
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

CREATE INDEX IF NOT EXISTS statement_batches_created_idx
  ON statement_batches (created_at DESC);

CREATE TABLE IF NOT EXISTS ask_turns (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  question     TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('answered', 'refused', 'failed')),
  sql_text     TEXT,
  model        TEXT,
  note         TEXT,
  -- Two columns the web's ask_turns does not have, because the web's answer shape
  -- does not have them. See schema.ts for why they are stored rather than derived.
  assumptions  TEXT,
  chart        TEXT,
  result_cols  TEXT,
  result_rows  TEXT,
  row_count    INTEGER NOT NULL DEFAULT 0,
  truncated    INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  ms           INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS ask_turns_created_idx ON ask_turns (created_at DESC);

ALTER TABLE bills ADD COLUMN holding_id INTEGER
  REFERENCES holdings(id) ON DELETE SET NULL;

ALTER TABLE bills ADD COLUMN statement_batch_id INTEGER
  REFERENCES statement_batches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS bills_holding_idx ON bills (holding_id);

CREATE INDEX IF NOT EXISTS bills_statement_batch_idx
  ON bills (statement_batch_id) WHERE statement_batch_id IS NOT NULL;
`;

/**
 * Each rung, in order. `to` must ascend by one and end at SCHEMA_VERSION.
 *
 * Rung 1 is the whole of `010_schema.sql` plus `020_seed.sql` — a fresh install.
 * Anything a fresh install should have goes in schema.ts and seed, *and* in a new
 * rung, because an existing install never re-runs rung 1.
 */
const STEPS: readonly Step[] = [
  { to: 1, what: "created the schema and default categories", sql: SCHEMA_SQL + SEED_SQL },
  { to: 2, what: "added statement imports, the Ask thread and the paid-from account", sql: STEP_2 },
];

/** Where `migrate()` got to, so the root layout can say something useful. */
export type MigrateResult = {
  from: number;
  to: number;
  /** True when this was a brand-new database, so Settings can offer sample data. */
  fresh: boolean;
};

/**
 * Brings the database up to SCHEMA_VERSION. Safe to call more than once.
 *
 * Throws if it cannot, which the root layout turns into the same `DbUnavailable`
 * card the web pages show — one screen saying what went wrong beats a blank app.
 */
export async function migrate(): Promise<MigrateResult> {
  const db = await database();

  const row = await db.getFirstAsync<{ user_version: number }>("PRAGMA user_version");
  const from = row?.user_version ?? 0;

  if (from > SCHEMA_VERSION) {
    // An older build opening a newer file. Migrating down would mean dropping
    // columns holding real data, so refuse instead: reinstalling the current
    // version costs nothing, and this way nothing is lost.
    throw new Error(
      `This database was written by a newer version of MoneyFit (schema ${from}, ` +
        `this build expects ${SCHEMA_VERSION}). Update the app rather than downgrade it.`,
    );
  }

  if (from === SCHEMA_VERSION) return { from, to: from, fresh: false };

  const pending = STEPS.filter((s) => s.to > from);

  await db.withExclusiveTransactionAsync(async (txn) => {
    // Views first: dropped up front so a step is free to change a table any of
    // them selects from, and recreated at the end from the current definitions.
    await txn.execAsync(DROP_VIEWS_SQL);

    for (const step of pending) {
      try {
        await txn.execAsync(step.sql);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`Migration to schema ${step.to} failed (${step.what}): ${detail}`);
      }
    }

    await txn.execAsync(VIEWS_SQL);

    // Not parameterisable — PRAGMA takes no bind values. The interpolated value
    // is a number literal from STEPS above, never anything a user typed.
    await txn.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  });

  return { from, to: SCHEMA_VERSION, fresh: from === 0 };
}
