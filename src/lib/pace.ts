import { daysBetween, today, addDays, type ISODate } from "./date";

export type PaceStatus = "ahead" | "on_track" | "behind" | "done" | "no_deadline";

export type Pace = {
  status: PaceStatus;
  /** 0..1 of the target actually funded. */
  progress: number;
  /** 0..1 that a straight line from start to target date says you should be at. */
  expected: number;
  savedMinor: number;
  remainingMinor: number;
  /** Rupees a month needed from today to still land on the target date. Null with no deadline. */
  requiredPerMonthMinor: number | null;
  /** Where today's pace actually lands you. Null if nothing saved yet. */
  projectedDate: ISODate | null;
  /** Signed gap against the straight line, in paise. Positive = ahead. */
  gapMinor: number;
  daysLeft: number | null;
};

/**
 * The "how is my goal planning going" answer.
 *
 * Compares what you have saved against a straight line from the goal's start
 * date to its target date. The straight line is the right baseline here: it is
 * the only schedule you can hold yourself to without having declared a
 * contribution plan, and it makes "behind" mean something specific — you are
 * ₹X short of where the calendar says you should be.
 *
 * `on_track` has a deliberate ±3% tolerance band. Without it a goal flickers
 * between ahead and behind every single day, which trains you to ignore the chip.
 */
export function computePace(goal: {
  target_minor: number;
  started_on: ISODate;
  target_date: ISODate | null;
  savedMinor: number;
}): Pace {
  const { target_minor, started_on, target_date, savedMinor } = goal;
  const progress = target_minor > 0 ? savedMinor / target_minor : 0;
  const remainingMinor = Math.max(0, target_minor - savedMinor);
  const now = today();

  if (savedMinor >= target_minor) {
    return {
      status: "done",
      progress: 1,
      expected: 1,
      savedMinor,
      remainingMinor: 0,
      requiredPerMonthMinor: 0,
      projectedDate: null,
      gapMinor: savedMinor - target_minor,
      daysLeft: target_date ? daysBetween(now, target_date) : null,
    };
  }

  // Rate achieved so far, in paise per day. Guard the first day so a goal
  // created today does not project to the year 30,000.
  const elapsed = Math.max(1, daysBetween(started_on, now));
  const perDay = savedMinor / elapsed;
  const projectedDate =
    perDay > 0 ? addDays(now, Math.ceil(remainingMinor / perDay)) : null;

  if (!target_date) {
    return {
      status: "no_deadline",
      progress,
      expected: progress,
      savedMinor,
      remainingMinor,
      requiredPerMonthMinor: null,
      projectedDate,
      gapMinor: 0,
      daysLeft: null,
    };
  }

  const totalDays = Math.max(1, daysBetween(started_on, target_date));
  const expected = Math.min(1, Math.max(0, elapsed / totalDays));
  const gapMinor = savedMinor - expected * target_minor;

  const daysLeft = daysBetween(now, target_date);
  // Past the deadline there is no "per month" left to quote — the whole
  // remainder is due now.
  const requiredPerMonthMinor =
    daysLeft <= 0 ? remainingMinor : Math.ceil(remainingMinor / (daysLeft / 30.44));

  const tolerance = 0.03 * target_minor;
  const status: PaceStatus =
    gapMinor > tolerance ? "ahead" : gapMinor < -tolerance ? "behind" : "on_track";

  return {
    status,
    progress,
    expected,
    savedMinor,
    remainingMinor,
    requiredPerMonthMinor,
    projectedDate,
    gapMinor,
    daysLeft,
  };
}

export const PACE_LABEL: Record<PaceStatus, string> = {
  ahead: "Ahead",
  on_track: "On track",
  behind: "Behind",
  done: "Complete",
  no_deadline: "No deadline",
};

/** Maps to the CSS custom properties in globals.css. */
export const PACE_TONE: Record<PaceStatus, "good" | "warn" | "bad" | "neutral"> = {
  ahead: "good",
  on_track: "good",
  behind: "bad",
  done: "good",
  no_deadline: "neutral",
};
