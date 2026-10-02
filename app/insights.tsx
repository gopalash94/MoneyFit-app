/**
 * Insights — `Finance/src/app/insights/page.tsx`.
 *
 * Track is descriptive: it shows what happened, in as much detail as you care to look at.
 * This screen is the opposite shape. It answers three questions nobody wants to work out by
 * reading tables — where the month is heading, what looks out of place, and what is already
 * committed for the months after it — and then says which of those actually matters.
 *
 * The order is deliberate, and it is the web's: the summary card leads, because the ranked
 * version of the screen is the reason to open it, and everything below it is the arithmetic
 * that summary is drawn from. All of it is computed on this phone, from your own rows.
 *
 * **The structural change that used to be here is gone, and that is worth recording.** The
 * summary was a hosted-model call, so `Narrative` had a `useLive` of its own: the fifteen
 * SQLite reads could not be held hostage to a network round trip, and a failure had to
 * degrade to a banner rather than take the screen down with it. There was also a cache, so
 * that a `refreshAll()` from anywhere did not pay for the same month twice.
 *
 * `writeInsights` is synchronous arithmetic over the brief this file already builds, so the
 * card is now assembled during the same render as everything else. No second load, no
 * spinner, no error banner, no retry, no "needs an API key" empty state and no cache — none
 * of those have anything left to describe. The screen always has an answer by the time it
 * paints, which is the entire point of the change.
 *
 * **The outliers table is a list.** React Native has no `<table>`, and six columns do not
 * fit on a phone regardless. Each row keeps all six values: merchant and amount on the
 * first line, then category, date and the usual size on the second, with the multiple as
 * the chip it already was. The column headings are gone because each value now says what it
 * is ("usually ₹420") instead of relying on a heading four rows above it.
 *
 * **Colours come from the theme, not from CSS.** `IconTile` builds its wash by appending an
 * alpha pair to the colour it is given, and `ProgressBar` and `Dot` take real colour
 * strings, so every `var(--red)` in the original is `t.c.red` here.
 *
 * The `/ask` button in the head is deliberately absent for now. Under `typedRoutes` an
 * `href` to a route with no file is a compile error, not a 404; it goes in when
 * `app/ask.tsx` lands.
 */

import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import type { TextStyle, ViewStyle } from "react-native";

import { MonthNav } from "@/components/filters";
import type { IconName } from "@/components/Icon";
import { Screen } from "@/components/Screen";
import {
  Banner, Card, Chip, Dot, EmptyState, IconTile, LinkButton,
  PageHead, ProgressBar, StatTile,
} from "@/components/ui";
import {
  burnForecast, flagOutliers, paceVsLastMonth, projectCashflow,
  type BurnForecast, type CashflowProjection,
} from "@/lib/analytics/forecast";
import {
  writeInsights, type Insights as InsightsPayload, type InsightsBrief,
} from "@/lib/analytics/narrative";
import {
  CADENCE_LABEL, detectSubscriptions, type DetectedSubscription,
} from "@/lib/analytics/subscriptions";
import {
  addMonthKey, fmtDate, fmtMonth, monthBounds, thisMonth, today, type MonthKey,
} from "@/lib/date";
import { useLive } from "@/lib/live";
import { fmtCompact, fmtWhole, pct } from "@/lib/money";
import { billsForDetection, listBills, listRecurring } from "@/lib/queries/bills";
import { goalFundedInMonth } from "@/lib/queries/goals";
import { investedInMonth } from "@/lib/queries/holdings";
import { getSettings } from "@/lib/queries/settings";
import {
  budgetStatus, cashflowByMonth, categoryBreakdown, categoryMoM, dataSpan, overallBudget,
  spendByMonth, spentInMonth,
} from "@/lib/queries/stats";
import { useStyles, useTheme, type Theme } from "@/theme/ThemeProvider";
import { font, radius, space, tnum, weight } from "@/theme/tokens";

/** `flagOutliers` adds two fields to the rows it is given; this is that return row. */
type Outlier = ReturnType<typeof flagOutliers>[number];

type Loaded = {
  month: MonthKey;
  /** The web's early return. Here it is a flag, because the brief is cheap to build. */
  empty: boolean;
  spent: number;
  budget: number;
  burn: BurnForecast;
  vsLast: { deltaPct: number | null; expectedByNowMinor: number };
  outliers: Outlier[];
  projection: CashflowProjection[];
  subs: DetectedSubscription[];
  brief: InsightsBrief;
};

async function load(month: MonthKey): Promise<Loaded> {
  const settings = await getSettings();
  const startDay = settings.month_start_day;
  const { start, end } = monthBounds(month, startDay);
  const prev = addMonthKey(month, -1);

  // Outlier medians are computed over half a year, not over this month: four charges is
  // the minimum for a category to have a distribution at all, and one month of groceries
  // rarely clears that. Only flags landing inside the month are shown — the history is
  // there to define "usual", not to be reported.
  const historyFrom = addMonthKey(month, -5) + "-01";

  const [
    spent, prevSpent, budget, cats, mom, budgets, span, recent, upcoming, recurring,
    history, detection, flow, goalFunded, invested,
  ] = await Promise.all([
    spentInMonth(month, startDay),
    spentInMonth(prev, startDay),
    overallBudget(month, settings.monthly_budget_minor),
    categoryBreakdown(month, startDay),
    categoryMoM(month, prev, startDay),
    budgetStatus(month, startDay),
    dataSpan(),
    listBills({ limit: 700 }),
    listBills({ status: "upcoming", limit: 200 }),
    listRecurring(),
    spendByMonth(historyFrom),
    billsForDetection(addMonthKey(month, -18) + "-01"),
    cashflowByMonth(month + "-01"),
    goalFundedInMonth(month, startDay),
    investedInMonth(month, startDay),
  ]);

  const burn = burnForecast(month, spent, budget, startDay);
  const vsLast = paceVsLastMonth(month, spent, prevSpent, startDay);

  const outliers = flagOutliers(
    recent
      .filter((b) => b.kind === "expense" && b.status === "paid" && b.txn_date >= historyFrom)
      .map((b) => ({
        id: b.id,
        merchant: b.merchant,
        amount_minor: b.amount_minor,
        txn_date: b.txn_date,
        category: b.category_name ?? "Uncategorised",
      })),
  ).filter((o) => o.txn_date >= start && o.txn_date <= end);

  const projection = projectCashflow({
    months: 3,
    monthStartDay: startDay,
    upcoming: upcoming.map((b) => ({ due_date: b.due_date, amount_minor: b.amount_minor })),
    recurring: recurring.map((b) => ({
      txn_date: b.txn_date,
      due_date: b.due_date,
      amount_minor: b.amount_minor,
      recurrence: b.recurrence,
    })),
    history,
  });

  const subs = detectSubscriptions(detection).filter((s) => !s.possiblyCancelled);
  const dueThisMonth = upcoming.filter(
    (b) => b.due_date && b.due_date >= today() && b.due_date <= end,
  );
  const income = flow.find((f) => f.month === month)?.income_minor ?? 0;

  const brief: InsightsBrief = {
    monthLabel: fmtMonth(month),
    progressPct: Math.round((burn.daysElapsed / (burn.daysElapsed + burn.daysRemaining)) * 100),
    daysRemaining: burn.daysRemaining,
    budget: fmtWhole(budget),
    spent: fmtWhole(spent),
    projected: fmtWhole(burn.projectedMinor),
    headroom:
      burn.headroomMinor < 0
        ? `${fmtWhole(-burn.headroomMinor)} over budget`
        : `${fmtWhole(burn.headroomMinor)} under budget`,
    safePerDay: burn.safePerDayMinor === null ? null : fmtWhole(burn.safePerDayMinor),
    vsLastMonth:
      vsLast.deltaPct === null
        ? null
        : `${vsLast.deltaPct > 0 ? "up" : "down"} ${Math.abs(vsLast.deltaPct)}% against ${fmtWhole(vsLast.expectedByNowMinor)}`,
    income: income ? fmtWhole(income) : null,
    // Ten categories is everything anyone has; the tail is noise in a summary.
    categories: cats.slice(0, 10).map((c) => {
      const limit = budgets.find((b) => b.category_id === c.category_id);
      const last = mom.find((m) => m.name === c.name);
      return {
        name: c.name,
        spent: fmtWhole(c.total_minor),
        spentMinor: c.total_minor,
        limit: limit ? fmtWhole(limit.limit_minor) : null,
        usedPct:
          limit && limit.limit_minor > 0 ? Math.round(pct(c.total_minor, limit.limit_minor)) : null,
        lastMonth: last && last.prev_minor > 0 ? fmtWhole(last.prev_minor) : null,
        lastMonthMinor: last && last.prev_minor > 0 ? last.prev_minor : null,
      };
    }),
    outliers: outliers.slice(0, 6).map((o) => ({
      merchant: o.merchant,
      amount: fmtWhole(o.amount_minor),
      date: fmtDate(o.txn_date),
      category: o.category,
      typical: fmtWhole(o.medianMinor),
      multiple: o.multiple,
    })),
    subscriptions: subs.slice(0, 8).map((s) => ({
      merchant: s.merchant,
      cadence: CADENCE_LABEL[s.cadence].toLowerCase(),
      typical: fmtWhole(s.typicalMinor),
      perYear: fmtWhole(s.annualCostMinor),
      perYearMinor: s.annualCostMinor,
      note: s.priceIncrease
        ? `up from ${fmtWhole(s.priceIncrease.fromMinor)} (+${s.priceIncrease.pctChange}%)`
        : null,
    })),
    upcoming: dueThisMonth.length
      ? {
          count: dueThisMonth.length,
          total: fmtWhole(dueThisMonth.reduce((s, b) => s + b.amount_minor, 0)),
          totalMinor: dueThisMonth.reduce((s, b) => s + b.amount_minor, 0),
        }
      : null,
    goals: settings.monthly_goal_target_minor
      ? {
          funded: fmtWhole(goalFunded),
          target: fmtWhole(settings.monthly_goal_target_minor),
          fundedPct: Math.round(pct(goalFunded, settings.monthly_goal_target_minor)),
        }
      : null,
    invest: settings.monthly_invest_target_minor
      ? {
          funded: fmtWhole(invested),
          target: fmtWhole(settings.monthly_invest_target_minor),
          fundedPct: Math.round(pct(invested, settings.monthly_invest_target_minor)),
        }
      : null,
    billCount: cats.reduce((s, c) => s + c.txn_count, 0),
    monthsOfHistory: span.months,

    // Numbers rather than strings: ranking needs to compare, and the formatted fields
    // above cannot be compared without parsing them back.
    headroomMinor: burn.headroomMinor,
    budgetUsedPct: budget > 0 ? Math.round(pct(spent, budget)) : null,
    vsLastMonthPct: vsLast.deltaPct,
  };

  return {
    month,
    empty: spent === 0 && cats.length === 0 && dueThisMonth.length === 0,
    spent,
    budget,
    burn,
    vsLast,
    outliers,
    projection,
    subs,
    brief,
  };
}

export default function InsightsScreen() {
  const sp = useLocalSearchParams();
  const asked = str(sp.month);
  const month = /^\d{4}-\d{2}$/.test(asked) ? asked : thisMonth();

  const live = useLive(() => load(month), [month]);
  const s = useStyles(styles);

  return (
    <>
      <Stack.Screen options={{ title: "Insights" }} />
      <Screen live={live}>
        {(d) => (
          <>
            <Head month={d.month} />

            {d.empty ? (
              <Card>
                <EmptyState
                  icon="sparkle"
                  title={`Nothing to draw conclusions from in ${fmtMonth(d.month)}`}
                  body="Insights read your own rows — the month needs something in it first. Step back a month with the arrows, or load a month of sample data from Settings."
                  cta={{ href: "/bill/new", label: "Add a bill" }}
                />
              </Card>
            ) : (
              <View style={s.stack}>
                <Narrative brief={d.brief} />

                <WhereItLands data={d} />
                <Unusual outliers={d.outliers} />
                <NextThree projection={d.projection} />
                <Standing subs={d.subs} />
              </View>
            )}
          </>
        )}
      </Screen>
    </>
  );
}

// ------------------------------------------------------------------- the head

/**
 * `MonthNav` loses its `path` prop — `setParams` merges into the route it is already on,
 * so there is nothing to tell it.
 */
function Head({ month }: { month: MonthKey }) {
  return (
    <PageHead
      title="Insights"
      sub={`What stands out in ${fmtMonth(month)}, and what is already committed`}
    >
      <MonthNav month={month} />
      <LinkButton href="/ask" label="Ask a question" icon="ask" variant="outline" small />
    </PageHead>
  );
}

// -------------------------------------------------------------- the narrative

const TONE_ICON: Record<InsightsPayload["observations"][number]["tone"], IconName> = {
  good: "check",
  warn: "alert",
  bad: "alert",
  info: "info",
};

/**
 * The summary, with no key, no network and no cost.
 *
 * This is why the screen no longer has a "needs an API key" state. "Written insights need a
 * key" was true of the prose and never of the reasoning: every figure the card quotes was
 * computed on this phone, and ranking them is something code can do. The footer is honest
 * about the limit — a rule cannot notice what no rule was written for — rather than hiding
 * the card behind a setting.
 */
function Narrative({ brief }: { brief: InsightsBrief }) {
  const t = useTheme();
  const s = useStyles(styles);
  const ins = writeInsights(brief);

  return (
    <Card
      title={ins.headline}
      note="Ranked on this phone from the figures below. Nothing left the device to write it."
      action={
        <Chip tone="neutral" icon="check">
          Computed locally
        </Chip>
      }
    >
      <View style={s.obsList}>
        {ins.observations.map((o, i) => (
          <View key={i} style={s.obs}>
            <IconTile color={toneColor(t, o.tone)} icon={TONE_ICON[o.tone]} size={32} />
            <View style={s.obsMain}>
              <Text style={s.obsTitle}>{o.title}</Text>
              <Text style={s.obsDetail}>{o.detail}</Text>
              {o.category ? (
                <View style={s.obsChip}>
                  <Chip tone="neutral" icon="tag">
                    {o.category}
                  </Chip>
                </View>
              ) : null}
            </View>
          </View>
        ))}
      </View>

      {ins.watch_list.length > 0 ? (
        <View style={s.watchWrap}>
          <Text style={s.watchTitle}>Worth keeping an eye on</Text>
          <View style={s.chipsRow}>
            {ins.watch_list.map((w, i) => (
              <Chip key={i} tone="warn" icon="eye">
                {w}
              </Chip>
            ))}
          </View>
        </View>
      ) : null}

      {ins.question ? (
        <View style={s.questionWrap}>
          <Banner tone="info" icon="info">
            {ins.question}
          </Banner>
        </View>
      ) : null}

      <Text style={s.footNote}>
        Assembled by MoneyFit itself — the same figures you can read below, picked by rule. It
        phrases things the same way every month and it will not spot anything a rule was not
        written for, but every number in it is one this app computed, and none of it left the
        phone.
      </Text>
    </Card>
  );
}

// --------------------------------------------------------- where it all lands

function WhereItLands({ data }: { data: Loaded }) {
  const t = useTheme();
  const s = useStyles(styles);
  const { burn, budget, spent, vsLast } = data;

  // Assigned out before the guard so the narrowing survives into `fmtDate` below.
  const exhausted = burn.exhaustedOn;
  const share = budget ? spent / budget : 0;

  return (
    <Card
      title="Where this month lands"
      note={`Day ${burn.daysElapsed} of ${burn.daysElapsed + burn.daysRemaining}, at the current rate`}
      action={
        <Chip
          tone={
            burn.headroomMinor < 0 ? "bad" : burn.headroomMinor < budget * 0.1 ? "warn" : "good"
          }
          icon={burn.headroomMinor < 0 ? "alert" : "check"}
        >
          {burn.headroomMinor < 0
            ? `${fmtCompact(-burn.headroomMinor)} over`
            : `${fmtCompact(burn.headroomMinor)} to spare`}
        </Chip>
      }
    >
      {/* `.grid.g-4` — four across on a desktop, two across here. */}
      <View style={s.grid}>
        <View style={s.cell}>
          <StatTile
            size="sm"
            label="Spent so far"
            value={fmtCompact(spent)}
            tone={spent > budget ? "neg" : undefined}
            sub={`${pct(spent, budget).toFixed(0)}% of ${fmtCompact(budget)}`}
          />
        </View>
        <View style={s.cell}>
          <StatTile
            size="sm"
            label="Heading for"
            value={fmtCompact(burn.projectedMinor)}
            tone={burn.headroomMinor < 0 ? "neg" : "pos"}
            sub={`${fmtCompact(burn.perDayMinor)} a day so far`}
          />
        </View>
        <View style={s.cell}>
          <StatTile
            size="sm"
            label="Against last month"
            value={
              vsLast.deltaPct === null
                ? "—"
                : `${vsLast.deltaPct > 0 ? "+" : ""}${vsLast.deltaPct}%`
            }
            tone={
              vsLast.deltaPct === null ? undefined : vsLast.deltaPct > 0 ? "neg" : "pos"
            }
            sub={
              vsLast.deltaPct === null
                ? "No comparable month"
                : `${fmtCompact(vsLast.expectedByNowMinor)} by this day last month`
            }
          />
        </View>
        <View style={s.cell}>
          <StatTile
            size="sm"
            label="Safe daily spend"
            value={burn.safePerDayMinor === null ? "—" : fmtCompact(burn.safePerDayMinor)}
            sub={
              burn.safePerDayMinor === null
                ? "Budget already used up"
                : `for the last ${burn.daysRemaining} day${burn.daysRemaining === 1 ? "" : "s"}`
            }
          />
        </View>
      </View>

      <View style={s.barWrap}>
        <ProgressBar
          value={share}
          color={share > 1 ? t.c.red : share >= 0.85 ? t.c.amber : t.c.blue}
          height={10}
        />
      </View>

      {exhausted ? (
        <View style={s.bannerWrap}>
          <Banner tone="warn" icon="alert">
            {`At ${fmtCompact(burn.perDayMinor)} a day the budget is gone by `}
            <Text style={s.strong}>{fmtDate(exhausted)}</Text>
            {`, with ${burn.daysRemaining} day${burn.daysRemaining === 1 ? "" : "s"} left to cover.`}
          </Banner>
        </View>
      ) : null}
    </Card>
  );
}

// ----------------------------------------------------- charges out of the ord

/**
 * The web's six-column table, as rows.
 *
 * Nothing is dropped: merchant and amount lead, and the second line carries the category,
 * the date and the median it was judged against. The multiple keeps its chip, which was
 * already the one cell that was not plain text.
 */
function Unusual({ outliers }: { outliers: Outlier[] }) {
  const s = useStyles(styles);
  const router = useRouter();

  return (
    <Card
      title="Charges out of the ordinary"
      note="Judged against the median for their own category over six months"
      action={
        outliers.length > 0 ? (
          <Chip tone="warn" icon="alert">{`${outliers.length} flagged`}</Chip>
        ) : (
          <Chip tone="good" icon="check">
            Nothing unusual
          </Chip>
        )
      }
    >
      {outliers.length === 0 ? (
        <EmptyState
          icon="check"
          title="Every charge is a normal size for its category"
          body="A charge is flagged at three times the median for its own category, and only where that category has at least four charges to compare against."
        />
      ) : (
        <View>
          {outliers.map((o, i) => (
            <Pressable
              key={o.id}
              accessibilityRole="link"
              accessibilityLabel={`${o.merchant}, ${fmtWhole(o.amount_minor)}, ${o.multiple} times the usual`}
              onPress={() =>
                router.push({ pathname: "/bill/[id]", params: { id: String(o.id) } })
              }
              style={({ pressed }) => [
                s.row,
                i === 0 ? null : s.rowSep,
                pressed ? s.rowPressed : null,
              ]}
            >
              <View style={s.rowMain}>
                <Text style={s.rowTitle} numberOfLines={1}>
                  {o.merchant}
                </Text>
                <Text style={s.rowMeta} numberOfLines={2}>
                  {`${o.category} · ${fmtDate(o.txn_date)} · usually ${fmtWhole(o.medianMinor)}`}
                </Text>
              </View>
              <View style={s.rowRight}>
                <Text style={s.rowAmount}>{fmtWhole(o.amount_minor)}</Text>
                <View style={s.chipWrap}>
                  <Chip tone={o.multiple >= 6 ? "bad" : "warn"}>{`${o.multiple}×`}</Chip>
                </View>
              </View>
            </Pressable>
          ))}
        </View>
      )}
    </Card>
  );
}

// ---------------------------------------------------- the next three months

function NextThree({ projection }: { projection: CashflowProjection[] }) {
  const t = useTheme();
  const s = useStyles(styles);

  const reliable = projection.length > 0 && projection[0].reliable;

  return (
    <Card
      title="The next three months"
      note="Committed bills and recurrence rules, plus an average month for everything else"
    >
      <View style={s.months}>
        {projection.map((p) => {
          // The web sized each segment as a percentage of the month's total. Flex children
          // normalise against their own sum, so the filler is what keeps the three
          // segments proportional to `totalMinor` rather than to each other.
          const rest = Math.max(
            0,
            p.totalMinor - p.committedMinor - p.recurringMinor - p.discretionaryMinor,
          );
          return (
            <View key={p.month}>
              <View style={s.monthHead}>
                <Text style={s.monthName}>{fmtMonth(p.month)}</Text>
                <Text style={s.monthTotal}>{fmtWhole(p.totalMinor)}</Text>
              </View>
              <View style={s.barTrack}>
                <Segment value={p.committedMinor} color={t.c.blue} />
                <Segment value={p.recurringMinor} color={t.c.amber} />
                <Segment value={p.discretionaryMinor} color={t.c.border} />
                {rest > 0 ? <View style={{ flex: rest }} /> : null}
              </View>
              <Text style={s.monthSub}>
                {`${fmtCompact(p.committedMinor)} already due · ${fmtCompact(p.recurringMinor)} repeating · ${fmtCompact(p.discretionaryMinor)} typical`}
              </Text>
            </View>
          );
        })}
      </View>

      <View style={s.keyRow}>
        <KeyItem color={t.c.blue} label="Bills already entered" />
        <KeyItem color={t.c.amber} label="Implied by recurrence" />
        <KeyItem color={t.c.border} label="Historic average" />
      </View>

      {reliable ? null : (
        <View style={s.bannerWrap}>
          <Banner tone="neutral" icon="info">
            With fewer than three complete months logged, the grey part of each bar is a weak
            guess. The blue and amber parts are real commitments and stand on their own.
          </Banner>
        </View>
      )}
    </Card>
  );
}

// ------------------------------------------------------ standing commitments

function Standing({ subs }: { subs: DetectedSubscription[] }) {
  const t = useTheme();
  const s = useStyles(styles);

  const yearly = subs.reduce((sum, x) => sum + x.annualCostMinor, 0);

  return (
    <Card
      title="Standing commitments"
      note={`${subs.length} repeating charge${subs.length === 1 ? "" : "s"} found in your own rows`}
      action={
        <LinkButton
          href={{ pathname: "/track", params: { view: "recurring" } }}
          label="All of them"
          variant="ghost"
          small
        />
      }
    >
      {subs.length === 0 ? (
        <EmptyState
          icon="repeat"
          title="Nothing repeating yet"
          body="A charge needs to appear three times at a steady interval before the detector will call it recurring."
        />
      ) : (
        <>
          <StatTile
            label="Committed every year"
            value={fmtCompact(yearly)}
            size="xl"
            tone="amber"
            sub={`${fmtCompact(Math.round(yearly / 12))} a month before anything discretionary`}
          />

          <View style={s.subList}>
            {subs.slice(0, 5).map((x) => (
              <View key={x.signature} style={s.subRow}>
                <View style={s.subLeft}>
                  <IconTile color={t.c.amber} icon="repeat" size={28} />
                  <Text style={s.subName} numberOfLines={1}>
                    {x.merchant}
                  </Text>
                </View>
                <Text style={s.subAmount}>
                  {fmtWhole(x.typicalMinor)}{" "}
                  <Text style={s.subCadence}>{CADENCE_LABEL[x.cadence].toLowerCase()}</Text>
                </Text>
              </View>
            ))}
          </View>
        </>
      )}
    </Card>
  );
}

// ----------------------------------------------------------------- the pieces

/** One band of a stacked bar. Zero-width bands are omitted rather than drawn as hairlines. */
function Segment({ value, color }: { value: number; color: string }) {
  if (value <= 0) return null;
  return <View style={{ flex: value, backgroundColor: color }} />;
}

/**
 * A swatch and a label. Named `KeyItem` rather than `Legend` because `charts.tsx` already
 * exports a `Legend`, and two of those in one import graph is a needless trap.
 */
function KeyItem({ color, label }: { color: string; label: string }) {
  const s = useStyles(styles);
  return (
    <View style={s.keyItem}>
      <Dot color={color} />
      <Text style={s.keyLabel}>{label}</Text>
    </View>
  );
}

// ---------------------------------------------------------------- the helpers

/** A param can legitimately arrive twice; the first spelling of it wins. */
function str(v: string | string[] | undefined): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return "";
}

/** `IconTile` builds its wash from `${color}22`, so these have to be six-digit hex. */
function toneColor(t: Theme, tone: InsightsPayload["observations"][number]["tone"]): string {
  if (tone === "good") return t.c.green;
  if (tone === "bad") return t.c.red;
  if (tone === "warn") return t.c.amber;
  return t.c.blue;
}

const styles = (t: Theme) => ({
  /** `.stack` — the gap between cards. `Banner` has none of its own, hence the wrapper. */
  stack: { gap: space.gap + 4 } as ViewStyle,

  strong: { fontWeight: weight.medium } as TextStyle,
  bannerWrap: { marginTop: 18 } as ViewStyle,

  // ------------------------------------------------------------ the narrative
  obsList: { gap: 18 } as ViewStyle,
  obs: { flexDirection: "row", alignItems: "flex-start", gap: 14 } as ViewStyle,
  obsMain: { flex: 1, minWidth: 0 } as ViewStyle,
  obsTitle: { ...font.body, fontWeight: weight.medium, color: t.c.text } as TextStyle,
  obsDetail: { ...font.small, color: t.c.text2, lineHeight: 18, marginTop: 3 } as TextStyle,
  /** A `Chip` is a `View`, so it needs a row around it or it stretches. */
  obsChip: { flexDirection: "row", marginTop: 7 } as ViewStyle,

  watchWrap: { marginTop: 24 } as ViewStyle,
  watchTitle: { ...font.cardTitle, color: t.c.text, marginBottom: 10 } as TextStyle,
  chipsRow: { flexDirection: "row", flexWrap: "wrap", gap: 9 } as ViewStyle,

  questionWrap: { marginTop: 22 } as ViewStyle,
  footNote: { ...font.small, color: t.c.text3, lineHeight: 17, marginTop: 20 } as TextStyle,

  // -------------------------------------------------------- where it all lands
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    rowGap: space.gap + 4,
    columnGap: space.gap,
  } as ViewStyle,
  cell: { width: "47%" } as ViewStyle,
  barWrap: { marginTop: 20 } as ViewStyle,

  // -------------------------------------------------------------- the outliers
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderRadius: radius.sm,
  } as ViewStyle,
  rowSep: { borderTopWidth: 1, borderTopColor: t.c.borderSoft } as ViewStyle,
  rowPressed: { backgroundColor: t.c.surface2 } as ViewStyle,
  rowMain: { flex: 1, minWidth: 0 } as ViewStyle,
  rowTitle: { ...font.entryTitle, color: t.c.text } as TextStyle,
  rowMeta: { ...font.small, color: t.c.text3, marginTop: 3 } as TextStyle,
  rowRight: { alignItems: "flex-end", gap: 6 } as ViewStyle,
  rowAmount: { ...font.entryAmount, ...tnum, color: t.c.text } as TextStyle,
  /** `justifyContent` rather than `alignItems`: the chip sets its own `alignSelf`. */
  chipWrap: { flexDirection: "row", justifyContent: "flex-end" } as ViewStyle,

  // ------------------------------------------------------ the three-month bars
  months: { gap: 20 } as ViewStyle,
  monthHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 7,
  } as ViewStyle,
  monthName: { ...font.small13, fontWeight: weight.medium, color: t.c.text } as TextStyle,
  monthTotal: { ...font.small, ...tnum, color: t.c.text2 } as TextStyle,
  barTrack: {
    flexDirection: "row",
    gap: 2,
    height: 10,
    borderRadius: 5,
    overflow: "hidden",
    backgroundColor: t.c.surface3,
  } as ViewStyle,
  monthSub: { ...font.small, color: t.c.text3, marginTop: 6 } as TextStyle,

  keyRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 18,
    marginTop: 20,
  } as ViewStyle,
  keyItem: { flexDirection: "row", alignItems: "center", gap: 8 } as ViewStyle,
  keyLabel: { ...font.small, color: t.c.text3 } as TextStyle,

  // ------------------------------------------------------------ subscriptions
  subList: { gap: 12, marginTop: 20 } as ViewStyle,
  subRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  } as ViewStyle,
  subLeft: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1, minWidth: 0 } as ViewStyle,
  subName: { ...font.small13, fontWeight: weight.medium, color: t.c.text, flexShrink: 1 } as TextStyle,
  subAmount: { ...font.small13, ...tnum, color: t.c.text2 } as TextStyle,
  subCadence: { color: t.c.text3 } as TextStyle,
});
