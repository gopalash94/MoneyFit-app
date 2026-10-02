/**
 * The data boundary — `Finance/src/lib/db.ts`, over expo-sqlite.
 *
 * Six exports, the same six names and the same six shapes: `q`, `q1`, `tx`,
 * `isReady`, `pool`, `poolRo`. That is deliberate and it is the whole reason the
 * port is affordable: roughly 1,800 lines of queries and actions sit on top of
 * these and need dialect edits only — `$1` becomes `?` — not rewrites.
 *
 * Three things `pg`'s type parsers used to do, which now happen here or nearby:
 *
 *   - **Booleans.** `types.ts` declares `archived: boolean`; SQLite has no such
 *     type and hands back 0 or 1. Going *in*, `bind()` below converts, so every
 *     existing call site can keep passing a boolean. Coming *out*, each query
 *     module maps its rows through `b()` rather than letting integers leak into
 *     the view layer, where `archived ? …` would be true for 0.
 *   - **JSON.** `scan_drafts.payload` and `ask_turns.result_cols`/`result_rows`
 *     were `jsonb` and `pg` parsed them. They are TEXT now, so their query
 *     modules call `JSON.parse` — see the note on `j()`.
 *   - **Dates and bigints.** Nothing to do. The web app told `pg` to leave DATE
 *     and TIMESTAMPTZ as strings and to turn INT8 into a Number, which is
 *     exactly what SQLite does unasked: TEXT columns come back as strings and
 *     INTEGER as a number. Paise fit in a double up to ₹90 trillion.
 *
 * `pool()` and `poolRo()` still return something you can call `.query()` on
 * synchronously, even though opening a SQLite database is asynchronous. The
 * facade below is what makes `await poolRo().query(sql)` in ai/sql.ts port
 * without an edit.
 *
 * Every value still goes in as a parameter. Never interpolate. The single
 * documented exception is `runQuery` in lib/ai/sql.ts, where the statement text
 * *is* the payload and the privilege boundary does the work.
 */

import * as SQLite from "expo-sqlite";

/** The database file, inside the app's own sandbox. Nothing else can read it. */
export const DB_NAME = "moneyfit.db";

/** What `pg`'s QueryResult gave callers, narrowed to the parts anything reads. */
export type Result<T> = {
  rows: T[];
  /** Rows returned for a query; rows *changed* for an INSERT/UPDATE/DELETE. */
  rowCount: number;
  /** SQLite's own addition. `RETURNING id` works too, so little needs it. */
  lastInsertRowId: number;
};

/** The surface `tx`'s callback and both pools expose — `pg`'s PoolClient, narrowed. */
export type Client = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<Result<T>>;
};

// ---------------------------------------------------------------- connections

let rw: Promise<SQLite.SQLiteDatabase> | null = null;
let ro: Promise<SQLite.SQLiteDatabase> | null = null;

async function openRw(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync(DB_NAME);
  // foreign_keys is OFF by default and is per-connection. Without it every
  // `ON DELETE CASCADE` in the schema is silently ignored, so deleting a bill
  // would leave its attachments behind as unreachable rows — the kind of bug
  // that shows up months later as a wrong count.
  //
  // WAL lets the read-only connection below read while a write is in flight,
  // which is what stops /ask blocking on a form submit.
  await db.execAsync("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  return db;
}

async function openRo(): Promise<SQLite.SQLiteDatabase> {
  // Barrier 1 of the /ask sandbox. Postgres had a role with SELECT on the
  // analytics schema and nothing else; SQLite has no roles, but `query_only` is
  // per-connection and lasts its lifetime, so this connection cannot write even
  // if a generated statement gets past validateSql. `useNewConnection` is what
  // keeps it a *separate* connection — without it expo-sqlite would hand back
  // the cached read/write one and the pragma would disarm the whole app.
  const db = await SQLite.openDatabaseAsync(DB_NAME, { useNewConnection: true });
  await db.execAsync("PRAGMA query_only = ON;");
  return db;
}

/**
 * Whether a statement returns rows, which decides what `rowCount` means.
 *
 * `pg` reported rows-returned for a SELECT and rows-affected for a DML
 * statement, and both meanings are relied on: `exists.rowCount` after a SELECT
 * and `row.rowCount === 0` after an UPDATE. SQLite's `changes` is a connection
 * property left over from the last modifying statement, so reading it after a
 * SELECT would return a stale number — and a SELECT that matched nothing would
 * look like a hit. Hence the split.
 */
function returnsRows(text: string): boolean {
  // Skip leading whitespace and any -- or /* */ comment, which the query modules
  // use liberally, before looking at the first keyword.
  const head = text.replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, "").slice(0, 12).toLowerCase();
  return /^(select|with|pragma|explain|values)\b/.test(head);
}

/**
 * A JS value as something SQLite will bind.
 *
 * Booleans are the point: `archived` is a boolean throughout `types.ts` and
 * every action passes one. Converting here means no call site changes.
 * `undefined` becomes NULL because that is what `pg` did with it, and a missing
 * optional field arriving as NULL is the behaviour the schema expects.
 */
function bind(params: unknown[]): SQLite.SQLiteBindValue[] {
  return params.map((p, i) => {
    if (p === undefined || p === null) return null;
    if (typeof p === "boolean") return p ? 1 : 0;
    if (typeof p === "string" || typeof p === "number") return p;
    if (p instanceof Uint8Array) return p;
    if (Array.isArray(p)) {
      // Postgres took arrays for `unnest($1::int[], …)` bulk inserts. SQLite has
      // no unnest, so those statements became loops inside `tx`. Binding an
      // array here would coerce it to a string and insert nonsense, so it is a
      // loud failure instead.
      throw new Error(
        `db: parameter ${i + 1} is an array. SQLite has no unnest — insert row by row inside tx().`,
      );
    }
    // Objects reach here only for JSONB columns, which are TEXT now. Stringify
    // rather than refuse, so writeCache can pass a payload the way it always did.
    return JSON.stringify(p);
  });
}

async function run<T>(
  db: SQLite.SQLiteDatabase,
  text: string,
  params: unknown[],
): Promise<Result<T>> {
  const stmt = await db.prepareAsync(text);
  try {
    // executeAsync carries both the rows and the counters, so one call answers
    // every shape of statement and there is no need to guess which API to use.
    const res = await stmt.executeAsync<T>(bind(params));
    const rows = await res.getAllAsync();
    return {
      rows,
      rowCount: returnsRows(text) ? rows.length : res.changes,
      lastInsertRowId: res.lastInsertRowId,
    };
  } finally {
    // Not finalizing leaks the statement and, on a write, holds the WAL lock.
    await stmt.finalizeAsync();
  }
}

/** Wraps a lazily-opened connection so `.query()` can be called synchronously. */
function facade(open: () => Promise<SQLite.SQLiteDatabase>): Client {
  return {
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
      return run<T>(await open(), text, params);
    },
  };
}

/** The read/write connection. Opened on first use, then reused. */
export function pool(): Client {
  if (!rw) rw = openRw();
  return facade(() => rw!);
}

/**
 * Read-only connection, used exclusively for AI-generated SQL.
 *
 * Replaces the `moneyfit_ro` Postgres role. See the header of lib/ai/sql.ts for
 * the full list of barriers and the one that did not survive the port (there is
 * no `statement_timeout` here, so `runQuery` races a timer instead).
 */
export function poolRo(): Client {
  if (!ro) ro = openRo();
  return facade(() => ro!);
}

/**
 * The underlying read/write connection.
 *
 * Only the migration ladder should use this. `q`/`q1`/`tx` run one prepared
 * statement at a time, which is right for everything the app does but wrong for
 * a multi-statement DDL script, and migrations legitimately need `execAsync` and
 * a transaction it controls itself. Everything else goes through the six
 * functions, so there is exactly one place that knows about expo-sqlite besides
 * this file.
 */
export function database(): Promise<SQLite.SQLiteDatabase> {
  return (rw ??= openRw());
}

// -------------------------------------------------------------------- queries

/** Parameterised query. Always pass values as ?, never interpolate. */
export async function q<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool().query<T>(text, params);
  return res.rows;
}

/** First row, or null. */
export async function q1<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Runs `fn` inside a transaction, rolling back on any throw.
 *
 * `withExclusiveTransactionAsync` rather than `withTransactionAsync`: it hands
 * the callback a connection scoped to the transaction and holds exclusive access
 * for its duration, which is what `pool().connect()` used to give. The plain
 * version shares the connection, so a screen reloading mid-submit could slip a
 * SELECT between two writes and read a half-finished state.
 */
export async function tx<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const db = await (rw ??= openRw());
  // Definite-assignment assertion, earned by the `done` flag below rather than
  // assumed: the callback either assigns this or throws.
  let out!: T;
  let done = false;
  await db.withExclusiveTransactionAsync(async (txn) => {
    // Written as a generic method, not an arrow, so `c.query<{ id: number }>(…)`
    // at the call sites keeps its type argument instead of widening to unknown.
    const client: Client = {
      query<R = Record<string, unknown>>(text: string, params: unknown[] = []) {
        return run<R>(txn, text, params);
      },
    };
    out = await fn(client);
    done = true;
  });
  // Unreachable: withExclusiveTransactionAsync rethrows whatever the callback
  // threw, having rolled back. The flag exists so the assertion above is
  // justified by something the compiler and a reader can both check.
  if (!done) throw new Error("db: transaction ended without completing");
  return out;
}

/** True once the schema exists, so the UI can show a message instead of a stack trace. */
export async function isReady(): Promise<boolean> {
  try {
    await q("SELECT 1 FROM settings LIMIT 1");
    return true;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------- row coercions

/**
 * SQLite's 0/1 as the boolean the types promise.
 *
 * Used at every read of `archived` and nowhere else, because it is the only
 * boolean column in the schema. Kept tolerant of a real boolean so a row that
 * has already been mapped, or a literal in sample data, does not flip to false.
 *
 *   rows.map((r) => ({ ...r, archived: b(r.archived) }))
 */
export function b(v: unknown): boolean {
  return v === 1 || v === true || v === "1" || v === "true";
}

/**
 * A JSONB column, now TEXT, as the object it used to arrive as.
 *
 * Five columns need it, and they divide:
 *
 *   - `scan_drafts.payload`, `ask_turns.result_cols` and `ask_turns.result_rows` were
 *     `jsonb` on Postgres with `pg` parsing them on the way out, and this is the one
 *     place the port has to do work Postgres did for free.
 *   - `ask_turns.assumptions` and `ask_turns.chart` have no Postgres ancestor at all.
 *     They are the two columns the web's `ask_turns` does not have, because its Ask
 *     never asked the model for either — so they arrive here as TEXT by design rather
 *     than by translation, and they go through this for the same reason: a stored turn
 *     is read back by a version of the app that may not be the one that wrote it.
 *
 * A row written by a previous version — or by hand — that is not valid JSON returns
 * null rather than throwing, because a payload nothing can read should mean one
 * missing draft, one blank result table or one absent chart, not a broken screen.
 */
export function j<T>(v: unknown): T | null {
  if (v == null) return null;
  if (typeof v !== "string") return v as T;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
}

/**
 * Closes both connections. Only the JSON import needs this, to replace the file
 * underneath itself; nothing in normal operation should call it.
 */
export async function closeAll(): Promise<void> {
  const open = [rw, ro];
  rw = null;
  ro = null;
  for (const p of open) {
    if (!p) continue;
    try {
      await (await p).closeAsync();
    } catch {
      // Already closed, or never finished opening. Either way there is nothing
      // to release and nothing the user could do about it.
    }
  }
}
