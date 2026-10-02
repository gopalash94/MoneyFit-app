/**
 * Reading and writing the Ask thread — `Finance/src/lib/queries/ask.ts`, in SQLite.
 *
 * The web module had two halves that deliberately did not share a connection:
 * `listTurns`/`recordTurn` on the ordinary pool, and `runAnswer` on `poolRo()` —
 * the `moneyfit_ro` role, which could read the `analytics` views and nothing else.
 *
 * **Only the first half is here.** `runAnswer` does not port, and the reason is that
 * its job was already done better before this file existed: `ai/sql.ts:runQuery`
 * runs the checked statement on `poolRo()`, which on this platform is a separate
 * connection pinned to `PRAGMA query_only = ON`, and races it against a five-second
 * timer in place of Postgres' `statement_timeout`. Porting `runAnswer` would mean a
 * second code path to the same connection, and the split it existed to enforce —
 * *the query nobody wrote by hand runs on the connection that cannot write* — is
 * enforced by `poolRo()` itself here rather than by which module makes the call.
 *
 * What did have to come across is the *rendering* half of `runAnswer`, as
 * `renderResult` below, because that is what decides what `ask_turns` stores.
 *
 * Two boundaries live in this file and nowhere else:
 *
 *   - **JSON.** `result_cols`, `result_rows`, `assumptions` and `chart` were `jsonb`
 *     and are TEXT here, so `recordTurn` stringifies and `listTurns` parses through
 *     `j()`. Above this file they are the types `types.ts` declares and nothing else.
 *   - **Rendering.** A cell becomes a string here, once, while it is still next to
 *     the SQL that produced it. See `cell()`.
 */

import { b, j, q, q1, tx } from "../db";
import type { GeneratedQuery, QueryResult } from "../ai/sql";
import { fmtWhole, groupIndian } from "../money";
import type { AskChart, AskColumn, AskTurn } from "../types";

/**
 * The thread, newest first.
 *
 * Newest first rather than chat order, because this screen is a notebook and not a
 * conversation: the input is at the top, the answer you just asked for appears
 * directly under it, and nothing scrolls away. Journal orders the same way for the
 * same reason.
 *
 * `ORDER BY id DESC` rather than `created_at DESC`, matching the web: `created_at`
 * has one-second resolution here (`datetime('now')`), so two questions asked in the
 * same second would come back in an order the database chose. The index on
 * `created_at` is for the eventual prune, not for this.
 */
export async function listTurns(limit = 30): Promise<AskTurn[]> {
  // The generic describes the mapped shape rather than the raw row — the same small
  // lie `listGoals` tells, and for the same reason: `b()` and `j()` both take
  // `unknown`, so the mapping below is what makes the claim true.
  const rows = await q<AskTurn>("SELECT * FROM ask_turns ORDER BY id DESC LIMIT ?1", [limit]);
  return rows.map((r) => ({
    ...r,
    assumptions: j<string[]>(r.assumptions),
    chart: j<AskChart>(r.chart),
    result_cols: j<AskColumn[]>(r.result_cols),
    result_rows: j<string[][]>(r.result_rows),
    truncated: b(r.truncated),
  }));
}

export async function turnCount(): Promise<number> {
  // `count(*)::int` on the web. SQLite has no cast and returns an integer already.
  const row = await q1<{ n: number }>("SELECT count(*) AS n FROM ask_turns");
  return row?.n ?? 0;
}

export async function recordTurn(t: {
  question: string;
  status: AskTurn["status"];
  sql_text?: string | null;
  model?: string | null;
  note?: string | null;
  assumptions?: string[] | null;
  chart?: AskChart | null;
  result_cols?: AskColumn[] | null;
  result_rows?: string[][] | null;
  row_count?: number;
  truncated?: boolean;
  ms?: number | null;
}): Promise<void> {
  await q(
    `INSERT INTO ask_turns
       (question, status, sql_text, model, note, assumptions, chart,
        result_cols, result_rows, row_count, truncated, ms)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    [
      t.question,
      t.status,
      t.sql_text ?? null,
      t.model ?? null,
      t.note ?? null,
      // Stringified here rather than left to `bind()`. `bind()` stringifies a plain
      // object but *throws* on an array, deliberately, so that a forgotten `unnest`
      // fails loudly instead of inserting `"[object Object]"` — and three of these
      // four are arrays. The web stringified at this same spot anyway.
      //
      // The length check rather than a bare truthiness test: an empty `assumptions`
      // array is the common case, and storing `"[]"` where `NULL` means the same
      // thing would make every refusal carry two bytes of nothing.
      t.assumptions && t.assumptions.length ? JSON.stringify(t.assumptions) : null,
      t.chart ? JSON.stringify(t.chart) : null,
      t.result_cols ? JSON.stringify(t.result_cols) : null,
      t.result_rows ? JSON.stringify(t.result_rows) : null,
      t.row_count ?? 0,
      // `bind()` maps booleans to 0/1, which is what the CHECK constraint wants.
      t.truncated ?? false,
      t.ms ?? null,
    ],
  );
}

export async function deleteTurn(id: number): Promise<void> {
  await q("DELETE FROM ask_turns WHERE id = ?1", [id]);
}

/**
 * Empty the thread, and restart numbering.
 *
 * `TRUNCATE ask_turns RESTART IDENTITY` on the web. SQLite has no TRUNCATE, and the
 * identity half is not decoration: `id` is `INTEGER PRIMARY KEY AUTOINCREMENT`, which
 * keeps its high-water mark in `sqlite_sequence`, so a plain DELETE would leave the
 * next question numbered 48 in a thread you had just emptied. Both statements, in one
 * transaction, so a thread is never half-cleared.
 *
 * Deleting the `sqlite_sequence` row rather than updating it is the documented way to
 * reset a sequence, and is safe when the table is empty — which the statement before
 * it has just made true.
 */
export async function clearTurns(): Promise<void> {
  await tx(async (c) => {
    await c.query("DELETE FROM ask_turns");
    await c.query("DELETE FROM sqlite_sequence WHERE name = 'ask_turns'");
  });
}

/**
 * A finished query's rows as the thread stores them: column headers with an
 * alignment flag, and every cell already a string.
 *
 * This is the rendering half of the web's `runAnswer`, and it has to live somewhere
 * below the screen for the reason the web gave — *this is the last place that knows
 * the column's type*. The two platforms learn that type differently:
 *
 *   - **Postgres told us.** `res.fields[i].dataTypeID` against a list of numeric OIDs
 *     (20/21/23 int, 700/701 float, 1700 numeric), so a column was numeric whether or
 *     not it had any rows.
 *   - **Here the column's name is the evidence.** expo-sqlite has no column-metadata
 *     side-channel at all, so `num` comes from `numeric()` — the same convention check
 *     `cell()` uses to decide whether to format a value as money. That pairing is the
 *     point: a value-sniffing flag would let a column be right-aligned and formatted as
 *     text, or the reverse, and an all-NULL column would silently change alignment
 *     depending on how many rows came back.
 *
 * `truncated` and the cap are not applied here. `runQuery` already slices to
 * `MAX_ROWS` and reports whether there were more, so this walks what it kept.
 */
export function renderResult(result: QueryResult): {
  cols: AskColumn[];
  rows: string[][];
} {
  return {
    cols: result.columns.map((name) => ({ name, num: numeric(name) })),
    // Column order comes from `result.columns`, not from each row's key order, so a
    // row that happens to be missing a key renders as a gap in the right place
    // rather than shifting every cell after it one column to the left.
    rows: result.rows.map((r) => result.columns.map((name) => cell(r[name], name))),
  };
}

/**
 * The series behind a chart the model asked for, pulled out while the values are
 * still numbers.
 *
 * Three ways a requested chart ends up as `null`, and all three are the model's own
 * doing rather than an error worth reporting:
 *
 *   - it named a column the query does not return — so there is nothing to plot, and
 *     a chart drawn anyway would be an empty box;
 *   - the value column holds text that will not convert, so every row is dropped;
 *   - fewer than two points survive, which is a number and not a chart.
 *
 * Saying so once here beats guarding it at every render, which is where the check
 * used to live — `answerQuestion` dropped a chart whose columns were missing before
 * it handed the answer over, and that is the line this absorbed.
 */
export function renderChart(
  chart: GeneratedQuery["chart"],
  result: QueryResult,
): AskChart | null {
  if (!chart) return null;
  if (
    !result.columns.includes(chart.label_column) ||
    !result.columns.includes(chart.value_column)
  ) {
    return null;
  }

  const labels: string[] = [];
  const values: number[] = [];

  for (const row of result.rows) {
    const n = Number(row[chart.value_column]);
    if (!Number.isFinite(n)) continue;
    labels.push(String(row[chart.label_column] ?? ""));
    values.push(n);
  }

  if (values.length < 2) return null;

  return {
    kind: chart.kind,
    label: chart.label_column,
    value: chart.value_column,
    labels,
    values,
  };
}

// ---------------------------------------------------------------- formatting
//
// These six moved down here from `app/ask.tsx` when the thread arrived, because a
// cell is now rendered once on the way *into* the database rather than on every
// render of a live answer.
//
// Three of them are still exported, and each for a different reason:
//
//   - `pretty`, because a column heading is the one thing the screen has to compute at
//     render time — a stored turn keeps the column's name and its alignment, and the
//     name is all a heading has.
//   - `isMoney` and `compactNumber`, because a chart's axis is formatted from the
//     *numbers* `renderChart` kept, not from the strings `cell()` made, and it has to
//     reach the same verdict about the same column name. Two copies of this convention
//     would be two chances for a chart to say ₹ where its table did not.
//
// `numeric` is not exported: its answer is stored on every column as `AskColumn.num`,
// so a screen that re-derived it could disagree with the rows it is aligning.
//
// The web's `cell()` did not come across. It called
// `v.toLocaleString("en-IN", { maximumFractionDigits: 2 })`, and Hermes ships without
// full ICU, so that request can fall back to en-US grouping and print 12,345,678
// where every other number in this app reads 1,23,45,678. That is the same reason
// `money.ts` wrote the lakh/crore rule out by hand instead of reaching for `Intl`.
// What is here instead is strictly more informed than what it replaces: the web's
// renderer saw a bare value, this one sees the column name too, so it can tell paise
// from rupees from a percentage and put the ₹ only where one belongs.

/**
 * Whether a column holds money.
 *
 * The analytics views name every money column `*_rupees` or `*_minor`, and the prompt asks
 * for snake_case aliases built from them — so this is a convention check, not a guess about
 * content. When it is wrong the number is still right, just missing a ₹.
 */
export function isMoney(col: string): boolean {
  return (
    /rupees|_minor$|amount|spend|spent|total|income|expense|net|value|invested|gain|limit|target|saved/.test(
      col.toLowerCase(),
    ) && !/count|pct|percent|days|months|years|rate/.test(col.toLowerCase())
  );
}

/** Right-align, and nothing more. Stored on each column as `AskColumn.num`. */
function numeric(col: string): boolean {
  return (
    isMoney(col) || /count|pct|percent|_id$|^id$|days|months|years|rate|number/.test(col.toLowerCase())
  );
}

/** A column name as a heading: `net_rupees` → `Net (₹)`. */
export function pretty(col: string): string {
  return col
    .replace(/_rupees$/, " (₹)")
    .replace(/_minor$/, " (paise)")
    .replace(/_pct$|^pct_/, " %")
    .replace(/_/g, " ")
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

/**
 * One cell. SQLite hands back dates as strings and everything numeric as a number, so the
 * only real work is money and nulls.
 *
 * Two lanes the screen version did not need, both because the output is now persisted
 * rather than thrown away on unmount. A `Uint8Array` is caught before `String()` can turn
 * a BLOB into a comma-separated list of byte values; no analytics view selects one, so it
 * is a guard rather than a feature. And the text lane is capped at 300 characters, as the
 * web's was, so a column nobody anticipated cannot write an unbounded string into every
 * row of the thread.
 */
function cell(v: unknown, col: string): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") {
    if (/_minor$/.test(col)) return fmtWhole(v);
    if (isMoney(col)) return fmtWhole(Math.round(v * 100));
    if (/pct|percent|rate/.test(col.toLowerCase())) return `${round(v)}%`;
    return compactNumber(v);
  }
  if (v instanceof Uint8Array) return `${v.length} bytes`;
  // A SUM over an empty set, or a cast in the generated SQL, can still produce a string.
  if (typeof v === "string" && v !== "" && !Number.isNaN(Number(v)) && isMoney(col)) {
    return fmtWhole(Math.round(Number(v) * 100));
  }
  return String(v).trim().slice(0, 300);
}

/**
 * A plain number, grouped the Indian way.
 *
 * `groupIndian` is the lakh/crore rule `money.ts` writes out by hand, and it takes paise,
 * hence the ×100. It emits no decimal part when the paise are zero, so a whole number
 * stays whole; a fraction comes back at two places rather than the web's "up to two".
 *
 * Deliberately no ₹. The query might be returning a count, a year or a row number, and a
 * currency symbol on a row count is a lie that looks like a feature — which is also why
 * this does not go through `fmt()`.
 */
export function compactNumber(v: number): string {
  return Number.isFinite(v) ? groupIndian(Math.round(v * 100)) : String(v);
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
