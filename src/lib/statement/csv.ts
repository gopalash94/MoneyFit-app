/**
 * The CSV extractor, which exists because it is nearly free.
 *
 * Every Indian bank that offers a PDF statement also offers a CSV or Excel export
 * of the same data, and that export is *better* input: the columns are already
 * columns, so none of the coordinate reconstruction in `table.ts` is needed and
 * none of its failure modes apply. Supporting it costs this one file, because it
 * ends at `CellRow` like the PDF extractor does and everything downstream is
 * already written.
 *
 * So the honest advice to a user is "upload the CSV if your bank gives you one",
 * and the PDF path is for when it does not — which is the opposite of how this
 * feature would be described if the PDF parser were the clever part worth showing
 * off. It is not. The clever part is that there is only one pipeline.
 *
 * Delimiter and header row are both detected rather than configured. Bank exports
 * put several lines of account preamble above the real header, so the header is
 * found by looking for the first row that declares a date column and a money
 * column, exactly as the PDF path does, using the same vocabulary.
 *
 * On this platform the advice above is stronger still, not weaker: the CSV path is
 * the one that needs no WebView, so it is the whole importer in pure TypeScript.
 *
 * Byte-for-byte the web app's `src/lib/statement/csv.ts`, with one thing worth
 * knowing before anyone edits it: the byte-order-mark strip near the bottom holds a
 * **literal, invisible U+FEFF** inside its regex. Deleting it leaves a regex that
 * still compiles and still runs — `/^/` matches the empty string at position zero —
 * so the BOM survives, the first header label stops being recognised, and a CSV
 * exported from Excel falls through to the guess path with nothing on screen saying
 * why. If an editor or a copy-paste strips it, put it back as a backslash-u
 * escape for U+FEFF rather than retyping the character by hand.
 */

import { looksLikeAmount } from "./amount";
import { looksLikeDate } from "./dates";
import { classifyHeader, type ColKind } from "./table";
import { StatementError, type CellRow, type Extracted } from "./types";

/**
 * Splits delimited text into rows of cells, honouring quotes.
 *
 * Hand-written rather than taken from a library for the same reason the rest of
 * this feature is: it is twenty lines, it has no dependencies, and a statement CSV
 * exercises exactly one awkward case — a narration containing the delimiter, which
 * the bank quotes. Doubled quotes inside a quoted field are handled; everything
 * else about RFC 4180 is incidental here.
 */
function splitRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }

  if (cell || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

/**
 * Picks the delimiter by counting candidates outside quotes and taking the one that
 * appears most consistently across lines — consistency rather than raw frequency,
 * because a narration full of commas can out-count the real tab delimiter.
 */
function detectDelimiter(text: string): string {
  const sample = text.split("\n").slice(0, 40).filter((l) => l.trim());
  let best = ",";
  let bestScore = -1;

  for (const d of [",", "\t", ";", "|"]) {
    const counts = sample.map((l) => l.split(d).length - 1).filter((n) => n > 0);
    if (counts.length < 2) continue;
    const mode = counts.sort((a, b) => a - b)[Math.floor(counts.length / 2)];
    // Rows that agree with the median count, times that count: a delimiter that
    // yields 6 columns on 30 of 40 lines beats one that yields 2 on all of them.
    const score = counts.filter((n) => n === mode).length * mode;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }

  return best;
}

type Schema = Partial<Record<ColKind, number>>;

/** Reads a row as a header, returning which column plays which role. */
function readSchema(cells: string[]): Schema | null {
  const schema: Schema = {};
  for (let i = 0; i < cells.length; i++) {
    const kind = classifyHeader(cells[i]);
    // First occurrence wins, as in the PDF path: "Date" then "Value Date" keeps the
    // transaction date.
    if (kind && schema[kind] === undefined) schema[kind] = i;
  }
  const hasMoney = schema.debit !== undefined || schema.credit !== undefined || schema.amount !== undefined;
  return schema.date !== undefined && hasMoney ? schema : null;
}

/**
 * Works out the layout from the data instead of a header: the first cell that holds
 * a date is the date column, the last amount-shaped cell is the balance, the one
 * before it is the amount, and the longest remaining text cell is the narration.
 * Judged across many rows so one odd line cannot decide it.
 */
function guessSchema(rows: string[][]): Schema | null {
  const dateVotes = new Map<number, number>();
  const amountVotes = new Map<number, number>();
  const textVotes = new Map<number, number>();

  for (const cells of rows.slice(0, 200)) {
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i].trim();
      if (!cell) continue;
      if (looksLikeDate(cell)) dateVotes.set(i, (dateVotes.get(i) ?? 0) + 1);
      else if (looksLikeAmount(cell)) amountVotes.set(i, (amountVotes.get(i) ?? 0) + 1);
      else if (/[a-z]{3}/i.test(cell)) textVotes.set(i, (textVotes.get(i) ?? 0) + cell.length);
    }
  }

  const top = (votes: Map<number, number>) =>
    [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];

  const date = top(dateVotes);
  const narration = top(textVotes);
  const numeric = [...amountVotes.keys()].sort((a, b) => a - b);
  if (date === undefined || numeric.length === 0) return null;

  return numeric.length >= 2
    ? { date, narration, amount: numeric[numeric.length - 2], balance: numeric[numeric.length - 1] }
    : { date, narration, amount: numeric[0] };
}

const cell = (cells: string[], at: number | undefined): string =>
  at === undefined ? "" : (cells[at] ?? "").trim();

export function readCsv(text: string): Extracted {
  // Excel writes a byte-order mark, which would otherwise glue itself to the first
  // header label and stop it being recognised. The regex below contains a literal
  // U+FEFF that cannot be seen — see the header before editing this line.
  const clean = text.replace(/^﻿/, "");
  const delimiter = detectDelimiter(clean);
  const rows = splitRows(clean, delimiter).filter((r) => r.some((c) => c.trim()));

  if (rows.length === 0) throw new StatementError("That file is empty.");

  const notes: string[] = [];
  const named = delimiter === "\t" ? "tab" : `"${delimiter}"`;

  let schema: Schema | null = null;
  let start = 0;
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    schema = readSchema(rows[i]);
    if (schema) {
      start = i + 1;
      break;
    }
  }

  if (schema) {
    notes.push(`Read as ${named}-separated, with the header row on line ${start}.`);
  } else {
    schema = guessSchema(rows);
    if (!schema) {
      throw new StatementError(
        "No transactions could be found in that file. A statement export needs a date column and an amount column — if this is a summary or a list of accounts rather than a list of transactions, there is nothing here to import.",
      );
    }
    notes.push(
      `Read as ${named}-separated. No header row was recognised, so the columns were worked out from the data itself — check the dates and amounts below especially carefully.`,
    );
  }

  const out: CellRow[] = [];
  for (let i = start; i < rows.length; i++) {
    const cells = rows[i];
    const row: CellRow = {
      line: i + 1,
      date: cell(cells, schema.date),
      narration: cell(cells, schema.narration).replace(/\s+/g, " "),
      debit: cell(cells, schema.debit),
      credit: cell(cells, schema.credit),
      amount: cell(cells, schema.amount),
      balance: cell(cells, schema.balance),
      drcr: cell(cells, schema.drcr).toLowerCase().slice(0, 2),
    };
    // A trailing summary block ("Closing balance", a legal footer) has neither a
    // date nor an amount, and is simply not a transaction.
    if (!row.date && !row.debit && !row.credit && !row.amount) continue;
    out.push(row);
  }

  return { rows: out, page_count: 0, notes };
}
