/**
 * Goals — "how is my planning going", answered for every goal at once.
 * `Finance/src/app/goals/page.tsx`.
 *
 * The web's own header survives the port, because none of it is about the web:
 * the list is sorted by deadline rather than by size or progress, because the
 * question a goals page has to answer first is which one needs attention now.
 * Each row carries a pace chip — the straight line from the goal's start to its
 * deadline, compared against what has actually gone in. That comparison is the
 * whole point; progress alone tells you nothing about whether you will arrive.
 *
 * Three shapes changed, none of the arithmetic.
 *
 * **The archived toggle is a button, not a link.** The web had two hrefs,
 * `/goals?archived=1` and `/goals`. Under `typedRoutes` a query string is not part
 * of an href literal, so the equivalent is `setParams` — and `ActionButton` holds
 * its own pending state rather than an enclosing form's, so it composes here in the
 * `PageHead` with no `<Form>` around it. `filters.tsx` documents the other half:
 * `setParams` merges, so clearing a param is `undefined`, which it maps to `""`.
 *
 * **The four figures wrap two-up**, as on the goal detail screen — `.grid.g-4` was
 * four columns, and the web's own stylesheet already flattened it below 860px.
 *
 * **The card grid is one column.** `.grid.g-2` at 360dp would put a 44px icon tile,
 * a name, a pace chip and a sparkline into half a screen width.
 *
 * **The coaching card has its own load.** Above the list sits the question no
 * individual row can ask — whether all of these fit together inside what is actually
 * left over each month. Every figure in it is computed here and handed over as
 * finished text; only the verdict is the model's.
 *
 * On the web the page awaits it, so the whole page waits on an API call. That is
 * survivable for a server render that streams and fatal here: the four figures, the
 * over-budget banner and every pace chip below are arithmetic over rows this device
 * already has, and holding them behind twenty seconds of network would make this a
 * worse screen than the web's. So `Coach` has its own `useLive`, exactly as
 * `insights.tsx`'s `Narrative` does, and for the same two reasons stated there:
 * `useLive` captures `load` through a ref, so the freshly-built brief is the one that
 * gets sent even though `deps` cannot mention it, and `cached()` fingerprints that
 * brief, so a `refreshAll()` from anywhere costs an API call only when the figures it
 * would summarise have actually moved.
 *
 * **Both of the web's failure sentences survive**, which is why `loadCoaching`
 * returns a tagged result rather than throwing: a brief that could not be built is
 * one query out of seven and says so quietly, whereas a call that failed with nothing
 * cached behind it is the one `useLive` surfaces as an error — and `useLive` has only
 * the one error channel to surface it through.
 */

import { useLocalSearchParams, useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import type { TextStyle, ViewStyle } from "react-native";

import { Sparkline } from "@/components/charts";
import type { IconName } from "@/components/Icon";
import { useSetParams } from "@/components/filters";
import { ActionButton } from "@/components/form";
import { Screen } from "@/components/Screen";
import {
  AiNotConfigured, Banner, Card, Chip, EmptyState, IconTile, LinkButton, Loading,
  PageHead, ProgressBar, StatTile, type Tone,
} from "@/components/ui";
import { cached, type CacheHit } from "@/lib/ai/cache";
import { aiConfigured } from "@/lib/ai/client";
import { generateCoaching, type CoachBrief, type Coaching } from "@/lib/ai/coach";
import { addMonthKey, fmtDate, thisMonth } from "@/lib/date";
import { goalIcon } from "@/lib/goal-icon";
import { useLive } from "@/lib/live";
import { fmt, fmtCompact, fmtWhole, pct } from "@/lib/money";
import { computePace, PACE_LABEL, PACE_TONE, type Pace } from "@/lib/pace";
import {
  goalCumulative, goalFundedInMonth, goalFundingByMonth, goalFundingRecent, listGoals,
} from "@/lib/queries/goals";
import { getSettings } from "@/lib/queries/settings";
import {
  budgetStatus, cashflowByMonth, categoryTotalsSince, dataSpan, overallBudget,
} from "@/lib/queries/stats";
import type { GoalRow, Settings } from "@/lib/types";
import { useStyles, useTheme, type Theme } from "@/theme/ThemeProvider";
import { font, radius, space, tnum, weight } from "@/theme/tokens";

type Loaded = {
  goals: GoalRow[];
  settings: Settings;
  fundedThisMonth: number;
  /** Cumulative-saved points per live goal id, for the row sparklines. */
  sparks: Map<number, number[]>;
};

async function load(showArchived: boolean): Promise<Loaded> {
  const [goals, settings, fundedThisMonth] = await Promise.all([
    listGoals(showArchived),
    getSettings(),
    // The web hardcodes a start day of 1 here rather than waiting on `settings`,
    // which is being read in this same batch. Goal funding is dated by the
    // contribution, not by a statement cycle, so the month boundary is the month.
    goalFundedInMonth(thisMonth(), 1),
  ]);

  // One query per goal, in parallel. At the scale this app is for — a handful of
  // goals — that is cheaper and far clearer than a single window-function query
  // unpacked in JS afterwards.
  const live = goals.filter((g) => !g.archived);
  const series = await Promise.all(live.map((g) => goalCumulative(g.id)));
  const sparks = new Map<number, number[]>(
    live.map((g, i) => [g.id, series[i].map((r) => r.cumulative_minor)]),
  );

  return { goals, settings, fundedThisMonth, sparks };
}

/** A param can legitimately arrive twice; the first spelling of it wins. */
function str(v: string | string[] | undefined): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return "";
}

export default function GoalsScreen() {
  const params = useLocalSearchParams();
  const showArchived = str(params.archived) === "1";
  // One primitive, always one — `useLive` re-runs its effect on this list and
  // React requires a stable length.
  const live = useLive(() => load(showArchived), [showArchived ? 1 : 0]);

  return (
    <Screen live={live}>
      {(data) => <Goals data={data} showArchived={showArchived} />}
    </Screen>
  );
}

function Goals({ data, showArchived }: { data: Loaded; showArchived: boolean }) {
  const s = useStyles(styles);
  const setParams = useSetParams();

  const { goals, settings, fundedThisMonth, sparks } = data;

  const live = goals.filter((g) => !g.archived);
  const done = live.filter((g) => g.saved_minor >= g.target_minor);
  const behind = live.filter((g) => paceOf(g).status === "behind");
  const totalTarget = live.reduce((sum, g) => sum + g.target_minor, 0);
  const totalSaved = live.reduce((sum, g) => sum + g.saved_minor, 0);
  const monthlyNeed = live.reduce((sum, g) => sum + (paceOf(g).requiredPerMonthMinor ?? 0), 0);
  const target = settings.monthly_goal_target_minor;

  return (
    <>
      <PageHead
        title="Goals"
        sub={
          live.length === 0
            ? "Nothing being saved for yet"
            : `${live.length} active · ${fmtWhole(totalSaved)} of ${fmtWhole(totalTarget)} funded`
        }
      >
        <ActionButton
          action={async () => setParams({ archived: showArchived ? undefined : "1" })}
          icon={showArchived ? "eye" : "filter"}
          variant="ghost"
        >
          {showArchived ? "Active only" : "Show archived"}
        </ActionButton>
        <LinkButton href="/goal/new" label="New goal" icon="plus" variant="solid" small />
      </PageHead>

      {goals.length === 0 ? (
        <EmptyState
          icon="target"
          title="No goals yet"
          body="A goal is a target amount and, ideally, a date. Once both exist this page can tell you whether you're on pace rather than just how much is in the pot."
          cta={{ href: "/goal/new", label: "Add your first goal" }}
        />
      ) : (
        <View style={s.stack}>
          <View style={s.factGrid}>
            <View style={s.fact}>
              <StatTile
                label="Funded this month"
                value={fmtWhole(fundedThisMonth)}
                tone="green"
                size="sm"
                sub={
                  target > 0
                    ? `${pct(fundedThisMonth, target)}% of the ${fmtCompact(target)} monthly target`
                    : "No monthly target set"
                }
              />
            </View>
            <View style={s.fact}>
              <StatTile
                label="Saved across all goals"
                value={fmtWhole(totalSaved)}
                size="sm"
                sub={`${pct(totalSaved, totalTarget)}% of ${fmtCompact(totalTarget)}`}
              />
            </View>
            <View style={s.fact}>
              <StatTile
                label="Needed per month"
                value={monthlyNeed > 0 ? fmtWhole(monthlyNeed) : "—"}
                tone={target > 0 && monthlyNeed > target ? "neg" : undefined}
                size="sm"
                sub={monthlyNeed > 0 ? "To hit every deadline from today" : "No deadlines set"}
              />
            </View>
            <View style={s.fact}>
              <StatTile
                label="Complete"
                value={`${done.length} of ${live.length}`}
                tone={done.length > 0 ? "pos" : undefined}
                size="sm"
                sub={behind.length > 0 ? `${behind.length} behind pace` : "None behind pace"}
              />
            </View>
          </View>

          {target > 0 && monthlyNeed > target ? (
            <Banner tone="warn" icon="alert">
              {"Hitting every deadline needs "}
              <Text style={s.strong}>{`${fmt(monthlyNeed)} a month`}</Text>
              {`, but the monthly goal target in Settings is ${fmt(target)}. Either the targets are optimistic or a deadline needs moving — the pace chips below show which goal is doing the damage.`}
            </Banner>
          ) : null}

          {/* The web's gate, unchanged: nothing runs for somebody with no goals, and
              nothing runs without a key, because the brief costs seven queries and
              would be built only to be thrown away. `aiConfigured()` is checked here
              rather than inside `Coach` so the hook below it never runs at all. */}
          {live.length > 0 ? (
            aiConfigured() ? (
              <Coach live={live} settings={settings} monthlyNeed={monthlyNeed} />
            ) : (
              <AiNotConfigured feature="Plan coaching" />
            )
          ) : null}

          {goals.map((g) => (
            <GoalCard key={g.id} goal={g} spark={sparks.get(g.id) ?? []} />
          ))}
        </View>
      )}
    </>
  );
}

// ------------------------------------------------------------------ the pieces

function paceOf(g: GoalRow): Pace {
  return computePace({
    target_minor: g.target_minor,
    started_on: g.started_on,
    target_date: g.target_date,
    savedMinor: g.saved_minor,
  });
}

function GoalCard({ goal: g, spark }: { goal: GoalRow; spark: number[] }) {
  const s = useStyles(styles);
  const t = useTheme();
  const router = useRouter();

  const p = paceOf(g);
  const tone: Tone = g.archived ? "neutral" : PACE_TONE[p.status];
  // Over-funding is not an error worth colouring red; the bar clamps and the
  // chip already says "Complete".
  const barColor = p.status === "behind" ? t.c.red : g.color;

  return (
    // `.muted-card { opacity: 0.62 }` — the whole card dims, there being no hover
    // on a phone to bring it back.
    <Card style={g.archived ? s.mutedCard : undefined}>
      {/* `router.push` rather than a `<Link>`: the whole header is the tap target.
          The web wrapped the icon, the name and the chip in one anchor and left the
          progress block outside it, which is what this reproduces. */}
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`${g.name} — ${g.archived ? "archived" : PACE_LABEL[p.status]}`}
        onPress={() => router.push({ pathname: "/goal/[id]", params: { id: String(g.id) } })}
        style={({ pressed }) => [s.head, pressed ? s.headPressed : null]}
      >
        <IconTile color={g.color} icon={goalIcon(g.icon)} size={44} />
        <View style={s.headMain}>
          <Text style={s.name} numberOfLines={1}>
            {g.name}
          </Text>
          <View style={s.meta}>
            <Text style={s.metaText}>
              {g.target_date ? `by ${fmtDate(g.target_date, { year: true })}` : "no deadline"}
            </Text>
            {g.contribution_count > 0 ? (
              <Text style={s.metaText}>{`· ${g.contribution_count} contributions`}</Text>
            ) : null}
          </View>
        </View>
        <Chip tone={tone} icon={g.archived ? undefined : chipIcon(p.status)}>
          {g.archived ? "Archived" : PACE_LABEL[p.status]}
        </Chip>
      </Pressable>

      <View style={s.progressWrap}>
        <View style={s.savedRow}>
          <Text style={s.saved}>
            {fmtWhole(g.saved_minor)}
            <Text style={s.savedOf}>{` of ${fmtWhole(g.target_minor)}`}</Text>
          </Text>
          <Text style={[s.pctText, { color: barColor }]}>
            {`${Math.round(p.progress * 100)}%`}
          </Text>
        </View>
        <ProgressBar value={p.progress} color={barColor} height={8} />

        {/* The straight line the chip is measured against, made visible. Without
            it "behind" is an accusation with no evidence attached. */}
        {p.status !== "no_deadline" && p.status !== "done" ? (
          <View style={s.paceRow}>
            <Text style={s.dim}>{`Pace says ${Math.round(p.expected * 100)}% by now`}</Text>
            <Text style={[s.dimNum, { color: p.gapMinor < 0 ? t.c.red : t.c.green }]}>
              {p.gapMinor < 0
                ? `${fmtWhole(-p.gapMinor)} short`
                : `${fmtWhole(p.gapMinor)} ahead`}
            </Text>
          </View>
        ) : null}
      </View>

      <View style={s.footRow}>
        <View style={s.footMain}>
          <Text style={s.kvK}>{rateLabel(p)}</Text>
          <Text style={s.kvV}>{rateValue(p)}</Text>
        </View>
        {spark.length >= 2 ? (
          <Sparkline points={spark} color={g.color} width={96} height={30} />
        ) : null}
      </View>
    </Card>
  );
}

function chipIcon(status: Pace["status"]): IconName | undefined {
  return status === "ahead"
    ? "arrowUp"
    : status === "behind"
      ? "arrowDown"
      : status === "done"
        ? "check"
        : undefined;
}

/**
 * The card's footer figure, which answers a different question in each of four
 * states. The web wrote both halves as one nested ternary inside the JSX; they are
 * two functions here only because the RN version has no `<div>` to hang them on.
 */
function rateLabel(p: Pace): string {
  if (p.status === "done") return "Funded";
  if (p.requiredPerMonthMinor === null) return "At the current rate";
  return p.daysLeft !== null && p.daysLeft <= 0 ? "Overdue by" : "Per month from here";
}

function rateValue(p: Pace): string {
  if (p.status === "done") return "Nothing left to save";
  if (p.requiredPerMonthMinor !== null) {
    if (p.daysLeft !== null && p.daysLeft <= 0) return fmtWhole(p.remainingMinor);
    return `${fmtWhole(p.requiredPerMonthMinor)}/mo`;
  }
  return p.projectedDate ? `done ${fmtDate(p.projectedDate, { year: true })}` : "nothing saved yet";
}

// --------------------------------------------------------------- the coaching card

/**
 * What one load produced.
 *
 * The web renders four outcomes and reaches three of them by returning early from a
 * server component. `useLive` has exactly one error channel, so three of the four are
 * values here and only the fourth — `cached()` failing with nothing in the table to
 * fall back on, which is also the only one the web lets reach its own catch — travels
 * as a rejection. That is what keeps the two failure sentences distinct.
 */
type CoachState =
  | { kind: "brief_failed"; message: string }
  | { kind: "thin" }
  | { kind: "ready"; hit: CacheHit<Coaching> & { staleReason?: string } };

async function loadCoaching(
  live: GoalRow[],
  settings: Settings,
  monthlyNeed: number,
): Promise<CoachState> {
  let brief: CoachBrief;
  try {
    brief = await buildBrief(live, settings, monthlyNeed);
  } catch (e) {
    // The screen's own handler has already survived `listGoals`, so a failure here is
    // one query out of seven. Say so quietly rather than replacing the screen.
    return { kind: "brief_failed", message: e instanceof Error ? e.message : String(e) };
  }

  // Two months of bills cannot establish what is typically left over, and a confident
  // verdict built on them is a guess wearing a number.
  if (brief.monthsOfHistory < 2) return { kind: "thin" };

  return {
    kind: "ready",
    hit: await cached<Coaching>("coach", "plan", brief, () => generateCoaching(brief)),
  };
}

/**
 * The coaching card. The caller has already established that there are goals and that
 * a key is configured.
 */
function Coach({ live, settings, monthlyNeed }: {
  live: GoalRow[];
  settings: Settings;
  monthlyNeed: number;
}) {
  const t = useTheme();
  const s = useStyles(styles);
  const router = useRouter();

  // Two primitives, always two. They are belt and braces rather than the real
  // trigger: every write in the app ends in `refreshAll()`, which `useLive` watches on
  // its own, and `cached()` decides from the brief's fingerprint whether that re-read
  // costs an API call. The archived toggle deliberately does not appear — `live` is
  // already the unarchived goals, so archiving one changes `live.length` anyway.
  const ai = useLive(() => loadCoaching(live, settings, monthlyNeed), [live.length, monthlyNeed]);

  const failed = ai.error;
  if (failed) {
    return (
      <Banner tone="warn" icon="alert">
        {`The coaching summary is unavailable: ${failed.message} Everything else on this screen is computed on this device and is unaffected.`}
      </Banner>
    );
  }

  const state = ai.data;
  if (!state) {
    return (
      <Card
        title="Checking whether the plan closes"
        note="Claude is being sent figures computed on this device"
      >
        <Loading label="Working through the plan…" />
      </Card>
    );
  }

  if (state.kind === "brief_failed") {
    return (
      <Banner tone="warn" icon="alert">
        {`The coaching summary could not be prepared: ${state.message}`}
      </Banner>
    );
  }

  if (state.kind === "thin") {
    return (
      <Card title="Not enough history to judge the plan yet">
        <Text style={s.coachProse}>
          Whether these goals are fundable depends on what is typically left over each month,
          and that needs a few months of bills behind it. The pace chips below already work —
          they only need each goal’s own dates.
        </Text>
      </Card>
    );
  }

  const hit = state.hit;
  const c = hit.value;
  const byName = new Map(c.goals.map((g) => [g.name, g]));

  return (
    <Card
      title="Does this plan close?"
      action={
        <Chip tone={VERDICT_TONE[c.verdict]} icon={c.verdict === "comfortable" ? "check" : "alert"}>
          {VERDICT_LABEL[c.verdict]}
        </Chip>
      }
    >
      <Text style={s.coachSummary}>{c.summary}</Text>

      {/* Joined back onto the real goals rather than rendered from the model's list: a
          name it altered simply has no verdict, instead of appearing on screen as a
          goal that does not exist. */}
      <View style={s.verdictList}>
        {live.map((g) => {
          const v = byName.get(g.name);
          if (!v) return null;
          return (
            <View key={g.id} style={s.verdictRow}>
              <IconTile
                color={t.c[GOAL_VERDICT_COLOR[v.verdict]]}
                icon={GOAL_VERDICT_ICON[v.verdict]}
                size={34}
              />
              <View style={s.verdictMain}>
                <View style={s.verdictHead}>
                  <Pressable
                    accessibilityRole="link"
                    accessibilityLabel={`${g.name} — ${GOAL_VERDICT_LABEL[v.verdict]}`}
                    onPress={() =>
                      router.push({ pathname: "/goal/[id]", params: { id: String(g.id) } })
                    }
                    style={({ pressed }) => (pressed ? s.namePressed : null)}
                  >
                    <Text style={s.verdictName}>{g.name}</Text>
                  </Pressable>
                  <Chip tone={GOAL_VERDICT_TONE[v.verdict]}>{GOAL_VERDICT_LABEL[v.verdict]}</Chip>
                </View>
                <Text style={s.verdictAdvice}>{v.advice}</Text>
              </View>
            </View>
          );
        })}
      </View>

      {c.levers.length > 0 ? (
        <View style={s.leversWrap}>
          <Text style={s.leversLabel}>Where the difference could come from</Text>
          <View style={s.leverList}>
            {c.levers.map((l, i) => (
              // Index keys: one positional list from one response, and nothing
              // reorders or removes an entry while it is on screen.
              <View key={i} style={s.lever}>
                <Text style={s.leverTitle}>{l.title}</Text>
                <Text style={s.leverDetail}>{l.detail}</Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      {c.tradeoff ? (
        <View style={s.tradeoffWrap}>
          <Banner tone="warn" icon="alert">
            <Text style={s.strong}>The tradeoff.</Text>
            {` ${c.tradeoff}`}
          </Banner>
        </View>
      ) : null}

      <Text style={s.cardNote}>
        {hit.staleReason
          ? `Showing the previous assessment — a new one could not be generated (${hit.staleReason})`
          : `Written by ${hit.model ?? "Claude"} from figures computed on this device · ${stamp(hit.at)}`}
      </Text>
    </Card>
  );
}

/**
 * Everything the model is allowed to say, computed here.
 *
 * Medians rather than means, and the current month is excluded: it is half-finished,
 * and including it makes "typically left over" wrong by however much of the month has
 * not happened yet. Six closed months is the window — long enough for an annual
 * premium to show up as the outlier a median ignores, short enough to follow a change
 * in salary.
 */
async function buildBrief(
  live: GoalRow[],
  settings: Settings,
  monthlyNeed: number,
): Promise<CoachBrief> {
  const month = thisMonth();
  const from = `${addMonthKey(month, -6)}-01`;

  const [flow, span, catTotals, budgets, goalFlow, recent, budget] = await Promise.all([
    cashflowByMonth(from),
    dataSpan(),
    categoryTotalsSince(from),
    budgetStatus(month, settings.month_start_day),
    goalFundingByMonth(from),
    goalFundingRecent(from),
    overallBudget(month, settings.monthly_budget_minor),
  ]);

  const closed = flow.filter((f) => f.month < month);
  const typicalSpend = median(closed.map((f) => f.expense_minor));
  // Only months that recorded income: a month with none is somebody who did not enter
  // their salary, not somebody who earned nothing, and averaging the zero in halves
  // the surplus.
  const earning = closed.filter((f) => f.income_minor > 0);
  const typicalIncome = earning.length > 0 ? median(earning.map((f) => f.income_minor)) : null;
  const typicalSurplus = typicalIncome === null ? null : typicalIncome - typicalSpend;
  const fundedTypical = median(goalFlow.filter((m) => m.month < month).map((m) => m.total_minor));

  const recentByGoal = new Map(recent.map((r) => [r.goal_id, r]));
  const limitByName = new Map(budgets.map((b) => [b.name, b.limit_minor]));

  return {
    monthsOfHistory: span.months,
    typicalSpend: fmtWhole(typicalSpend),
    typicalIncome: typicalIncome === null ? null : fmtWhole(typicalIncome),
    typicalSurplus: typicalSurplus === null ? null : fmtWhole(typicalSurplus),
    budget: fmtWhole(budget),
    goalTargetPerMonth:
      settings.monthly_goal_target_minor > 0
        ? fmtWhole(settings.monthly_goal_target_minor)
        : null,
    fundedTypical: fmtWhole(fundedTypical),
    requiredPerMonthTotal: fmtWhole(monthlyNeed),
    shortfall: phraseShortfall(monthlyNeed, typicalSurplus),
    goals: live.slice(0, 8).map((g) => {
      const p = paceOf(g);
      const r = recentByGoal.get(g.id);
      return {
        name: g.name,
        target: fmtWhole(g.target_minor),
        saved: fmtWhole(g.saved_minor),
        progressPct: Math.round(p.progress * 100),
        deadline: g.target_date ? fmtDate(g.target_date, { year: true }) : null,
        // 30.44 rather than 30: over a three-year goal the difference is a month.
        monthsLeft: p.daysLeft === null ? null : Math.max(0, Math.round(p.daysLeft / 30.44)),
        status: PACE_LABEL[p.status],
        requiredPerMonth:
          p.requiredPerMonthMinor === null ? null : fmtWhole(p.requiredPerMonthMinor),
        gap:
          p.status === "no_deadline" || p.status === "done"
            ? null
            : p.gapMinor < 0
              ? `${fmtWhole(-p.gapMinor)} behind the straight line`
              : `${fmtWhole(p.gapMinor)} ahead of the straight line`,
        recentPerMonth:
          r && r.months > 0 ? fmtWhole(Math.round(r.total_minor / r.months)) : null,
      };
    }),
    // Divided by the months the category itself appears in, not by the window: school
    // fees started two months ago should not read as a third of itself.
    categories: catTotals
      .filter((c) => c.months > 0)
      .slice(0, 10)
      .map((c) => {
        const typical = Math.round(c.total_minor / c.months);
        const limit = limitByName.get(c.name) ?? null;
        return {
          name: c.name,
          typical: fmtWhole(typical),
          limit: limit === null ? null : fmtWhole(limit),
          overBy: limit !== null && typical > limit ? fmtWhole(typical - limit) : null,
        };
      }),
  };
}

/**
 * The one subtraction the whole card turns on, done here and handed over as a
 * finished sentence so the model has no reason to attempt it.
 */
function phraseShortfall(monthlyNeed: number, typicalSurplus: number | null): string {
  if (monthlyNeed <= 0) {
    return "No goal has a deadline, so there is no required monthly figure to compare against. Say that rather than inventing a schedule.";
  }
  if (typicalSurplus === null) {
    return "No income has been recorded, so there is no figure for what is left over and no shortfall can be computed. Do not guess one — say that income entries are needed before the plan can be judged.";
  }
  if (typicalSurplus <= 0) {
    return `Nothing is typically left over at all — spending matches or exceeds income in a normal month, so the whole ${fmtWhole(monthlyNeed)} a month would have to come from somewhere that does not currently exist.`;
  }
  return monthlyNeed <= typicalSurplus
    ? `That fits inside the ${fmtWhole(typicalSurplus)} typically left over, leaving ${fmtWhole(typicalSurplus - monthlyNeed)} a month spare.`
    : `That is ${fmtWhole(monthlyNeed - typicalSurplus)} a month more than the ${fmtWhole(typicalSurplus)} typically left over, so the plan does not close as written.`;
}

/** Median, not mean: one annual premium should not redefine a normal month. */
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * SQLite writes `ai_cache.created_at` as `'YYYY-MM-DD HH:MM:SS'` already, but a value
 * that came back from `new Date().toISOString()` has a T in it. Cutting at 16
 * characters leaves the date and the minute either way.
 */
function stamp(at: string): string {
  return at.replace("T", " ").slice(0, 16);
}

const VERDICT_LABEL: Record<Coaching["verdict"], string> = {
  comfortable: "Comfortable",
  tight: "Tight",
  overcommitted: "Overcommitted",
  unknown: "Not enough data",
};

const VERDICT_TONE: Record<Coaching["verdict"], Tone> = {
  comfortable: "good",
  tight: "warn",
  overcommitted: "bad",
  unknown: "neutral",
};

type GoalVerdict = Coaching["goals"][number]["verdict"];

const GOAL_VERDICT_LABEL: Record<GoalVerdict, string> = {
  fine: "On pace",
  needs_more: "Needs more",
  at_risk: "At risk",
  reconsider: "Reconsider",
};

const GOAL_VERDICT_TONE: Record<GoalVerdict, Tone> = {
  fine: "good",
  needs_more: "warn",
  at_risk: "bad",
  reconsider: "info",
};

const GOAL_VERDICT_ICON: Record<GoalVerdict, IconName> = {
  fine: "check",
  needs_more: "arrowUp",
  at_risk: "alert",
  reconsider: "undo",
};

/**
 * Palette keys rather than colours. The web wrote `var(--green)` and so on; `IconTile`
 * builds a 13% background with `${color}22`, which needs real six-digit hex, so the
 * value has to come out of the live palette at the use site instead.
 */
const GOAL_VERDICT_COLOR: Record<GoalVerdict, "green" | "amber" | "red" | "blue"> = {
  fine: "green",
  needs_more: "amber",
  at_risk: "red",
  reconsider: "blue",
};

const styles = (t: Theme) => ({
  // `.stack > * + * { margin-top: 20px }`, and `.grid.g-2` collapsed to one column.
  stack: { gap: space.gap + 4 } as ViewStyle,

  // `.grid.g-4`, wrapped two-up — the same arithmetic as the goal detail screen.
  factGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    rowGap: space.gap + 4,
    columnGap: space.gap,
  } as ViewStyle,
  fact: { width: "47%" } as ViewStyle,

  // `<strong>` inside a Banner. `Banner` wraps its children in one `<Text>` that
  // carries the tone colour, so this only has to supply the weight.
  strong: { fontWeight: weight.medium } as TextStyle,

  mutedCard: { opacity: 0.62 } as ViewStyle,

  // The anchor the web wrapped around the icon, the name and the chip.
  head: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 14,
    // Negative margin so the pressed tint reaches the card's padding edge without
    // the row itself being inset from the content below it.
    marginHorizontal: -6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  } as ViewStyle,
  headPressed: { opacity: 0.6 } as ViewStyle,
  headMain: { flex: 1, minWidth: 0 } as ViewStyle,

  // `.entry-title` at the 15px the card used.
  name: { ...font.cardTitle, color: t.c.text } as TextStyle,
  // `.entry-meta` — 12px, `--text-3`, wrapping.
  meta: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 3 } as ViewStyle,
  // `.entry-meta` and `.dim` are both `--text-3`, so the web's `<span class="dim">`
  // around "no deadline" rendered identically to the text beside it. One style.
  metaText: { ...font.small, color: t.c.text3 } as TextStyle,

  progressWrap: { marginTop: 16 } as ViewStyle,
  savedRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.gapSm,
    marginBottom: 7,
  } as ViewStyle,
  // 19px/300 — between `font.amount` and `font.body`, and used nowhere else, so it
  // is written out rather than made a token.
  saved: { fontSize: 19, fontWeight: weight.light, color: t.c.text, ...tnum } as TextStyle,
  savedOf: { fontSize: 13, fontWeight: weight.regular, color: t.c.text3 } as TextStyle,
  pctText: { ...font.small, ...tnum } as TextStyle,

  paceRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.gapSm,
    marginTop: 7,
  } as ViewStyle,
  dim: { ...font.small, color: t.c.text3 } as TextStyle,
  dimNum: { ...font.small, ...tnum } as TextStyle,

  footRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: space.gapSm,
    marginTop: 16,
  } as ViewStyle,
  footMain: { flex: 1, minWidth: 0, gap: 3 } as ViewStyle,
  kvK: { ...font.label, color: t.c.text3 } as TextStyle,
  kvV: { ...font.body, ...tnum, color: t.c.text } as TextStyle,

  // ------------------------------------------------------------ the coaching card
  // `.muted` at the card's own body size, for the thin-history card's one paragraph.
  coachProse: { ...font.body, lineHeight: 22, color: t.c.text2 } as TextStyle,
  // `font-size: 15; line-height: 1.65`. RN has no unitless line height, so 15 × 1.65.
  coachSummary: { fontSize: 15, lineHeight: 25, color: t.c.text } as TextStyle,

  // `.stack` inside the card, at `margin-top: 18px`.
  verdictList: { gap: space.gap - 2, marginTop: 18 } as ViewStyle,
  // `.row` with `gap: 12; align-items: flex-start`.
  verdictRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 } as ViewStyle,
  verdictMain: { flex: 1, minWidth: 0 } as ViewStyle,
  verdictHead: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
  } as ViewStyle,
  // The web's link is `.strong` in the inherited colour — `a { color: inherit }` — so
  // the weight is the whole of it, and the press state carries the affordance.
  verdictName: { ...font.entryTitle, color: t.c.text } as TextStyle,
  namePressed: { opacity: 0.6 } as ViewStyle,
  // `.muted.small` with `line-height: 1.6` — 12 × 1.6, rounded.
  verdictAdvice: { ...font.small, lineHeight: 19, color: t.c.text2, marginTop: 3 } as TextStyle,

  leversWrap: { marginTop: 26 } as ViewStyle,
  // `.kv-k` with `margin-bottom: 10px`, matching `kvK` above.
  leversLabel: { ...font.label, color: t.c.text3, marginBottom: 10 } as TextStyle,
  // `.grid.g-2` → one column, for the same reason the goal cards are.
  leverList: { gap: space.gapSm } as ViewStyle,
  // `.muted-card` with `padding: 14px 16px`. `.muted-card` is only an opacity, and the
  // web undoes it on hover; a phone has no hover, so body text would sit at 62%
  // permanently. The quieter-than-the-card intent is a `--surface-2` tile instead.
  lever: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: radius.sm,
    backgroundColor: t.c.surface2,
  } as ViewStyle,
  leverTitle: { ...font.body, fontWeight: weight.medium, color: t.c.text } as TextStyle,
  leverDetail: { ...font.small, lineHeight: 19, color: t.c.text2, marginTop: 4 } as TextStyle,

  // `Banner` carries no margin of its own, hence the wrapper.
  tradeoffWrap: { marginTop: 22 } as ViewStyle,

  // `.card-note` with `margin-top: 20px`.
  cardNote: { ...font.small, color: t.c.text3, marginTop: 20 } as TextStyle,
});
