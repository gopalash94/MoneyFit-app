/**
 * AI feature 4 of 4 — goal and budget coaching.
 *
 * Insights looks backwards at one month. This looks forwards at several years,
 * and asks the only question the Goals screen cannot answer on its own: given what
 * this person actually spends, is the plan they have written down fundable, and
 * if not, which part of it gives?
 *
 * The arithmetic is all done before the model sees anything. `computePace` already
 * knows what each goal needs per month; the queries already know what is typically
 * left over after a month of bills. Subtracting one from the other is the whole
 * quantitative question and it happens in `buildCoachBrief`, in code, where it can
 * be read. What is left over is genuinely a judgement — which of four goals to
 * slow down, whether a deadline or a target is the thing to move, whether a
 * category with a lot of room in it is room or is rent — and that is what is
 * asked for.
 *
 * The one thing this must never do is invent an amount. A coaching card that says
 * "put aside ₹18,000 a month" when the real figure is ₹31,000 is worse than a
 * blank card, because it will be believed. So every figure the model may write is
 * in the brief as a formatted string, and the prompt's first rule is to copy them.
 *
 * Verbatim from the web app. The brief is assembled on the Goals screen from the
 * same seven queries, so this file is unaware it moved.
 */

import { z } from "zod";
import { AI_MODEL, askStructured } from "./client";

const MAX_GOALS = 8;
const MAX_LEVERS = 4;

export const Coaching = z.object({
  verdict: z
    .enum(["comfortable", "tight", "overcommitted", "unknown"])
    .describe("'comfortable' when the goals fit inside what is typically left over, 'tight' when they fit only with nothing going wrong, 'overcommitted' when the arithmetic does not close, 'unknown' when there is too little history to say."),
  summary: z
    .string()
    .describe("Two or three sentences. Say whether the plan closes, quote the two figures that decide it, and name the goal that dominates. No preamble, no encouragement."),
  goals: z
    .array(
      z.object({
        name: z
          .string()
          .describe("The goal's name, copied exactly from the brief. Do not rephrase or shorten it."),
        verdict: z
          .enum(["fine", "needs_more", "at_risk", "reconsider"])
          .describe("'fine' = on pace, nothing to do. 'needs_more' = achievable but under-funded right now. 'at_risk' = the required monthly amount is a large share of what is available. 'reconsider' = the deadline or the target is the thing that has to move, not the saving rate."),
        advice: z
          .string()
          .describe("One or two sentences of specific direction for this goal, quoting its figures from the brief. When the verdict is 'reconsider', say concretely what to change — a later date, a smaller target, or pausing it while another goal finishes."),
      }),
    )
    .describe(`One entry for each goal in the brief, in the brief's order, up to ${MAX_GOALS}. Do not invent a goal and do not omit one.`),
  levers: z
    .array(
      z.object({
        title: z.string().describe("Four to eight words naming where the money could come from."),
        detail: z
          .string()
          .describe("One or two sentences. Quote the category's figures from the brief. Say what it would free up per month, using only figures the brief gives you."),
      }),
    )
    .describe(`Up to ${MAX_LEVERS} places the shortfall could realistically come from, largest first. Empty array when there is no shortfall — do not manufacture savings advice for somebody who is already ahead.`),
  tradeoff: z
    .string()
    .nullable()
    .describe("The single honest tradeoff, in one sentence, when the plan cannot close without one. Null when it closes comfortably. Never soften this into a platitude."),
});

export type Coaching = z.infer<typeof Coaching>;

const SYSTEM = `You advise one person on their own savings plan, in India. They have written down goals with amounts and dates, and the app has already worked out what each one needs per month and what is typically left over after their bills. Your job is the judgement, not the arithmetic.

Rules, in order of importance:

1. Every rupee figure you write must appear verbatim in the brief. Never add, subtract, average, or scale anything — the brief already contains every number you are allowed to use, including the shortfall. If the figure you want is not there, describe the relationship in words instead.
2. Address the plan as a whole before any single goal. Four affordable goals can be collectively impossible, and that is the finding worth leading with.
3. When the plan does not close, say which goal gives. Spreading a shortfall evenly across every goal is not advice. Name one, say why it is that one — furthest deadline, largest target, least urgent — and be specific about what changes.
4. A deadline is as movable as a saving rate, and often more so. "Push the car by eight months" is a real option and usually a better one than "save an impossible amount"; treat both as available.
5. No moralising and no motivational language. This is somebody's own money and their goals are theirs. Report what the numbers force, including when the answer is that everything is fine and there is nothing to do.
6. Say when you do not know. With one or two months of history, what is "typically left over" is a guess — set the verdict to unknown and say the plan needs a few more months of data before it can be judged.
7. Plain second person, no exclamation marks, no emoji, no bullet symbols inside a field.`;

/**
 * Everything the model is told. Strings, not paise — for the same reason as the
 * insights brief: a number in minor units is an invitation to divide by a hundred,
 * and the one time it is forgotten a card claims the car costs eight crore.
 */
export type CoachBrief = {
  monthsOfHistory: number;
  /** Median monthly spend over the history window; median, so one bad month does not set the baseline. */
  typicalSpend: string;
  typicalIncome: string | null;
  /** Income minus spend, when income is known. The figure everything else is measured against. */
  typicalSurplus: string | null;
  budget: string;
  goalTargetPerMonth: string | null;
  /** What has actually gone into goals per month lately, as opposed to the target. */
  fundedTypical: string;
  /** Sum of every goal's required monthly contribution. */
  requiredPerMonthTotal: string;
  /** Phrased as a sentence fragment, because a signed number here reads ambiguously. */
  shortfall: string;
  goals: {
    name: string;
    target: string;
    saved: string;
    progressPct: number;
    deadline: string | null;
    monthsLeft: number | null;
    status: string;
    requiredPerMonth: string | null;
    gap: string | null;
    recentPerMonth: string | null;
  }[];
  /** Where the money currently goes, so a lever can be pointed at something real. */
  categories: { name: string; typical: string; limit: string | null; overBy: string | null }[];
};

export async function generateCoaching(brief: CoachBrief): Promise<{
  value: Coaching;
  model: string;
}> {
  const value = await askStructured({
    schema: Coaching,
    system: SYSTEM,
    content: render(brief),
    // High, unlike insights. Insights ranks facts that are all already true;
    // this has to hold several goals, a surplus and a set of deadlines in mind at
    // once and work out which constraint actually binds. That is the reasoning
    // the effort buys, and the screen it renders on is opened deliberately.
    effort: "high",
    maxTokens: 4000,
    timeoutMs: 120_000,
  });

  return {
    value: {
      ...value,
      // Counts are asked for in the descriptions, not enforced by the schema:
      // minItems/maxItems are outside the structured-output subset.
      goals: value.goals.slice(0, MAX_GOALS),
      levers: value.levers.slice(0, MAX_LEVERS),
    },
    model: AI_MODEL,
  };
}

function render(b: CoachBrief): string {
  const L: string[] = [];

  L.push(`## What a month looks like`);
  L.push(`Typical monthly spending: ${b.typicalSpend}. Budget set in the app: ${b.budget}.`);
  if (b.typicalIncome) L.push(`Typical monthly income: ${b.typicalIncome}.`);
  L.push(
    b.typicalSurplus
      ? `Typically left over after spending: ${b.typicalSurplus}. This is the money the goals have to come out of.`
      : `No income has been recorded, so there is no figure for what is left over each month. Say so rather than assuming one.`,
  );
  if (b.goalTargetPerMonth) L.push(`Monthly goal target set in the app: ${b.goalTargetPerMonth}.`);
  L.push(`Actually going into goals per month lately: ${b.fundedTypical}.`);
  L.push(`Based on ${b.monthsOfHistory} months of history.`);

  L.push(`\n## The plan as a whole`);
  L.push(`Every deadline met from today needs ${b.requiredPerMonthTotal} a month across all goals.`);
  L.push(b.shortfall);

  L.push(`\n## Each goal`);
  for (const g of b.goals) {
    const bits = [
      `${g.name}: ${g.saved} of ${g.target} (${g.progressPct}%)`,
      g.deadline
        ? `due ${g.deadline}${g.monthsLeft === null ? "" : `, ${g.monthsLeft} months away`}`
        : `no deadline`,
      g.status,
    ];
    if (g.requiredPerMonth) bits.push(`needs ${g.requiredPerMonth} a month from now`);
    if (g.gap) bits.push(g.gap);
    if (g.recentPerMonth) bits.push(`recently receiving ${g.recentPerMonth} a month`);
    L.push(`- ${bits.join("; ")}`);
  }

  if (b.categories.length) {
    L.push(`\n## Where the money goes each month`);
    L.push(`(Typical monthly figures. A large category is not automatically a lever — rent and a loan are not optional.)`);
    for (const c of b.categories) {
      const bits = [`${c.name}: ${c.typical}`];
      if (c.limit) bits.push(`budgeted ${c.limit}`);
      if (c.overBy) bits.push(`over by ${c.overBy}`);
      L.push(`- ${bits.join(", ")}`);
    }
  }

  L.push(
    `\nGive the assessment. Remember: quote figures from above exactly, lead with whether the plan closes, and name the one goal that gives if it does not.`,
  );

  return L.join("\n");
}
