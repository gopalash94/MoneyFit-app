/**
 * "Does this plan close?"
 *
 * The question the Goals screen cannot answer row by row is whether every goal
 * together fits inside what is typically left over each month. The arithmetic is
 * already done: `buildBrief` sums each goal's required contribution and knows the
 * surplus, so the comparison is a subtraction. The judgement on top — which of four
 * goals gives, and whether a deadline or a target is the thing to move — reduces,
 * honestly, to a handful of rules.
 *
 * A goal whose required monthly amount exceeds the whole surplus on its own cannot
 * be fixed by saving harder; the cheapest deadline to move is the one furthest
 * away; a category already inside its budget is not a lever. Those rules are
 * written out below. They never surprise you, but they are right about the
 * arithmetic and they cannot invent an amount: every figure here is either copied
 * from the brief verbatim or computed from its `*Minor` companions.
 *
 * ## What this replaces
 *
 * `src/lib/ai/coach.ts` — a 200-line module that sent this same brief to a hosted
 * model. It is deleted, along with the loading, error and retry states around it on
 * `app/(tabs)/goals.tsx` and the cache read that avoided paying twice for an answer
 * about a month that had not changed.
 *
 * **Byte-for-byte the web app's `src/lib/analytics/coaching.ts`.** Pure arithmetic
 * and string templates over a brief — nothing in it touches a browser, Node, or a
 * database, so there is nothing to translate and no reason to re-derive the
 * thresholds. `writeCoaching` is **synchronous**; the call site loses its `await`.
 *
 * The `Coaching` shape matches the zod-inferred one `ai/coach.ts` declared, because
 * the prompt there was written to produce it. The card's rendering is unchanged.
 */

import type { PaceStatus } from "../pace";
import { fmtWhole } from "../money";

const MAX_LEVERS = 4;

/** What the coaching card renders. */
export type Coaching = {
  /**
   * "comfortable" when the goals fit inside what is typically left over, "tight"
   * when they fit only with nothing going wrong, "overcommitted" when the
   * arithmetic does not close, "unknown" with too little history to say.
   */
  verdict: "comfortable" | "tight" | "overcommitted" | "unknown";
  summary: string;
  goals: {
    /** The goal's name, copied exactly, so the card can join back onto the real row. */
    name: string;
    verdict: "fine" | "needs_more" | "at_risk" | "reconsider";
    advice: string;
  }[];
  /** Where a shortfall could realistically come from, largest first. */
  levers: { title: string; detail: string }[];
  /** The single honest tradeoff, or null when the plan closes comfortably. */
  tradeoff: string | null;
};

/**
 * Everything the writer is given. Strings, not paise, with the `*Minor` fields as
 * the exception — deciding which goal gives means comparing figures rather than
 * quoting them.
 */
export type CoachBrief = {
  monthsOfHistory: number;
  /** Median monthly spend over the history window, so one bad month does not set the baseline. */
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
    statusCode: PaceStatus;
    requiredPerMonthMinor: number | null;
    gapMinor: number | null;
  }[];
  categories: {
    name: string;
    typical: string;
    limit: string | null;
    overBy: string | null;
    typicalMinor: number;
    overByMinor: number | null;
  }[];
  requiredPerMonthTotalMinor: number;
  typicalSurplusMinor: number | null;
  typicalSpendMinor: number;
};

/**
 * Where "tight" starts. A plan that needs more than three quarters of everything
 * left over technically closes and practically does not — one unbudgeted month and
 * a goal slips — so it gets its own verdict rather than being called comfortable.
 */
const TIGHT_SHARE = 0.75;

type GoalBrief = CoachBrief["goals"][number];
type GoalVerdict = Coaching["goals"][number]["verdict"];

export function writeCoaching(b: CoachBrief): Coaching {
  const need = b.requiredPerMonthTotalMinor;
  const surplus = b.typicalSurplusMinor;
  const verdict = overallVerdict(b, need, surplus);

  // Sorted by what each goal demands per month, so "the goal that dominates" is
  // the one actually making the plan hard rather than the one with the largest
  // total — a ₹20,00,000 house in 2039 asks less per month than a ₹3,00,000 car
  // next spring.
  const byDemand = [...b.goals]
    .filter((g) => (g.requiredPerMonthMinor ?? 0) > 0)
    .sort((x, y) => (y.requiredPerMonthMinor ?? 0) - (x.requiredPerMonthMinor ?? 0));
  const dominant = byDemand[0] ?? null;

  const over = b.categories
    .filter((c) => c.overByMinor !== null && c.overByMinor > 0)
    .sort((x, y) => (y.overByMinor ?? 0) - (x.overByMinor ?? 0));

  return {
    verdict,
    summary: summary(b, verdict, need, surplus, dominant),
    goals: b.goals.map((g) => {
      const v = goalVerdict(g, surplus);
      return { name: g.name, verdict: v, advice: advice(g, v, b, surplus) };
    }),
    // Nothing to close means nothing to suggest. Manufacturing savings advice for
    // somebody already ahead is the one thing the old prompt forbade outright, and
    // it would be no less wrong coming from a template.
    levers:
      verdict === "comfortable" || verdict === "unknown"
        ? []
        : over.slice(0, MAX_LEVERS).map((c) => ({
            title: `${c.name} is over its budget`,
            detail: `${c.typical} a month typically, against a ${c.limit} budget — ${c.overBy} a month over. Held to the limit, that is ${c.overBy} a month towards the goals.`,
          })),
    tradeoff: tradeoff(b, verdict, need, surplus, over),
  };
}

/* ------------------------------------------------------------------- verdict */

function overallVerdict(b: CoachBrief, need: number, surplus: number | null): Coaching["verdict"] {
  // Two months of bills cannot establish what a normal month looks like, and no
  // deadline anywhere means there is no required figure to test against at all.
  if (b.monthsOfHistory < 2 || need <= 0 || surplus === null) return "unknown";
  if (surplus <= 0 || need > surplus) return "overcommitted";
  return need > surplus * TIGHT_SHARE ? "tight" : "comfortable";
}

function summary(
  b: CoachBrief,
  verdict: Coaching["verdict"],
  need: number,
  surplus: number | null,
  dominant: GoalBrief | null,
): string {
  const withDeadlines = b.goals.filter((g) => g.deadline !== null).length;

  if (need <= 0) {
    return `No goal has a deadline, so there is no required monthly figure to compare against what is left over. ${b.fundedTypical} a month has been going in lately. Giving even one goal a date is what turns this list into a plan that can be checked.`;
  }
  if (surplus === null) {
    return `Every deadline met from today needs ${b.requiredPerMonthTotal} a month across ${withDeadlines === 1 ? "the one dated goal" : `${withDeadlines} dated goals`}. Nothing in the app records income, so there is no figure for what is typically left over and no way to say whether that fits. Entering a month or two of income answers it.`;
  }
  if (b.monthsOfHistory < 2) {
    return `Every deadline met from today needs ${b.requiredPerMonthTotal} a month. With ${b.monthsOfHistory} month${b.monthsOfHistory === 1 ? "" : "s"} of history, what is "typically left over" is not yet a real figure, so the plan cannot be judged against it.`;
  }
  if (surplus <= 0) {
    // A non-null surplus means income was recorded, so the fallback is unreachable;
    // it is here because the type cannot say that and "null" on a card is unforgivable.
    return `Spending matches or exceeds income in a normal month — ${b.typicalSpend} out against ${b.typicalIncome ?? b.typicalSpend} in — so there is nothing typically left over to fund the ${b.requiredPerMonthTotal} a month these goals require. The plan does not close, and the gap is the whole of it.`;
  }

  const spare = surplus - need;
  const lead = `Every deadline met from today needs ${b.requiredPerMonthTotal} a month across ${withDeadlines === 1 ? "the one dated goal" : `${withDeadlines} dated goals`}, against the ${b.typicalSurplus} typically left over after a month of bills.`;
  const who = dominant
    ? ` ${dominant.name} is the largest single claim on that at ${dominant.requiredPerMonth} a month.`
    : "";

  if (verdict === "overcommitted") {
    return `${lead} That is ${fmtWhole(need - surplus)} a month short, so the plan does not close as written.${who}`;
  }
  if (verdict === "tight") {
    return `${lead} It closes, but with only ${fmtWhole(spare)} a month spare — enough that one unbudgeted month puts a deadline at risk.${who}`;
  }
  return `${lead} That fits, leaving ${fmtWhole(spare)} a month unspoken for. Nothing in the plan forces a change.${who}`;
}

/* --------------------------------------------------------------- each goal */

/**
 * A goal's share of the surplus is what separates "save more" from "move the
 * date". Past the whole surplus, saving harder is not an option that exists, and
 * saying so is more use than encouragement.
 */
function shareOfSurplus(g: GoalBrief, surplus: number | null): number | null {
  if (surplus === null || surplus <= 0) return null;
  if (g.requiredPerMonthMinor === null || g.requiredPerMonthMinor <= 0) return null;
  return g.requiredPerMonthMinor / surplus;
}

function goalVerdict(g: GoalBrief, surplus: number | null): GoalVerdict {
  if (g.statusCode === "done") return "fine";
  if (g.statusCode === "no_deadline") return "fine";

  const share = shareOfSurplus(g, surplus);
  if (share !== null && share > 1) return "reconsider";
  if (g.statusCode === "behind") return share !== null && share > 0.5 ? "at_risk" : "needs_more";
  // On pace, but only because the required amount is most of the month's slack.
  return share !== null && share > 0.7 ? "at_risk" : "fine";
}

function advice(g: GoalBrief, v: GoalVerdict, b: CoachBrief, surplus: number | null): string {
  const pace = g.gap ? `, ${g.gap}` : "";
  const months = g.monthsLeft === null ? null : `${g.monthsLeft} month${g.monthsLeft === 1 ? "" : "s"}`;

  if (g.statusCode === "done") {
    return `Funded — ${g.saved} against a ${g.target} target. Nothing more needs to go into it.`;
  }
  if (g.statusCode === "no_deadline") {
    return `${g.saved} of ${g.target}, ${g.progressPct}% there, with no date set. Without one there is no monthly figure to hold yourself to and nothing here can say whether it is on track.`;
  }

  const share = shareOfSurplus(g, surplus);
  const sharePct = share === null ? null : Math.round(share * 100);

  if (v === "reconsider") {
    return `${g.requiredPerMonth} a month is more than the ${b.typicalSurplus} typically left over, on its own and before any other goal. Saving harder cannot close this one: either ${g.deadline} moves back or the ${g.target} target comes down.`;
  }
  if (v === "at_risk") {
    return `${g.requiredPerMonth} a month is ${sharePct}% of everything typically left over${pace}.${months ? ` ${months} is not long enough to make that up unless something else gives.` : ""}`;
  }
  if (v === "needs_more") {
    return `${g.saved} of ${g.target}${pace}. ${g.requiredPerMonth} a month from now still lands it on ${g.deadline}${g.recentPerMonth ? `, against the ${g.recentPerMonth} a month it has actually been getting` : ""}.`;
  }
  return `On pace — ${g.saved} of ${g.target}${pace}${months && g.deadline ? `, ${months} from ${g.deadline}` : ""}.${g.requiredPerMonth ? ` Holding it there needs ${g.requiredPerMonth} a month.` : ""}`;
}

/* ------------------------------------------------------------------ tradeoff */

/**
 * The one honest sentence, and only when there is one. "Which goal gives" is
 * answered by the furthest deadline rather than the largest target: eight months
 * added to a date three years out costs the least of any available change, which
 * is exactly why it is the first thing to offer.
 */
function tradeoff(
  b: CoachBrief,
  verdict: Coaching["verdict"],
  need: number,
  surplus: number | null,
  over: CoachBrief["categories"],
): string | null {
  if (verdict === "comfortable" || verdict === "unknown") return null;

  const movable = b.goals
    .filter((g) => g.deadline !== null && g.monthsLeft !== null && g.statusCode !== "done")
    .sort((x, y) => (y.monthsLeft ?? 0) - (x.monthsLeft ?? 0))[0];
  const covered =
    over.length > 0
      ? `holding ${over[0].name} to its budget covers ${over[0].overBy} of it`
      : `no category is over its budget, so the dates and the targets are the only parts that give`;

  if (verdict === "tight") {
    return `The plan has almost no slack: ${movable ? `the first month that overruns comes out of ${movable.name}, whose ${movable.deadline} deadline is the furthest out and the cheapest to move` : `the first month that overruns has to come out of a goal`}, and ${covered}.`;
  }

  const short = surplus === null || surplus <= 0 ? b.requiredPerMonthTotal : fmtWhole(need - surplus);
  return `${short} a month has to come from somewhere. ${movable ? `${movable.name} is the obvious place — its ${movable.deadline} deadline is the furthest out, so pushing it back costs less than finding the money` : `Every goal is on a near deadline, so a target has to come down`}, and ${covered}.`;
}
