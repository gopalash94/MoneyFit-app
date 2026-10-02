/**
 * The two shapes every statement format reduces to.
 *
 * These types are the seam the whole feature is built around. A PDF extractor and a
 * CSV extractor have nothing in common — one reconstructs columns from glyph
 * coordinates, the other splits on commas — but both stop at `CellRow`: one line's
 * cells, as strings, with nothing interpreted. Everything after that point (reading
 * the dates, deciding the direction, cleaning the merchant, categorising, duplicate
 * detection, the review table, the insert) is written once and shared.
 *
 * The split matters for a reason that only shows up in the hard cases: the date
 * format cannot be settled one row at a time (see `dates.ts`), so *something* has
 * to hold the whole statement as plain strings before any of it is interpreted.
 * `CellRow[]` is that something. Adding a bank or a format means writing an
 * extractor that fills in these six fields, and touching nothing else.
 *
 * **Byte-for-byte the web app's `src/lib/statement/types.ts`.** It imports two type
 * aliases that exist under the same paths here and contains no logic, so there is
 * nothing to translate. The same is true of `amount.ts`, `dates.ts`, `narration.ts`,
 * `rules.ts`, `categorise.ts`, `dedupe.ts`, `csv.ts` and `table.ts`: nine of the
 * eleven files in this directory are the web's, unchanged. `pdf.ts` is the one real
 * rewrite — see its header — and `parse.ts` changes in exactly one place, where it
 * used to take a Node `Buffer`.
 */

import type { ISODate } from "../date";
import type { Kind } from "../types";

/** One line of a statement, as cells, straight out of an extractor. */
export type CellRow = {
  /** Where it was found, 1-based across the whole file. Survives into form field names. */
  line: number;
  date: string;
  narration: string;
  /** The withdrawal / debit column, when the statement has separate columns. */
  debit: string;
  /** The deposit / credit column. */
  credit: string;
  /** Filled instead of debit/credit when the statement has one amount column. */
  amount: string;
  /**
   * The running balance. Not imported — but when a statement has a single amount
   * column and no Dr/Cr marker, the change in balance from the row above is the only
   * thing in the file that says whether money went out or came in, so it is carried
   * this far rather than thrown away at the extractor.
   */
  balance: string;
  /** A "Dr/Cr" or "Type" indicator column, when there is one. */
  drcr: string;
};

/** What an extractor returns. `notes` are what it had to assume, in plain words. */
export type Extracted = {
  rows: CellRow[];
  page_count: number;
  notes: string[];
};

/** A `CellRow` once the shared pipeline has read it. */
export type RawRow = {
  line: number;
  /** Null when the date cell could not be read — the row is kept and flagged. */
  txn_date: ISODate | null;
  /** The narration column exactly as printed, kept for display and for the notes field. */
  narration: string;
  /** Always positive. Direction lives in `kind`, as it does on `bills`. */
  amount_minor: number;
  kind: Kind;
};

/** Why `categorise` chose what it chose. Shown in the review table, per row. */
export type CategorySource = "learned" | "rule" | "none";

/** A `RawRow` with everything the review table needs to show next to it. */
export type CandidateRow = RawRow & {
  /** The narration reduced to something you would recognise on a bill. */
  merchant: string;
  /** The payment rail the narration came over, when it announced itself. */
  rail: string | null;
  category_id: number | null;
  category_source: CategorySource;
  /** An existing bill this looks like. Pre-unticked in the review table. */
  duplicate_of: number | null;
  /** Set when the row cannot be imported as it stands — no date, no amount. */
  problem: string | null;
};

export type ParsedStatement = {
  rows: CandidateRow[];
  page_count: number;
  /**
   * What the extractor had to assume, in plain words. Surfaced in the UI rather
   * than logged: a reader who can see "columns found from the header row: Date,
   * Narration, Withdrawal, Deposit, Balance" and "dates read as day-first" can tell
   * at a glance whether to trust the table underneath.
   */
  notes: string[];
};

/** A failure the user can act on: wrong password, no text layer, not a statement. */
export class StatementError extends Error {}
