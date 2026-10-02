/**
 * Pulling a merchant out of a bank narration, deterministically.
 *
 * This is where a non-AI importer earns its keep, because the narration is not
 * free text — it is a structured record with the delimiters left in:
 *
 *   UPI/DR/412345678901/SWIGGY/YESB/swiggy@ybl/Order payment
 *   UPI-ZOMATO LTD-ZOMATO@HDFCBANK-HDFC0000240-41234567-UPI
 *   POS/4532XXXXXXXX1234/BIGBASKET BANGALORE
 *   NEFT-SBIN0001234-ACME SERVICES PVT LTD-REF88213
 *   ACH D- NETFLIX ENTERTAINMENT SVCS-2938471
 *
 * Field four of a UPI narration is the payee name, every time. No inference is
 * required and none is performed: the rail announces itself in the first token,
 * the fields are split on the delimiter, and the field that holds a name is picked
 * by scoring the candidates on how much of each is alphabetic. A model asked to do
 * this would be slower, would cost money, and would occasionally hallucinate a
 * merchant that is not in the string at all.
 *
 * Everything here is reversible by eye: `rail` and the untouched narration both
 * travel to the review table, so a wrong pick is visible next to its evidence.
 *
 * Byte-for-byte the web app's `src/lib/statement/narration.ts`. No imports at all,
 * and nothing in it but string and RegExp work, which Hermes implements the same
 * way — including named character classes, which this file does not use.
 */

/** Rails that prefix a narration and tell you how the rest is laid out. */
const RAILS = [
  "upi", "pos", "neft", "imps", "rtgs", "ach", "nach", "ecs", "atw", "atm",
  "mmt", "chq", "clg", "si", "emi", "ift", "tpt", "vps", "onl", "idm", "cwd",
];

/** Tokens that are structure, never a merchant. */
const NOISE = new RegExp(
  "^(" +
    [
      ...RAILS,
      "dr", "cr", "d", "c", "p2a", "p2m", "paid", "payment", "pmt", "txn", "ref",
      "refno", "rev", "reversal", "charges", "chrg", "gst", "inb", "ib", "mb",
      "transfer", "trf", "by", "to", "from", "via", "and", "the", "for",
      "india", "indian", "bank", "ltd", "limited", "pvt", "private", "llp", "inc",
      "com", "co", "www", "collect", "request", "autopay", "mandate", "nil", "na",
    ].join("|") +
  ")$",
);

/** An IFSC code (`HDFC0000240`) or anything else that is a code rather than a name. */
const CODE = /^[a-z]{2,6}\d{4,}[a-z0-9]*$/i;
/** A masked card or account number: `4532XXXXXXXX1234`, `XXXXXXXX1234`. */
const MASKED = /^[0-9x*]{6,}$/i;
/** A UPI handle. Its local part is a usable last resort. */
const VPA = /^([a-z0-9._-]{2,})@[a-z]{2,}$/i;

export type Narration = {
  merchant: string;
  rail: string | null;
};

/**
 * Scores a candidate field on how much it looks like somebody's name rather than
 * a reference number. Letters count for it, digits against it, and a field that is
 * nothing but digits scores zero however long it is.
 */
function nameScore(field: string): number {
  const letters = (field.match(/[a-z]/gi) ?? []).length;
  const digits = (field.match(/\d/g) ?? []).length;
  if (letters === 0) return 0;
  const words = field.split(/\s+/).filter((w) => w.length > 1).length;
  return letters * 2 - digits * 3 + words;
}

/**
 * Title-cases an all-caps merchant, which is how statements print them.
 *
 * A word is left alone when it is short or has no vowels, so HDFC and SBI survive
 * as themselves. It is not perfect — IRCTC comes out as "Irctc" — and it is not
 * worth being clever about, because the merchant lands in an editable field in the
 * review table and a one-character fix there is cheaper than a heuristic nobody
 * can predict.
 */
function titleCase(s: string): string {
  if (/[a-z]/.test(s)) return s; // Already mixed case — the bank sent it that way.
  return s
    .split(/\s+/)
    .map((w) =>
      w.length >= 4 && /[aeiou]/i.test(w) ? w[0] + w.slice(1).toLowerCase() : w,
    )
    .join(" ");
}

/**
 * A trailing per-transaction reference written as letters-then-digits: the `POS77121`
 * of "POS 4521XXXX8890 RELIANCE SMART POS77121", or `ACH5512`, or `IMP8831`.
 *
 * Worth removing rather than leaving for the eye, because the merchant is also the
 * key the learned categories are looked up by — and a key with this month's reference
 * in it matches nothing next month. Kept deliberately narrow: at least two letters
 * and three digits fused into one word, and only ever the last word.
 */
const TRAILING_REF = /\s+[a-z]{2,6}\d{3,}[a-z0-9]*$/i;

function tidy(s: string): string {
  const out = s
    .replace(/[_|]+/g, " ")
    .replace(/\s+/g, " ")
    // A trailing reference number is the commonest tail: "ACME SERVICES 88213".
    .replace(/\s+\d{5,}$/, "")
    .replace(/^[\s\-/.*#]+|[\s\-/.*#]+$/g, "")
    .trim();

  // Only if something nameable is left. "SBIN0001234" on its own is the whole field
  // and is dealt with by `CODE`; here it would leave nothing behind.
  const shorter = out.replace(TRAILING_REF, "");
  return (shorter.match(/[a-z]/gi) ?? []).length >= 3 ? shorter : out;
}

/**
 * Splits a narration into its fields. Slashes win when present, because a UPI
 * narration is slash-delimited and its payee names routinely contain hyphens;
 * where there are no slashes, hyphens are the delimiter.
 */
function fields(raw: string): string[] {
  if (raw.includes("/")) return raw.split("/").map(tidy).filter((p) => p.length > 0);

  const out: string[] = [];
  for (const piece of raw.split("-")) {
    const prev = out[out.length - 1];
    if (prev !== undefined && insideWord(prev, piece)) out[out.length - 1] = `${prev}-${piece}`;
    else out.push(piece);
  }
  return out.map(tidy).filter((p) => p.length > 0);
}

/**
 * Was the hyphen between these two pieces part of a word rather than a delimiter?
 *
 * "Two-wheeler insurance renewal" is one merchant, not a rail called `Two` followed
 * by one called `wheeler`, and splitting it threw away the first word — which then
 * stopped the row matching the bill of the same name already in the journal. A bank's
 * own delimiters sit beside an uppercase token, a digit or a space, so sparing the
 * lowercase-on-both-sides case costs nothing. The exception is a lowercase rail or
 * suffix ("upi-swiggy@ybl", "acme limited-ref"), which is structure and still splits.
 */
function insideWord(left: string, right: string): boolean {
  if (!/[a-z]$/.test(left) || !/^[a-z]/.test(right)) return false;
  const lastWord = (left.match(/[a-z]+$/) ?? [""])[0];
  return !NOISE.test(lastWord);
}

export function readNarration(raw: string): Narration {
  const narration = raw.replace(/\s+/g, " ").trim();
  if (!narration) return { merchant: "Unknown", rail: null };

  const parts = fields(narration);
  const first = (parts[0] ?? "").toLowerCase().replace(/[^a-z]/g, "");
  const rail = RAILS.includes(first) ? first : null;

  // Candidates are every field that is not structure, a code or a masked number.
  const candidates = parts.filter(
    (p) => !NOISE.test(p.toLowerCase()) && !CODE.test(p) && !MASKED.test(p) && !/^\d+$/.test(p),
  );

  let best = "";
  let bestScore = 0;
  for (const c of candidates) {
    if (VPA.test(c)) continue; // Held back as a fallback, below.
    const score = nameScore(c);
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }

  // Nothing scored: fall back to the local part of a UPI handle, which is usually
  // the merchant's own name ("swiggy@ybl").
  if (!best) {
    for (const c of candidates) {
      const m = c.match(VPA);
      if (m) {
        best = m[1].replace(/[._-]+/g, " ");
        break;
      }
    }
  }

  // Still nothing — a cash withdrawal, a bank charge, a cheque. The narration
  // itself is the most honest label available.
  if (!best) best = narration;

  const merchant = titleCase(tidy(best)).slice(0, 200) || "Unknown";
  return { merchant, rail };
}
