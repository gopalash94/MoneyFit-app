/**
 * Track — the analytics half of the app, and the deliberate counterpart to Home.
 *
 * Home answers "where am I right now" in one screen. This answers "why", and it
 * needs more than one screen to do it, so it splits into three views that a
 * single `?view=` parameter switches between:
 *
 *   month     one month in detail — burn-down against pace, every day, every
 *             category, the biggest single charges
 *   trend     twelve months of income against outgo, and what an average month
 *             actually looks like
 *   recurring what you are subscribed to, worked out from the shape of the dates
 *             and amounts rather than from anything you told the app
 *
 * Nothing here is AI. Every figure on this page is arithmetic over your own rows,
 * which is why it all still works with no API key — the AI surfaces live at
 * /insights and /ask.
 *
 * Five things changed on the way to the phone.
 *
 * **One `load()` per view, not three awaited components.** The web page awaited
 * `ThisMonth`, `Trends` or `Recurring` inside a try so a cold database showed one
 * explanatory card; `useLive` + `Screen` already do exactly that, so the three
 * bodies became three plain components over a discriminated union and the reads
 * moved into `load()`. Only the chosen view's queries run, which is what the web
 * got from the same ternary. `getSettings()` is read only by the month view,
 * because it is the only one that needs the start day and the budget fallback —
 * trends are whole calendar months and the detector does not budget.
 *
 * **The head comes from the params, the body from the data.** Tapping a tab has
 * to light it up immediately, and `useLive` holds the previous data until the new
 * read lands, so for one frame the highlighted tab and the rendered body can
 * disagree. That is the right trade: an instant control and a body that is a beat
 * behind reads as loading, whereas a control that waits reads as broken.
 *
 * **The three tables are row lists.** React Native has no `<table>`. Each one
 * keeps every column it had, folded into two or three lines with a hairline
 * between rows — the same substitution `CategoriesEditor` made, and for the same
 * reason the column headings went with them: a heading exists to explain a bare
 * cell, and a labelled line does not need one.
 *
 * **The grids collapse.** `.g-4` (the four burn-down figures) becomes the wrapping
 * two-up every other screen in this port uses; `.g-2-1` and `.g-3` become full
 * width and stack, because an `xl` metric is 56px tall and two of them side by
 * side on a phone is neither.
 *
 * **Every `var(--…)` became `t.c.*`.** `react-native-svg` resolves no custom
 * properties, so the pace line, the burn-down fill, the two cashflow series, the
 * over-budget bar and the detector's tile all take real colours from the theme.
 */

import { useLocalSearchParams, useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import type { TextStyle, ViewStyle } from "react-native";

import { BarChart, BarRows, LineChart, toDayBars } from "@/components/charts";
import { MonthNav, Tabs, useSetParams, type Tab } from "@/components/filters";
import { Icon } from "@/components/Icon";
import { Screen } from "@/components/Screen";
import {
  Banner,
  Card,
  Chip,
  Dot,
  EmptyState,
  IconTile,
  PageHead,
  ProgressBar,
  StatTile,
  type Tone,
} from "@/components/ui";
import {
  CADENCE_LABEL,
  detectSubscriptions,
  type DetectedSubscription,
} from "@/lib/analytics/subscriptions";
import {
  addMonthKey,
  fmtDate,
  fmtDayNum,
  fmtMonth,
  fmtMonthShort,
  monthBounds,
  thisMonth,
  today,
  type ISODate,
  type MonthKey,
} from "@/lib/date";
import { useLive } from "@/lib/live";
import { fmt, fmtCompact, fmtSigned, fmtWhole, pct } from "@/lib/money";
import { billsForDetection } from "@/lib/queries/bills";
import { getSettings } from "@/lib/queries/settings";
import {
  budgetStatus,
  burnDown,
  cashflowByMonth,
  categoryBreakdown,
  categoryMoM,
  dailySpend,
  dataSpan,
  largestExpenses,
  overallBudget,
  spentInMonth,
} from "@/lib/queries/stats";
import { useStyles, useTheme, type Theme } from "@/theme/ThemeProvider";
import { font, radius, space, tnum, weight } from "@/theme/tokens";

type View = "" | "trend" | "recurring";

const VIEWS: Tab[] = [
  { value: "", label: "This month" },
  { value: "trend", label: "Trends" },
  { value: "recurring", label: "Recurring" },
];

/* ---------------------------------------------------------------- the reads */

type MonthLoaded = {
  view: "";
  month: MonthKey;
  prev: MonthKey;
  start: ISODate;
  end: ISODate;
  now: ISODate;
  current: boolean;
  spent: number;
  budget: number;
  cum: Awaited<ReturnType<typeof burnDown>>;
  days: Awaited<ReturnType<typeof dailySpend>>;
  cats: Awaited<ReturnType<typeof categoryBreakdown>>;
  mom: Awaited<ReturnType<typeof categoryMoM>>;
  budgets: Awaited<ReturnType<typeof budgetStatus>>;
  largest: Awaited<ReturnType<typeof largestExpenses>>;
};

type TrendLoaded = {
  view: "trend";
  month: MonthKey;
  flow: Awaited<ReturnType<typeof cashflowByMonth>>;
  span: Awaited<ReturnType<typeof dataSpan>>;
};

type RecurringLoaded = {
  view: "recurring";
  found: DetectedSubscription[];
};

type Loaded = MonthLoaded | TrendLoaded | RecurringLoaded;

async function load(month: MonthKey, view: View): Promise<Loaded> {
  // Trends are whole calendar months regardless of the budgeting start day: a
  // twelve-month comparison shifted by four days is not a different answer, and
  // the month labels on the axis would stop matching the months in the list.
  if (view === "trend") {
    const from = `${addMonthKey(month, -11)}-01`;
    const [flow, span] = await Promise.all([cashflowByMonth(from), dataSpan()]);
    return { view, month, flow, span };
  }

  // Eighteen months is enough to see a yearly charge twice, which is the minimum
  // for it to be a cadence rather than a coincidence.
  if (view === "recurring") {
    const rows = await billsForDetection(`${addMonthKey(month, -18)}-01`);
    return { view, found: detectSubscriptions(rows) };
  }

  const settings = await getSettings();
  const startDay = settings.month_start_day;
  const { start, end } = monthBounds(month, startDay);
  const prev = addMonthKey(month, -1);

  const [spent, budget, cum, days, cats, mom, budgets, largest] = await Promise.all([
    spentInMonth(month, startDay),
    overallBudget(month, settings.monthly_budget_minor),
    burnDown(month, startDay),
    dailySpend(start, end),
    categoryBreakdown(month, startDay),
    categoryMoM(month, prev, startDay),
    budgetStatus(month, startDay),
    largestExpenses(month, startDay, 8),
  ]);

  return {
    view: "",
    month,
    prev,
    start,
    end,
    now: today(),
    current: month === thisMonth(),
    spent,
    budget,
    cum,
    days,
    cats,
    mom,
    budgets,
    largest,
  };
}

/* -------------------------------------------------------------- the screen */

/** A param can legitimately arrive twice; the first spelling of it wins. */
function str(v: string | string[] | undefined): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return "";
}

export default function TrackScreen() {
  const s = useStyles(styles);
  const params = useLocalSearchParams();

  // A hand-edited month in the params must not reach monthBounds() as nonsense.
  const asked = str(params.month);
  const month = /^\d{4}-\d{2}$/.test(asked) ? asked : thisMonth();
  const wanted = str(params.view);
  const view: View = wanted === "trend" || wanted === "recurring" ? wanted : "";

  const live = useLive(() => load(month, view), [month, view]);

  return (
    <Screen live={live}>
      {(data) => (
        <>
          <PageHead
            title="Track"
            sub={
              view === "trend"
                ? "Twelve months of cashflow"
                : view === "recurring"
                  ? "Charges that repeat, found statistically"
                  : `${fmtMonth(month)} in detail`
            }
          >
            {view === "" ? <MonthNav month={month} /> : null}
          </PageHead>

          <View style={s.tabsWrap}>
            <Tabs tabs={VIEWS} active={view} name="view" />
          </View>

          {data.view === "trend" ? (
            <Trends data={data} />
          ) : data.view === "recurring" ? (
            <Recurring data={data} />
          ) : (
            <ThisMonth data={data} />
          )}
        </>
      )}
    </Screen>
  );
}

/* ---------------------------------------------------------------- month view */

function ThisMonth({ data }: { data: MonthLoaded }) {
  const t = useTheme();
  const s = useStyles(styles);
  const { month, prev, start, end, now, current, spent, budget, cum, days, cats, mom, budgets, largest } = data;

  if (spent === 0 && cats.length === 0) {
    return (
      <Card>
        <EmptyState
          icon="track"
          title={`Nothing paid in ${fmtMonth(month)}`}
          body="Analytics needs something to analyse. Log a bill, or step back a month with the arrows above."
          cta={{ href: "/bill/new", label: "Add a bill" }}
        />
      </Card>
    );
  }

  // The cumulative series carries forward flat across days that have not
  // happened yet, which would draw a confident horizontal line into the future.
  // Cut it at today; the dashed pace line keeps running to month end.
  const cutAt = current ? cum.findIndex((r) => r.day > now) : -1;
  const actual = cutAt === -1 ? cum : cum.slice(0, cutAt);
  const paceLine = cum.map((_, i) => Math.round((budget * (i + 1)) / cum.length));

  const expectedByNow = actual.length ? paceLine[actual.length - 1] : 0;
  const vsPace = spent - expectedByNow;
  const totalSpend = cats.reduce((acc, c) => acc + c.total_minor, 0);

  const movers = mom.filter((m) => m.delta_minor !== 0).slice(0, 6);
  const overspent = budgets.filter((b) => b.spent_minor > b.limit_minor);
  const left = budget - spent;

  return (
    <View style={s.stack}>
      {/* --------------------------------------------------------- burn-down */}
      <Card
        title="Budget burn-down"
        note={`Cumulative spend against an even ${fmtWhole(budget)} across the month`}
        action={
          <Chip tone={vsPace > 0 ? "bad" : "good"} icon={vsPace > 0 ? "arrowUp" : "arrowDown"}>
            {`${fmtCompact(Math.abs(vsPace))} ${vsPace > 0 ? "ahead of" : "behind"} pace`}
          </Chip>
        }
      >
        <LineChart
          series={[
            { points: paceLine, color: t.c.text3, dashed: true },
            {
              points: actual.map((r) => r.cumulative_minor),
              color: spent > budget ? t.c.red : t.c.blue,
              fill: true,
            },
          ]}
          labels={cum.map((r) => fmtDayNum(r.day))}
          height={220}
        />
        <View style={s.grid}>
          <View style={s.cell}>
            <StatTile label="Spent" value={fmtCompact(spent)} size="sm" tone={spent > budget ? "neg" : undefined} />
          </View>
          <View style={s.cell}>
            <StatTile label="Expected by now" value={fmtCompact(expectedByNow)} size="sm" />
          </View>
          <View style={s.cell}>
            <StatTile
              label="Budget left"
              value={fmtCompact(Math.abs(left))}
              size="sm"
              tone={left < 0 ? "neg" : "pos"}
              sub={left < 0 ? "over" : undefined}
            />
          </View>
          <View style={s.cell}>
            <StatTile label="Of budget used" value={`${pct(spent, budget).toFixed(0)}%`} size="sm" />
          </View>
        </View>
      </Card>

      {/* --------------------------------------------------------- every day */}
      <Card title="Every day" note={`${fmtDate(start)} – ${fmtDate(end)}`}>
        <BarChart bars={toDayBars(days, now)} height={180} />
      </Card>

      {/* ------------------------------------------------------- categories */}
      <Card title="Where it went" note={`${cats.length} categories · ${fmtWhole(totalSpend)}`}>
        <BarRows
          rows={cats.map((c) => ({
            label: c.name,
            value: c.total_minor,
            color: c.color,
            note: `${pct(c.total_minor, totalSpend).toFixed(0)}% · ${c.txn_count} txn${c.txn_count === 1 ? "" : "s"}`,
          }))}
        />
      </Card>

      {/* ----------------------------------------------------------- movers */}
      <Card title="Biggest movers" note={`vs ${fmtMonth(prev)}`}>
        {movers.length === 0 ? (
          <EmptyState icon="repeat" title="Nothing moved" body={`No category changed against ${fmtMonth(prev)}.`} />
        ) : (
          <View style={s.moverList}>
            {movers.map((m) => (
              <View key={m.name} style={s.rowBetween}>
                <View style={s.dotRow}>
                  <Dot color={m.color} />
                  <Text style={s.strong} numberOfLines={1}>
                    {m.name}
                  </Text>
                </View>
                <View style={s.moverRight}>
                  {/* Spending more is bad news, so a positive delta is red. */}
                  <Text style={m.delta_minor > 0 ? s.deltaNeg : s.deltaPos}>{fmtSigned(m.delta_minor)}</Text>
                  <Text style={s.deltaPct}>
                    {m.prev_minor > 0
                      ? `${pct(m.delta_minor, m.prev_minor) > 0 ? "+" : ""}${pct(m.delta_minor, m.prev_minor).toFixed(0)}%`
                      : "new"}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        )}
      </Card>

      {/* --------------------------------------------------- category budgets */}
      {budgets.length > 0 ? (
        <Card
          title="Category budgets"
          note={`${budgets.length} with a limit set`}
          action={
            overspent.length > 0 ? (
              <Chip tone="bad" icon="alert">
                {`${overspent.length} over`}
              </Chip>
            ) : (
              <Chip tone="good" icon="check">
                All within limit
              </Chip>
            )
          }
        >
          <View style={s.budgetList}>
            {budgets.map((b) => {
              const ratio = b.limit_minor > 0 ? b.spent_minor / b.limit_minor : 0;
              const over = b.spent_minor > b.limit_minor;
              return (
                <View key={b.category_id}>
                  <View style={[s.rowBetween, s.barHead]}>
                    <View style={s.dotRow}>
                      <Dot color={b.color} />
                      <Text style={s.strong} numberOfLines={1}>
                        {b.name}
                      </Text>
                      {over ? (
                        <Chip tone="bad">{`${fmtCompact(b.spent_minor - b.limit_minor)} over`}</Chip>
                      ) : null}
                    </View>
                    <Text style={s.pair}>
                      {fmtWhole(b.spent_minor)}
                      <Text style={s.pairDim}>{` / ${fmtWhole(b.limit_minor)}`}</Text>
                    </Text>
                  </View>
                  <ProgressBar
                    value={ratio}
                    color={over ? t.c.red : ratio >= 0.85 ? t.c.amber : b.color}
                    height={8}
                  />
                </View>
              );
            })}
          </View>
        </Card>
      ) : null}

      {/* -------------------------------------------------- largest expenses */}
      <Card title="Largest single charges" note={`Top ${largest.length} in ${fmtMonth(month)}`}>
        <View>
          {largest.map((l, i) => (
            <ChargeRow key={l.id} row={l} share={pct(l.amount_minor, totalSpend)} first={i === 0} />
          ))}
        </View>
      </Card>
    </View>
  );
}

/**
 * One of the eight biggest charges — the web's first table row, folded onto two
 * lines and made tappable.
 *
 * The merchant was a `<Link>` to the bill; the whole block is the link here,
 * because a 14px word is not a touch target and the rest of the row was already
 * about that same bill.
 */
function ChargeRow({
  row: l,
  share,
  first,
}: {
  row: MonthLoaded["largest"][number];
  share: number;
  first: boolean;
}) {
  const s = useStyles(styles);
  const router = useRouter();

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${l.merchant} — ${fmt(l.amount_minor)} on ${fmtDate(l.txn_date)}`}
      onPress={() => router.push({ pathname: "/bill/[id]", params: { id: String(l.id) } })}
      style={({ pressed }) => [s.row, first ? null : s.rowSep, pressed ? s.rowPressed : null]}
    >
      <View style={s.rowBetween}>
        <Text style={s.rowTitle} numberOfLines={1}>
          {l.merchant}
        </Text>
        <Text style={s.rowAmount}>{fmt(l.amount_minor)}</Text>
      </View>
      <Text style={s.rowMeta} numberOfLines={1}>
        {`${l.name ?? "Uncategorised"} · ${fmtDate(l.txn_date)} · ${share.toFixed(1)}% of the month`}
      </Text>
    </Pressable>
  );
}

/* ---------------------------------------------------------------- trend view */

function Trends({ data }: { data: TrendLoaded }) {
  const t = useTheme();
  const s = useStyles(styles);
  const { month, flow, span } = data;

  if (flow.length === 0) {
    return (
      <Card>
        <EmptyState
          icon="track"
          title="No history to trend"
          body="Trends need at least a couple of months of paid bills. Load sample data from Settings to see this populated."
          cta={{ href: "/settings", label: "Open Settings" }}
        />
      </Card>
    );
  }

  // Averages are over *complete* months only. Including the month in progress
  // drags every mean down by however much of it has not happened yet.
  const current = thisMonth();
  const complete = flow.filter((f) => f.month < current);
  const basis = complete.length ? complete : flow;
  const avg = (of: (f: (typeof flow)[number]) => number) =>
    Math.round(basis.reduce((acc, f) => acc + of(f), 0) / basis.length);

  const avgIn = avg((f) => f.income_minor);
  const avgOut = avg((f) => f.expense_minor);
  const avgNet = avgIn - avgOut;
  const savingsRate = avgIn > 0 ? pct(avgNet, avgIn) : 0;

  const worst = [...basis].sort((a, b) => b.expense_minor - a.expense_minor)[0];
  const best = [...basis].sort((a, b) => b.net_minor - a.net_minor)[0];

  return (
    <View style={s.stack}>
      <Card title="Income and outgo" note={`${flow.length} months to ${fmtMonth(month)}`}>
        <LineChart
          series={[
            { points: flow.map((f) => f.income_minor), color: t.c.green, fill: true },
            { points: flow.map((f) => f.expense_minor), color: t.c.blue, fill: true },
          ]}
          labels={flow.map((f) => fmtMonthShort(f.month))}
          height={230}
        />
        {/* The chart takes no legend prop, so the two series are named beneath it. */}
        <View style={s.legend}>
          <View style={s.legendItem}>
            <Dot color={t.c.green} />
            <Text style={s.legendLabel}>Income</Text>
          </View>
          <View style={s.legendItem}>
            <Dot color={t.c.blue} />
            <Text style={s.legendLabel}>Expenses</Text>
          </View>
        </View>
      </Card>

      <Card title="An average month" note={`Over ${basis.length} complete month${basis.length === 1 ? "" : "s"}`}>
        <View style={s.avgList}>
          <StatTile label="Comes in" value={fmtCompact(avgIn)} tone="green" />
          <StatTile label="Goes out" value={fmtCompact(avgOut)} tone="blue" />
          <StatTile
            label="Kept"
            value={fmtCompact(avgNet)}
            tone={avgNet >= 0 ? "pos" : "neg"}
            sub={avgIn > 0 ? `${savingsRate.toFixed(0)}% savings rate` : "No income logged"}
          />
        </View>
        {complete.length === 0 ? (
          <View style={s.bannerWrap}>
            <Banner tone="warn" icon="info">
              Only the month in progress has data, so these averages are a partial month — treat them
              as provisional.
            </Banner>
          </View>
        ) : null}
      </Card>

      <Card title="Months with data">
        <StatTile
          label="Recorded"
          value={String(span.months)}
          size="xl"
          sub={span.first ? `Since ${fmtDate(span.first, { year: true })}` : "Nothing yet"}
        />
      </Card>

      <Card title="Heaviest month">
        <StatTile
          label={worst ? fmtMonth(worst.month) : "—"}
          value={worst ? fmtCompact(worst.expense_minor) : "—"}
          size="xl"
          tone="neg"
          sub={worst && avgOut > 0 ? `${(pct(worst.expense_minor, avgOut) - 100).toFixed(0)}% above average` : undefined}
        />
      </Card>

      <Card title="Best month">
        <StatTile
          label={best ? fmtMonth(best.month) : "—"}
          value={best ? fmtCompact(best.net_minor) : "—"}
          size="xl"
          tone={best && best.net_minor >= 0 ? "pos" : "neg"}
          sub="Most kept after expenses"
        />
      </Card>

      <Card title="Month by month" note="Paid bills only — upcoming ones are not history yet">
        <View>
          {[...flow].reverse().map((f, i) => (
            <MonthRow
              key={f.month}
              row={f}
              delta={avgOut > 0 ? pct(f.expense_minor - avgOut, avgOut) : null}
              inProgress={f.month === current}
              first={i === 0}
            />
          ))}
        </View>
      </Card>
    </View>
  );
}

/**
 * One month of cashflow — the web's `<Link href={`/track?month=…`}>` row.
 *
 * `setParams` merges, so clearing `view` is what sends the tap to the month view
 * rather than leaving it on Trends looking at a month it does not use.
 */
function MonthRow({
  row: f,
  delta,
  inProgress,
  first,
}: {
  row: TrendLoaded["flow"][number];
  /** Null when there is no average to compare against — the web's `"—"`. */
  delta: number | null;
  inProgress: boolean;
  first: boolean;
}) {
  const s = useStyles(styles);
  const setParams = useSetParams();

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${fmtMonth(f.month)} in detail`}
      onPress={() => setParams({ month: f.month, view: undefined })}
      style={({ pressed }) => [s.row, first ? null : s.rowSep, pressed ? s.rowPressed : null]}
    >
      <View style={s.rowBetween}>
        <Text style={s.rowTitle} numberOfLines={1}>
          {fmtMonth(f.month)}
          {inProgress ? <Text style={s.rowMeta}> · in progress</Text> : null}
        </Text>
        <Text style={f.net_minor >= 0 ? s.rowAmountPos : s.rowAmountNeg}>{fmtSigned(f.net_minor)}</Text>
      </View>
      <View style={s.rowBetween}>
        <Text style={s.rowMeta}>
          {`${f.income_minor ? fmt(f.income_minor) : "—"} in · ${fmt(f.expense_minor)} out`}
        </Text>
        <Text style={s.rowMeta}>
          {delta === null ? "—" : `${delta >= 0 ? "+" : ""}${delta.toFixed(0)}% vs average out`}
        </Text>
      </View>
    </Pressable>
  );
}

/* ------------------------------------------------------------ recurring view */

function Recurring({ data }: { data: RecurringLoaded }) {
  const s = useStyles(styles);
  const { found } = data;

  const running = found.filter((f) => !f.possiblyCancelled);
  const annual = running.reduce((acc, f) => acc + f.annualCostMinor, 0);
  const rises = found.filter((f) => f.priceIncrease);

  if (found.length === 0) {
    return (
      <Card>
        <EmptyState
          icon="repeat"
          title="No repeating charges found"
          body="A charge needs to appear at least three times at a steady interval and a steady amount before it counts. Keep logging and this fills in."
        />
      </Card>
    );
  }

  return (
    <View style={s.stack}>
      <Card title="Still running">
        <StatTile
          label="Subscriptions"
          value={String(running.length)}
          size="xl"
          sub={
            found.length > running.length
              ? `${found.length - running.length} look cancelled`
              : "All charging on schedule"
          }
        />
      </Card>

      <Card title="Committed per year">
        <StatTile
          label="Across all of them"
          value={fmtCompact(annual)}
          size="xl"
          tone="amber"
          sub={`${fmtCompact(Math.round(annual / 12))} a month`}
        />
      </Card>

      <Card title="Price rises">
        <StatTile
          label="Charging more than before"
          value={String(rises.length)}
          size="xl"
          tone={rises.length ? "neg" : undefined}
          sub={
            rises.length
              ? rises
                  .map((r) => r.merchant)
                  .slice(0, 3)
                  .join(", ")
              : "Nothing has gone up"
          }
        />
      </Card>

      <Banner tone="info" icon="info">
        Found by looking at the shape of your own rows — three or more charges, gaps that cluster
        around a real cadence, amounts stable within about 15%. No AI, no API key, nothing sent
        anywhere. The confidence figure is the detector’s own honesty about each one.
      </Banner>

      <Card title="Detected" note={`${found.length} from the last 18 months`}>
        <View>
          {found.map((f, i) => (
            <SubRow key={f.signature} sub={f} first={i === 0} />
          ))}
        </View>
      </Card>
    </View>
  );
}

/**
 * One detected subscription — the web's seven-column row on three lines.
 *
 * Merchant and typical charge on the first, the cadence, the count and the yearly
 * commitment with the confidence chip on the second, and when it is next due on
 * the third. Nothing is dropped; the column headings are, because each figure now
 * carries its own word.
 */
function SubRow({ sub, first }: { sub: DetectedSubscription; first: boolean }) {
  const t = useTheme();
  const s = useStyles(styles);
  const tone: Tone = sub.confidence >= 0.75 ? "good" : sub.confidence >= 0.55 ? "info" : "warn";
  const rise = sub.priceIncrease;

  return (
    <View style={[s.subRow, first ? null : s.rowSep]}>
      <IconTile color={t.c.amber} icon="repeat" size={30} />

      <View style={s.subBody}>
        <View style={s.rowBetween}>
          <Text style={s.rowTitle} numberOfLines={1}>
            {sub.merchant}
          </Text>
          <Text style={s.rowAmount}>{fmt(sub.typicalMinor)}</Text>
        </View>

        {rise ? (
          // An SVG cannot sit inside a `<Text>`, so the arrow is its own child of
          // a row rather than the inline glyph the web had.
          <View style={s.riseRow}>
            <Icon name="arrowUp" size={12} stroke={2.4} color={t.c.red} />
            <Text style={s.riseText}>
              {`${fmtWhole(rise.fromMinor)} → ${fmtWhole(rise.toMinor)} (+${rise.pctChange}%)`}
            </Text>
          </View>
        ) : null}

        <View style={s.rowBetween}>
          <Text style={s.rowMeta} numberOfLines={1}>
            {`${CADENCE_LABEL[sub.cadence]} · ${sub.occurrences}× · ${fmtCompact(sub.annualCostMinor)} a year`}
          </Text>
          <Chip tone={tone}>{`${Math.round(sub.confidence * 100)}%`}</Chip>
        </View>

        {sub.possiblyCancelled ? (
          // A `<Chip>` is a `<View>`, so it would stretch the full width on its
          // own line; a row wrapper shrinks it back to its text.
          <View style={s.chipWrap}>
            <Chip tone="neutral" icon="clock">
              {`missed since ${fmtDate(sub.nextExpected)}`}
            </Chip>
          </View>
        ) : (
          <Text style={s.rowMeta}>{`Next expected ${fmtDate(sub.nextExpected)}`}</Text>
        )}
      </View>
    </View>
  );
}

/* -------------------------------------------------------------------- styles */

const styles = (t: Theme) => ({
  // `.stack > * + * { margin-top: 20px }`.
  stack: { gap: space.gap + 4 } as ViewStyle,
  tabsWrap: { marginBottom: space.gap } as ViewStyle,

  // `.grid.g-4`, wrapped two-up — the four burn-down figures.
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    rowGap: space.gap + 4,
    columnGap: space.gap,
    marginTop: 20,
  } as ViewStyle,
  cell: { width: "47%" } as ViewStyle,

  // `.row-between`, and the `.row` that holds a dot beside a name.
  rowBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  } as ViewStyle,
  dotRow: { flexDirection: "row", alignItems: "center", gap: 9, flexShrink: 1 } as ViewStyle,
  chipWrap: { flexDirection: "row" } as ViewStyle,

  // `.small.strong`.
  strong: { ...font.small, fontWeight: weight.medium, color: t.c.text, flexShrink: 1 } as TextStyle,

  // ------------------------------------------------------------------ movers
  moverList: { gap: 14 } as ViewStyle,
  moverRight: { flexDirection: "row", alignItems: "center", gap: 8 } as ViewStyle,
  deltaNeg: { ...font.small, ...tnum, color: t.c.red } as TextStyle,
  deltaPos: { ...font.small, ...tnum, color: t.c.green } as TextStyle,
  deltaPct: { ...font.small, ...tnum, color: t.c.text3 } as TextStyle,

  // ---------------------------------------------------------------- budgets
  budgetList: { gap: 18 } as ViewStyle,
  barHead: { marginBottom: 6 } as ViewStyle,
  pair: { ...font.small, ...tnum, color: t.c.text2 } as TextStyle,
  pairDim: { color: t.c.text3 } as TextStyle,

  // ----------------------------------------------------------------- legend
  legend: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 20,
    marginTop: 14,
  } as ViewStyle,
  legendItem: { flexDirection: "row", alignItems: "center", gap: 8 } as ViewStyle,
  legendLabel: { ...font.small, color: t.c.text } as TextStyle,

  // The three averages, stacked at the `.col` gap the web used.
  avgList: { gap: 24 } as ViewStyle,
  bannerWrap: { marginTop: 18 } as ViewStyle,

  // ------------------------------------------------- the three former tables
  // `.table tbody td` — 12px vertical padding and a hairline above every row
  // but the first, which is what `border-top` on a table row amounts to.
  row: { paddingVertical: 12, paddingHorizontal: 4, borderRadius: radius.sm, gap: 4 } as ViewStyle,
  rowSep: { borderTopWidth: 1, borderTopColor: t.c.borderSoft } as ViewStyle,
  rowPressed: { backgroundColor: t.c.surface2 } as ViewStyle,
  rowTitle: { ...font.entryTitle, color: t.c.text, flexShrink: 1 } as TextStyle,
  rowAmount: { ...font.entryAmount, ...tnum, color: t.c.text } as TextStyle,
  rowAmountPos: { ...font.entryAmount, ...tnum, color: t.c.green } as TextStyle,
  rowAmountNeg: { ...font.entryAmount, ...tnum, color: t.c.red } as TextStyle,
  rowMeta: { ...font.small, color: t.c.text3 } as TextStyle,

  // The detector's rows carry a tile, so they are a row with a column inside.
  subRow: { flexDirection: "row", gap: 10, paddingVertical: 12, paddingHorizontal: 4 } as ViewStyle,
  subBody: { flex: 1, gap: 6 } as ViewStyle,
  riseRow: { flexDirection: "row", alignItems: "center", gap: 4 } as ViewStyle,
  riseText: { ...font.small, ...tnum, color: t.c.red } as TextStyle,
});
