/**
 * Home — `Finance/src/app/page.tsx`.
 *
 * The whole month on one screen: three concentric rings, the burn-rate figures,
 * the last seven days, the statement importer, where the money went, what is due,
 * the goals and their pace, net worth and the spending trend. Nine cards, thirteen
 * reads.
 *
 * Four things changed on the way over, and nothing else did.
 *
 * **The reads.** On the web this was an async server component: one `Promise.all`
 * of twelve independent aggregates, then the derived figures, then JSX. Here that
 * whole first half is `load()` — same twelve calls in the same single round, same
 * derivations — and `useLive(load)` runs it, re-runs it when an action calls
 * `bump()`, and hands the result to `Screen`. A failed read becomes one
 * `DbUnavailable` card with a retry instead of a blank app, which is exactly what
 * the web page's `try { return await Home() } catch` was for.
 *
 * **The grid collapses.** The web laid this out as `g-hero` (rings beside a stack)
 * and two `g-2-1` pairs, and at `max-width: 860px` its own stylesheet flattened
 * every one of those to a single column. A phone is narrower than 860px, so the
 * flattened form *is* the design: eight cards in one column, 20px apart, in the
 * order the CSS would have stacked them. The four burn-rate tiles stay two-up,
 * because `g-2` was already two columns at every width.
 *
 * **Colours are read, not named.** `var(--blue)` and `var(--green)` were resolved
 * by the browser; here `Sparkline` and `LineChart` take `t.c.blue` / `t.c.green`
 * from the palette at the point of use, so both themes still work.
 *
 * **The bill links are real now.** Every `href` under `typedRoutes: true` has to
 * name a route file that exists, so when this screen was first written the Upcoming
 * rows and the "See all" beside them had nowhere to point. Phase 8 built
 * `/bill/[id]`, so each row is a link again and "See all" carries `status=upcoming`
 * the way the web's query string did. Three destinations are still ahead of their
 * screens — a goal, a holding, and the Net worth card's `/profile` — and each is
 * commented where it belongs.
 *
 * **No keyboard.** The empty-state banner used to tell you to press `N`. The
 * sidebar's single-key shortcuts are not ported, because a phone has no keys to
 * press, so the sentence names the button and stops there.
 */

import { useRouter } from "expo-router";
import { Pressable, View, Text } from "react-native";
import type { TextStyle, ViewStyle } from "react-native";

import { BarChart, BarRows, LineChart, RingLegend, Sparkline, TripleRing, toDayBars } from "@/components/charts";
import { Screen } from "@/components/Screen";
import { catIcon } from "@/components/Icon";
import { StatementUpload } from "@/components/StatementUpload";
import {
  Banner, Card, Chip, EmptyState, Dot, IconTile, LinkButton, PageHead, ProgressBar, SeeAll, StatTile,
} from "@/components/ui";
import { uploadStatement } from "@/lib/actions/statement";
import { burnForecast, paceVsLastMonth } from "@/lib/analytics/forecast";
import { addDays, addMonthKey, fmtDate, fmtMonth, fmtMonthShort, fmtDue, thisMonth, today } from "@/lib/date";
import { useLive } from "@/lib/live";
import { fmtCompact, fmtWhole, pct } from "@/lib/money";
import { computePace, PACE_LABEL, PACE_TONE } from "@/lib/pace";
import { listUpcoming } from "@/lib/queries/bills";
import { goalFundedInMonth, listGoals } from "@/lib/queries/goals";
import { investedInMonth, netWorthSeries } from "@/lib/queries/holdings";
import { getSettings } from "@/lib/queries/settings";
import {
  categoryBreakdown, dailySpend, dataSpan, overallBudget, spendByMonth, spentInMonth,
} from "@/lib/queries/stats";
import { listBatches } from "@/lib/queries/statements";
import type { RingData, StatementBatch } from "@/lib/types";
import { useStyles, useTheme, type Theme } from "@/theme/ThemeProvider";
import { font, radius, tnum, weight } from "@/theme/tokens";

/**
 * One round of parallel reads — each is an independent aggregate, so there is no
 * reason to wait on them in sequence. `getSettings()` goes first because the month
 * start day and the three targets come out of it.
 */
async function load() {
  const settings = await getSettings();
  const mk = thisMonth();
  const startDay = settings.month_start_day;
  const prev = addMonthKey(mk, -1);
  const now = today();

  const [
    spent, budget, goalFunded, invested, week, categories,
    upcoming, goals, netSeries, span, monthly, prevSpent, waiting,
  ] = await Promise.all([
    spentInMonth(mk, startDay),
    overallBudget(mk, settings.monthly_budget_minor),
    goalFundedInMonth(mk, startDay),
    investedInMonth(mk, startDay),
    dailySpend(addDays(now, -6), now),
    categoryBreakdown(mk, startDay),
    listUpcoming(4),
    listGoals(),
    netWorthSeries(7),
    dataSpan(),
    spendByMonth(addMonthKey(mk, -5) + "-01"),
    spentInMonth(prev, startDay),
    // The web kept this one out of its `Promise.all` because it swallows its own
    // errors; swallowing them is exactly what makes it safe *inside* one, so it
    // joins the round here rather than costing a second trip.
    oldestUnreviewed(),
  ]);

  const rings: RingData = {
    month: mk,
    spentMinor: spent,
    budgetMinor: budget,
    goalFundedMinor: goalFunded,
    goalTargetMinor: settings.monthly_goal_target_minor,
    investedMinor: invested,
    investTargetMinor: settings.monthly_invest_target_minor,
  };

  const burn = burnForecast(mk, spent, budget, startDay);
  const vsLast = paceVsLastMonth(mk, spent, prevSpent, startDay);

  const netNow = netSeries.length ? netSeries[netSeries.length - 1].net_minor : 0;
  const netPrev = netSeries.length > 1 ? netSeries[netSeries.length - 2].net_minor : 0;
  const netDelta = netNow - netPrev;

  return {
    settings, mk, now, week, categories, upcoming, goals, netSeries, monthly,
    spent, budget, rings, burn, vsLast, netNow, netPrev, netDelta, waiting,
    empty: span.months === 0 && goals.length === 0,
  };
}

/**
 * The statement sitting on the review screen, if there is one.
 *
 * Swallows its own errors, which is the web's decision and its reasoning: a
 * `statement_batches` that cannot be read is a migration that has not landed, not a
 * database that is down, and the right response is a Home screen with one fewer banner
 * rather than the "database not reachable" card. `migrate()` runs in the root layout, so
 * on a phone the table is always there by the time this runs — the guard is kept anyway,
 * because it costs a `try` and the failure it prevents is the whole screen.
 */
async function oldestUnreviewed(): Promise<StatementBatch | null> {
  try {
    const batches = await listBatches(10);
    return batches.filter((b) => !b.committed_at).pop() ?? null;
  } catch {
    return null;
  }
}

type Data = Awaited<ReturnType<typeof load>>;

export default function HomeScreen() {
  const live = useLive(load);
  return <Screen live={live}>{(data) => <Feed d={data} />}</Screen>;
}

/**
 * The render half, as its own component so it can use the theme. `Screen` calls its
 * child only once data exists, and a render function cannot hold hooks — a
 * component can.
 */
function Feed({ d }: { d: Data }) {
  const t = useTheme();
  const s = useStyles(styles);
  const router = useRouter();

  // Hoisted to a local so the narrowing survives into the `onPress` closure below —
  // reading `d.waiting` inside it would widen back to `StatementBatch | null`. Same
  // reason `app/more.tsx` keeps a local for its `href`.
  const waiting = d.waiting;

  return (
    <>
      <PageHead
        title={greeting(d.settings.display_name)}
        sub={`${fmtMonth(d.mk)} · day ${d.burn.daysElapsed} of ${d.burn.daysElapsed + d.burn.daysRemaining}`}
      >
        <LinkButton href="/track" label="Analytics" icon="track" variant="outline" small />
      </PageHead>

      <View style={s.stack}>
        {d.empty ? (
          <Banner tone="info" icon="sparkle">
            <Text style={s.bold}>Nothing logged yet.</Text> Add your first bill with the button in the
            corner — or load a month of realistic sample data from Settings to see every chart populated
            before you commit real numbers.
          </Banner>
        ) : null}

        {/* ---------------------------------------------------------- the rings */}
        <Card>
          <View style={s.centre}>
            {/* 244 rather than the web's 260: the card's content box is 288dp on a
                360dp screen and 248dp on the narrowest phone still in use, so this
                fits everywhere. The 240-unit viewBox scales 1.017×, as it did on
                the web at 260. */}
            <TripleRing data={d.rings} size={244} />
          </View>
          <View style={s.legendWrap}>
            <RingLegend data={d.rings} />
          </View>
        </Card>

        {/* ------------------------------------------------------ burn forecast */}
        <Card title="This month" note={`Budget ${fmtWhole(d.budget)}`}>
          <View style={s.tiles}>
            <View style={s.tile}>
              <StatTile
                label="Spent so far"
                value={fmtCompact(d.spent)}
                tone={d.spent > d.budget ? "neg" : undefined}
                sub={
                  d.vsLast.deltaPct === null
                    ? "No comparable month yet"
                    : `${d.vsLast.deltaPct >= 0 ? "+" : ""}${d.vsLast.deltaPct}% vs the same point last month`
                }
              />
            </View>
            <View style={s.tile}>
              <StatTile
                label="Projected at this rate"
                value={fmtCompact(d.burn.projectedMinor)}
                tone={d.burn.headroomMinor < 0 ? "neg" : "pos"}
                sub={
                  d.burn.headroomMinor < 0
                    ? `${fmtCompact(-d.burn.headroomMinor)} over budget`
                    : `${fmtCompact(d.burn.headroomMinor)} to spare`
                }
              />
            </View>
            <View style={s.tile}>
              <StatTile
                label="Spending per day"
                value={fmtCompact(d.burn.perDayMinor)}
                size="sm"
                sub={
                  d.burn.safePerDayMinor === null
                    ? "Budget already used up"
                    : `${fmtCompact(d.burn.safePerDayMinor)}/day keeps you on budget`
                }
              />
            </View>
            <View style={s.tile}>
              <StatTile
                label="Days remaining"
                value={String(d.burn.daysRemaining)}
                size="sm"
                sub={
                  d.burn.exhaustedOn
                    ? `Budget runs out ${fmtDate(d.burn.exhaustedOn)}`
                    : "Budget lasts the month at this rate"
                }
              />
            </View>
          </View>

          {d.burn.exhaustedOn ? (
            <View style={s.bannerWrap}>
              <Banner tone="warn" icon="alert">
                At {fmtCompact(d.burn.perDayMinor)} a day the budget is gone by{" "}
                <Text style={s.bold}>{fmtDate(d.burn.exhaustedOn)}</Text>, with {d.burn.daysRemaining} day
                {d.burn.daysRemaining === 1 ? "" : "s"} still to go.
              </Banner>
            </View>
          ) : null}
        </Card>

        {/* -------------------------------------------------------- last 7 days */}
        <Card title="Last 7 days" note="Paid expenses per day">
          <BarChart bars={toDayBars(d.week, d.now)} height={140} />
        </Card>

        {/* ------------------------------------------------- import a statement */}
        {/*
          High up on purpose, and in the web's own position — after the last-7-days
          card, before the categories. One statement is a month of entries, so this is
          the fastest route from an empty journal to a full one, and the thing most
          worth finding without being told it exists. The control is the same component
          the importer's own screen uses, so there is one upload path, not a simplified
          copy that drifts.
        */}
        <Card
          title="Import a bank statement"
          note="PDF or CSV · read on this phone · nothing is added until you have ticked the rows"
          action={<SeeAll href="/statement" />}
        >
          {waiting ? (
            <Banner tone="warn" icon="clock">
              <Text style={s.bold}>{waiting.original_name}</Text>
              {` was read but nothing from it has been added yet — ${waiting.row_count} row${
                waiting.row_count === 1 ? "" : "s"
              } are waiting. `}
              {/* A nested `<Text onPress>` rather than a `Pressable`: a tappable word
                  inside a sentence has to flow with the sentence, and `Banner` has
                  already put a `<Text>` around its children. Same construction as
                  `app/statement/index.tsx`'s copy of this banner. */}
              <Text
                style={s.bannerLink}
                onPress={() =>
                  router.push({
                    pathname: "/statement/[id]",
                    params: { id: String(waiting.id) },
                  })
                }
              >
                Review them
              </Text>
              .
            </Banner>
          ) : null}
          <View style={waiting ? s.bannerWrap : undefined}>
            <StatementUpload action={uploadStatement} compact />
          </View>
        </Card>

        {/* ------------------------------------------------------- where it went */}
        <Card title="Where it went" note={`Top categories in ${fmtMonth(d.mk)}`} action={<SeeAll href="/track" />}>
          {d.categories.length === 0 ? (
            <EmptyState
              icon="tag"
              title="No spending logged this month"
              body="Categories appear here as soon as you log a paid expense."
            />
          ) : (
            <BarRows
              rows={d.categories.slice(0, 7).map((c) => ({
                label: c.name,
                value: c.total_minor,
                color: c.color,
                note: `${c.txn_count} txn${c.txn_count === 1 ? "" : "s"}`,
              }))}
            />
          )}
        </Card>

        {/* ------------------------------------------------------------ upcoming */}
        {/* The web's `/journal?status=upcoming`, written as an object because that is
            the form the router's own types describe for params. The Journal reads
            `sp.status` and comes up with its Upcoming tab already selected. */}
        <Card title="Upcoming" action={<SeeAll href={{ pathname: "/journal", params: { status: "upcoming" } }} />}>
          {d.upcoming.length === 0 ? (
            <EmptyState icon="calendar" title="Nothing due" body="Bills you mark as upcoming show up here." />
          ) : (
            <View style={s.entryList}>
              {d.upcoming.map((b) => {
                const due = b.due_date ? fmtDue(b.due_date) : null;
                return (
                  // `.entry` was an anchor, so the whole row is the target — the
                  // 34px tile and the 14px name are neither of them tappable alone.
                  <Pressable
                    key={b.id}
                    accessibilityRole="link"
                    accessibilityLabel={`${b.merchant}, ${fmtWhole(b.amount_minor)}`}
                    onPress={() => router.push({ pathname: "/bill/[id]", params: { id: String(b.id) } })}
                    style={({ pressed }) => [s.entry, pressed ? s.entryPressed : null]}
                  >
                    <IconTile color={b.category_color ?? "#80868B"} icon={catIcon(b.category_icon)} size={34} />
                    <View style={s.entryMain}>
                      <Text style={s.entryTitle} numberOfLines={1}>
                        {b.merchant}
                      </Text>
                      <View style={s.entryMeta}>
                        {due ? (
                          <Chip tone={due.overdue ? "bad" : due.soon ? "warn" : "neutral"}>{due.label}</Chip>
                        ) : null}
                        {b.category_name ? <Text style={s.entryMetaText}>{b.category_name}</Text> : null}
                      </View>
                    </View>
                    <Text style={s.entryAmount}>{fmtWhole(b.amount_minor)}</Text>
                  </Pressable>
                );
              })}
            </View>
          )}
        </Card>

        {/* --------------------------------------------------------------- goals */}
        <Card
          title="Goals"
          note="Measured against a straight line to the target date"
          action={<SeeAll href="/goals" />}
        >
          {d.goals.length === 0 ? (
            <EmptyState
              icon="goals"
              title="No goals yet"
              body="A goal with a target amount and date gets you an on-pace reading and a required-per-month figure."
              cta={{ href: "/goal/new", label: "Create a goal" }}
            />
          ) : (
            <View style={s.goalList}>
              {d.goals.slice(0, 3).map((g) => {
                const pace = computePace({
                  target_minor: g.target_minor,
                  started_on: g.started_on,
                  target_date: g.target_date,
                  savedMinor: g.saved_minor,
                });
                return (
                  // The web wrapped the whole block in a link to the goal; the row
                  // is the target here for the same reason the bill entries are.
                  <Pressable
                    key={g.id}
                    accessibilityRole="link"
                    accessibilityLabel={`${g.name}, ${PACE_LABEL[pace.status]}`}
                    onPress={() => router.push({ pathname: "/goal/[id]", params: { id: String(g.id) } })}
                    style={({ pressed }) => [s.goalRow, pressed ? s.entryPressed : null]}
                  >
                    <View style={s.goalHead}>
                      <View style={s.goalHeadLeft}>
                        <Dot color={g.color} />
                        <Text style={s.goalName} numberOfLines={1}>
                          {g.name}
                        </Text>
                        <Chip tone={PACE_TONE[pace.status]}>{PACE_LABEL[pace.status]}</Chip>
                      </View>
                      <Text style={s.goalValue}>
                        {fmtCompact(g.saved_minor)}{" "}
                        <Text style={s.dim}>/ {fmtCompact(g.target_minor)}</Text>
                      </Text>
                    </View>
                    <ProgressBar value={pace.progress} color={g.color} height={8} />
                    <Text style={s.goalNote}>
                      {pace.requiredPerMonthMinor
                        ? `${fmtCompact(pace.requiredPerMonthMinor)}/month to finish by ${fmtDate(g.target_date!)}`
                        : pace.status === "done"
                          ? "Target reached"
                          : pace.projectedDate
                            ? `On this pace, complete around ${fmtDate(pace.projectedDate)}`
                            : "Add a contribution to start the pace calculation"}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          )}
        </Card>

        {/* ----------------------------------------------------------- net worth */}
        <Card title="Net worth" action={<SeeAll href="/profile" />}>
          {d.netNow === 0 && d.netSeries.every((x) => x.net_minor === 0) ? (
            <EmptyState
              icon="bank"
              title="No holdings valued"
              body="Add a holding and a value snapshot to start the net worth series."
              cta={{ href: "/holding/new", label: "Add a holding" }}
            />
          ) : (
            <>
              <StatTile
                label="Today"
                value={fmtCompact(d.netNow)}
                size="xl"
                sub={
                  d.netSeries.length > 1 ? (
                    <Text style={d.netDelta >= 0 ? s.subGood : s.subBad}>
                      {d.netDelta >= 0 ? "▲" : "▼"} {fmtCompact(Math.abs(d.netDelta))} (
                      {d.netPrev ? Math.abs(pct(d.netDelta, Math.abs(d.netPrev))).toFixed(1) : "—"}%) this month
                    </Text>
                  ) : (
                    "One month of history so far"
                  )
                }
              />
              <View style={s.sparkWrap}>
                <Sparkline
                  points={d.netSeries.map((x) => x.net_minor)}
                  color={d.netDelta >= 0 ? t.c.green : t.c.red}
                  width={240}
                  height={56}
                />
              </View>
            </>
          )}
        </Card>

        {/* ------------------------------------------------------- spending trend */}
        {d.monthly.length >= 2 ? (
          <Card title="Spending trend" note={`Last ${d.monthly.length} months`} action={<SeeAll href="/track" />}>
            <LineChart
              series={[{ points: d.monthly.map((m) => m.total_minor), color: t.c.blue, fill: true }]}
              labels={d.monthly.map((m) => fmtMonthShort(m.month))}
              height={170}
            />
          </Card>
        ) : null}
      </View>
    </>
  );
}

/** Fit greets you by name; the time of day is the only thing that varies. */
function greeting(name: string): string {
  const h = new Date().getHours();
  const part = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  return name && name !== "You" ? `${part}, ${name}` : part;
}

const styles = (t: Theme) => ({
  // `.stack > * + * { margin-top: 20px }`.
  stack: { gap: 20 } as ViewStyle,
  centre: { alignItems: "center" } as ViewStyle,
  legendWrap: { marginTop: 22 } as ViewStyle,
  bannerWrap: { marginTop: 18 } as ViewStyle,
  sparkWrap: { marginTop: 14 } as ViewStyle,
  bold: { fontWeight: weight.medium } as TextStyle,
  /** A tappable word inside a `Banner`'s sentence. Colour and weight stay the
      banner's, so the word does not shout louder than the sentence around it. */
  bannerLink: { textDecorationLine: "underline" } as TextStyle,

  // `.grid g-2` with `gap: 22px` — two columns at every width on the web, so the
  // phone keeps them. 48% rather than 50% leaves room for the column gap.
  tiles: { flexDirection: "row", flexWrap: "wrap", columnGap: 16, rowGap: 22 } as ViewStyle,
  tile: { width: "48%" } as ViewStyle,

  // `.entry` — transparent by default on the web, `surface-2` on hover. There is no
  // hover on a phone, so that colour is the pressed state instead, exactly as the
  // Journal's rows use it.
  entryList: { gap: 4 } as ViewStyle,
  entry: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: radius.sm,
  } as ViewStyle,
  entryPressed: { backgroundColor: t.c.surface2 } as ViewStyle,
  // `gap: 3` because RN stacks two `Text`s with no block spacing between them,
  // where the browser's line boxes left a little.
  entryMain: { flex: 1, minWidth: 0, gap: 3 } as ViewStyle,
  entryTitle: { ...font.entryTitle, color: t.c.text } as TextStyle,
  entryMeta: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" } as ViewStyle,
  entryMetaText: { ...font.small, color: t.c.text3 } as TextStyle,
  entryAmount: { ...font.entryAmount, ...tnum, color: t.c.text, textAlign: "right" } as TextStyle,

  goalList: { gap: 20 } as ViewStyle,
  // The tap target the web's anchor was. Padded so the press tint has something to
  // fill, and pulled back out again so the bar still lines up with the card's text.
  goalRow: { paddingVertical: 5, paddingHorizontal: 4, marginHorizontal: -4, borderRadius: radius.sm } as ViewStyle,
  // `.row-between` with the 7px the web put between a goal's header and its bar.
  goalHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 7,
  } as ViewStyle,
  goalHeadLeft: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1, minWidth: 0 } as ViewStyle,
  goalName: { ...font.small, fontWeight: weight.medium, color: t.c.text, flexShrink: 1 } as TextStyle,
  goalValue: { ...font.small, ...tnum, color: t.c.text } as TextStyle,
  dim: { color: t.c.text3 } as TextStyle,
  goalNote: { ...font.small, color: t.c.text3, marginTop: 6 } as TextStyle,

  // `.metric-sub` recoloured — `<span className="pos">` / `"neg"` inside the sub.
  subGood: { ...font.small, color: t.c.green } as TextStyle,
  subBad: { ...font.small, color: t.c.red } as TextStyle,
});
