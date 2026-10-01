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
export const SCHEMA_VERSION = 1;

type Step = {
  /** The version reached once this has run. */
  readonly to: number;
  /** What it does, in the past tense, for the error message if it fails. */
  readonly what: string;
  /** DDL/DML to run. Multiple statements, separated by `;`. */
  readonly sql: string;
};

/**
 * Each rung, in order. `to` must ascend by one and end at SCHEMA_VERSION.
 *
 * Rung 1 is the whole of `010_schema.sql` plus `020_seed.sql` — a fresh install.
 * Anything a fresh install should have goes in schema.ts and seed, *and* in a new
 * rung, because an existing install never re-runs rung 1.
 */
const STEPS: readonly Step[] = [
  { to: 1, what: "created the schema and default categories", sql: SCHEMA_SQL + SEED_SQL },
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
