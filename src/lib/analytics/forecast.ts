import {
  addMonthKey, daysBetween, monthBounds, monthProgress, today,
  type ISODate, type MonthKey,
} from "../date";
import { occurrencesUntil, type Recurrence } from "../recurrence";

/** Straight-line burn rate for the month in progress. */
export type BurnForecast = {
  spentMinor: number;
  budgetMinor: number;
  /** Where the current daily rate lands by month end. */
  projectedMinor: number;
  /** Positive = projected to come in under budget. */
  headroomMinor: number;
  perDayMinor: number;
  /** What you can spend each remaining day and still finish on budget. Null once over. */
  safePerDayMinor: number | null;
  daysElapsed: number;
  daysRemaining: number;
  /** Day the budget runs out at the current rate, if that lands inside the month. */
  exhaustedOn: ISODate | null;
};

export function burnForecast(
  mk: MonthKey,
  spentMinor: number,
  budgetMinor: number,
  startDay = 1,
): BurnForecast {
  const { start, end } = monthBounds(mk, startDay);
  const totalDays = daysBetween(start, end) + 1;
  const elapsed = Math.min(totalDays, Math.max(1, daysBetween(start, today()) + 1));
  const remaining = Math.max(0, totalDays - elapsed);

  const perDay = spentMinor / elapsed;
  const projected = Math.round(perDay * totalDays);
  const left = budgetMinor - spentMinor;

  // Counting forward from today, not from the start of the month.
  let exhaustedOn: ISODate | null = null;
  if (perDay > 0 && left > 0) {
    const daysToBurn = Math.ceil(left / perDay);
    if (daysToBurn <= remaining) exhaustedOn = addDaysIso(today(), daysToBurn);
  }

  return {
    spentMinor,
    budgetMinor,
    projectedMinor: projected,
    headroomMinor: budgetMinor - projected,
    perDayMinor: Math.round(perDay),
    safePerDayMinor: left > 0 && remaining > 0 ? Math.floor(left / remaining) : null,
    daysElapsed: elapsed,
    daysRemaining: remaining,
    exhaustedOn,
  };
}

function addDaysIso(d: ISODate, n: number): ISODate {
  const [y, m, day] = d.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day + n));
  return dt.toISOString().slice(0, 10);
}

/** Projected outgoings for the coming months. */
export type CashflowProjection = {
  month: MonthKey;
  /** Bills already entered as upcoming, with a real due date. */
  committedMinor: number;
  /** Future occurrences implied by recurrence rules. */
  recurringMinor: number;
  /** Historic average of everything that is neither committed nor recurring. */
  discretionaryMinor: number;
  totalMinor: number;
  /** False when there is too little history for the discretionary estimate to mean anything. */
  reliable: boolean;
};

/**
 * Projects the next `months` months of spending from three sources, kept
 * separate on purpose: committed bills are near-certain, recurrence-implied
 * charges are likely, and the discretionary average is a guess. Collapsing them
 * into one number would hide which part of the forecast is soft.
 *
 * Nothing is written to the database — a forecast must not manufacture history.
 */
export function projectCashflow(opts: {
  months: number;
  monthStartDay?: number;
  upcoming: { due_date: ISODate | null; amount_minor: number }[];
  recurring: { txn_date: ISODate; due_date: ISODate | null; amount_minor: number; recurrence: Recurrence }[];
  /** Past months of total spend, used for the discretionary baseline. */
  history: { month: MonthKey; total_minor: number }[];
  /** Recurring + committed already inside those historic totals, to avoid double counting. */
  historicalCommittedMinor?: number;
}): CashflowProjection[] {
  const startDay = opts.monthStartDay ?? 1;
  const from = today().slice(0, 7);
  const months = Array.from({ length: opts.months }, (_, i) => addMonthKey(from, i + 1));
  const horizonEnd = monthBounds(months[months.length - 1], startDay).end;

  // Average monthly spend over whole months of history, ignoring the current
  // partial month, which would drag the mean down every time.
  const complete = opts.history.filter((h) => h.month < from);
  const avg = complete.length ? complete.reduce((s, h) => s + h.total_minor, 0) / complete.length : 0;

  return months.map((mk) => {
    const { start, end } = monthBounds(mk, startDay);

    const committedMinor = opts.upcoming
      .filter((u) => u.due_date && u.due_date >= start && u.due_date <= end)
      .reduce((s, u) => s + u.amount_minor, 0);

    const recurringMinor = opts.recurring.reduce((sum, r) => {
      const anchor = r.due_date ?? r.txn_date;
      const hits = occurrencesUntil(anchor, r.recurrence, horizonEnd).filter(
        (d) => d >= start && d <= end,
      );
      return sum + hits.length * r.amount_minor;
    }, 0);

    // Whatever the average month contains beyond the known commitments.
    const discretionaryMinor = Math.max(0, Math.round(avg - (committedMinor + recurringMinor)));

    return {
      month: mk,
      committedMinor,
      recurringMinor,
      discretionaryMinor,
      totalMinor: committedMinor + recurringMinor + discretionaryMinor,
      reliable: complete.length >= 3,
    };
  });
}

/** Net worth trajectory from an ordinary-least-squares fit on the recent series. */
export type NetWorthProjection = {
  /** Paise per month, from the regression slope. */
  slopeMinor: number;
  points: { month: MonthKey; net_minor: number; projected: boolean }[];
  /** 0..1 fit quality. Below ~0.5 the trend is noise and the UI says so. */
  r2: number;
  reliable: boolean;
};

/**
 * Fits a straight line to the net worth series and extends it.
 *
 * Least squares rather than "last minus first over months": one unusual month
 * at either end would otherwise set the entire trajectory. R² comes back with
 * it so a poor fit can be labelled instead of quietly presented as a forecast.
 */
export function projectNetWorth(
  series: { month: MonthKey; net_minor: number }[],
  aheadMonths = 6,
): NetWorthProjection {
  const pts = series.filter((s) => s.net_minor !== 0);
  if (pts.length < 3) {
    return {
      slopeMinor: 0,
      points: series.map((s) => ({ ...s, projected: false })),
      r2: 0,
      reliable: false,
    };
  }

  const n = pts.length;
  const xs = pts.map((_, i) => i);
  const ys = pts.map((p) => p.net_minor);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;

  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  const slope = sxx ? sxy / sxx : 0;
  const intercept = my - slope * mx;

  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    ssRes += (ys[i] - (slope * xs[i] + intercept)) ** 2;
    ssTot += (ys[i] - my) ** 2;
  }
  const r2 = ssTot ? Math.max(0, 1 - ssRes / ssTot) : 0;

  const lastMonth = pts[n - 1].month;
  const future = Array.from({ length: aheadMonths }, (_, k) => ({
    month: addMonthKey(lastMonth, k + 1),
    net_minor: Math.round(slope * (n - 1 + k + 1) + intercept),
    projected: true,
  }));

  return {
    slopeMinor: Math.round(slope),
    points: [...pts.map((p) => ({ ...p, projected: false })), ...future],
    r2: Number(r2.toFixed(3)),
    reliable: n >= 4 && r2 >= 0.5,
  };
}

/** Where the month's spend is expected to sit relative to the same point last month. */
export function paceVsLastMonth(
  mk: MonthKey,
  spentThis: number,
  spentLastFull: number,
  startDay = 1,
): { deltaPct: number | null; expectedByNowMinor: number } {
  const p = monthProgress(mk, startDay);
  const expectedByNowMinor = Math.round(spentLastFull * p);
  if (!expectedByNowMinor) return { deltaPct: null, expectedByNowMinor };
  return {
    deltaPct: Number((((spentThis - expectedByNowMinor) / expectedByNowMinor) * 100).toFixed(1)),
    expectedByNowMinor,
  };
}

/**
 * Anomaly flags on individual charges, statistical rather than AI: a charge is
 * unusual when it sits far above the median for its own category, measured in
 * median absolute deviations. Median/MAD rather than mean/stdev because a single
 * ₹2,00,000 charge inflates the mean enough to hide itself.
 */
export function flagOutliers(
  rows: { id: number; merchant: string; amount_minor: number; txn_date: ISODate; category: string }[],
  minMultiple = 3,
): { id: number; merchant: string; amount_minor: number; txn_date: ISODate; category: string; medianMinor: number; multiple: number }[] {
  const byCat = new Map<string, number[]>();
  for (const r of rows) {
    const list = byCat.get(r.category) ?? [];
    list.push(r.amount_minor);
    byCat.set(r.category, list);
  }

  const med = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  const out = [];
  for (const r of rows) {
    const list = byCat.get(r.category)!;
    // Under four samples there is no distribution to be an outlier of.
    if (list.length < 4) continue;
    const m = med(list);
    if (m <= 0) continue;
    const multiple = r.amount_minor / m;
    if (multiple >= minMultiple) {
      out.push({ ...r, medianMinor: Math.round(m), multiple: Number(multiple.toFixed(1)) });
    }
  }
  return out.sort((a, b) => b.multiple - a.multiple);
}
