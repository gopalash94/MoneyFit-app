/**
 * One goal, with the pace maths shown rather than asserted —
 * `Finance/src/app/goals/[id]/page.tsx`.
 *
 * The web's own header still describes what this screen is for, and it survives the
 * port intact: the chart draws two lines on one scale, what you have actually put in
 * and the straight line from the goal's start to its deadline, so "behind" is a visible
 * gap between two lines instead of a red chip you have to take on trust — and the
 * projection line says where today's rate actually lands you, which is usually the
 * number that changes behaviour.
 *
 * Four changes, all of them the shape of the phone rather than the maths.
 *
 * **`notFound()` became a render**, exactly as in `app/bill/[id]/index.tsx`: the loader
 * returns `{ goal: null }` — never a bare `null`, which `Screen` cannot tell from "still
 * loading" — and the render function picks `<NotFound/>`. The same branch covers a junk
 * id, which the web checked before it ever queried.
 *
 * **The four pace figures wrap two-up.** `.grid.g-4` was four columns; below 860px the
 * web's own stylesheet already flattened it, and two 47% columns is what 360dp fits with
 * the page gutter and the card padding taken off. Same four tiles, same order.
 *
 * **The contributions table became a list.** There is no `<table>` here, and a
 * four-column table at 360dp would not have been readable anyway. Each contribution is a
 * row: date and note on the left, the signed amount and its Remove button on the right.
 *
 * **The add form comes before the list.** On the web these two sat side by side in a
 * `g-2-1` grid, so both were visible at once. One column can only keep one of those
 * properties, and a goal with forty contributions would bury the form under them — so
 * the form goes first. Its note still says "log several in a row", and now that is
 * actually true without scrolling back up.
 */

import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Text, View } from "react-native";
import type { TextStyle, ViewStyle } from "react-native";

import { LineChart, type Series } from "@/components/charts";
import { ContributionForm } from "@/components/ContributionForm";
import { ActionButton, DangerButton } from "@/components/form";
import { Screen } from "@/components/Screen";
import {
  Banner, Card, Chip, Dot, EmptyState, IconTile, LinkButton, NotFound, PageHead,
  ProgressBar, StatTile,
} from "@/components/ui";
import {
  addGoalContribution, deleteGoal, deleteGoalContribution, setGoalArchived,
} from "@/lib/actions/goals";
import { addDays, daysBetween, fmtDate, today, type ISODate } from "@/lib/date";
import { goalIcon } from "@/lib/goal-icon";
import { useLive } from "@/lib/live";
import { fmt, fmtSigned, fmtWhole } from "@/lib/money";
import { computePace, PACE_LABEL, PACE_TONE } from "@/lib/pace";
import { getGoal, goalContributions, goalCumulative } from "@/lib/queries/goals";
import type { Contribution, GoalRow } from "@/lib/types";
import { useStyles, useTheme, type Theme } from "@/theme/ThemeProvider";
import { font, radius, space, tnum } from "@/theme/tokens";

/** What the chart and the pace line are both drawn from. */
type Cumulative = { txn_date: ISODate; cumulative_minor: number };

type Loaded = {
  /** Null for both "no such row" and "not a valid id" — one branch renders both. */
  goal: GoalRow | null;
  contributions: Contribution[];
  cumulative: Cumulative[];
};

const NONE: Loaded = { goal: null, contributions: [], cumulative: [] };

async function load(n: number): Promise<Loaded> {
  if (!Number.isInteger(n) || n <= 0) return NONE;

  const goal = await getGoal(n);
  if (!goal) return NONE;

  const [contributions, cumulative] = await Promise.all([
    goalContributions(n),
    goalCumulative(n),
  ]);
  return { goal, contributions, cumulative };
}

export default function GoalScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const n = Number(typeof params.id === "string" ? params.id : "");
  const live = useLive(() => load(n), [n]);

  function back() {
    if (router.canGoBack()) router.back();
    else router.replace("/goals");
  }

  return (
    <>
      <Stack.Screen options={{ title: live.data?.goal?.name ?? "Goal" }} />
      <Screen live={live}>
        {(data) =>
          data.goal ? (
            <Detail goal={data.goal} contributions={data.contributions} cumulative={data.cumulative} />
          ) : (
            <NotFound what="goal" onBack={back} />
          )
        }
      </Screen>
    </>
  );
}

function Detail({ goal: g, contributions, cumulative }: Loaded & { goal: GoalRow }) {
  const s = useStyles(styles);
  const t = useTheme();
  const router = useRouter();

  const id = g.id;
  const p = computePace({
    target_minor: g.target_minor,
    started_on: g.started_on,
    target_date: g.target_date,
    savedMinor: g.saved_minor,
  });
  const now = today();
  const withdrawals = contributions.filter((c) => c.amount_minor < 0);

  return (
    <>
      <PageHead
        title={g.name}
        // The web put a muted "Goals ·" link here. The header's back arrow is that
        // link, and it knows where you actually came from.
        sub={
          `started ${fmtDate(g.started_on, { year: true })}` +
          (g.target_date ? ` · due ${fmtDate(g.target_date, { year: true })}` : "")
        }
      >
        <LinkButton
          href={{ pathname: "/goal/[id]/edit", params: { id: String(id) } }}
          label="Edit"
          icon="edit"
          variant="outline"
          small
        />

        <ActionButton
          action={() => setGoalArchived(id, !g.archived)}
          icon={g.archived ? "undo" : "check"}
        >
          {g.archived ? "Unarchive" : "Archive"}
        </ActionButton>

        <DangerButton
          action={() => deleteGoal(id)}
          label="Delete"
          confirm={
            contributions.length
              ? `Delete “${g.name}” and its ${contributions.length} contribution${
                  contributions.length === 1 ? "" : "s"
                }? This cannot be undone — archive it instead to keep the history.`
              : `Delete “${g.name}”? This cannot be undone.`
          }
          onDone={() => router.replace("/goals")}
        />
      </PageHead>

      {g.archived ? (
        <View style={s.bannerWrap}>
          <Banner tone="neutral" icon="info">
            This goal is archived. It keeps its history but is left out of the goals list,
            the monthly ring and the per-month totals.
          </Banner>
        </View>
      ) : null}

      <View style={s.stack}>
        <Card>
          <View style={s.heroRow}>
            <IconTile color={g.color} icon={goalIcon(g.icon)} size={52} />
            <View style={s.heroMain}>
              <StatTile
                label={p.status === "done" ? "Funded" : "Saved so far"}
                value={fmt(g.saved_minor)}
                size="xl"
                sub={
                  <View style={s.chipRow}>
                    <Chip tone={PACE_TONE[p.status]}>{PACE_LABEL[p.status]}</Chip>
                    <Chip>{`${Math.round(p.progress * 100)}% of ${fmtWhole(g.target_minor)}`}</Chip>
                    {p.daysLeft !== null ? (
                      <Chip tone={p.daysLeft < 0 ? "bad" : p.daysLeft <= 30 ? "warn" : "info"}>
                        {p.daysLeft < 0
                          ? `${-p.daysLeft} days overdue`
                          : p.daysLeft === 0
                            ? "due today"
                            : `${p.daysLeft} days left`}
                      </Chip>
                    ) : null}
                  </View>
                }
              />
            </View>
          </View>

          <View style={s.barWrap}>
            <ProgressBar
              value={p.progress}
              color={p.status === "behind" ? t.c.red : g.color}
              height={10}
            />
          </View>

          <View style={s.factGrid}>
            <View style={s.fact}>
              <StatTile
                label="Still to go"
                value={p.remainingMinor === 0 ? "Nothing" : fmtWhole(p.remainingMinor)}
                size="sm"
              />
            </View>
            <View style={s.fact}>
              <StatTile
                label={p.daysLeft !== null && p.daysLeft <= 0 ? "Due now" : "Per month from here"}
                value={
                  p.requiredPerMonthMinor === null
                    ? "—"
                    : p.requiredPerMonthMinor === 0
                      ? "Done"
                      : fmtWhole(p.requiredPerMonthMinor)
                }
                size="sm"
                sub={p.requiredPerMonthMinor === null ? "no deadline" : undefined}
              />
            </View>
            <View style={s.fact}>
              <StatTile
                label="Against pace"
                value={p.status === "no_deadline" ? "—" : fmtSigned(p.gapMinor)}
                size="sm"
                tone={p.status === "no_deadline" ? undefined : p.gapMinor < 0 ? "neg" : "pos"}
                sub={p.status === "no_deadline" ? "no deadline to pace against" : undefined}
              />
            </View>
            <View style={s.fact}>
              <StatTile
                label="At the current rate"
                value={p.projectedDate ? fmtDate(p.projectedDate, { year: true }) : "—"}
                size="sm"
                sub={
                  p.projectedDate && g.target_date
                    ? projectionNote(p.projectedDate, g.target_date)
                    : p.projectedDate
                      ? "no deadline to compare"
                      : "nothing saved yet"
                }
              />
            </View>
          </View>

          {g.notes ? (
            <View style={s.notesWrap}>
              <Text style={s.kvK}>Notes</Text>
              <Text style={s.kvText}>{g.notes}</Text>
            </View>
          ) : null}
        </Card>

        <Progress goal={g} cumulative={cumulative} now={now} />

        <Card title="Add to this goal" note="Stays on this screen — log several in a row.">
          <ContributionForm
            action={(prev, fd) => addGoalContribution(id, prev, fd)}
            today={now}
            verb="Add contribution"
            withdrawLabel="This was a withdrawal"
          />
        </Card>

        <Card
          title={contributions.length ? `Contributions · ${contributions.length}` : "Contributions"}
          note={
            withdrawals.length
              ? `Including ${withdrawals.length} withdrawal${withdrawals.length === 1 ? "" : "s"}`
              : undefined
          }
        >
          {contributions.length === 0 ? (
            <EmptyState
              icon="coins"
              title="Nothing in yet"
              body="Add what you've already put aside — back-dated if it went in earlier. The pace line runs from the goal's start date, so honest dates give an honest answer."
            />
          ) : (
            <View style={s.rowList}>
              {contributions.map((c) => (
                <ContributionRow key={c.id} c={c} />
              ))}
            </View>
          )}
        </Card>
      </View>
    </>
  );
}

// ------------------------------------------------------------------ the pieces

/** One row of the web's contributions table, laid out for a narrow screen. */
function ContributionRow({ c }: { c: Contribution }) {
  const s = useStyles(styles);
  const out = c.amount_minor < 0;

  return (
    <View style={s.contribRow}>
      <View style={s.contribText}>
        <Text style={s.muted}>{fmtDate(c.txn_date, { year: true })}</Text>
        {c.note ? (
          <Text style={s.dim} numberOfLines={2}>
            {c.note}
          </Text>
        ) : null}
      </View>
      <Text style={out ? s.amountOut : s.amount}>{fmtSigned(c.amount_minor)}</Text>
      <DangerButton
        action={() => deleteGoalContribution(c.id)}
        label="Remove"
        confirm={`Remove this ${fmtWhole(Math.abs(c.amount_minor))} entry from ${fmtDate(
          c.txn_date,
          { year: true },
        )}?`}
      />
    </View>
  );
}

/**
 * The two-line chart: money actually in, against the straight line the pace chip
 * is computed from.
 *
 * Both series are sampled on the same x-axis of dates so one y-scale is honest.
 * The actual series stops at today — carrying it flat to the deadline would draw
 * a confident claim about months that have not happened.
 *
 * The only edit from the web is the colour: `"var(--text-3)"` became `t.c.text3`,
 * because `react-native-svg` has no custom properties to resolve.
 */
function Progress({
  goal: g,
  cumulative,
  now,
}: {
  goal: GoalRow;
  cumulative: Cumulative[];
  now: ISODate;
}) {
  const s = useStyles(styles);
  const t = useTheme();

  if (cumulative.length === 0) {
    return (
      <Card title="Progress">
        <EmptyState
          icon="track"
          title="Nothing to plot yet"
          body="Once there are two contributions this chart compares what you've saved against the straight line to your deadline."
        />
      </Card>
    );
  }

  const last = cumulative[cumulative.length - 1].txn_date;
  const end = g.target_date ?? (last > now ? last : now);

  // A shared, evenly spaced axis — about 28 samples, which is enough to look like
  // a line and few enough that the x labels stay readable.
  const span = Math.max(1, daysBetween(g.started_on, end));
  const step = Math.max(1, Math.ceil(span / 28));
  const axis: ISODate[] = [];
  for (let d = 0; d <= span; d += step) axis.push(addDays(g.started_on, d));
  if (axis[axis.length - 1] !== end) axis.push(end);

  // Cumulative saved at each sample: the last contribution at or before it.
  const savedAt = (date: ISODate) => {
    let v = 0;
    for (const r of cumulative) {
      if (r.txn_date > date) break;
      v = r.cumulative_minor;
    }
    return v;
  };

  const actual = axis.filter((d) => d <= now).map(savedAt);
  const pace = g.target_date
    ? axis.map((d) =>
        Math.round(
          g.target_minor * Math.min(1, Math.max(0, daysBetween(g.started_on, d) / span)),
        ),
      )
    : [];

  const series: Series[] = [];
  if (pace.length) {
    series.push({ points: pace, color: t.c.text3, dashed: true, label: "Pace" });
  }
  // A goal whose start date is in the future has no observed segment yet; an
  // empty series would emit a path that begins with a line-to.
  if (actual.length) {
    series.push({ points: actual, color: g.color, fill: true, label: "Saved" });
  }

  // The target as a flat reference only helps when the pace line is absent —
  // otherwise it is the same number the pace line already ends on.
  if (!pace.length) {
    series.push({
      points: axis.map(() => g.target_minor),
      color: t.c.text3,
      dashed: true,
      label: "Target",
    });
  }

  return (
    <Card
      title="Progress"
      note={
        g.target_date
          ? "Saved against a straight line from start to deadline"
          : "Saved against the target — no deadline, so no pace line"
      }
      action={
        <View style={s.legend}>
          <View style={s.legendItem}>
            <Dot color={g.color} />
            <Text style={s.muted}>Saved</Text>
          </View>
          <View style={s.legendItem}>
            <Dot color={t.c.text3} />
            <Text style={s.muted}>{g.target_date ? "Pace" : "Target"}</Text>
          </View>
        </View>
      }
    >
      <LineChart series={series} labels={axis.map((d) => fmtDate(d))} height={210} />
    </Card>
  );
}

/** "3 weeks early" / "2 months late" — the comparison the date alone implies. */
function projectionNote(projected: ISODate, deadline: ISODate): string {
  const days = daysBetween(projected, deadline);
  if (days === 0) return "exactly on the deadline";
  const late = days < 0;
  const n = Math.abs(days);
  const unit =
    n >= 60 ? `${Math.round(n / 30.44)} months`
    : n >= 14 ? `${Math.round(n / 7)} weeks`
    : `${n} day${n === 1 ? "" : "s"}`;
  return `${unit} ${late ? "late" : "early"}`;
}

const styles = (t: Theme) => ({
  // `.stack > * + * { margin-top: 20px }`.
  stack: { gap: space.gap + 4 } as ViewStyle,
  bannerWrap: { marginBottom: space.gap } as ViewStyle,

  heroRow: { flexDirection: "row", alignItems: "flex-start", gap: space.gap } as ViewStyle,
  heroMain: { flex: 1, minWidth: 0 } as ViewStyle,
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 } as ViewStyle,
  barWrap: { marginTop: 18 } as ViewStyle,

  // `.grid.g-4`, wrapped two-up. Same arithmetic as the bill screen's `.kv`.
  factGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    rowGap: space.gap + 4,
    columnGap: space.gap,
    marginTop: 26,
  } as ViewStyle,
  fact: { width: "47%" } as ViewStyle,

  notesWrap: { marginTop: 24, gap: 3 } as ViewStyle,
  kvK: { ...font.label, color: t.c.text3 } as TextStyle,
  kvText: { ...font.body, color: t.c.text } as TextStyle,

  dim: { ...font.small, color: t.c.text3 } as TextStyle,
  muted: { ...font.small13, color: t.c.text2 } as TextStyle,
  amount: { ...font.small13, ...tnum, color: t.c.text, textAlign: "right" } as TextStyle,
  amountOut: { ...font.small13, ...tnum, color: t.c.red, textAlign: "right" } as TextStyle,

  // ---------------------------------------------------------- contributions
  rowList: { gap: 2 } as ViewStyle,
  contribRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.gapSm,
    minHeight: 48,
    paddingHorizontal: 4,
    borderRadius: radius.sm,
  } as ViewStyle,
  contribText: { flex: 1, minWidth: 0, gap: 2 } as ViewStyle,

  legend: { flexDirection: "row", alignItems: "center", gap: 14 } as ViewStyle,
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 } as ViewStyle,
});
