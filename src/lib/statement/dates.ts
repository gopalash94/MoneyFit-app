/**
 * Date cells, and the one genuinely ambiguous decision in statement parsing.
 *
 * "03/04/2026" is the 3rd of April to an Indian bank and the 4th of March to an
 * American one, and nothing in the cell says which. Guessing per row is the worst
 * option: a statement would come out with most dates right and a few silently
 * transposed, which is far harder to notice than all of them being wrong.
 *
 * So the order is decided **once per statement**, from the evidence in every date
 * cell at once: a first component over 12 anywhere proves day-first, a second
 * component over 12 anywhere proves month-first. If no row settles it — a whole
 * statement inside the first twelve days of months — it falls back to day-first,
 * because that is what Indian bank statements use and this app is denominated in
 * rupees. Either way the decision is reported in the parse notes, so a reader can
 * see which reading produced the table they are looking at.
 *
 * Byte-for-byte the web app's `src/lib/statement/dates.ts`. The only thing it
 * touches outside itself is `Date.UTC`, which Hermes implements identically.
 */

import type { ISODate } from "../date";

export type DateOrder = "dmy" | "mdy";

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** `01-Apr-2026`, `1 April 26`, `01 Apr 2026` — unambiguous, so order is irrelevant. */
const NAMED = /^(\d{1,2})[\s\-/.]*([a-z]{3,9})[\s\-/.]*(\d{2}|\d{4})$/;
/** `2026-04-01` — ISO, equally unambiguous. */
const ISO_LIKE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/;
/** `03/04/2026`, `3-4-26` — the ambiguous one. */
const NUMERIC = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/;

/**
 * Statements often carry a time or a second date in the same cell
 * ("01/04/2026 14:32", "01/04/2026 02/04/2026" for value date). The leading date
 * is the transaction date; the rest is dropped.
 */
function firstToken(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/\s+/g, " ");
  const m = s.match(/^\d{1,4}[-/.\s]*[a-z0-9]{1,9}[-/.\s]*\d{2,4}/);
  return (m ? m[0] : s).trim();
}

function fourDigitYear(y: string): number {
  const n = Number(y);
  if (y.length === 4) return n;
  // A statement is a record of the past; a two-digit year in the seventies is a
  // 20th-century date, anything lower is this century.
  return n >= 70 ? 1900 + n : 2000 + n;
}

/** Builds an ISO date only if the calendar agrees it exists. */
function toIso(y: number, m: number, d: number): ISODate | null {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() + 1 !== m || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Decides day-first vs month-first for a whole statement. Returns the order and
 * the sentence that explains it, which goes straight into the parse notes.
 */
export function detectDateOrder(cells: string[]): { order: DateOrder; note: string } {
  let dayFirst = 0;
  let monthFirst = 0;

  for (const cell of cells) {
    const m = firstToken(cell).match(NUMERIC);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && b <= 12) dayFirst++;
    else if (b > 12 && a <= 12) monthFirst++;
  }

  if (dayFirst && !monthFirst) {
    return { order: "dmy", note: `Dates read as day-first — ${dayFirst} row${dayFirst === 1 ? "" : "s"} can only be read that way.` };
  }
  if (monthFirst && !dayFirst) {
    return { order: "mdy", note: `Dates read as month-first — ${monthFirst} row${monthFirst === 1 ? "" : "s"} can only be read that way.` };
  }
  if (dayFirst && monthFirst) {
    // Both proofs present: the file is internally inconsistent, or a column was
    // misidentified. Day-first wins, and the note says so plainly rather than
    // pretending the reading is settled.
    return {
      order: "dmy",
      note: `Dates are inconsistent — ${dayFirst} row${dayFirst === 1 ? "" : "s"} must be day-first and ${monthFirst} must be month-first. Read as day-first; check every date below.`,
    };
  }
  return { order: "dmy", note: "Dates read as day-first (no row in the file settles it either way). Check a few against the statement." };
}

export function parseDateCell(raw: string, order: DateOrder): ISODate | null {
  const s = firstToken(raw);
  if (!s) return null;

  const named = s.match(NAMED);
  if (named) {
    const month = MONTHS[named[2].slice(0, named[2].startsWith("sept") ? 4 : 3)];
    if (month) return toIso(fourDigitYear(named[3]), month, Number(named[1]));
    return null;
  }

  const iso = s.match(ISO_LIKE);
  if (iso) return toIso(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const num = s.match(NUMERIC);
  if (num) {
    const a = Number(num[1]);
    const b = Number(num[2]);
    const year = fourDigitYear(num[3]);
    // A row that contradicts the statement-wide order is still read correctly
    // where only one reading is possible at all.
    if (a > 12) return toIso(year, b, a);
    if (b > 12) return toIso(year, a, b);
    return order === "dmy" ? toIso(year, b, a) : toIso(year, a, b);
  }

  return null;
}

/** Does this cell look like a date at all? Used to find the date column. */
export function looksLikeDate(raw: string): boolean {
  const s = firstToken(raw);
  return NAMED.test(s) || ISO_LIKE.test(s) || NUMERIC.test(s);
}
