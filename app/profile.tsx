/**
 * Profile — the standing totals, where Fit puts your body measurements.
 * `Finance/src/app/profile/page.tsx`.
 *
 * The web page's reasoning holds unchanged: everything else in the app is about this
 * month, and this is the only screen that answers "where am I, overall" — net worth
 * now and over the last year, what the whole record adds up to, and whether the three
 * monthly targets are set at levels you actually hit. **Nothing here is editable.**
 * Every figure is derived in `lib/queries/*`; this file contains no SQL and no writes,
 * and the targets are changed in Settings, which the header links to.
 *
 * Five shapes changed.
 *
 * **Four grids became one column.** `.g-hero`, `.g-2`, `.g-4` and `.g-2-1` are all
 * multi-column desktop layouts. Cards stack; the tile groups inside them use the
 * same wrapping two-up grid the rest of the port uses (`s.grid` + `Cell` at 47%),
 * which is what those grids collapsed to under their own `@media` rules anyway.
 *
 * **`SLICE` became a function of the theme.** The web's donut rotation was six
 * `var(--…)` strings; `react-native-svg` resolves no custom properties, so
 * `slicePalette(t)` hands `DonutChart` six real colours and picks up dark mode for
 * free. Same substitution for the two `ProgressBar` colours, the three `TargetRow`
 * colours and the net-worth line.
 *
 * **The empty-state banner names Settings instead of linking to it.** On the web the
 * sentence carried an inline underlined `<Link>`. `Banner` here wraps its children in
 * exactly one `<Text>`, so a nested `<Text>` is free and a nested `<Link>` is not —
 * and nothing else in this port underlines inline text, so there is no precedent to
 * follow. The destination is already one tap away in the header, which is the better
 * place for it on a phone: a 13px underlined word inside a paragraph is a poor target.
 *
 * **The goal rows are tappable blocks.** The web wrapped each in a `<Link>`; here it
 * is the same `Pressable` the Goals and Invest lists use, pushing the typed route.
 * The order `listGoals()` returns is kept — archived last, then target date — because
 * its own contract says consumers must not re-sort. The holdings in `Composition`
 * *are* re-sorted, deliberately: that donut is ranked by value.
 *
 * **Every `!` is gone.** There is no `noUncheckedIndexedAccess` here, so `series[0]`,
 * `ranked[0]` and `SLICE[i % SLICE.length]` need no assertion. The one that was doing
 * real work — `g.target_date!` beside `requiredPerMonthMinor` — becomes an explicit
 * `&& g.target_date`, which changes the reading only in a case `computePace` cannot
 * produce (there is no required-per-month without a deadline).
 */

import { Stack, useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import type { TextStyle, ViewStyle } from "react-native";

import { DonutChart, Legend, LineChart, type Series } from "@/components/charts";
import { Screen } from "@/components/Screen";
import {
  Banner, Card, Chip, Dot, EmptyState, IconTile, LinkButton, PageHead, ProgressBar,
  SeeAll, StatTile,
} from "@/components/ui";
import { fmtDate, fmtMonth, fmtMonthShort, thisMonth, type MonthKey } from "@/lib/date";
import { useLive } from "@/lib/live";
import { fmtCompact, fmtWhole, pct } from "@/lib/money";
import { computePace, PACE_LABEL, PACE_TONE } from "@/lib/pace";
import { goalFundedInMonth, listGoals } from "@/lib/queries/goals";
import {
  investedInMonth, listHoldings, netWorthNow, netWorthSeries,
} from "@/lib/queries/holdings";
import { getSettings } from "@/lib/queries/settings";
import { dataSpan, lifetimeTotals, overallBudget, spentInMonth } from "@/lib/queries/stats";
import { ASSET_TYPE_LABEL, type GoalRow, type HoldingRow, type Settings } from "@/lib/types";
import { useStyles, useTheme, type Theme } from "@/theme/ThemeProvider";
import { font, radius, space, tnum, weight } from "@/theme/tokens";

type NetPoint = {
  month: MonthKey;
  assets_minor: number;
  liabilities_minor: number;
  net_minor: number;
};

type Loaded = {
  settings: Settings;
  month: MonthKey;
  net: {
    assets_minor: number;
    liabilities_minor: number;
    net_minor: number;
    invested_minor: number;
  };
  series: NetPoint[];
  life: Awaited<ReturnType<typeof lifetimeTotals>>;
  span: Awaited<ReturnType<typeof dataSpan>>;
  goals: GoalRow[];
  holdings: HoldingRow[];
  spent: number;
  budget: number;
  goalFunded: number;
  invested: number;
};

/**
 * Settings is read first and on its own: the month-start day and the budget fallback
 * are both inputs to four of the ten reads below.
 */
async function load(): Promise<Loaded> {
  const settings = await getSettings();
  const month = thisMonth();
  const startDay = settings.month_start_day;

  const [net, series, life, span, goals, holdings, spent, budget, goalFunded, invested] =
    await Promise.all([
      netWorthNow(),
      netWorthSeries(12),
      lifetimeTotals(),
      dataSpan(),
      listGoals(),
      listHoldings(),
      spentInMonth(month, startDay),
      overallBudget(month, settings.monthly_budget_minor),
      goalFundedInMonth(month, startDay),
      investedInMonth(month, startDay),
    ]);

  return {
    settings, month, net, series, life, span, goals, holdings,
    spent, budget, goalFunded, invested,
  };
}

export default function ProfileScreen() {
  const live = useLive(load);

  return (
    <>
      <Stack.Screen options={{ title: "Profile" }} />
      <Screen live={live}>{(data) => <Inner data={data} />}</Screen>
    </>
  );
}

function Inner({ data }: { data: Loaded }) {
  const s = useStyles(styles);
  const { settings, span, goals, holdings } = data;

  const nothingYet = span.months === 0 && holdings.length === 0 && goals.length === 0;

  return (
    <>
      <PageHead
        title={
          settings.display_name && settings.display_name !== "You"
            ? settings.display_name
            : "Your profile"
        }
        sub={
          span.first
            ? `Tracking since ${fmtDate(span.first, { year: true })} · ${span.months} month${
                span.months === 1 ? "" : "s"
              } of records`
            : "Nothing logged yet"
        }
      >
        <LinkButton href="/track" label="Analytics" icon="track" variant="outline" small />
        <LinkButton href="/settings" label="Settings" icon="settings" variant="outline" small />
      </PageHead>

      <View style={s.stack}>
        {nothingYet ? (
          <Banner tone="info" icon="sparkle">
            <Text style={s.strong}>This page fills itself in.</Text>
            {" Log a bill, add a holding with a value, or load a month of sample data from " +
              "Settings — every figure below is derived, so none of it needs entering twice."}
          </Banner>
        ) : null}

        <Hero data={data} />
        <History data={data} />
        <Numbers data={data} />
        <Targets data={data} />
        <Owned data={data} />
        <Goals data={data} />
      </View>
    </>
  );
}

/** A 47%-wide cell in the wrapping two-up grid. Two per line, with room for the gap. */
function Cell({ children }: { children: React.ReactNode }) {
  const s = useStyles(styles);
  return <View style={s.cell}>{children}</View>;
}

/**
 * This month's movement in net worth, measured against the second-to-last point in
 * the series — the last closed month. Null when there is no earlier month to compare.
 */
function netMove(now: number, series: NetPoint[]): { prev: number | null; delta: number | null } {
  const prev = series.length > 1 ? series[series.length - 2].net_minor : null;
  return { prev, delta: prev === null ? null : now - prev };
}

// ===================================================================== net worth

function Hero({ data }: { data: Loaded }) {
  const s = useStyles(styles);
  const t = useTheme();
  const { net, holdings, series } = data;

  const { prev, delta } = netMove(net.net_minor, series);
  const assets = holdings.filter((h) => h.side === "asset");
  const debts = holdings.filter((h) => h.side === "liability");

  return (
    <Card>
      <StatTile
        label="Net worth"
        value={fmtWhole(net.net_minor)}
        size="xl"
        tone={net.net_minor < 0 ? "neg" : undefined}
        sub={
          <View style={s.chipRow}>
            {delta !== null ? (
              <Chip
                tone={delta === 0 ? "neutral" : delta > 0 ? "good" : "bad"}
                icon={delta > 0 ? "arrowUp" : delta < 0 ? "arrowDown" : undefined}
              >
                {`${fmtCompact(Math.abs(delta))}${
                  prev ? ` · ${Math.abs(pct(delta, Math.abs(prev))).toFixed(1)}%` : ""
                } this month`}
              </Chip>
            ) : null}
            <Chip tone="neutral" icon="bank">
              {`${assets.length} holding${assets.length === 1 ? "" : "s"}${
                debts.length ? `, ${debts.length} debt${debts.length === 1 ? "" : "s"}` : ""
              }`}
            </Chip>
          </View>
        }
      />

      <View style={[s.grid, s.gridSpaced]}>
        <Cell>
          <StatTile
            label="You own"
            value={fmtWhole(net.assets_minor)}
            size="sm"
            tone="pos"
            sub={
              net.invested_minor > 0
                ? `${fmtCompact(net.invested_minor)} of it is money you put in`
                : "no contributions recorded"
            }
          />
        </Cell>
        <Cell>
          <StatTile
            label="You owe"
            value={fmtWhole(net.liabilities_minor)}
            size="sm"
            tone={net.liabilities_minor > 0 ? "neg" : undefined}
            sub={
              net.assets_minor > 0 && net.liabilities_minor > 0
                ? `${pct(net.liabilities_minor, net.assets_minor).toFixed(0)}% of what you own`
                : net.liabilities_minor === 0
                  ? "nothing outstanding"
                  : "no assets recorded yet"
            }
          />
        </Cell>
      </View>

      {net.assets_minor > 0 ? (
        <View style={s.gearing}>
          <View style={s.rowBetween}>
            <Text style={s.muted}>Owed against owned</Text>
            <Text style={s.mutedNum}>
              {`${pct(net.liabilities_minor, net.assets_minor).toFixed(0)}%`}
            </Text>
          </View>
          <ProgressBar
            value={net.liabilities_minor / net.assets_minor}
            color={net.liabilities_minor > net.assets_minor * 0.5 ? t.c.red : t.c.amber}
            height={8}
          />
          <Text style={s.note}>
            {net.liabilities_minor === 0
              ? "Debt-free on everything you've recorded."
              : "The share of what you own that is borrowed. Lower is more of it yours."}
          </Text>
        </View>
      ) : null}
    </Card>
  );
}

function History({ data }: { data: Loaded }) {
  const { series, holdings } = data;

  return (
    <Card
      title="Net worth over time"
      note="Value at each month end, closed holdings excluded"
      action={<SeeAll href="/invest" />}
    >
      {series.length < 2 ? (
        <EmptyState
          icon="bank"
          title="Not enough history yet"
          body="Net worth is drawn from your value snapshots. Record a second one in a different month and this becomes a line."
          cta={
            holdings.length
              ? {
                  // `EmptyState`'s `cta.href` is a `LinkTarget`, so the web's
                  // `/invest/${id}` ports as the typedRoutes object form rather than
                  // degrading to the "add a holding" route.
                  href: { pathname: "/holding/[id]", params: { id: String(holdings[0].id) } },
                  label: "Record a value",
                }
              : { href: "/holding/new", label: "Add a holding" }
          }
        />
      ) : (
        <Trend data={data} />
      )}
    </Card>
  );
}

/** The line and the three readings under it. Only ever rendered with two-plus points. */
function Trend({ data }: { data: Loaded }) {
  const s = useStyles(styles);
  const t = useTheme();
  const { series, net } = data;

  const { delta } = netMove(net.net_minor, series);
  const first = series[0];
  const best = bestMove(series);
  const peak = Math.max(...series.map((p) => p.net_minor));

  const lines: Series[] = [
    {
      points: series.map((p) => p.net_minor),
      color: delta !== null && delta < 0 ? t.c.red : t.c.green,
      fill: true,
      label: "Net worth",
    },
  ];

  return (
    <>
      {/* `yZero={false}`: net worth rarely starts near zero, and forcing the axis
          there flattens a year of change into a straight line. */}
      <LineChart
        series={lines}
        labels={series.map((p) => fmtMonthShort(p.month))}
        height={232}
        yZero={false}
      />

      <View style={[s.grid, s.gridSpaced]}>
        <Cell>
          <StatTile
            label={`Since ${fmtMonth(first.month)}`}
            value={fmtCompact(net.net_minor - first.net_minor)}
            size="sm"
            tone={net.net_minor >= first.net_minor ? "pos" : "neg"}
            sub={`over ${series.length} month${series.length === 1 ? "" : "s"}`}
          />
        </Cell>
        <Cell>
          <StatTile
            label="Best month"
            value={fmtCompact(best.delta)}
            size="sm"
            tone="pos"
            sub={fmtMonth(best.month)}
          />
        </Cell>
        <Cell>
          <StatTile
            label="Highest it's been"
            value={fmtCompact(peak)}
            size="sm"
            sub={peak === net.net_minor ? "that's today" : "an earlier month"}
          />
        </Cell>
      </View>
    </>
  );
}

/** The biggest month-on-month rise in the series, for the "best month" tile. */
function bestMove(series: NetPoint[]): { month: MonthKey; delta: number } {
  let best = { month: series[0].month, delta: 0 };
  for (let i = 1; i < series.length; i++) {
    const delta = series[i].net_minor - series[i - 1].net_minor;
    if (delta > best.delta) best = { month: series[i].month, delta };
  }
  return best;
}

// ================================================================== the lifetime

function Numbers({ data }: { data: Loaded }) {
  const s = useStyles(styles);
  const { life, span, goals, holdings, net } = data;

  const assets = holdings.filter((h) => h.side === "asset");

  // Income is optional in this app — plenty of people only log what goes out. Every
  // rate below is therefore nullable rather than quietly dividing by zero.
  const kept = life.income_minor - life.expense_minor;
  const savedRate = life.income_minor > 0 ? kept / life.income_minor : null;
  const putAway = life.goal_saved_minor + life.contributed_minor;
  const putAwayRate = life.income_minor > 0 ? putAway / life.income_minor : null;
  const perMonth = span.months > 0 ? Math.round(life.expense_minor / span.months) : null;

  return (
    <Card
      title="Your numbers"
      note={
        span.first && span.last
          ? `Everything logged between ${fmtDate(span.first, { year: true })} and ${fmtDate(
              span.last,
              { year: true },
            )}`
          : "All time"
      }
    >
      <View style={s.grid}>
        <Cell>
          <StatTile
            label="Bills logged"
            value={String(life.bills)}
            size="sm"
            icon="journal"
            sub={
              life.attachments
                ? `${life.attachments} file${life.attachments === 1 ? "" : "s"} attached`
                : "no receipts attached yet"
            }
          />
        </Cell>
        <Cell>
          <StatTile
            label="Money out"
            value={fmtCompact(life.expense_minor)}
            size="sm"
            icon="arrowDown"
            sub={
              perMonth === null
                ? "no months recorded"
                : `${fmtCompact(perMonth)} a month on average`
            }
          />
        </Cell>
        <Cell>
          <StatTile
            label="Money in"
            value={life.income_minor ? fmtCompact(life.income_minor) : "—"}
            size="sm"
            icon="arrowUp"
            sub={life.income_minor ? "income you logged" : "log income to unlock the rates"}
          />
        </Cell>
        <Cell>
          <StatTile
            label="Kept"
            value={life.income_minor ? fmtCompact(kept) : "—"}
            size="sm"
            tone={!life.income_minor ? undefined : kept >= 0 ? "pos" : "neg"}
            icon="wallet"
            sub={
              savedRate === null
                ? "needs income logged"
                : `${(savedRate * 100).toFixed(0)}% of what came in`
            }
          />
        </Cell>
        <Cell>
          <StatTile
            label="Into goals"
            value={fmtCompact(life.goal_saved_minor)}
            size="sm"
            tone={life.goal_saved_minor > 0 ? "green" : undefined}
            icon="goals"
            sub={`across ${goals.length} goal${goals.length === 1 ? "" : "s"}`}
          />
        </Cell>
        <Cell>
          <StatTile
            label="Into investments"
            value={fmtCompact(life.contributed_minor)}
            size="sm"
            tone={life.contributed_minor > 0 ? "amber" : undefined}
            icon="invest"
            sub={`across ${assets.length} holding${assets.length === 1 ? "" : "s"}`}
          />
        </Cell>
        <Cell>
          <StatTile
            label="Put away"
            value={fmtCompact(putAway)}
            size="sm"
            icon="target"
            sub={
              putAwayRate === null
                ? "goals and investments together"
                : `${(putAwayRate * 100).toFixed(0)}% of what came in`
            }
          />
        </Cell>
        <Cell>
          <StatTile
            label="Gain on investments"
            value={net.invested_minor > 0 ? fmtCompact(net.assets_minor - net.invested_minor) : "—"}
            size="sm"
            tone={
              net.invested_minor === 0
                ? undefined
                : net.assets_minor >= net.invested_minor
                  ? "pos"
                  : "neg"
            }
            icon="sparkle"
            sub={
              net.invested_minor > 0
                ? `${fmtCompact(net.assets_minor)} worth on ${fmtCompact(net.invested_minor)} in`
                : "record what you put in"
            }
          />
        </Cell>
      </View>

      {/* "Put away" counts goal and holding contributions; "Kept" is income less
          expense. They answer different questions and will not agree — worth saying
          once rather than leaving as a discrepancy to be noticed. */}
      {life.income_minor > 0 ? (
        <Text style={s.note}>
          <Text style={s.strong}>Kept</Text>
          {" is income less expenses — what your bills say is left. "}
          <Text style={s.strong}>Put away</Text>
          {" is money you actually moved into a goal or a holding. The two differ by " +
            "whatever stayed in your current account."}
        </Text>
      ) : null}
    </Card>
  );
}

// =================================================================== the targets

function Targets({ data }: { data: Loaded }) {
  const s = useStyles(styles);
  const t = useTheme();
  const { settings, month, spent, budget, goalFunded, invested } = data;

  return (
    <Card
      title="This month against your targets"
      note={fmtMonth(month)}
      action={
        <LinkButton
          href="/settings"
          label="Adjust"
          iconAfter="chevronRight"
          variant="ghost"
          small
        />
      }
    >
      <View style={s.targetList}>
        <TargetRow
          icon="wallet"
          label="Spending"
          actual={spent}
          target={budget}
          color={spent > budget ? t.c.red : spent > budget * 0.85 ? t.c.amber : t.c.blue}
          over="over budget"
          under="left to spend"
          lowerIsBetter
        />
        <TargetRow
          icon="goals"
          label="Into goals"
          actual={goalFunded}
          target={settings.monthly_goal_target_minor}
          color={t.c.green}
          over="past the target"
          under="still to put away"
        />
        <TargetRow
          icon="invest"
          label="Into investments"
          actual={invested}
          target={settings.monthly_invest_target_minor}
          color={t.c.amber}
          over="past the target"
          under="still to contribute"
        />
      </View>

      <Text style={s.note}>
        These are the three rings on the home page. A target you beat every month is set
        too low to tell you anything — the point of the number is that it bites
        occasionally.
      </Text>
    </Card>
  );
}

/**
 * One target, its progress, and the gap in words.
 *
 * `lowerIsBetter` inverts only the reading, never the bar: the spending bar still
 * fills as you spend, because that is the fuel-gauge behaviour the rings use. What
 * changes is whether a full bar is congratulated or flagged.
 */
function TargetRow({
  icon,
  label,
  actual,
  target,
  color,
  over,
  under,
  lowerIsBetter = false,
}: {
  icon: "wallet" | "goals" | "invest";
  label: string;
  actual: number;
  target: number;
  color: string;
  over: string;
  under: string;
  lowerIsBetter?: boolean;
}) {
  const s = useStyles(styles);
  const gap = target - actual;
  const share = target > 0 ? actual / target : 0;

  return (
    <View style={s.target}>
      <View style={s.rowBetween}>
        <View style={s.targetLeft}>
          <IconTile color={color} icon={icon} size={30} />
          <Text style={s.targetLabel} numberOfLines={1}>
            {label}
          </Text>
          {target > 0 ? (
            <Chip
              tone={gap >= 0 ? (lowerIsBetter ? "good" : "neutral") : lowerIsBetter ? "bad" : "good"}
            >
              {share === 0 ? "nothing yet" : `${Math.round(share * 100)}%`}
            </Chip>
          ) : null}
        </View>
        <Text style={s.pair}>
          {fmtWhole(actual)}
          <Text style={s.pairDim}>{` / ${fmtWhole(target)}`}</Text>
        </Text>
      </View>

      <ProgressBar value={share} color={color} height={8} />

      <Text style={s.note}>
        {target <= 0
          ? "No target set — set one in Settings to get a reading."
          : gap >= 0
            ? `${fmtWhole(gap)} ${under}`
            : `${fmtWhole(-gap)} ${over}`}
      </Text>
    </View>
  );
}

// ================================================================= what you own

function Owned({ data }: { data: Loaded }) {
  const assets = data.holdings.filter((h) => h.side === "asset");

  return (
    <Card title="What you own" action={<SeeAll href="/invest" />}>
      {assets.length === 0 ? (
        <EmptyState
          icon="invest"
          title="No holdings yet"
          body="Add what you own — funds, deposits, gold, property — and net worth builds itself."
          cta={{ href: "/holding/new", label: "Add a holding" }}
        />
      ) : (
        <Composition holdings={assets} total={data.net.assets_minor} />
      )}
    </Card>
  );
}

/**
 * What the assets are made of, by holding rather than by asset type.
 *
 * Invest already breaks the portfolio down by type. The useful second cut is by the
 * individual thing, because concentration lives there: "equity 60%" hides one fund
 * being half of everything. Anything past the sixth largest is gathered into a single
 * slice rather than drawn as a sliver nobody can read.
 */
function Composition({ holdings, total }: { holdings: HoldingRow[]; total: number }) {
  const s = useStyles(styles);
  const t = useTheme();

  const valued = holdings.filter((h) => h.value_minor > 0);
  if (valued.length === 0) {
    return (
      <EmptyState
        icon="alert"
        title="Nothing valued yet"
        body="Your holdings are recorded but none has a value snapshot, so net worth counts them as zero."
      />
    );
  }

  const ranked = [...valued].sort((a, b) => b.value_minor - a.value_minor);
  const top = ranked.slice(0, 6);
  const rest = ranked.slice(6);
  const restTotal = rest.reduce((n, h) => n + h.value_minor, 0);

  const palette = slicePalette(t);
  const slices = top.map((h, i) => ({
    label: h.name,
    value: h.value_minor,
    color: palette[i % palette.length],
  }));
  if (restTotal > 0) {
    slices.push({ label: `${rest.length} more`, value: restTotal, color: t.c.text3 });
  }

  const biggest = ranked[0];

  return (
    <>
      <View style={s.donutWrap}>
        <DonutChart
          slices={slices}
          size={186}
          thickness={24}
          centreLabel="Assets"
          centreValue={fmtCompact(total)}
        />
      </View>

      <Legend items={slices} total={total} />

      <Text style={s.note}>
        {"Largest single holding: "}
        <Text style={s.strong}>{biggest.name}</Text>
        {` at ${pct(biggest.value_minor, total).toFixed(0)}% of everything you own (${
          ASSET_TYPE_LABEL[biggest.asset_type]
        }).`}
      </Text>
    </>
  );
}

/**
 * A fixed rotation rather than the per-type colours used on Invest: this donut is
 * sliced by holding, and two funds of the same type would otherwise be the same
 * colour and indistinguishable.
 */
function slicePalette(t: Theme): string[] {
  return [t.c.blue, t.c.teal, t.c.green, t.c.amber, t.c.purple, t.c.blueDim];
}

// ======================================================================== goals

function Goals({ data }: { data: Loaded }) {
  const s = useStyles(styles);
  const { goals } = data;

  return (
    <Card
      title={goals.length ? `Goals · ${goals.length}` : "Goals"}
      note="Every open goal, measured against a straight line to its target date"
      action={<SeeAll href="/goals" />}
    >
      {goals.length === 0 ? (
        <EmptyState
          icon="goals"
          title="No goals yet"
          body="A goal with an amount and a date gets you a pace reading and a required-per-month figure."
          cta={{ href: "/goal/new", label: "Create a goal" }}
        />
      ) : (
        <View style={s.goalList}>
          {goals.map((g) => (
            <GoalLine key={g.id} goal={g} />
          ))}
        </View>
      )}
    </Card>
  );
}

function GoalLine({ goal: g }: { goal: GoalRow }) {
  const s = useStyles(styles);
  const router = useRouter();

  const p = computePace({
    target_minor: g.target_minor,
    started_on: g.started_on,
    target_date: g.target_date,
    savedMinor: g.saved_minor,
  });

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${g.name} — ${PACE_LABEL[p.status]}`}
      onPress={() => router.push({ pathname: "/goal/[id]", params: { id: String(g.id) } })}
      style={({ pressed }) => [s.goal, pressed ? s.goalPressed : null]}
    >
      <View style={s.rowBetween}>
        <View style={s.goalLeft}>
          <Dot color={g.color} />
          <Text style={s.goalName} numberOfLines={1}>
            {g.name}
          </Text>
          <Chip tone={PACE_TONE[p.status]}>{PACE_LABEL[p.status]}</Chip>
        </View>
        <Text style={s.pairSm}>
          {fmtCompact(g.saved_minor)}
          <Text style={s.pairDim}>{` / ${fmtCompact(g.target_minor)}`}</Text>
        </Text>
      </View>

      <ProgressBar value={p.progress} color={g.color} height={8} />

      <Text style={s.note}>
        {/* `requiredPerMonthMinor` only exists when there is a deadline to divide by,
            so the second half of this condition is the web's `g.target_date!`. */}
        {p.requiredPerMonthMinor && g.target_date
          ? `${fmtCompact(p.requiredPerMonthMinor)}/month to finish by ${fmtDate(g.target_date)}`
          : p.status === "done"
            ? "Target reached"
            : p.projectedDate
              ? `On this pace, complete around ${fmtDate(p.projectedDate)}`
              : "Add a contribution to start the pace calculation"}
      </Text>
    </Pressable>
  );
}

const styles = (t: Theme) => ({
  // `.stack > * + * { margin-top: 20px }`.
  stack: { gap: space.gap + 4 } as ViewStyle,

  // The one grid every tile group on this page uses — `.g-2`, `.g-4` and the hero
  // pair all collapsed to two-up on a narrow viewport anyway.
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    rowGap: space.gap + 4,
    columnGap: space.gap,
  } as ViewStyle,
  /** The hero's `margin-top: 26px` and the trend tiles' `margin-top: 16px`, split. */
  gridSpaced: { marginTop: 22 } as ViewStyle,
  cell: { width: "47%" } as ViewStyle,

  rowBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.gapSm,
  } as ViewStyle,

  /** The hero's two chips, which wrap under the xl numeral. */
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6 } as ViewStyle,

  // `.small.muted` / `.small.dim` — the two note weights the page uses throughout.
  muted: { ...font.small, color: t.c.text2 } as TextStyle,
  mutedNum: { ...font.small, ...tnum, color: t.c.text2 } as TextStyle,
  note: { ...font.small, color: t.c.text3, marginTop: 8, lineHeight: 18 } as TextStyle,
  /** `<strong>` inside a note or a Banner, both of which set the colour themselves. */
  strong: { fontWeight: weight.medium } as TextStyle,

  // A `saved / target` pair, right-aligned, the dim half nested.
  pair: { ...font.small13, ...tnum, color: t.c.text } as TextStyle,
  pairSm: { ...font.small, ...tnum, color: t.c.text2 } as TextStyle,
  pairDim: { color: t.c.text3 } as TextStyle,

  // --------------------------------------------------------------- net worth hero
  gearing: { marginTop: 24, gap: 8 } as ViewStyle,

  // ------------------------------------------------------------------ the targets
  targetList: { gap: 24 } as ViewStyle,
  target: { gap: 8 } as ViewStyle,
  targetLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    flex: 1,
    minWidth: 0,
  } as ViewStyle,
  targetLabel: { ...font.body, fontWeight: weight.medium, color: t.c.text, flexShrink: 1 } as TextStyle,

  // ----------------------------------------------------------------- composition
  donutWrap: { alignItems: "center", marginBottom: space.gap + 4 } as ViewStyle,

  // ----------------------------------------------------------------- goal rows
  goalList: { gap: space.gap } as ViewStyle,
  goal: { gap: 7, paddingVertical: 8, paddingHorizontal: 4, borderRadius: radius.sm } as ViewStyle,
  goalPressed: { backgroundColor: t.c.surface2 } as ViewStyle,
  goalLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
    minWidth: 0,
  } as ViewStyle,
  goalName: { ...font.body, fontWeight: weight.medium, color: t.c.text, flexShrink: 1 } as TextStyle,
});
