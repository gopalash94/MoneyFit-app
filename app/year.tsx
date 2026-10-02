/**
 * Year — one calendar year, consolidated. `Finance/src/app/year/page.tsx`.
 *
 * The rest of the app is month-shaped: Home is this month, Track's detail view is
 * a month, Goals and Invest are "now". Track's trend view is twelve *rolling*
 * months, which is a different thing from a year — it cannot be named, it moves
 * when you change `?month=`, and it only knows about cashflow.
 *
 * This screen is the coarse lens, and it is deliberately the only one that gathers
 * all five subjects in one place: money in and out, where it went, what went into
 * goals, what went into investments, and where net worth ended up. Everything on
 * it is arithmetic over your own rows — the drill-down from any month row is
 * Track at that month, which is where the detail already lives.
 *
 * Two honesty rules it inherits from Track's trend view, both worth keeping:
 *
 *   - averages are over *complete* months only, because a half-finished October
 *     drags every mean down by however much of it has not happened yet;
 *   - a month with no data renders as a blank, not as ₹0. A year is twelve months
 *     whether or not you were using the app for all of them, and a zero row reads
 *     as "a month where nothing happened", which is a different claim.
 *
 * Five things changed on the way to the phone.
 *
 * **The reads moved into `load()`.** The web page awaited a `Year()` component
 * inside a try so a cold database showed one explanatory card; `useLive` + `Screen`
 * already do exactly that, so the nine-way `Promise.all` is a module-scope function
 * and the whole body is one synchronous component over its result.
 *
 * **The four headlines shrank from `xl` to the default size.** On the web they were
 * four `Card`s in a `.g-4` — four figures scannable at once, which is the entire
 * point of that grid. Four full-width cards each holding a 56px metric would be
 * most of a screen of scrolling before the first chart, so they wrap two-up in a
 * bare grid, as Invest and Goals already do, at a size that fits half a phone.
 *
 * **The three tables are row lists**, the same substitution Track made and for the
 * same reason: React Native has no `<table>`, so each row keeps every column it
 * had folded onto two lines with a hairline between, and the column headings go
 * with them because a labelled line does not need one. The `tfoot` becomes a final
 * row with a stronger top edge. A month with no data is **one** dim line rather
 * than two, since there is nothing to put on the second.
 *
 * **The grids collapse.** `.g-2-1` (the categories table beside its donut) becomes
 * donut first and then the list inside one card, exactly as Invest's allocation
 * does; `.g-3` and the extremes' `.g-2` go full width and stack.
 *
 * **Every `var(--…)` became `t.c.*`.** `react-native-svg` resolves no custom
 * properties, so the two cashflow series, the net-worth sparkline and every dot
 * take real colours from the theme.
 */

import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import type { TextStyle, ViewStyle } from "react-native";

import { DonutChart, LineChart, Sparkline } from "@/components/charts";
import { YearNav } from "@/components/filters";
import { Screen } from "@/components/Screen";
import { Banner, Card, Dot, EmptyState, LinkButton, PageHead, StatTile } from "@/components/ui";
import {
  fmtDate,
  fmtMonthShort,
  monthsOfYear,
  thisMonth,
  thisYear,
  yearBounds,
  yearOf,
  type MonthKey,
} from "@/lib/date";
import { useLive } from "@/lib/live";
import { fmt, fmtCompact, fmtSigned, fmtWhole, pct } from "@/lib/money";
import { goalFundingByMonth, goalFundingRecent, listGoals } from "@/lib/queries/goals";
import { allAssetContributions, netWorthByMonth } from "@/lib/queries/holdings";
import {
  cashflowByMonth,
  categoryTotalsSince,
  dataSpan,
  largestExpensesBetween,
} from "@/lib/queries/stats";
import type { GoalRow } from "@/lib/types";
import { useStyles, useTheme, type Theme } from "@/theme/ThemeProvider";
import { font, radius, space, tnum, weight } from "@/theme/tokens";

/** Wide enough for any real statement, narrow enough that `?year=0` cannot reach SQL. */
const FIRST_YEAR = 1970;

/** The colour a category with no category gets — the same grey the queries COALESCE to. */
const NO_COLOUR = "#80868B";

/* ---------------------------------------------------------------- the reads */

type Loaded = {
  year: number;
  /** Captured once, in JS, so every "is this month finished" test below agrees. */
  current: MonthKey;
  inProgress: boolean;
  flow: Awaited<ReturnType<typeof cashflowByMonth>>;
  cats: Awaited<ReturnType<typeof categoryTotalsSince>>;
  goalFlow: Awaited<ReturnType<typeof goalFundingByMonth>>;
  goalRecent: Awaited<ReturnType<typeof goalFundingRecent>>;
  goals: Awaited<ReturnType<typeof listGoals>>;
  assetContribs: Awaited<ReturnType<typeof allAssetContributions>>;
  netPoints: Awaited<ReturnType<typeof netWorthByMonth>>;
  biggest: Awaited<ReturnType<typeof largestExpensesBetween>>;
  span: Awaited<ReturnType<typeof dataSpan>>;
};

async function load(year: number): Promise<Loaded> {
  const { start, end } = yearBounds(year);

  const [flow, cats, goalFlow, goalRecent, goals, assetContribs, netPoints, biggest, span] =
    await Promise.all([
      cashflowByMonth(start, end),
      categoryTotalsSince(start, end),
      goalFundingByMonth(start, end),
      goalFundingRecent(start, end),
      // Archived goals included: money you put into a goal you have since closed
      // still left your account this year, and a nameless row would be a mystery.
      listGoals(true),
      allAssetContributions(),
      netWorthByMonth(`${year}-01`, `${year}-12`),
      largestExpensesBetween(start, end, 8),
      dataSpan(),
    ]);

  return {
    year,
    current: thisMonth(),
    inProgress: year === thisYear(),
    flow,
    cats,
    goalFlow,
    goalRecent,
    goals,
    assetContribs,
    netPoints,
    biggest,
    span,
  };
}

/* -------------------------------------------------------------- the screen */

/** A param can legitimately arrive twice; the first spelling of it wins. */
function str(v: string | string[] | undefined): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return "";
}

export default function YearScreen() {
  const params = useLocalSearchParams();

  // Exactly the web's guard, and for the same reason: `YearNav` has no lower bound,
  // so stepping back far enough — or hand-editing the param — must not reach SQL
  // with nonsense. Four digits, no earlier than 1970, no later than next year.
  const asked = str(params.year);
  const n = Number(asked);
  const valid = /^\d{4}$/.test(asked) && n >= FIRST_YEAR && n <= thisYear() + 1;
  const year = valid ? n : thisYear();

  const live = useLive(() => load(year), [year]);

  return (
    <>
      <Stack.Screen options={{ title: "Year" }} />
      <Screen live={live}>{(data) => <Body data={data} />}</Screen>
    </>
  );
}

function Body({ data }: { data: Loaded }) {
  const t = useTheme();
  const s = useStyles(styles);
  const {
    year,
    current,
    inProgress,
    flow,
    cats,
    goalFlow,
    goalRecent,
    goals,
    assetContribs,
    netPoints,
    biggest,
    span,
  } = data;

  /* ------------------------------------------------------------- cashflow */

  const income = flow.reduce((a, f) => a + f.income_minor, 0);
  const expense = flow.reduce((a, f) => a + f.expense_minor, 0);
  const net = income - expense;
  const savingsRate = income > 0 ? pct(net, income) : null;

  const byMonth = new Map(flow.map((f) => [f.month, f]));
  const months = monthsOfYear(year);

  // Complete months only — and in the current year, nothing past today either:
  // plotting Nov and Dec as zero would draw a cliff that has not happened.
  const plotted = inProgress ? months.filter((m) => m <= current) : months;

  const complete = flow.filter((f) => f.month < current);
  const basis = complete.length ? complete : flow;
  const avgOut = basis.length
    ? Math.round(basis.reduce((a, f) => a + f.expense_minor, 0) / basis.length)
    : 0;

  // One sorted array rather than the web's two: with `ranked` descending, the
  // heaviest is the head and the quietest is the tail, which cannot disagree with
  // each other the way two independent sorts of two filtered copies could.
  const spending = basis.filter((f) => f.expense_minor > 0);
  const ranked = [...spending].sort((a, b) => b.expense_minor - a.expense_minor);
  const heaviest = ranked.length > 0 ? ranked[0] : null;
  const lightest = ranked.length > 1 ? ranked[ranked.length - 1] : null;

  /* ---------------------------------------------- goals, investing, worth */

  const intoGoals = goalFlow.reduce((a, g) => a + g.total_minor, 0);
  const goalName = new Map(goals.map((g) => [g.id, g]));
  const funded = [...goalRecent]
    .sort((a, b) => b.total_minor - a.total_minor)
    .map((r) => ({ ...r, goal: goalName.get(r.goal_id) }));

  // Filtered in JS rather than in SQL: this read already exists for the forecasts,
  // it is one row per contribution, and asking twelve times for one month each
  // would be twelve round trips to answer one question.
  const invested = assetContribs
    .filter((c) => yearOf(c.txn_date) === year)
    .reduce((a, c) => a + c.amount_minor, 0);

  const netSeries = inProgress ? netPoints.filter((p) => p.month <= current) : netPoints;
  const netOpen = netSeries.length ? netSeries[0].net_minor : 0;
  const netClose = netSeries.length ? netSeries[netSeries.length - 1].net_minor : 0;

  /* ------------------------------------------------------------- the body */

  const nothing =
    flow.length === 0 && intoGoals === 0 && invested === 0 && netSeries.length === 0;

  if (nothing) {
    // `first` and `last` come from min()/max() over the same rows, so they are null
    // together — hoisted and tested together rather than asserted, which is the one
    // place this file does not copy the web's `!`.
    const first = span.first;
    const last = span.last;
    const elsewhere = last ? yearOf(last) : null;

    return (
      <>
        <Head year={year} sub="Nothing recorded" />
        <Card>
          <EmptyState
            icon="calendar"
            title={`No activity in ${year}`}
            body={
              // dataSpan() counts bills only, so say bills: this very screen proves a
              // year can hold goal contributions and valuations and no bills at all.
              first && last
                ? `Nothing was logged in ${year}. Your bill history runs from ${fmtDate(first, { year: true })} to ${fmtDate(last, { year: true })}.`
                : "Nothing has been logged yet at all. Add a bill, or load sample data from Settings to see this page populated."
            }
            cta={
              // A push rather than a param change: `EmptyState`'s cta is an href, so
              // this stacks a second Year screen and the back gesture returns to the
              // empty one. Which is the honest behaviour for a suggestion — you asked
              // to look somewhere else, not to leave where you were.
              elsewhere !== null && elsewhere !== year
                ? {
                    href: { pathname: "/year", params: { year: String(elsewhere) } },
                    label: `Go to ${elsewhere}`,
                  }
                : { href: "/settings", label: "Open Settings" }
            }
          />
        </Card>
      </>
    );
  }

  /*
   * A year can be short of bills and still full of everything else. Goal
   * contributions and valuations reach a year further back than the bills in this
   * database, and they will for anyone who starts tracking net worth before they
   * start logging every purchase. Twelve blank cashflow rows stacked above real
   * goal totals reads as a broken screen rather than as an honest gap, so the
   * cashflow half is left out entirely when there is none of it.
   */
  const noBills = flow.length === 0;

  return (
    <>
      <Head
        year={year}
        sub={
          noBills
            ? "No bills recorded"
            : inProgress
              ? `Year to date · ${flow.length} month${flow.length === 1 ? "" : "s"} with data`
              : `${flow.length} month${flow.length === 1 ? "" : "s"} with data`
        }
      />

      <View style={s.stack}>
        {/* ------------------------------------- the headlines, or why there are none */}
        {noBills ? (
          <Banner tone="info" icon="info">
            <Text style={s.strong}>{`No bills were logged in ${year}.`}</Text>
            {" There is no income or spending to report, so the cashflow sections are " +
              "absent rather than empty. Everything below comes from goal contributions, " +
              "investments and valuations, which start earlier here than the bills do."}
          </Banner>
        ) : (
          <View style={s.factGrid}>
            <View style={s.fact}>
              <StatTile label="Came in" value={fmtCompact(income)} tone="green" icon="arrowDown" />
            </View>
            <View style={s.fact}>
              <StatTile label="Went out" value={fmtCompact(expense)} tone="blue" icon="arrowUp" />
            </View>
            <View style={s.fact}>
              <StatTile
                label="Kept"
                value={savingsRate === null ? "—" : `${savingsRate.toFixed(0)}%`}
                tone={net >= 0 ? "pos" : "neg"}
                sub={savingsRate === null ? "No income logged" : "of everything that came in"}
              />
            </View>
            <View style={s.fact}>
              <StatTile
                label="Net"
                value={fmtSigned(net)}
                tone={net >= 0 ? "pos" : "neg"}
                sub={avgOut > 0 ? `${fmtCompact(avgOut)} out in a typical month` : undefined}
              />
            </View>
          </View>
        )}

        {!noBills && inProgress ? (
          <Banner tone="info" icon="info">
            <Text style={s.strong}>{`${year} is still running.`}</Text>
            {` The totals above are the year so far. Averages and the heaviest and quietest months below are worked out over ${basis.length} complete month${basis.length === 1 ? "" : "s"}, so the month in progress cannot flatter or spoil them.`}
          </Banner>
        ) : null}

        {/* ---------------------------------------------------- month by month */}
        {!noBills ? (
          <Card title="Income and outgo" note={`Every month of ${year}, paid bills only`}>
            <LineChart
              series={[
                {
                  points: plotted.map((m) => byMonth.get(m)?.income_minor ?? 0),
                  color: t.c.green,
                  fill: true,
                },
                {
                  points: plotted.map((m) => byMonth.get(m)?.expense_minor ?? 0),
                  color: t.c.blue,
                  fill: true,
                },
              ]}
              labels={plotted.map(fmtMonthShort)}
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
        ) : null}

        {!noBills ? (
          <Card
            title="Month by month"
            note="A blank row is a month with nothing recorded, not a month with no spending"
          >
            {months.map((m, i) => (
              <MonthRow
                key={m}
                month={m}
                row={byMonth.get(m) ?? null}
                current={current}
                yearExpense={expense}
                first={i === 0}
              />
            ))}

            {/* The web's `tfoot`: the same two lines, a heavier top edge, and no tap
                target, because the total of twelve months is not itself a month. */}
            <View style={[s.row, s.rowTotal]}>
              <View style={s.rowBetween}>
                <Text style={s.rowTitleStrong}>{year}</Text>
                <Text style={[s.rowAmountStrong, net >= 0 ? s.pos : s.neg]}>{fmtSigned(net)}</Text>
              </View>
              <View style={s.rowBetween}>
                <Text style={s.rowMeta}>{`${fmt(income)} in · ${fmt(expense)} out`}</Text>
                <Text style={s.rowMeta}>100% of the year</Text>
              </View>
            </View>
          </Card>
        ) : null}

        {/* ------------------------------------------------------ where it went */}
        {cats.length > 0 ? (
          <Card title="Where it went" note={`${cats.length} categories across ${year}`}>
            <View style={s.donutWrap}>
              <DonutChart
                slices={cats.slice(0, 8).map((c) => ({
                  label: c.name,
                  value: c.total_minor,
                  color: c.color,
                }))}
                centreLabel="Out"
                centreValue={fmtCompact(expense)}
              />
            </View>

            {cats.map((c, i) => (
              <View key={c.name} style={[s.row, i === 0 ? null : s.rowSep]}>
                <View style={s.rowBetween}>
                  <View style={s.dotRow}>
                    <Dot color={c.color} />
                    <Text style={s.rowTitle} numberOfLines={1}>
                      {c.name}
                    </Text>
                  </View>
                  <Text style={s.rowAmount}>{fmt(c.total_minor)}</Text>
                </View>
                <View style={s.rowBetween}>
                  <Text style={s.rowMeta}>
                    {expense > 0 ? `${pct(c.total_minor, expense).toFixed(0)}% of the year` : "—"}
                  </Text>
                  {/* Divided by the months this category actually appeared in, not by
                      twelve: a school fee paid in two months is not a sixth of itself
                      every month. */}
                  <Text style={s.rowMeta}>
                    {`${fmtWhole(Math.round(c.total_minor / Math.max(c.months, 1)))} a month · ${c.months} mo`}
                  </Text>
                </View>
              </View>
            ))}
          </Card>
        ) : null}

        {/* ------------------------------------- goals, investing, net worth */}
        <Card title="Into goals">
          <StatTile
            label={
              funded.length
                ? `${funded.length} goal${funded.length === 1 ? "" : "s"} funded`
                : "Nothing set aside"
            }
            value={fmtCompact(intoGoals)}
            size="xl"
            tone="green"
            sub={
              goalFlow.length
                ? `Across ${goalFlow.length} month${goalFlow.length === 1 ? "" : "s"}`
                : "No contributions this year"
            }
          />
          {funded.length > 0 ? (
            <View style={s.goalList}>
              {funded.slice(0, 4).map((r) => (
                <FundedGoalRow key={r.goal_id} row={r} />
              ))}
            </View>
          ) : null}
        </Card>

        <Card title="Invested">
          <StatTile
            label="Put into holdings"
            value={fmtCompact(invested)}
            size="xl"
            tone="amber"
            sub="Assets only — money drawn on a loan is not money put away"
          />
          <View style={s.tileBelow}>
            <StatTile
              label="Set aside in total"
              value={fmtCompact(intoGoals + invested)}
              size="sm"
              sub={
                income > 0 ? `${pct(intoGoals + invested, income).toFixed(0)}% of income` : undefined
              }
            />
          </View>
        </Card>

        <Card
          title="Net worth"
          note={
            netSeries.length
              ? `${fmtMonthShort(netSeries[0].month)} → ${fmtMonthShort(netSeries[netSeries.length - 1].month)}`
              : undefined
          }
        >
          {netSeries.length > 1 ? (
            <>
              <StatTile
                label="At the end"
                value={fmtCompact(netClose)}
                size="xl"
                tone={netClose >= 0 ? "pos" : "neg"}
                // The web wrapped "· from ₹…" in a `.dim` span inside the sub. Here the
                // whole sub is already `text3`, so that span would be a no-op — and a
                // node `sub` would have to carry its own `<Text>` to survive `slot()`.
                sub={`${fmtSigned(netClose - netOpen)} over the year · from ${fmtCompact(netOpen)}`}
              />
              <View style={s.sparkWrap}>
                <Sparkline
                  points={netSeries.map((p) => p.net_minor)}
                  color={netClose >= netOpen ? t.c.green : t.c.red}
                  width={240}
                  height={54}
                />
              </View>
            </>
          ) : (
            <StatTile
              label="Not enough valuations"
              value="—"
              size="xl"
              sub="Value a holding at least twice in a year and the line appears"
            />
          )}
        </Card>

        {/* ----------------------------------------------------------- extremes */}
        {/* Two cards only once there are two months to tell apart: with one month of
            spending the heaviest and the quietest are the same month, and printing
            it twice under opposite headings is a chart lying to you. */}
        {heaviest ? (
          <Card title="Heaviest month" note={inProgress ? "Complete months only" : undefined}>
            <StatTile
              label={fmtMonthShort(heaviest.month)}
              value={fmtCompact(heaviest.expense_minor)}
              size="xl"
              tone="neg"
              sub={
                avgOut > 0
                  ? `${(pct(heaviest.expense_minor, avgOut) - 100).toFixed(0)}% above a typical month`
                  : undefined
              }
            />
          </Card>
        ) : null}

        {lightest ? (
          <Card title="Quietest month" note={inProgress ? "Complete months only" : undefined}>
            <StatTile
              label={fmtMonthShort(lightest.month)}
              value={fmtCompact(lightest.expense_minor)}
              size="xl"
              tone="pos"
              sub={
                avgOut > 0
                  ? `${(100 - pct(lightest.expense_minor, avgOut)).toFixed(0)}% below a typical month`
                  : undefined
              }
            />
          </Card>
        ) : null}

        {biggest.length > 0 ? (
          <Card title={`The biggest single charges of ${year}`}>
            {biggest.map((b, i) => (
              <ChargeRow key={b.id} row={b} first={i === 0} />
            ))}
          </Card>
        ) : null}
      </View>
    </>
  );
}

function Head({ year, sub }: { year: number; sub: string }) {
  return (
    <PageHead title={String(year)} sub={sub}>
      <YearNav year={year} />
      <LinkButton href="/track" label="Month detail" icon="track" variant="outline" small />
    </PageHead>
  );
}

/* ----------------------------------------------------------------- the rows */

/**
 * One month of the twelve.
 *
 * A month with no rows is a single dim line rather than two, because the web's four
 * em dashes existed to fill table cells and there are no cells here — a name with
 * nothing beside it already says "nothing happened", and a second line of dashes
 * would just make an empty year four screens long.
 *
 * The whole block is the link, not just the month name: a three-letter word is not
 * a touch target. It pushes Track rather than changing a param, because Track is a
 * different route — this is the drill-down the web's `/track?month=` was.
 */
function MonthRow({
  month,
  row,
  current,
  yearExpense,
  first,
}: {
  month: MonthKey;
  row: { income_minor: number; expense_minor: number; net_minor: number } | null;
  current: MonthKey;
  yearExpense: number;
  first: boolean;
}) {
  const s = useStyles(styles);
  const router = useRouter();

  if (!row) {
    return (
      <View style={[s.row, first ? null : s.rowSep]}>
        <View style={s.rowBetween}>
          <Text style={s.rowTitleDim}>{fmtMonthShort(month)}</Text>
          <Text style={s.rowMeta}>—</Text>
        </View>
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${fmtMonthShort(month)} ${month.slice(0, 4)} in detail`}
      onPress={() => router.push({ pathname: "/track", params: { month } })}
      style={({ pressed }) => [
        s.row,
        first ? null : s.rowSep,
        pressed ? s.rowPressed : null,
      ]}
    >
      <View style={s.rowBetween}>
        <Text style={s.rowTitle}>
          {fmtMonthShort(month)}
          {month === current ? <Text style={s.rowMeta}> · in progress</Text> : null}
        </Text>
        <Text style={[s.rowAmount, row.net_minor >= 0 ? s.pos : s.neg]}>
          {fmtSigned(row.net_minor)}
        </Text>
      </View>
      <View style={s.rowBetween}>
        <Text style={s.rowMeta}>
          {`${row.income_minor ? fmt(row.income_minor) : "—"} in · ${fmt(row.expense_minor)} out`}
        </Text>
        <Text style={s.rowMeta}>
          {yearExpense > 0 ? `${pct(row.expense_minor, yearExpense).toFixed(0)}% of the year` : "—"}
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * A goal that was funded this year.
 *
 * `goal` is undefined when the contribution outlived the goal it was for — the
 * query is deliberately unfiltered, so a deleted goal's money still shows up and
 * says what it is rather than vanishing from the year's total.
 */
function FundedGoalRow({
  row,
}: {
  row: { goal_id: number; total_minor: number; goal: GoalRow | undefined };
}) {
  const s = useStyles(styles);
  const router = useRouter();

  // A `const` rather than `row.goal!` at the two sites that need it non-null: the
  // guard below narrows this binding for good, where a property access would have to
  // be re-proved. Same reason Home hoists `d.waiting`.
  const goal = row.goal;

  const body = (
    <>
      <View style={s.dotRow}>
        <Dot color={goal?.color ?? NO_COLOUR} />
        <Text style={goal ? s.goalName : s.goalNameGone} numberOfLines={1}>
          {goal ? goal.name : "Deleted goal"}
          {goal?.archived ? <Text style={s.rowMeta}> · archived</Text> : null}
        </Text>
      </View>
      <Text style={s.goalAmount}>{fmtWhole(row.total_minor)}</Text>
    </>
  );

  if (!goal) return <View style={s.goalRow}>{body}</View>;

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={goal.name}
      onPress={() => router.push({ pathname: "/goal/[id]", params: { id: String(row.goal_id) } })}
      style={({ pressed }) => [s.goalRow, pressed ? s.rowPressed : null]}
    >
      {body}
    </Pressable>
  );
}

/** One of the year's biggest charges. The merchant was a `<Link>`; the block is it here. */
function ChargeRow({
  row,
  first,
}: {
  row: Awaited<ReturnType<typeof largestExpensesBetween>>[number];
  first: boolean;
}) {
  const s = useStyles(styles);
  const router = useRouter();

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={row.merchant}
      onPress={() => router.push({ pathname: "/bill/[id]", params: { id: String(row.id) } })}
      style={({ pressed }) => [
        s.row,
        first ? null : s.rowSep,
        pressed ? s.rowPressed : null,
      ]}
    >
      <View style={s.rowBetween}>
        <Text style={s.rowTitle} numberOfLines={1}>
          {row.merchant}
        </Text>
        <Text style={s.rowAmount}>{fmt(row.amount_minor)}</Text>
      </View>
      <Text style={s.rowMeta}>
        {`${row.name ?? "Uncategorised"} · ${fmtDate(row.txn_date, { year: false })}`}
      </Text>
    </Pressable>
  );
}

/* -------------------------------------------------------------- the styles */

const styles = (t: Theme) => ({
  stack: { gap: space.gap + 4 } as ViewStyle,

  // `.grid.g-4`, wrapped — four figures two-up, bare rather than in four cards,
  // which is what `invest.tsx` does with the same grid for the same reason.
  factGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    rowGap: space.gap + 4,
    columnGap: space.gap,
  } as ViewStyle,
  fact: { width: "47%" } as ViewStyle,

  strong: { fontWeight: weight.medium } as TextStyle,

  // `.row` with a centred `gap: 20`, under the chart.
  legend: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 20,
    marginTop: 14,
  } as ViewStyle,
  legendItem: { flexDirection: "row", alignItems: "center", gap: 8 } as ViewStyle,
  legendLabel: { ...font.small, color: t.c.text } as TextStyle,

  // The web's `.g-2-1` put the donut beside the table; here it goes above the list.
  donutWrap: { alignItems: "center", marginBottom: space.gap + 4 } as ViewStyle,

  // A table row, folded onto two lines. Same geometry as Track's.
  row: {
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderRadius: radius.sm,
    gap: 4,
  } as ViewStyle,
  rowSep: { borderTopWidth: 1, borderTopColor: t.c.borderSoft } as ViewStyle,
  // The `tfoot` rule: the full border rather than the hairline, so the total reads
  // as a total and not as a thirteenth month.
  rowTotal: { borderTopWidth: 1, borderTopColor: t.c.border, marginTop: 2 } as ViewStyle,
  rowPressed: { backgroundColor: t.c.surface2 } as ViewStyle,

  rowBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  } as ViewStyle,
  dotRow: { flexDirection: "row", alignItems: "center", gap: 9, flexShrink: 1 } as ViewStyle,

  rowTitle: { ...font.entryTitle, color: t.c.text, flexShrink: 1 } as TextStyle,
  rowTitleDim: { ...font.entryTitle, color: t.c.text3 } as TextStyle,
  rowTitleStrong: {
    ...font.entryTitle,
    fontWeight: weight.medium,
    color: t.c.text,
  } as TextStyle,
  rowAmount: { ...font.entryAmount, ...tnum, color: t.c.text } as TextStyle,
  rowAmountStrong: {
    ...font.entryAmount,
    ...tnum,
    fontWeight: weight.medium,
    color: t.c.text,
  } as TextStyle,
  rowMeta: { ...font.small, color: t.c.text3 } as TextStyle,
  pos: { color: t.c.green } as TextStyle,
  neg: { color: t.c.red } as TextStyle,

  // The funded-goal list under the "Into goals" tile — `.col` at `gap: 10`.
  goalList: { gap: 10, marginTop: 18 } as ViewStyle,
  goalRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    minHeight: 44,
  } as ViewStyle,
  goalName: { ...font.small, color: t.c.blue, flexShrink: 1 } as TextStyle,
  goalNameGone: { ...font.small, color: t.c.text3, flexShrink: 1 } as TextStyle,
  goalAmount: { ...font.small, ...tnum, color: t.c.text2 } as TextStyle,

  // The web's two `marginTop: 18` wrappers.
  tileBelow: { marginTop: 18 } as ViewStyle,
  sparkWrap: { marginTop: 18 } as ViewStyle,
});
