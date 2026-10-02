/**
 * Amounts as a *statement* writes them, which is not what a human types.
 *
 * Deliberately not `money.ts`'s `parseAmount`. That one is generous on purpose —
 * it accepts "1.2L", "45k", "3cr" — which is exactly right for a person typing
 * into a form and exactly wrong here: a statement cell reading "1,234.56 Cr"
 * would be read by the lakh rule as ₹1.23 crore, silently, and the review table
 * would show a plausible-looking number that is five orders of magnitude out. So
 * this parser accepts digits, one decimal point, grouping commas and a Dr/Cr
 * marker, and refuses everything else.
 *
 * The conversion to paise is integer arithmetic on the two halves of the string
 * rather than `Math.round(Number(s) * 100)`. The multiply is safe for realistic
 * amounts, but the repo's rule is that no money value passes through a float, and
 * splitting on the decimal point is both exact and shorter to justify.
 *
 * Byte-for-byte the web app's `src/lib/statement/amount.ts`. No imports at all.
 */

/** Which column a value declared itself to be in, when the cell says so. */
export type Marker = "dr" | "cr" | null;

export type ParsedAmount = {
  /** Paise, always ≥ 0. */
  minor: number;
  marker: Marker;
  /** True when the cell was bracketed or signed negative: "(1,234.56)", "-1,234.56". */
  negated: boolean;
};

/** Cells that mean "nothing in this column", which is most cells in a statement. */
const BLANK = /^[\s.–—-]*$/;

export function parseStatementAmount(raw: string): ParsedAmount | null {
  let s = raw.trim().toLowerCase();
  if (BLANK.test(s)) return null;

  let negated = false;
  if (/^\(.*\)$/.test(s)) {
    negated = true;
    s = s.slice(1, -1).trim();
  }

  let marker: Marker = null;
  // Both orders occur: "1,234.56 Cr" on a bank statement, "Cr 1,234.56" on some
  // credit-card ones. The suffix form also appears glued on, with no space.
  const m = s.match(/^(?:(dr|cr)\s*)?(.*?)(?:\s*(dr|cr))?$/);
  if (m) {
    marker = (m[1] ?? m[3] ?? null) as Marker;
    s = m[2].trim();
  }

  s = s.replace(/[₹,\s]/g, "");
  if (s.startsWith("-")) {
    negated = true;
    s = s.slice(1);
  } else if (s.endsWith("-")) {
    // Some mainframe-era statements trail the minus sign.
    negated = true;
    s = s.slice(0, -1);
  }

  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;

  const [whole, frac = ""] = s.split(".");
  const paise = Number(frac.padEnd(2, "0"));
  const rupees = Number(whole);
  if (!Number.isSafeInteger(rupees)) return null;

  return { minor: rupees * 100 + paise, marker, negated };
}

/**
 * True for a cell that holds no amount — used to tell "this row's Withdrawal
 * column is empty, so it is a deposit" from "this row is not a transaction".
 */
export function isBlankCell(raw: string): boolean {
  return BLANK.test(raw.trim());
}

/**
 * True for a token that is plausibly a printed money amount.
 *
 * Stricter than `parseStatementAmount` on purpose, because this one is asked about
 * tokens that might not be amounts at all: a long run of bare digits with no
 * decimal point and no grouping comma is a UPI reference or a masked account
 * number, and reading "412345678901" as ₹4,123,456,789.01 would put a nonsense row
 * in front of you with no hint of where it came from.
 */
export function looksLikeAmount(raw: string): boolean {
  const s = raw.trim();
  if (!/\d/.test(s)) return false;
  if (parseStatementAmount(s) === null) return false;
  return !/^\d{7,}$/.test(s.replace(/[(),+\-₹\s]/g, ""));
}
