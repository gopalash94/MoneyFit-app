import { yearsBetween, type ISODate } from "./date";

export type Flow = { date: ISODate; amount: number };

/**
 * Money-weighted annualised return (XIRR) — the rate r that makes the present
 * value of a dated cashflow series zero:
 *
 *     Σ  cf_i / (1 + r) ^ ((d_i - d_0) / 365)  =  0
 *
 * A naive `value / cost - 1` is badly wrong for anything SIP-like: ₹10,000
 * invested monthly for a year ending at ₹1,30,000 is not a 8.3% return, because
 * the average rupee was only invested for six months. XIRR is the honest figure,
 * and dated contributions plus a current valuation are exactly its input.
 *
 * Solved by Newton–Raphson, which converges in a handful of iterations on
 * well-behaved series, falling back to bisection when it does not — the NPV
 * curve can be flat or have a derivative near zero for irregular flows, and
 * Newton then shoots off to a nonsensical rate.
 *
 * Returns a decimal (0.124 = 12.4% a year), or null when the series cannot have
 * a return: fewer than two flows, or all flows the same sign.
 */
export function xirr(flows: Flow[]): number | null {
  if (flows.length < 2) return null;

  const sorted = [...flows].sort((a, b) => (a.date < b.date ? -1 : 1));
  const t0 = sorted[0].date;
  const pts = sorted.map((f) => ({ t: yearsBetween(t0, f.date), cf: f.amount }));

  const hasPos = pts.some((p) => p.cf > 0);
  const hasNeg = pts.some((p) => p.cf < 0);
  if (!hasPos || !hasNeg) return null;

  const npv = (r: number): number => {
    // r <= -1 makes (1+r)^t undefined for fractional t; the guards below keep us out.
    let sum = 0;
    for (const p of pts) sum += p.cf / Math.pow(1 + r, p.t);
    return sum;
  };

  const dNpv = (r: number): number => {
    let sum = 0;
    for (const p of pts) sum += (-p.t * p.cf) / Math.pow(1 + r, p.t + 1);
    return sum;
  };

  // --- Newton–Raphson ---
  let r = 0.1;
  for (let i = 0; i < 60; i++) {
    const f = npv(r);
    if (Math.abs(f) < 1e-7) return sane(r);
    const d = dNpv(r);
    if (!Number.isFinite(d) || Math.abs(d) < 1e-12) break; // flat — hand over to bisection
    const next = r - f / d;
    if (!Number.isFinite(next) || next <= -0.999999) break;
    if (Math.abs(next - r) < 1e-9) return sane(next);
    r = next;
  }

  // --- Bisection fallback ---
  // Widen a bracket until the NPV changes sign across it, then halve.
  let lo = -0.9999;
  let hi = 1.0;
  let fLo = npv(lo);
  let fHi = npv(hi);
  let widened = 0;
  while (fLo * fHi > 0 && widened < 60) {
    hi *= 1.6;
    fHi = npv(hi);
    widened++;
    if (hi > 1e6) break;
  }
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fLo * fHi > 0) return null;

  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid);
    if (Math.abs(fMid) < 1e-9 || hi - lo < 1e-10) return sane(mid);
    if (fLo * fMid < 0) {
      hi = mid;
      fHi = fMid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  return sane((lo + hi) / 2);
}

/** Rates beyond ±1000%/yr are an artefact of a degenerate series, not a return. */
function sane(r: number): number | null {
  if (!Number.isFinite(r) || r <= -0.9999 || r > 10) return null;
  return r;
}

/**
 * Builds the flow series for one holding: each contribution is money leaving
 * your pocket (negative), and the latest valuation is the position you could
 * realise today (positive).
 */
export function holdingFlows(
  contributions: { txn_date: ISODate; amount_minor: number }[],
  latest: { as_of: ISODate; value_minor: number } | null,
): Flow[] {
  const flows: Flow[] = contributions.map((c) => ({
    date: c.txn_date,
    amount: -c.amount_minor,
  }));
  if (latest) flows.push({ date: latest.as_of, amount: latest.value_minor });
  return flows;
}

/** Simple (not annualised) total return — shown alongside XIRR, never instead of it. */
export function absoluteReturn(investedMinor: number, valueMinor: number): number | null {
  if (investedMinor <= 0) return null;
  return (valueMinor - investedMinor) / investedMinor;
}

/** "12.4%" / "−3.1%" */
export function fmtPct(r: number | null, dp = 1): string {
  if (r === null || !Number.isFinite(r)) return "—";
  const v = r * 100;
  return `${v >= 0 ? "" : "−"}${Math.abs(v).toFixed(dp)}%`;
}

/**
 * Largest peak-to-trough fall in a valuation series, as a positive fraction.
 * Answers "how bad has this got, at worst" — a number a single current-value
 * figure hides completely.
 */
export function maxDrawdown(
  series: { as_of: ISODate; value_minor: number }[],
): { depth: number; peakOn: ISODate; troughOn: ISODate } | null {
  if (series.length < 2) return null;
  const pts = [...series].sort((a, b) => (a.as_of < b.as_of ? -1 : 1));

  let peak = pts[0].value_minor;
  let peakOn = pts[0].as_of;
  let best: { depth: number; peakOn: ISODate; troughOn: ISODate } | null = null;

  for (const p of pts) {
    if (p.value_minor > peak) {
      peak = p.value_minor;
      peakOn = p.as_of;
    }
    if (peak > 0) {
      const depth = (peak - p.value_minor) / peak;
      if (depth > 0 && (!best || depth > best.depth)) {
        best = { depth, peakOn, troughOn: p.as_of };
      }
    }
  }
  return best;
}
