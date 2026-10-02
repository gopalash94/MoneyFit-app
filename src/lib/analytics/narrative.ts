/**
 * The monthly summary.
 *
 * Which of the fourteen true things about this month deserves a person's attention
 * is a ranking problem over a fixed set of facts, and a ranking problem is
 * something code can do. So this generates every observation the facts support,
 * scores each one, and keeps the top few.
 *
 * It is blunt about being code: the sentences are templates, the phrasing repeats
 * month to month, and it cannot notice the thing nobody thought to write a template
 * for. What it does instead is run on a phone with no key, no network and no
 * per-page cost, and never state a figure that was not computed upstream — every
 * rupee amount below is interpolated from the brief or arithmetic over its `*Minor`
 * companions, never parsed back out of a formatted string.
 *
 * ## What this replaces
 *
 * `src/lib/ai/insights.ts` — a 207-line module that sent a brief to a hosted model
 * and waited. It is deleted, and so is the chrome around it on `app/insights.tsx`:
 * the spinner, the error banner, the retry button, the "needs a key" empty state and
 * the cache read that existed to avoid paying for the same month twice. None of
 * those have anything to describe any more. The screen now always has an answer by
 * the time it renders, which is the entire point of the change.
 *
 * **Byte-for-byte the web app's `src/lib/analytics/narrative.ts`**, which is the
 * reason this file is worth having rather than a rewrite: the thresholds, the
 * scores, the tie-breaks and the sentences are a product decision that was made and
 * tested there, and none of it touches a browser, Node, or a database. There is
 * nothing to translate. `writeInsights` is **synchronous** — no promise, no `await`
 * at the call site.
 *
 * The `Insights` shape is identical to the zod-inferred one `ai/insights.ts` used,
 * which is not a coincidence: the prompt there was written to produce this shape. So
 * `app/insights.tsx`'s rendering is unchanged below the point where it stops waiting.
 */

import { fmtWhole } from "../money";

const MAX_OBSERVATIONS = 5;
const MAX_WATCH = 3;

/** What the summary card renders. */
export type Insights = {
  /** One sentence naming the single most important thing about this month. */
  headline: string;
  observations: {
    /** A claim, not a label — "Food is running 40% hot", not "Food spending". */
    title: string;
    detail: string;
    tone: "good" | "warn" | "bad" | "info";
    /** The category this concerns, or null when it is about the month as a whole. */
    category: string | null;
  }[];
  /** Things that are fine now but would not be if they continued. */
  watch_list: string[];
  /** One question worth asking yourself, or null when the month is unremarkable. */
  question: string | null;
};

/**
 * Everything the writer is given, already computed and already formatted.
 *
 * Deliberately strings, not paise, so no consumer is tempted to divide by a
 * hundred. The `*Minor` and `*Pct` fields are the exception: sentence selection
 * needs to compare and rank, which strings cannot do.
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
    spentMinor: number;
    limit: string | null;
    usedPct: number | null;
    lastMonth: string | null;
    lastMonthMinor: number | null;
  }[];
  outliers: {
    merchant: string;
    amount: string;
    date: string;
    category: string;
    typical: string;
    multiple: number;
  }[];
  subscriptions: {
    merchant: string;
    cadence: string;
    typical: string;
    perYear: string;
    perYearMinor: number;
    note: string | null;
  }[];
  upcoming: { count: number; total: string; totalMinor: number } | null;
  goals: { funded: string; target: string; fundedPct: number } | null;
  invest: { funded: string; target: string; fundedPct: number } | null;
  /** Bills in the month, so the writer knows when it is reasoning about nothing. */
  billCount: number;
  monthsOfHistory: number;

  /** Signed paise. Negative is over budget, which is what `headroom` says in words. */
  headroomMinor: number;
  /** Spent as a share of the budget. Null when no budget is set. */
  budgetUsedPct: number | null;
  /** Signed. Positive is up on the same day of last month, matching `vsLastMonth`. */
  vsLastMonthPct: number | null;
};

type Observation = Insights["observations"][number];

/** An observation with the case for including it. Higher wins; the scale is arbitrary and only ordinal. */
type Candidate = { obs: Observation; score: number };

/** Below this the month has not happened enough to say anything confident about it. */
const THIN_BILLS = 5;

export function writeInsights(b: InsightsBrief): Insights {
  const thin = b.billCount < THIN_BILLS || b.monthsOfHistory < 2;
  const cands: Candidate[] = [];
  const add = (score: number, obs: Observation) => cands.push({ obs, score });

  // Categories arrive biggest-first and outliers in flag order; neither is
  // guaranteed by a type, so both are sorted here rather than assumed.
  const cats = [...b.categories].sort((x, y) => y.spentMinor - x.spentMinor);
  const outliers = [...b.outliers].sort((x, y) => y.multiple - x.multiple);
  const catTotal = cats.reduce((s, c) => s + c.spentMinor, 0);
  const overBudget = b.headroomMinor < 0;
  const alreadySpent = b.budgetUsedPct !== null && b.budgetUsedPct >= 100;
  const days = `${b.daysRemaining} day${b.daysRemaining === 1 ? "" : "s"}`;

  // ---------------------------------------------------------------- thin data
  if (thin) {
    add(100, {
      title: "Not much to go on yet",
      detail: `${b.billCount} ${b.billCount === 1 ? "entry" : "entries"} in ${b.monthLabel}, across ${b.monthsOfHistory} ${b.monthsOfHistory === 1 ? "month" : "months"} of history. Anything below is arithmetic over a small number of rows, so treat it as a start rather than a pattern.`,
      tone: "info",
      category: null,
    });
  }

  // ------------------------------------------------------- where the month lands
  if (alreadySpent) {
    add(95, {
      title: "The budget is already spent",
      detail: `${b.spent} of a ${b.budget} budget is gone with ${days} of the month left, and the current rate ends the month at ${b.projected} — ${b.headroom}.`,
      tone: "bad",
      category: null,
    });
  } else if (overBudget) {
    add(92, {
      title: "Heading past the budget",
      detail: `At the rate so far the month finishes at ${b.projected} against a ${b.budget} budget, ${b.headroom}.${b.safePerDay ? ` Staying inside it means ${b.safePerDay} a day for the ${days} left.` : ""}`,
      tone: "warn",
      category: null,
    });
  } else {
    add(52, {
      title: "On course to come in under",
      detail: `${b.spent} of ${b.budget} spent with ${days} to go. The current rate lands the month at ${b.projected}, ${b.headroom}.`,
      tone: "good",
      category: null,
    });
  }

  // ------------------------------------------------------------- the categories
  // Collected separately and capped at two: without a cap a month with four
  // budgets set becomes four observations about budgets and nothing else.
  const catCands: Candidate[] = [];
  for (const c of cats) {
    if (c.limit === null || c.usedPct === null) continue;
    if (c.usedPct > 100) {
      catCands.push({
        score: 86 + Math.min(8, Math.round((c.usedPct - 100) / 10)),
        obs: {
          title: `${c.name} is past its limit`,
          detail: `${c.spent} against a ${c.limit} limit — ${c.usedPct}% of it, with ${days} still to cover.${c.lastMonth ? ` Last month the same category came to ${c.lastMonth}.` : ""}`,
          tone: "bad",
          category: c.name,
        },
      });
      // Exactly at the limit is its own case, not the one above. A fixed cost
      // budgeted at what it costs — rent, a loan payment — lands here every
      // month, and calling that "past its limit" in red would be a lie told
      // twelve times a year. It still earns a line while the month has days
      // left, because nothing more can go into the category.
    } else if (c.usedPct === 100) {
      catCands.push({
        score: 68,
        obs: {
          title: `${c.name} has used all of its limit`,
          detail: `${c.spent} against a ${c.limit} limit, exactly at it, with ${days} still to cover. Anything further in ${c.name} this month goes over.`,
          tone: "warn",
          category: c.name,
        },
      });
      // Ahead of the calendar, not merely high: 80% of a limit on the 28th is
      // fine, and the same figure on the 9th is the thing worth saying.
    } else if (c.usedPct >= 70 && c.usedPct > b.progressPct + 15) {
      catCands.push({
        score: 74,
        obs: {
          title: `${c.name} is running ahead of the month`,
          detail: `${c.usedPct}% of its ${c.limit} limit is used, and only ${b.progressPct}% of ${b.monthLabel} has passed. At this pace it runs out before the month does.`,
          tone: "warn",
          category: c.name,
        },
      });
    }
  }
  catCands.sort((x, y) => y.score - x.score);
  const kept = catCands.slice(0, 2);
  cands.push(...kept);
  const spokenFor = new Set(kept.map((c) => c.obs.category));

  // Concentration, which no single category row shows: a third of a month in one
  // place is the fact that explains the other figures.
  const top = cats[0];
  if (top && cats.length >= 3 && catTotal > 0) {
    const share = Math.round((top.spentMinor / catTotal) * 100);
    if (share >= 30) {
      add(58, {
        title: `${top.name} is ${share}% of the month`,
        detail: `${top.spent} of the ${fmtWhole(catTotal)} spent across ${cats.length} categories went to ${top.name}.`,
        tone: "info",
        category: top.name,
      });
    }
  }

  // A category that moved, where both months are known. Chosen by absolute
  // change rather than percentage: a 300% rise on ₹200 is not news. Categories
  // already spoken for above are skipped — on a five-line card, "Food is past
  // its limit" followed by "Food is up on last month" spends two of the five
  // lines saying one thing, and the next-largest mover is new information.
  const moved = cats
    .filter((c) => !spokenFor.has(c.name))
    .filter((c) => c.lastMonthMinor !== null && c.lastMonthMinor > 0)
    .map((c) => ({ c, delta: c.spentMinor - c.lastMonthMinor! }))
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))[0];
  if (moved && Math.abs(moved.delta) > 0 && moved.c.lastMonthMinor !== null) {
    const up = moved.delta > 0;
    const movedPct = Math.round((Math.abs(moved.delta) / moved.c.lastMonthMinor) * 100);
    if (movedPct >= 25) {
      add(up ? 70 : 46, {
        title: `${moved.c.name} is ${up ? "up" : "down"} on last month`,
        detail: `${moved.c.spent} this month against ${moved.c.lastMonth} last — ${fmtWhole(Math.abs(moved.delta))} ${up ? "more" : "less"}, ${movedPct}% ${up ? "higher" : "lower"}.`,
        tone: up ? "warn" : "good",
        category: moved.c.name,
      });
    }
  }

  // ----------------------------------------------------------------- outliers
  const biggest = outliers[0];
  if (biggest) {
    add(80, {
      title: `${biggest.merchant} is ${biggest.multiple}× the usual`,
      detail: `${biggest.amount} on ${biggest.date}, against a typical ${biggest.typical} in ${biggest.category}. Unusual is not the same as wrong, but it is the largest departure from normal this month.`,
      tone: biggest.multiple >= 6 ? "bad" : "warn",
      category: biggest.category,
    });
  }

  // ------------------------------------------------------- the whole month vs last
  if (b.vsLastMonthPct !== null && b.vsLastMonth && Math.abs(b.vsLastMonthPct) >= 10) {
    const up = b.vsLastMonthPct > 0;
    add(up ? 76 : 50, {
      title: up ? "Running hotter than last month" : "Running cooler than last month",
      detail: `Spending to this point in the month is ${b.vsLastMonth}, the figure reached by the same day last month.`,
      tone: up ? "warn" : "good",
      category: null,
    });
  }

  // --------------------------------------------------------------- still to pay
  if (b.upcoming) {
    const tight = !overBudget && b.upcoming.totalMinor > b.headroomMinor;
    add(tight ? 84 : 44, {
      title: tight ? "What is still due exceeds what is left" : "Still to pay this month",
      detail: tight
        ? `${b.upcoming.count} bill${b.upcoming.count === 1 ? "" : "s"} totalling ${b.upcoming.total} are still due, and the month has only ${b.headroom} of room at the current rate.`
        : `${b.upcoming.count} bill${b.upcoming.count === 1 ? "" : "s"} totalling ${b.upcoming.total} are still due before the month ends.`,
      tone: tight ? "warn" : "info",
      category: null,
    });
  }

  // ------------------------------------------------------------ what repeats
  const bumped = b.subscriptions.filter((s) => s.note !== null);
  if (bumped[0]) {
    add(72, {
      title: `${bumped[0].merchant} costs more than it did`,
      detail: `${bumped[0].typical} ${bumped[0].cadence}, ${bumped[0].note} — about ${bumped[0].perYear} a year at the new price.`,
      tone: "warn",
      category: null,
    });
  }
  if (b.subscriptions.length >= 3) {
    const perYear = b.subscriptions.reduce((s, x) => s + x.perYearMinor, 0);
    add(60, {
      title: "Committed before anything is chosen",
      detail: `${b.subscriptions.length} repeating payments were detected in your own rows, about ${fmtWhole(perYear)} a year — ${fmtWhole(Math.round(perYear / 12))} of every month gone before anything discretionary.`,
      tone: "info",
      category: null,
    });
  }

  // -------------------------------------------------------- goals and investing
  for (const [noun, subject, g] of [
    ["goals", "Saving", b.goals],
    ["investments", "Investing", b.invest],
  ] as const) {
    if (!g) continue;
    const met = g.fundedPct >= 100;
    add(met ? 48 : 64, {
      title: met ? `${subject} hit its target this month` : `${subject} is behind its monthly target`,
      detail: `${g.funded} went into ${noun} this month against a ${g.target} target — ${g.fundedPct}% of it.`,
      tone: met ? "good" : "warn",
      category: null,
    });
  }

  cands.sort((x, y) => y.score - x.score);

  return {
    headline: headline(b, { thin, alreadySpent, overBudget, cats, outliers }),
    // Thin months get fewer observations rather than the same five padded out:
    // a confident five-point summary of three bills is a false summary.
    observations: cands.slice(0, thin ? 3 : MAX_OBSERVATIONS).map((c) => c.obs),
    watch_list: watchList(b, cats),
    question: question(b, { overBudget, cats, outliers }),
  };
}

/* ------------------------------------------------------------------ headline */

type Shape = {
  thin: boolean;
  alreadySpent: boolean;
  overBudget: boolean;
  cats: InsightsBrief["categories"];
  outliers: InsightsBrief["outliers"];
};

/**
 * One sentence, under the 110 characters the card has room for. Strict priority
 * rather than a score: the headline is the one place where "the most important
 * thing" has to be a single answer, and a tie broken by arithmetic reads like a
 * tie. Each branch is checked in the order a person would ask the questions.
 */
function headline(b: InsightsBrief, s: Shape): string {
  if (s.thin) {
    return `Only ${b.billCount} ${b.billCount === 1 ? "entry" : "entries"} in ${b.monthLabel} so far — too little to read much into.`;
  }
  if (s.alreadySpent) {
    return `The ${b.budget} budget for ${b.monthLabel} is gone, with ${b.daysRemaining} day${b.daysRemaining === 1 ? "" : "s"} left to cover.`;
  }
  if (s.overBudget) {
    return `${b.monthLabel} is heading for ${b.projected} against a ${b.budget} budget.`;
  }
  // Strictly past, not merely at: see the `usedPct === 100` case above.
  const past = s.cats.find((c) => c.usedPct !== null && c.usedPct > 100);
  if (past) {
    return `${past.name} has passed its ${past.limit} limit with ${b.daysRemaining} day${b.daysRemaining === 1 ? "" : "s"} of ${b.monthLabel} left.`;
  }
  if (b.vsLastMonthPct !== null && b.vsLastMonthPct >= 15) {
    return `${b.monthLabel} is running ${b.vsLastMonthPct}% hotter than the same point last month.`;
  }
  const o = s.outliers[0];
  if (o && o.multiple >= 6) {
    return `${b.monthLabel} is on budget, but ${o.merchant} at ${o.amount} is well outside its category's usual size.`;
  }
  return `${b.monthLabel} is on course: ${b.spent} spent, ${b.headroom}.`;
}

/* ---------------------------------------------------------------- watch list */

/**
 * Things that are fine now and would not be if they continued — so nothing that
 * has already gone wrong, which belongs in an observation instead. Under 60
 * characters each, because these render as chips.
 */
function watchList(b: InsightsBrief, cats: InsightsBrief["categories"]): string[] {
  const out: string[] = [];

  for (const c of cats) {
    if (c.usedPct !== null && c.usedPct >= 70 && c.usedPct < 100) {
      out.push(`${c.name} at ${c.usedPct}% of its limit`);
    }
  }
  if (b.headroomMinor >= 0 && b.safePerDay && b.daysRemaining > 0) {
    out.push(`${b.safePerDay} a day is the limit from here`);
  }
  for (const s of b.subscriptions) {
    if (s.note !== null) out.push(`${s.merchant} has gone up in price`);
  }
  if (b.outliers.length >= 3) {
    out.push(`${b.outliers.length} charges well above their usual size`);
  }

  // Deduplicated because two categories can produce the same phrase, and the
  // length filter is a floor the card's layout actually needs.
  return [...new Set(out)].filter((w) => w.length <= 60).slice(0, MAX_WATCH);
}

/* ------------------------------------------------------------------ question */

/**
 * One question, or none. Null is the right answer for an unremarkable month —
 * a question asked because the field exists is worse than a blank.
 */
function question(
  b: InsightsBrief,
  s: Pick<Shape, "overBudget" | "cats" | "outliers">,
): string | null {
  if (s.overBudget) {
    const top = s.cats[0];
    return top
      ? `Is there anything in the ${top.spent} of ${top.name} this month that was a one-off?`
      : `Which part of this month would you rather not have spent?`;
  }
  const o = s.outliers[0];
  if (o) return `Was ${o.merchant} at ${o.amount} a one-off, or is it going to repeat?`;
  if (b.goals && b.goals.fundedPct < 100) {
    return `Is the ${b.goals.target} monthly goal target still the right number?`;
  }
  const bumped = b.subscriptions.find((x) => x.note !== null);
  if (bumped) return `${bumped.merchant} costs more than it used to — is it still worth it?`;
  return null;
}
