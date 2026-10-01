import { addDays, addMonths, type ISODate } from "./date";

export type Recurrence = "none" | "weekly" | "monthly" | "quarterly" | "yearly";

export const RECURRENCE_LABEL: Record<Recurrence, string> = {
  none: "One-off",
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Every 3 months",
  yearly: "Yearly",
};

/** The date the next occurrence of a recurring bill falls due. */
export function nextOccurrence(from: ISODate, r: Recurrence): ISODate | null {
  switch (r) {
    case "weekly":
      return addDays(from, 7);
    case "monthly":
      return addMonths(from, 1);
    case "quarterly":
      return addMonths(from, 3);
    case "yearly":
      return addMonths(from, 12);
    default:
      return null;
  }
}

/** Roughly how many times a year this recurs — used by the forecast. */
export function occurrencesPerYear(r: Recurrence): number {
  return { none: 0, weekly: 52, monthly: 12, quarterly: 4, yearly: 1 }[r];
}

/**
 * Every occurrence strictly after `from` and up to `until`. Used to project
 * known commitments forward without writing rows into the database — a
 * forecast should not manufacture history.
 */
export function occurrencesUntil(from: ISODate, r: Recurrence, until: ISODate): ISODate[] {
  if (r === "none") return [];
  const out: ISODate[] = [];
  let cursor = from;
  // Bounded so a bad date can never spin here.
  for (let i = 0; i < 400; i++) {
    const next = nextOccurrence(cursor, r);
    if (!next || next > until) break;
    out.push(next);
    cursor = next;
  }
  return out;
}
