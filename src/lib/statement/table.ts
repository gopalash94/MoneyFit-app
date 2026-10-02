/**
 * Turning positioned text back into a table.
 *
 * The approach here is deliberately *not* "draw column boundaries from the header
 * and drop every word into whichever box it lands in". That sounds principled and
 * fails on real statements, because a long narration bleeds past the boundary into
 * the withdrawal column and the text is lost, while a right-aligned number sits to
 * the left of its own header and is read as belonging to the column before it.
 *
 * Instead each line is read the way a person reads it, using the two things a bank
 * statement is always laid out around:
 *
 *   • the **date is first** on the line, and
 *   • the **amounts are last**.
 *
 * So the date comes off the front, amount-shaped tokens come off the back until a
 * non-amount stops the scan, and whatever is left in the middle is the narration —
 * all of it, however wide it ran. That alone is enough for a single-amount
 * statement.
 *
 * Coordinates are then used for the one job they are genuinely reliable for:
 * deciding *which* numeric column each trailing amount came from. An amount is
 * right-aligned inside its column, so its right edge falls between its own header
 * and the next one along — a test that is immune to the bleed that boundaries
 * suffer from, because narration text is never consulted for it.
 *
 * Two further facts about real statements are handled rather than ignored: a
 * narration often wraps onto the lines below it, which carry no date and no amount
 * and are appended to the row above; and the header repeats at the top of every
 * page, so lines that are themselves headers are skipped wherever they appear.
 *
 * **Byte-for-byte the web app's `src/lib/statement/table.ts`, and the file this
 * whole port is arranged around.** It is the column reconstructor: 356 lines of
 * decisions taken against real statements, none of which have anything to do with
 * the platform. Its `import type { Line } from "./pdf"` is untouched, which is the
 * constraint `pdf.ts` had to satisfy — the WebView rewrite over there keeps `Glyph`,
 * `Line` and `PdfText` structurally identical precisely so that this file does not
 * have to know that pdf.js now runs somewhere else.
 */

import { looksLikeAmount } from "./amount";
import { looksLikeDate } from "./dates";
import type { Line } from "./pdf";
import type { CellRow } from "./types";

/** A word with its position. Glyph runs are split and merged into these. */
type Token = { text: string; x: number; right: number };

/** The roles a statement column can play. Shared with the CSV extractor. */
export type ColKind = "date" | "narration" | "debit" | "credit" | "amount" | "balance" | "drcr" | "ref";

/** A header label's position, plus where the next column begins. */
type Anchor = { kind: ColKind; x: number; right: number; until: number };

const NUMERIC: ColKind[] = ["debit", "credit", "amount", "balance"];

/**
 * Header words, most specific first. "Withdrawal Amt." must be tested against the
 * withdrawal patterns before the bare "amount" pattern gets a chance, and
 * "Transaction Date" before the narration patterns, or a column lands in the wrong
 * role and every row after it is wrong in the same way.
 */
const HEADER_PATTERNS: Array<[ColKind, RegExp]> = [
  ["drcr", /^(dr\s*\/?\s*cr|cr\s*\/?\s*dr|type|txn type|transaction type|indicator)\b/],
  ["balance", /\b(balance|bal)\b/],
  ["debit", /^(withdrawal|withdrawl|withdraw|debit|dr|paid out|amount withdrawn)\b/],
  ["credit", /^(deposit|credit|cr|paid in|amount deposited)\b/],
  ["date", /\b(date|dt)\b/],
  ["amount", /^(amount|amt|transaction amount|txn amount)\b/],
  ["narration", /\b(narration|description|particulars|details|remarks|transaction)\b/],
  ["ref", /\b(ref|reference|cheque|chq|instrument|utr)\b/],
];

/**
 * What role a header label declares. Exported because a CSV's header row means
 * exactly the same thing as a PDF's, and the two extractors agreeing on the
 * vocabulary is what lets a bank's CSV and its PDF import identically.
 */
export function classifyHeader(text: string): ColKind | null {
  const s = text.toLowerCase().replace(/[.()*:]/g, " ").replace(/\s+/g, " ").trim();
  if (!s || s.length > 40) return null;
  for (const [kind, re] of HEADER_PATTERNS) if (re.test(s)) return kind;
  return null;
}

/**
 * Splits a line's glyph runs into words, keeping each word's position.
 *
 * pdfjs hands back runs, not words, and a run may hold several words or half of
 * one. Words inside a run get their x estimated by character count, which is
 * approximate for a proportional font and perfectly adequate here — the positions
 * that have to be exact are the right edges of trailing amounts, and an amount is
 * almost always a run of its own, so its right edge comes straight from pdfjs.
 * Runs that touch are then glued back together, which repairs the "1,234" + ".56"
 * split that a font change in the middle of a number produces.
 */
function tokenise(line: Line): Token[] {
  const split: Token[] = [];

  for (const g of line.items) {
    const width = Math.max(0, g.right - g.x);
    const per = g.text.length > 0 ? width / g.text.length : 0;
    let offset = 0;
    let last: Token | null = null;
    for (const part of g.text.split(/(\s+)/)) {
      if (part.length === 0) continue;
      if (!/\s/.test(part)) {
        last = {
          text: part,
          x: g.x + offset * per,
          right: g.x + (offset + part.length) * per,
        };
        split.push(last);
      }
      offset += part.length;
    }
    // The last word of a run ends exactly where pdfjs says the run ends; the
    // estimate only has to carry the words in the middle.
    if (last) last.right = g.right;
  }

  const merged: Token[] = [];
  for (const t of split) {
    const prev = merged[merged.length - 1];
    if (prev && t.x - prev.right <= 0.8) {
      prev.text += t.text;
      prev.right = t.right;
    } else {
      merged.push({ ...t });
    }
  }
  return merged;
}

/** Groups tokens into visually separated runs — used to read header labels whole. */
function runs(tokens: Token[], gap: number): Token[] {
  const out: Token[] = [];
  for (const t of tokens) {
    const prev = out[out.length - 1];
    if (prev && t.x - prev.right <= gap) {
      prev.text += ` ${t.text}`;
      prev.right = t.right;
    } else {
      out.push({ ...t });
    }
  }
  return out;
}

/**
 * Reads a line as a header row. Returns the columns it declares, or null if it is
 * not a header: a header has a date column and at least one money column, and
 * nothing else in a statement looks like that.
 */
function headerAnchors(line: Line): Anchor[] | null {
  const found: Array<Omit<Anchor, "until">> = [];
  const seen = new Set<ColKind>();

  for (const r of runs(tokenise(line), 5)) {
    const kind = classifyHeader(r.text);
    if (!kind) continue;
    // First occurrence wins, so "Txn Date … Value Date" keeps the transaction date
    // and a repeated label cannot shift a column that is already placed.
    if (seen.has(kind)) continue;
    seen.add(kind);
    found.push({ kind, x: r.x, right: r.right });
  }

  const hasMoney = found.some((a) => a.kind === "debit" || a.kind === "credit" || a.kind === "amount");
  if (!seen.has("date") || !hasMoney) return null;

  found.sort((a, b) => a.x - b.x);
  return found.map((a, i) => ({ ...a, until: found[i + 1]?.x ?? Infinity }));
}

/**
 * Pulls the leading date off a line.
 *
 * Shortest match first, which matters: a cell holding a transaction date and a value
 * date side by side ("01/04/2026 01/04/2026 UPI/…") would, tried longest-first, read
 * three tokens as one date and swallow the start of the narration.
 */
function takeDate(tokens: Token[]): { date: string; rest: Token[] } {
  for (const skip of [0, 1]) {
    // Some statements number their rows. A leading serial is only dropped if a date
    // actually follows it, so "1 Apr 2026" is never mistaken for a serial.
    if (skip === 1 && !/^\d{1,4}$/.test(tokens[0]?.text ?? "")) break;
    for (const n of [1, 2, 3]) {
      if (tokens.length < skip + n) break;
      const text = tokens.slice(skip, skip + n).map((t) => t.text).join(" ");
      if (looksLikeDate(text)) return { date: text, rest: tokens.slice(skip + n) };
    }
  }
  return { date: "", rest: tokens };
}

type TrailingAmount = { token: Token; marker: string };

/** Pulls amount tokens off the end of a line, rightmost first. */
function takeAmounts(tokens: Token[]): { amounts: TrailingAmount[]; rest: Token[] } {
  const amounts: TrailingAmount[] = [];
  let end = tokens.length;
  let marker = "";

  while (end > 0 && amounts.length < 4) {
    const t = tokens[end - 1];
    // A free-standing Dr/Cr belongs to the amount immediately to its left.
    if (/^(dr|cr)\.?$/i.test(t.text)) {
      marker = t.text.slice(0, 2).toLowerCase();
      end--;
      continue;
    }
    if (looksLikeAmount(t.text)) {
      amounts.push({ token: t, marker });
      marker = "";
      end--;
      continue;
    }
    break;
  }

  return { amounts, rest: tokens.slice(0, end) };
}

/**
 * Decides which numeric column each trailing amount came from.
 *
 * Primary test: an amount is right-aligned inside its column, so its right edge
 * falls between its own header's left edge and the next header's. Where no column
 * claims it — an unusually wide number, a header that sits oddly — the nearest
 * right edge decides instead.
 *
 * Greedy, rightmost amount first, each column claimed once. Greedy is correct here
 * rather than merely convenient: amounts and columns are both in left-to-right
 * order, so an amount cannot belong to a column to the right of one already taken by
 * an amount further right.
 */
function assignColumns(amounts: TrailingAmount[], anchors: Anchor[]): Map<ColKind, TrailingAmount> {
  const numeric = anchors.filter((a) => NUMERIC.includes(a.kind));
  const out = new Map<ColKind, TrailingAmount>();
  const used = new Set<ColKind>();

  for (const amount of amounts) {
    const free = numeric.filter((a) => !used.has(a.kind));
    if (free.length === 0) break;

    const edge = amount.token.right;
    let best = free.find((a) => edge >= a.x && edge < a.until) ?? null;
    if (!best) {
      let bestGap = Infinity;
      for (const a of free) {
        const gap = Math.abs(edge - a.right);
        if (gap < bestGap) {
          best = a;
          bestGap = gap;
        }
      }
    }
    if (!best) break;

    used.add(best.kind);
    out.set(best.kind, amount);
  }

  return out;
}

/**
 * The same job without a header to go on: the rightmost trailing amount is the
 * running balance and the one before it is the transaction amount, which is the
 * layout of nearly every statement that prints a single amount column. `parse.ts`
 * can still recover the direction of each row from how the balance moved.
 */
function assignByOrder(amounts: TrailingAmount[]): Map<ColKind, TrailingAmount> {
  const out = new Map<ColKind, TrailingAmount>();
  if (amounts.length >= 2) {
    out.set("balance", amounts[0]);
    out.set("amount", amounts[1]);
  } else if (amounts.length === 1) {
    out.set("amount", amounts[0]);
  }
  return out;
}

/** Page furniture: neither a transaction nor part of one. */
const FURNITURE =
  /^(page\s*\d+\b|.*\bpage \d+ of \d+|continued\b|statement of account|opening balance|closing balance|b\/f\b|brought forward|carried forward|total\b|grand total|this is a (computer|system)[ -]generated|registered office|please examine)/i;

export type TableResult = {
  rows: CellRow[];
  notes: string[];
};

export function readTable(lines: Line[]): TableResult {
  const notes: string[] = [];

  let found: Anchor[] | null = null;
  for (const line of lines) {
    found = headerAnchors(line);
    if (found) break;
  }
  const headerless = found === null;
  const columns: Anchor[] = found ?? [];

  if (found) {
    notes.push(`Columns found from the statement's own header row: ${found.map((a) => a.kind).join(", ")}.`);
  } else {
    notes.push(
      "No header row was recognised, so every line was read as date, description, amount, balance in that order. Check the amounts below especially carefully.",
    );
  }

  const rows: CellRow[] = [];
  let lineNo = 0;

  for (const line of lines) {
    lineNo++;

    // The header repeats at the top of every page; skip it wherever it turns up,
    // including the one the columns were built from.
    if (headerAnchors(line)) continue;

    const tokens = tokenise(line);
    if (tokens.length === 0) continue;

    const { date, rest } = takeDate(tokens);
    const { amounts, rest: middle } = takeAmounts(rest);

    // A second date at the front of what is left is the value date, which is of no
    // interest once the transaction date is in hand.
    const body = middle.length > 0 && looksLikeDate(middle[0].text) ? middle.slice(1) : middle;
    const narration = body.map((t) => t.text).join(" ").replace(/\s+/g, " ").trim();

    if (!date && amounts.length === 0) {
      // No date and no money: either a narration wrapped from the row above, or page
      // furniture. The row above gets it only if it is the former.
      const prev = rows[rows.length - 1];
      if (prev && narration.length > 2 && !FURNITURE.test(narration)) {
        prev.narration = `${prev.narration} ${narration}`.trim();
      }
      continue;
    }

    if (FURNITURE.test(narration)) continue;

    const byColumn = headerless ? assignByOrder(amounts) : assignColumns(amounts, columns);
    rows.push({
      line: lineNo,
      date,
      narration,
      debit: byColumn.get("debit")?.token.text ?? "",
      credit: byColumn.get("credit")?.token.text ?? "",
      amount: byColumn.get("amount")?.token.text ?? "",
      balance: byColumn.get("balance")?.token.text ?? "",
      drcr:
        byColumn.get("amount")?.marker ||
        byColumn.get("debit")?.marker ||
        byColumn.get("credit")?.marker ||
        "",
    });
  }

  return { rows, notes };
}
