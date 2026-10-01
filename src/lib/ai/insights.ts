/**
 * AI feature 2 of 4 — spending insights and anomaly detection.
 *
 * The division of labour here is the whole design. Every number is computed in
 * SQLite or in `analytics/`, formatted to a rupee string, and handed over as
 * text. Claude's job is interpretation: which of the fourteen true things about
 * this month is worth a person's attention, and why. It is never asked to add,
 * divide, or project anything.
 *
 * That is not caution for its own sake. "You spent ₹4,000 more on food than last
 * month" is checkable and useful; the same sentence with a number the model
 * derived is a liability, because a wrong figure in a confident sentence is worse
 * than no sentence. Arithmetic is the one part of this we can guarantee, so we
 * guarantee it and ask for the part we cannot.
 *
 * Anomalies arrive here *already flagged* by `flagOutliers` — median/MAD over each
 * category. The model explains and ranks them; it does not decide what is odd.
 *
 * Verbatim from the web app but for the word "Postgres" above: the brief is built
 * from the same queries, formatted by the same `money.ts`, and this file never
 * learns which database produced it.
 */

import { z } from "zod";
import { AI_MODEL, askStructured } from "./client";

/** Five observations is the most a card can hold before it stops being glanceable. */
const MAX_OBSERVATIONS = 5;
const MAX_WATCH = 3;

export const Insights = z.object({
  headline: z
    .string()
    .describe("One sentence, under 110 characters, naming the single most important thing about this month. No greeting, no preamble."),
  observations: z
    .array(
      z.object({
        title: z
          .string()
          .describe("Four to eight words. A claim, not a label — 'Food is running 40% hot', not 'Food spending'."),
        detail: z
          .string()
          .describe("One or two sentences. Quote the relevant figures from the brief exactly as they are written there, and say what they mean."),
        tone: z
          .enum(["good", "warn", "bad", "info"])
          .describe("'good' for something working, 'warn' for a trend worth watching, 'bad' for something already gone wrong, 'info' for neutral context."),
        category: z
          .string()
          .nullable()
          .describe("The category name from the brief this concerns, copied exactly, or null when it is about the month as a whole."),
      }),
    )
    .describe(`Between two and ${MAX_OBSERVATIONS} observations, most important first. Each must be about a different thing — do not restate the headline.`),
  watch_list: z
    .array(z.string())
    .describe(`Up to ${MAX_WATCH} short phrases, under 60 characters each, naming things that are fine now but would not be if they continued. Empty array when there is nothing.`),
  question: z
    .string()
    .nullable()
    .describe("One question worth asking themselves, phrased plainly. Null when the month is unremarkable — a forced question is worse than none."),
});

export type Insights = z.infer<typeof Insights>;

const SYSTEM = `You write the monthly summary for one person's own finance app, in India. They are looking at their own numbers and already know what they bought — so tell them what they cannot see at a glance: the trend, the outlier, the thing that will matter next month.

Rules, in order of importance:

1. Every figure you write must appear verbatim in the brief. Do not add, subtract, average or convert anything. If a number you want does not exist in the brief, describe the relationship in words instead ("noticeably higher than last month") rather than inventing a figure.
2. Be specific or say nothing. "Watch your spending" is worth nothing; "Rent and the home loan are 61% of the month before anything else happens" is worth reading.
3. No moralising. This is somebody's own money, and a bill for something enjoyable is not a lapse. Report what is true, including when the answer is that the month is fine.
4. Do not repeat yourself between the headline, the observations and the watch list.
5. Write plainly, in the second person, no exclamation marks, no emoji, no bullet symbols inside a field.

When the brief is thin — a new app, one or two bills — say so honestly in the headline and give fewer observations. A confident summary of six days of data is a false summary.`;

/**
 * Everything the model is told, already computed and already formatted.
 *
 * Deliberately strings, not paise. A brief in minor units invites the model to
 * divide by a hundred, and the one time it forgets is the one time a card shows
 * ₹4,52,00,000 for a grocery run.
 */
export type InsightsBrief = {
  monthLabel: string;
  /** How far through the month, as a percentage. */
  progressPct: number;
  daysRemaining: number;
  budget: string;
  spent: string;
  projected: string;
  /** Phrased as over/under, because a signed number here reads ambiguously. */
  headroom: string;
  safePerDay: string | null;
  vsLastMonth: string | null;
  income: string | null;
  categories: {
    name: string;
    spent: string;
    limit: string | null;
    usedPct: number | null;
    lastMonth: string | null;
  }[];
  outliers: {
    merchant: string;
    amount: string;
    date: string;
    category: string;
    typical: string;
    multiple: number;
  }[];
  subscriptions: { merchant: string; cadence: string; typical: string; perYear: string; note: string | null }[];
  upcoming: { count: number; total: string } | null;
  goals: { funded: string; target: string } | null;
  invest: { funded: string; target: string } | null;
  /** Bills in the month. The model needs to know when it is reasoning about nothing. */
  billCount: number;
  monthsOfHistory: number;
};

export async function generateInsights(brief: InsightsBrief): Promise<{
  value: Insights;
  model: string;
}> {
  const value = await askStructured({
    schema: Insights,
    system: SYSTEM,
    content: render(brief),
    // Medium is the right trade here. The reasoning is comparison and ranking over
    // a brief that already contains every fact — there is nothing to work out, only
    // something to judge — and this runs on a screen opening, not on a click.
    effort: "medium",
    maxTokens: 3000,
    timeoutMs: 120_000,
  });

  return {
    value: {
      ...value,
      // The counts are asked for in the schema description, not enforced by it:
      // minItems/maxItems are not part of the structured-output schema subset, so
      // the ceiling is applied here where it cannot be ignored.
      observations: value.observations.slice(0, MAX_OBSERVATIONS),
      watch_list: value.watch_list.slice(0, MAX_WATCH),
    },
    model: AI_MODEL,
  };
}

/**
 * The brief as text rather than JSON.
 *
 * Both work, but prose is fewer tokens and the model quotes it back more
 * faithfully — a figure inside a sentence gets copied; a figure inside a nested
 * object gets paraphrased.
 */
function render(b: InsightsBrief): string {
  const L: string[] = [];

  L.push(`## ${b.monthLabel}, ${b.progressPct}% elapsed, ${b.daysRemaining} days left`);
  L.push(
    `Budget ${b.budget}. Spent so far ${b.spent}. At the current rate the month ends at ${b.projected} (${b.headroom}).`,
  );
  if (b.safePerDay) L.push(`Staying on budget means ${b.safePerDay} per remaining day.`);
  if (b.vsLastMonth) L.push(`Against the same point last month: ${b.vsLastMonth}.`);
  if (b.income) L.push(`Money in this month: ${b.income}.`);
  L.push(`${b.billCount} entries this month; ${b.monthsOfHistory} months of history in total.`);

  if (b.categories.length) {
    L.push(`\n## Categories`);
    for (const c of b.categories) {
      const bits = [`${c.name}: ${c.spent}`];
      if (c.limit) bits.push(`limit ${c.limit}${c.usedPct === null ? "" : ` (${c.usedPct}% used)`}`);
      if (c.lastMonth) bits.push(`last month ${c.lastMonth}`);
      L.push(`- ${bits.join(", ")}`);
    }
  }

  if (b.outliers.length) {
    L.push(`\n## Charges well above their category's usual size`);
    L.push(`(Flagged statistically, against the median for that category. Unusual is not the same as wrong.)`);
    for (const o of b.outliers) {
      L.push(
        `- ${o.merchant}, ${o.amount} on ${o.date} in ${o.category} — ${o.multiple}× the usual ${o.typical}`,
      );
    }
  }

  if (b.subscriptions.length) {
    L.push(`\n## Detected recurring payments`);
    for (const s of b.subscriptions) {
      L.push(
        `- ${s.merchant}: ${s.typical} ${s.cadence}, about ${s.perYear} a year${s.note ? ` — ${s.note}` : ""}`,
      );
    }
  }

  if (b.upcoming) L.push(`\n${b.upcoming.count} bills still due this month, totalling ${b.upcoming.total}.`);
  if (b.goals) L.push(`Into goals this month: ${b.goals.funded} of a ${b.goals.target} target.`);
  if (b.invest) L.push(`Invested this month: ${b.invest.funded} of a ${b.invest.target} target.`);

  L.push(
    `\nWrite the summary. Remember: quote figures from above exactly, and say so plainly if there is too little here to draw a conclusion from.`,
  );

  return L.join("\n");
}
