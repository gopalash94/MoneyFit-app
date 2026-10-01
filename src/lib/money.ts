// Money is always an integer number of paise. Nothing here returns a float that
// another function is expected to add up.
//
// The grouping is hand-written rather than Intl.NumberFormat("en-IN") because
// the lakh/crore rule is ten lines and this way the output is identical on the
// server and in the browser regardless of the container's ICU build.

/** 123456789 paise -> "12,34,567.89" (no symbol). */
export function groupIndian(minor: number): string {
  const neg = minor < 0;
  const abs = Math.abs(Math.round(minor));
  const rupees = Math.floor(abs / 100);
  const paise = abs % 100;

  const digits = String(rupees);
  let grouped: string;
  if (digits.length <= 3) {
    grouped = digits;
  } else {
    // Last three digits, then pairs — 1,23,45,678 rather than 12,345,678.
    const head = digits.slice(0, -3);
    const tail = digits.slice(-3);
    grouped = head.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + tail;
  }

  const frac = paise ? "." + String(paise).padStart(2, "0") : "";
  return (neg ? "-" : "") + grouped + frac;
}

/** Full precision with symbol: "₹12,34,567.89". Use in tables and detail views. */
export function fmt(minor: number): string {
  return "₹" + groupIndian(minor);
}

/** Rupees only, no paise: "₹12,34,568". Use where the decimals are noise. */
export function fmtWhole(minor: number): string {
  const rounded = Math.round(minor / 100) * 100;
  return "₹" + groupIndian(rounded);
}

/**
 * Short form for large headline numbers: ₹1.2L, ₹3.45Cr, ₹8,500.
 * Below a lakh it falls back to grouped rupees, because "₹0.9L" reads worse
 * than "₹90,000".
 */
export function fmtCompact(minor: number): string {
  const neg = minor < 0;
  const rupees = Math.abs(minor) / 100;
  const sign = neg ? "-" : "";

  if (rupees >= 1e7) return `${sign}₹${trim(rupees / 1e7)}Cr`;
  if (rupees >= 1e5) return `${sign}₹${trim(rupees / 1e5)}L`;
  return sign + "₹" + groupIndian(Math.round(Math.abs(minor) / 100) * 100);
}

function trim(n: number): string {
  // 1.20 -> "1.2", 3.00 -> "3", 12.34 -> "12.3" (two significant decimals max,
  // one once we're into double digits, so labels stay a predictable width).
  const dp = n >= 10 ? 1 : 2;
  return n.toFixed(dp).replace(/\.?0+$/, "");
}

/** A signed delta, always with an explicit sign: "+₹1,200" / "-₹340". */
export function fmtSigned(minor: number): string {
  return (minor >= 0 ? "+" : "-") + fmtWhole(Math.abs(minor));
}

/**
 * Parses what a human types into paise. Accepts "1234", "1,234.50", "₹1234",
 * "1.2L", "3cr", " 1 234 ". Returns null when there is no number in there.
 */
export function parseAmount(input: string): number | null {
  let s = input.trim().toLowerCase().replace(/[₹,\s]/g, "");
  if (!s) return null;

  let mult = 1;
  if (/(cr|crore)$/.test(s)) {
    mult = 1e7;
    s = s.replace(/(cr|crore)$/, "");
  } else if (/(l|lac|lakh|lakhs)$/.test(s)) {
    mult = 1e5;
    s = s.replace(/(l|lac|lakh|lakhs)$/, "");
  } else if (/k$/.test(s)) {
    mult = 1e3;
    s = s.replace(/k$/, "");
  }

  if (!/^-?\d*\.?\d*$/.test(s) || s === "" || s === "." || s === "-") return null;
  const rupees = Number(s) * mult;
  if (!Number.isFinite(rupees)) return null;
  // Round at the paise boundary so 0.1 + 0.2 style error never enters the DB.
  return Math.round(rupees * 100);
}

/** Paise -> a plain rupee string for prefilling a form input: "1234.50". */
export function toInput(minor: number): string {
  return (minor / 100).toFixed(2).replace(/\.00$/, "");
}

/** Safe percentage, clamped, with a sane answer when the denominator is zero. */
export function pct(part: number, whole: number): number {
  if (!whole) return 0;
  return (part / whole) * 100;
}

export function clamp(n: number, lo = 0, hi = 1): number {
  return Math.min(hi, Math.max(lo, n));
}
