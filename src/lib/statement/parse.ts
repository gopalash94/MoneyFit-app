/**
 * The pipeline: cells in, reviewable rows out.
 *
 * Everything that is format-specific has already happened by the time this file is
 * called — a PDF has had its table rebuilt from coordinates, a CSV has had its
 * columns identified — and both arrive as `CellRow[]`. What is left is the part that
 * is the same for every bank and every format: read the dates, work out which way
 * the money went, clean up the merchant, choose a category, and flag anything that
 * looks like a transaction you already have.
 *
 * The function is pure. Given the same file, the same category list and the same
 * existing bills it returns the same rows, every time, with no clock, no randomness
 * and no network. That is what makes it safe for the review screen to simply re-parse
 * the stored file rather than keep a half-finished copy of the parse in the database:
 * there is one source of truth, and it is the file you uploaded.
 *
 * Nothing here ever gives up on a row. A line whose date could not be read or whose
 * amount came out as zero is kept, marked with what is wrong with it, and shown —
 * because a silently dropped transaction is a hole in your spending that nothing in
 * the app will ever point at again, while a row with "no date" written next to it is
 * a thirty-second fix.
 *
 * ---
 *
 * **The web app's `src/lib/statement/parse.ts`, changed in exactly one place.**
 *
 * There it takes `{ buf: Buffer; mimeType: string }` and decides inside `extract`
 * whether to read those bytes as a PDF or as UTF-8 text. React Native has no
 * `Buffer` and no `buf.toString("utf8")`, and the two formats do not even want the
 * same read: a PDF has to arrive base64-encoded, because that is what crosses into
 * the WebView, and a CSV has to arrive as text, because `readCsv` splits characters.
 *
 * So the format decision comes out one step earlier. `statementFormat(mimeType)`
 * answers "which way do I read this file?" *before* it is read, the caller does the
 * matching `FileSystem.readAsStringAsync` — base64 or UTF-8 — and hands in a
 * `StatementSource` that is already the right kind of string. The refusal for an
 * unsupported type is the web's sentence, word for word, and simply fires earlier.
 *
 * Everything below `extract` is untouched: the once-per-file date order, the
 * newest-first detection, the balance array, the evidence ladder in `direction()`,
 * and the three summary notes.
 */

import { isBlankCell, parseStatementAmount } from "./amount";
import { makeCategoriser, type LearnedMap } from "./categorise";
import { readCsv } from "./csv";
import { detectDateOrder, parseDateCell } from "./dates";
import { signature } from "./dedupe";
import { readNarration } from "./narration";
import { readPdf } from "./pdf";
import { readTable } from "./table";
import type { Category, Kind } from "../types";
import { StatementError, type CandidateRow, type CellRow, type Extracted, type ParsedStatement } from "./types";

/**
 * A statement's bytes, already read the way its format needs them.
 *
 * A discriminated union rather than a byte array and a mime type, because that is
 * the honest shape: nothing downstream of here can read a PDF out of a UTF-8 string
 * or a CSV out of base64, so the pairing is not incidental and the type should not
 * let them be mixed up.
 */
export type StatementSource =
  | { format: "pdf"; base64: string }
  | { format: "delimited"; text: string };

/**
 * Routes a mime type to a format, or refuses it.
 *
 * The web did this inside `extract`, where it already had the bytes in hand. Here
 * the caller must know which way to read the file *before* reading it, so the
 * decision comes out one step earlier. The refusal is the web's, word for word, and
 * `StatementError` is what the UI already knows how to show.
 */
export function statementFormat(mimeType: string): StatementSource["format"] {
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "text/csv" || mimeType === "text/plain" || mimeType === "text/tab-separated-values") {
    return "delimited";
  }
  throw new StatementError(`${mimeType} is not a statement format this can read. Upload the PDF or the CSV your bank gives you.`);
}

export type ParseInput = {
  source: StatementSource;
  /** For a password-protected PDF. Never stored. */
  password?: string;
  categories: Category[];
  /** Merchant → the category you have filed it under most often. */
  learned: LearnedMap;
  /** Signature → the id of the bill that already covers it. */
  existing: Map<string, number>;
};

async function extract(source: StatementSource, password?: string): Promise<Extracted> {
  if (source.format === "pdf") {
    const { lines, page_count } = await readPdf(source.base64, password);
    const { rows, notes } = readTable(lines);
    return { rows, page_count, notes };
  }
  return readCsv(source.text);
}

type Direction = {
  amount_minor: number;
  kind: Kind;
  problem: string | null;
  /** True when nothing in the row said which way the money went. Counted, not repeated. */
  assumed: boolean;
};

/**
 * Works out how much moved and which way.
 *
 * Separate withdrawal and deposit columns answer the question by themselves. A
 * single amount column does not, and the fallbacks are tried in descending order of
 * how much they are really evidence: an explicit Dr/Cr marker, then a negative sign
 * or brackets, then the direction the running balance moved — which is exact when
 * the statement prints a balance, and is the reason `balance` is carried this far.
 * Only when none of those exist does it assume an expense, and then it says so.
 */
function direction(row: CellRow, balanceDelta: number | null): Direction {
  const debit = isBlankCell(row.debit) ? null : parseStatementAmount(row.debit);
  const credit = isBlankCell(row.credit) ? null : parseStatementAmount(row.credit);

  if (debit && debit.minor > 0) return { amount_minor: debit.minor, kind: "expense", problem: null, assumed: false };
  if (credit && credit.minor > 0) return { amount_minor: credit.minor, kind: "income", problem: null, assumed: false };

  const single = isBlankCell(row.amount) ? null : parseStatementAmount(row.amount);
  if (!single || single.minor === 0) {
    // Fall back to whichever of the three columns held something, so a row with an
    // unreadable amount is reported as unreadable rather than as missing.
    const printed = [row.debit, row.credit, row.amount].find((c) => !isBlankCell(c));
    return {
      amount_minor: 0,
      kind: "expense",
      problem: printed ? `Could not read the amount "${printed.trim()}".` : "No amount on this line.",
      assumed: false,
    };
  }

  const marker = row.drcr === "dr" || row.drcr === "cr" ? row.drcr : single.marker;
  if (marker === "dr") return { amount_minor: single.minor, kind: "expense", problem: null, assumed: false };
  if (marker === "cr") return { amount_minor: single.minor, kind: "income", problem: null, assumed: false };
  if (single.negated) return { amount_minor: single.minor, kind: "expense", problem: null, assumed: false };

  if (balanceDelta !== null && balanceDelta !== 0) {
    return { amount_minor: single.minor, kind: balanceDelta < 0 ? "expense" : "income", problem: null, assumed: false };
  }

  return {
    amount_minor: single.minor,
    kind: "expense",
    problem: "Nothing on this line says whether money went out or came in — assumed money out.",
    assumed: true,
  };
}

export async function parseStatement(input: ParseInput): Promise<ParsedStatement> {
  const { rows: cells, page_count, notes } = await extract(input.source, input.password);

  if (cells.length === 0) {
    throw new StatementError(
      "No transaction rows were found in that file. If it opened correctly, it may be a summary page or a passbook-style layout this cannot read yet — a CSV export of the same period will work.",
    );
  }

  // Decided once for the whole file, never per row. See dates.ts.
  const order = detectDateOrder(cells.map((c) => c.date));
  notes.push(order.note);

  // Which way the file runs. Needed before any balance can be read as a delta,
  // because a newest-first statement's balances fall as money comes in.
  const dates = cells.map((c) => parseDateCell(c.date, order.order)).filter((d): d is string => d !== null);
  const descending = dates.length >= 2 && dates[0] > dates[dates.length - 1];
  if (descending) notes.push("The file lists the newest transaction first.");

  const balances = cells.map((c) => (isBlankCell(c.balance) ? null : parseStatementAmount(c.balance)?.minor ?? null));

  const categorise = makeCategoriser(input.categories, input.learned);
  const out: CandidateRow[] = [];
  let assumed = 0;

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];

    const here = balances[i];
    const prev = balances[i - 1] ?? null;
    let delta = here !== null && prev !== null ? here - prev : null;
    if (delta !== null && descending) delta = -delta;

    const { amount_minor, kind, problem: amountProblem, assumed: guessed } = direction(cell, delta);
    if (guessed) assumed++;

    const txn_date = parseDateCell(cell.date, order.order);
    const { merchant, rail } = readNarration(cell.narration);
    const { category_id, category_source } = categorise(merchant, cell.narration, kind);

    const duplicate_of =
      txn_date && amount_minor > 0 ? input.existing.get(signature(txn_date, amount_minor, merchant)) ?? null : null;

    const problem =
      amount_minor === 0
        ? amountProblem ?? "No amount on this line."
        : !txn_date
          ? cell.date.trim()
            ? `Could not read the date "${cell.date.trim()}".`
            : "No date on this line."
          : amountProblem;

    out.push({
      line: cell.line,
      txn_date,
      narration: cell.narration,
      amount_minor,
      kind,
      merchant,
      rail,
      category_id,
      category_source,
      duplicate_of,
      problem,
    });
  }

  // One summary note rather than the same sentence on fifty rows.
  if (assumed > 2) {
    notes.push(
      `${assumed} rows do not say which way the money went, and were read as money out. If this statement has a separate column for deposits, check those rows.`,
    );
  }

  const unreadable = out.filter((r) => r.problem).length;
  if (unreadable > 0) {
    notes.push(`${unreadable} of ${out.length} rows need attention before they can be added — they are marked below.`);
  }

  return { rows: out, page_count, notes };
}
