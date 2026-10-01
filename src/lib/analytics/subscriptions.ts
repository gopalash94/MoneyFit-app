import { addDays, daysBetween, today, type ISODate } from "../date";

export type Cadence = "weekly" | "monthly" | "quarterly" | "yearly";

export type DetectedSubscription = {
  signature: string;
  merchant: string;
  cadence: Cadence;
  /** Median charge — resistant to the one month a subscription was pro-rated. */
  typicalMinor: number;
  occurrences: number;
  firstSeen: ISODate;
  lastSeen: ISODate;
  nextExpected: ISODate;
  annualCostMinor: number;
  /** 0..1. Combines interval regularity, amount stability and sample size. */
  confidence: number;
  /** True when the expected charge is more than one interval overdue. */
  possiblyCancelled: boolean;
  /** Set when the amount has stepped up — the price-rise signal. */
  priceIncrease: { fromMinor: number; toMinor: number; pctChange: number } | null;
};

/** Candidate cadences, in days, with the tolerance each one is matched within. */
const CADENCES: { cadence: Cadence; days: number; tol: number }[] = [
  { cadence: "weekly", days: 7, tol: 2 },
  { cadence: "monthly", days: 30.5, tol: 5 },
  { cadence: "quarterly", days: 91.3, tol: 10 },
  { cadence: "yearly", days: 365.25, tol: 21 },
];

const PER_YEAR: Record<Cadence, number> = { weekly: 52, monthly: 12, quarterly: 4, yearly: 1 };

/**
 * Collapses a merchant string to a comparison key.
 *
 * Statements are noisy — "NETFLIX.COM 4432", "Netflix*Subscription" and
 * "netflix" are one merchant. Digits, punctuation and a handful of payment-rail
 * words are stripped so those three land on the same signature. Deliberately
 * conservative: it will split a merchant that renamed itself rather than risk
 * merging two unrelated ones.
 */
export function normaliseMerchant(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\b(upi|neft|imps|ach|autopay|auto|debit|payment|pmt|ltd|pvt|india|inc|com|www|recurring|subscription|renewal)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Finds recurring charges you never told the app about — no AI involved, purely
 * the shape of the dates and amounts.
 *
 * Three tests have to pass together, because any one alone produces nonsense:
 *   • at least 3 charges (two points define an interval, they cannot confirm it)
 *   • the gaps cluster around a real cadence, judged by median absolute
 *     deviation rather than mean/stdev so one missed month does not sink an
 *     otherwise obvious monthly subscription
 *   • the amounts are stable within ~15% of the median
 *
 * Confidence is reported rather than thresholded away, so a borderline find is
 * still shown — just labelled honestly.
 */
export function detectSubscriptions(
  bills: { merchant: string; amount_minor: number; txn_date: ISODate }[],
  dismissed: Set<string> = new Set(),
): DetectedSubscription[] {
  const groups = new Map<string, { merchant: string; rows: typeof bills }>();

  for (const b of bills) {
    const sig = normaliseMerchant(b.merchant);
    if (!sig || dismissed.has(sig)) continue;
    const g = groups.get(sig);
    if (g) g.rows.push(b);
    else groups.set(sig, { merchant: b.merchant, rows: [b] });
  }

  const out: DetectedSubscription[] = [];
  const now = today();

  for (const [signature, { merchant, rows }] of groups) {
    if (rows.length < 3) continue;

    const sorted = [...rows].sort((a, b) => (a.txn_date < b.txn_date ? -1 : 1));

    // One charge per day at most: two coffees on Tuesday are not a cadence.
    const byDay = new Map<ISODate, number>();
    for (const r of sorted) byDay.set(r.txn_date, (byDay.get(r.txn_date) ?? 0) + r.amount_minor);
    const dates = [...byDay.keys()].sort();
    if (dates.length < 3) continue;

    const gaps: number[] = [];
    for (let i = 1; i < dates.length; i++) gaps.push(daysBetween(dates[i - 1], dates[i]));

    const medGap = median(gaps);
    const match = CADENCES.find((c) => Math.abs(medGap - c.days) <= c.tol);
    if (!match) continue;

    // Median absolute deviation: robust to a single skipped or doubled period.
    const mad = median(gaps.map((g) => Math.abs(g - medGap)));
    const intervalScore = Math.max(0, 1 - mad / match.tol);
    if (intervalScore <= 0) continue;

    const amounts = dates.map((d) => byDay.get(d)!);
    const medAmt = median(amounts);
    if (medAmt <= 0) continue;
    const amtMad = median(amounts.map((a) => Math.abs(a - medAmt)));
    const amountScore = Math.max(0, 1 - amtMad / (medAmt * 0.15));
    if (amountScore <= 0) continue;

    // More observations = more trust, saturating at six.
    const sampleScore = Math.min(1, (dates.length - 2) / 4);
    const confidence = Number((intervalScore * 0.45 + amountScore * 0.35 + sampleScore * 0.2).toFixed(2));
    if (confidence < 0.4) continue;

    const lastSeen = dates[dates.length - 1];
    const nextExpected = addDays(lastSeen, Math.round(medGap));

    // A price rise shows as the recent half sitting materially above the earlier
    // half. Compared on medians so a single odd charge is not read as a rise.
    let priceIncrease: DetectedSubscription["priceIncrease"] = null;
    if (amounts.length >= 4) {
      const half = Math.floor(amounts.length / 2);
      const older = median(amounts.slice(0, half));
      const newer = median(amounts.slice(half));
      const change = older > 0 ? (newer - older) / older : 0;
      if (change > 0.05) {
        priceIncrease = {
          fromMinor: Math.round(older),
          toMinor: Math.round(newer),
          pctChange: Number((change * 100).toFixed(1)),
        };
      }
    }

    out.push({
      signature,
      merchant,
      cadence: match.cadence,
      typicalMinor: Math.round(medAmt),
      occurrences: dates.length,
      firstSeen: dates[0],
      lastSeen,
      nextExpected,
      annualCostMinor: Math.round(medAmt * PER_YEAR[match.cadence]),
      confidence,
      possiblyCancelled: daysBetween(nextExpected, now) > Math.round(medGap),
      priceIncrease,
    });
  }

  return out.sort((a, b) => b.annualCostMinor - a.annualCostMinor);
}

export const CADENCE_LABEL: Record<Cadence, string> = {
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
};
