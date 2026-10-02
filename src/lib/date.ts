// Dates are 'YYYY-MM-DD' strings end to end — that is what Postgres DATE holds
// and what <input type="date"> speaks. All arithmetic goes through UTC Date
// objects so a container running in IST never shifts a day boundary.

export type ISODate = string; // 'YYYY-MM-DD'
export type MonthKey = string; // 'YYYY-MM'

const DAY_MS = 86_400_000;

function utc(iso: ISODate): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function iso(dt: Date): ISODate {
  return dt.toISOString().slice(0, 10);
}

/** Today in the phone's timezone. */
export function today(): ISODate {
  // The web app used toLocaleDateString("en-CA"), which renders as YYYY-MM-DD.
  // That is the one line of this file that did not survive the port: it leans on
  // locale data, and Hermes' Intl support varies by Android version and build
  // flags. `today()` is the most-called function in the app — a locale that
  // rendered 30/09/2026 would break every comparison silently — so the fields
  // are read off the local Date directly. Same output, no locale involved.
  const n = new Date();
  const p = (v: number) => String(v).padStart(2, "0");
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`;
}

export function monthKeyOf(d: ISODate): MonthKey {
  return d.slice(0, 7);
}

export function thisMonth(): MonthKey {
  return monthKeyOf(today());
}

export function addDays(d: ISODate, n: number): ISODate {
  return iso(new Date(utc(d).getTime() + n * DAY_MS));
}

/** Calendar-correct month shift; clamps the day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(d: ISODate, n: number): ISODate {
  const [y, m, day] = d.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return iso(target);
}

export function addMonthKey(mk: MonthKey, n: number): MonthKey {
  return monthKeyOf(addMonths(mk + "-01", n));
}

/** Whole days from a to b; negative when b is earlier. */
export function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((utc(b).getTime() - utc(a).getTime()) / DAY_MS);
}

/**
 * Inclusive [start, end] of a budgeting month.
 *
 * `startDay` supports a salary-aligned month: with startDay = 5, the month
 * labelled 2026-03 runs 5 Mar to 4 Apr. With the default 1 it is the calendar
 * month, and `end` is computed from day 0 of the next month so leap years and
 * 31-day months need no special casing.
 */
export function monthBounds(mk: MonthKey, startDay = 1): { start: ISODate; end: ISODate } {
  const [y, m] = mk.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const day = Math.min(Math.max(startDay, 1), 28); // 29-31 would skip short months
  const start = `${mk}-${String(day).padStart(2, "0")}`;
  if (day === 1) {
    return { start, end: `${mk}-${String(lastDay).padStart(2, "0")}` };
  }
  return { start, end: addDays(addMonths(start, 1), -1) };
}

/** Every date in [start, end] inclusive. Used for the day bars and burn-down. */
export function dateRange(start: ISODate, end: ISODate): ISODate[] {
  const out: ISODate[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The last n months ending at `mk`, oldest first. */
export function lastMonths(mk: MonthKey, n: number): MonthKey[] {
  return Array.from({ length: n }, (_, i) => addMonthKey(mk, i - (n - 1)));
}

/*
 * Years are *calendar* years here, deliberately, even though a month can be
 * salary-aligned through `settings.month_start_day`.
 *
 * Every per-month aggregate in the app groups on `substr(txn_date, 1, 7)`, so a year
 * assembled out of those months is calendar by construction. Shifting the year
 * boundary by the start day while the month rows stayed calendar would mean the twelve
 * rows no longer added up to the figure printed above them — and a screen that
 * disagrees with its own total is worse than one that is a few days out.
 */

export function thisYear(): number {
  return Number(today().slice(0, 4));
}

export function yearOf(d: ISODate): number {
  return Number(d.slice(0, 4));
}

/** Inclusive [Jan 1, Dec 31] of a calendar year. */
export function yearBounds(year: number): { start: ISODate; end: ISODate } {
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

/** All twelve month keys of a year, oldest first — the spine of the year table. */
export function monthsOfYear(year: number): MonthKey[] {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "14 Mar" or "14 Mar 2025" once the year differs from today's. */
export function fmtDate(d: ISODate, opts: { year?: boolean } = {}): string {
  const [y, m, day] = d.split("-").map(Number);
  const showYear = opts.year ?? String(y) !== today().slice(0, 4);
  return `${day} ${MONTHS[m - 1]}${showYear ? " " + y : ""}`;
}

/** "Mar 2026" — for month pickers and chart axes. */
export function fmtMonth(mk: MonthKey): string {
  const [y, m] = mk.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

export function fmtMonthShort(mk: MonthKey): string {
  return MONTHS[Number(mk.slice(5, 7)) - 1];
}

export function weekday(d: ISODate): string {
  return DAYS[utc(d).getUTCDay()];
}

/** Bar-chart label for a week-length range: "Mon", "Tue". */
export function fmtDayShort(d: ISODate): string {
  return weekday(d);
}

/** Bar-chart label for a month-length range, where 30 weekday names would not fit. */
export function fmtDayNum(d: ISODate): string {
  return String(Number(d.slice(8, 10)));
}

/** Journal day headers: "Today", "Yesterday", then "Fri, 14 Mar". */
export function fmtDayHeading(d: ISODate): string {
  const delta = daysBetween(today(), d);
  if (delta === 0) return "Today";
  if (delta === -1) return "Yesterday";
  if (delta === 1) return "Tomorrow";
  return `${weekday(d)}, ${fmtDate(d)}`;
}

/** Due-date chips: "due in 4 days", "due today", "5 days overdue". */
export function fmtDue(due: ISODate): { label: string; overdue: boolean; soon: boolean } {
  const n = daysBetween(today(), due);
  if (n < 0) return { label: `${-n} day${n === -1 ? "" : "s"} overdue`, overdue: true, soon: true };
  if (n === 0) return { label: "due today", overdue: false, soon: true };
  if (n === 1) return { label: "due tomorrow", overdue: false, soon: true };
  return { label: `due in ${n} days`, overdue: false, soon: n <= 7 };
}

/** Fraction of the month elapsed, for the "expected by now" pace line. */
export function monthProgress(mk: MonthKey, startDay = 1): number {
  const { start, end } = monthBounds(mk, startDay);
  const total = daysBetween(start, end) + 1;
  const done = daysBetween(start, today()) + 1;
  return Math.min(1, Math.max(0, done / total));
}

/** Decimal years between two dates, for XIRR. 365-day basis. */
export function yearsBetween(a: ISODate, b: ISODate): number {
  return daysBetween(a, b) / 365;
}
