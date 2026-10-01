/**
 * Invest — "how is my investing going", answered at portfolio level.
 * `Finance/src/app/invest/page.tsx`.
 *
 * The web's reasoning holds unchanged: the headline is net worth, not portfolio
 * value, because a ₹40L portfolio against a ₹35L home loan is a different financial
 * position from a ₹40L portfolio against nothing, and only one number says so.
 * Liabilities are holdings here too, which is what lets that subtraction be a query
 * rather than a spreadsheet. Return is reported as XIRR first and absolute gain
 * second, because for anything bought with a SIP the two differ enormously and the
 * annualised one is the figure that can be compared against an FD rate.
 *
 * Four shapes changed.
 *
 * **Two tables became two lists.** There is no `<table>` here, and the holdings
 * table had six columns — name, invested, value, gain, share, last valued. At 360dp
 * that is a block per holding rather than a row: name and type on the left with the
 * share bar under them, the three money figures stacked on the right. The allocation
 * table's four columns collapse the same way.
 *
 * **The donut moved above its list.** `.row` with `flex: 1 1 340px` beside a 200px
 * donut is a two-column layout that only exists above ~560px; one column puts the
 * donut first, which is the order the card's own note implies — where is it, then is
 * that working.
 *
 * **The archived toggle is a button.** As on the Goals screen: `typedRoutes` has no
 * `/invest?archived=1` literal, so it is `setParams` through an `ActionButton`,
 * which holds its own pending state and needs no enclosing form.
 *
 * **`var(--green)` became `t.c.green`.** `react-native-svg` has no custom properties
 * to resolve, so every colour handed to a chart is a real string from the theme.
 */

import { useLocalSearchParams, useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import type { TextStyle, ViewStyle } from "react-native";

import { DonutChart, LineChart, type Series } from "@/components/charts";
import { useSetParams } from "@/components/filters";
import { ActionButton } from "@/components/form";
import { Screen } from "@/components/Screen";
import {
  Banner, Card, Chip, Dot, EmptyState, IconTile, LinkButton, PageHead, ProgressBar,
  StatTile,
} from "@/components/ui";
import { assetIcon } from "@/lib/asset-icon";
import { fmtDate, fmtMonthShort, thisMonth, type MonthKey } from "@/lib/date";
import { useLive } from "@/lib/live";
import { fmt, fmtCompact, fmtSigned, fmtWhole, pct } from "@/lib/money";
import {
  allAssetContributions, allocation, investedInMonth, listHoldings, netWorthNow,
  netWorthSeries, portfolioValueSeries,
} from "@/lib/queries/holdings";
import { getSettings } from "@/lib/queries/settings";
import { ASSET_TYPE_COLOR, ASSET_TYPE_LABEL, type AssetType, type HoldingRow } from "@/lib/types";
import { absoluteReturn, fmtPct, maxDrawdown, xirr, type Flow } from "@/lib/xirr";
import { useStyles, useTheme, type Theme } from "@/theme/ThemeProvider";
import { font, radius, space, tnum, weight } from "@/theme/tokens";

type NetWorthPoint = {
  month: MonthKey;
  assets_minor: number;
  liabilities_minor: number;
  net_minor: number;
};

type AllocRow = { asset_type: string; value_minor: number; invested_minor: number };

type Loaded = {
  holdings: HoldingRow[];
  now: { assets_minor: number; liabilities_minor: number; net_minor: number; invested_minor: number };
  series: NetWorthPoint[];
  alloc: AllocRow[];
  /** The portfolio's own cash flows, already signed for `xirr`. */
  portfolioFlows: Flow[];
  drawdown: ReturnType<typeof maxDrawdown>;
  investedThisMonth: number;
  monthlyTarget: number;
};

async function load(showArchived: boolean): Promise<Loaded> {
  const mk = thisMonth();
  const [holdings, now, series, alloc, flows, valueSeries, investedThisMonth, settings] =
    await Promise.all([
      listHoldings(showArchived),
      netWorthNow(),
      netWorthSeries(12),
      allocation(),
      allAssetContributions(),
      portfolioValueSeries(),
      investedInMonth(mk, 1),
      getSettings(),
    ]);

  // Portfolio XIRR: every contribution is money out of pocket, today's total value
  // is the position you could realise. Liabilities are excluded — a loan's "return"
  // is not a meaningful number, and mixing it in would make the portfolio one
  // meaningless too.
  const portfolioFlows: Flow[] = flows.map((f) => ({ date: f.txn_date, amount: -f.amount_minor }));
  const lastValued = valueSeries.length ? valueSeries[valueSeries.length - 1].as_of : null;
  if (lastValued) portfolioFlows.push({ date: lastValued, amount: now.assets_minor });

  return {
    holdings,
    now,
    series,
    alloc,
    portfolioFlows,
    drawdown: maxDrawdown(valueSeries),
    investedThisMonth,
    monthlyTarget: settings.monthly_invest_target_minor,
  };
}

/** A param can legitimately arrive twice; the first spelling of it wins. */
function str(v: string | string[] | undefined): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return "";
}

export default function InvestScreen() {
  const params = useLocalSearchParams();
  const showArchived = str(params.archived) === "1";
  // One primitive, always one — `useLive` re-runs its effect on this list and
  // React requires a stable length.
  const live = useLive(() => load(showArchived), [showArchived ? 1 : 0]);

  return (
    <Screen live={live}>
      {(data) => <Invest data={data} showArchived={showArchived} />}
    </Screen>
  );
}

function Invest({ data, showArchived }: { data: Loaded; showArchived: boolean }) {
  const s = useStyles(styles);
  const setParams = useSetParams();

  const { holdings, now, series, alloc, portfolioFlows, drawdown, investedThisMonth } = data;
  const target = data.monthlyTarget;

  const live = holdings.filter((h) => !h.archived);
  const assets = live.filter((h) => h.side === "asset");
  const liabilities = live.filter((h) => h.side === "liability");

  const rate = xirr(portfolioFlows);
  const abs = absoluteReturn(now.invested_minor, now.assets_minor);
  const gainMinor = now.assets_minor - now.invested_minor;

  if (holdings.length === 0) {
    return (
      <>
        <PageHead title="Invest" sub="Nothing tracked yet">
          <LinkButton href="/holding/new" label="Add holding" icon="plus" variant="solid" small />
        </PageHead>
        <EmptyState
          icon="invest"
          title="No holdings yet"
          body="Add a fund, a deposit, some gold — anything you own — with what you've put in and what it's worth. Add your loans too: net worth only means something once both sides are here."
          cta={{ href: "/holding/new", label: "Add your first holding" }}
        />
      </>
    );
  }

  return (
    <>
      <PageHead
        title="Invest"
        sub={
          `${assets.length} holding${assets.length === 1 ? "" : "s"}` +
          (liabilities.length
            ? ` · ${liabilities.length} liabilit${liabilities.length === 1 ? "y" : "ies"}`
            : "")
        }
      >
        <ActionButton
          action={async () => setParams({ archived: showArchived ? undefined : "1" })}
          icon={showArchived ? "eye" : "filter"}
          variant="ghost"
        >
          {showArchived ? "Active only" : "Show closed"}
        </ActionButton>
        <LinkButton href="/holding/new" label="Add holding" icon="plus" variant="solid" small />
      </PageHead>

      <View style={s.stack}>
        <View style={s.factGrid}>
          {/* Net worth is the headline, so it keeps the full width and the xl size
              the web gave it; the other three wrap two-up beneath. */}
          <View style={s.factWide}>
            <StatTile
              label="Net worth"
              value={fmt(now.net_minor)}
              size="xl"
              tone={now.net_minor < 0 ? "neg" : undefined}
              sub={
                liabilities.length
                  ? `${fmtCompact(now.assets_minor)} owned less ${fmtCompact(now.liabilities_minor)} owed`
                  : "Nothing owed — assets only"
              }
            />
          </View>
          <View style={s.fact}>
            <StatTile
              label="Annualised return"
              value={fmtPct(rate)}
              size="sm"
              tone={rate === null ? undefined : rate < 0 ? "neg" : "pos"}
              sub={
                rate === null
                  ? "Needs dated contributions and a valuation"
                  : "XIRR — money-weighted, so SIP timing counts"
              }
            />
          </View>
          <View style={s.fact}>
            <StatTile
              label="Total gain"
              value={now.invested_minor > 0 ? fmtSigned(gainMinor) : "—"}
              size="sm"
              tone={now.invested_minor === 0 ? undefined : gainMinor < 0 ? "neg" : "pos"}
              sub={
                now.invested_minor > 0
                  ? `${fmtPct(abs)} on ${fmtCompact(now.invested_minor)} invested`
                  : "Nothing invested yet"
              }
            />
          </View>
          <View style={s.fact}>
            <StatTile
              label="Invested this month"
              value={fmtWhole(investedThisMonth)}
              size="sm"
              tone="amber"
              sub={
                target > 0
                  ? `${pct(investedThisMonth, target)}% of the ${fmtCompact(target)} monthly target`
                  : "No monthly target set"
              }
            />
          </View>
        </View>

        {drawdown && drawdown.depth >= 0.05 ? (
          <Banner tone="neutral" icon="info">
            {"The portfolio's worst fall so far was "}
            <Text style={s.strong}>{fmtPct(drawdown.depth)}</Text>
            {`, from its peak on ${fmtDate(drawdown.peakOn, { year: true })} to ${fmtDate(
              drawdown.troughOn,
              { year: true },
            )}. Worth knowing before the next one — it says what you have actually sat through.`}
          </Banner>
        ) : null}

        <NetWorth series={series} hasLiabilities={liabilities.length > 0} />

        {alloc.length > 0 ? <Allocation rows={alloc} total={now.assets_minor} /> : null}

        <Card title="Holdings" note="Value shown is the latest snapshot — a stale one is flagged.">
          <HoldingList rows={assets} kind="asset" />
        </Card>

        {liabilities.length > 0 ? (
          <Card title="What you owe" note="The latest snapshot is the balance outstanding.">
            <HoldingList rows={liabilities} kind="liability" />
          </Card>
        ) : null}

        {showArchived && holdings.some((h) => h.archived) ? (
          <Card title="Closed" note="Sold, matured or paid off. Kept for the history.">
            {/* Split by side even here: the columns mean opposite things, and a
                paid-off loan shown among the assets reads as a total loss. */}
            {(["asset", "liability"] as const).map((k) => {
              const rows = holdings.filter((h) => h.archived && h.side === k);
              return rows.length ? <HoldingList key={k} rows={rows} kind={k} /> : null;
            })}
          </Card>
        ) : null}
      </View>
    </>
  );
}

// ------------------------------------------------------------------ the pieces

/**
 * Net worth over a year, as assets and the net line on one scale.
 *
 * `yZero={false}` on purpose: net worth rarely starts near zero, and forcing the
 * axis down to it flattens a year of real movement into a horizontal line.
 */
function NetWorth({
  series,
  hasLiabilities,
}: {
  series: NetWorthPoint[];
  hasLiabilities: boolean;
}) {
  const s = useStyles(styles);
  const t = useTheme();

  if (series.length < 2) {
    return (
      <Card title="Net worth">
        <EmptyState
          icon="track"
          title="Not enough history yet"
          body="This chart carries each holding's latest valuation forward month by month. Record a second month of values and the line appears."
        />
      </Card>
    );
  }

  const lines: Series[] = [
    { points: series.map((r) => r.net_minor), color: t.c.green, fill: true, label: "Net" },
  ];
  // Drawing assets alongside net is only informative when they differ.
  if (hasLiabilities) {
    lines.push({ points: series.map((r) => r.assets_minor), color: t.c.blue, label: "Assets" });
  }

  const delta = series[series.length - 1].net_minor - series[0].net_minor;

  return (
    <Card
      title="Net worth"
      note="Each holding's latest valuation, carried forward to each month end"
      action={
        <Chip tone={delta < 0 ? "bad" : "good"} icon={delta < 0 ? "arrowDown" : "arrowUp"}>
          {`${fmtSigned(delta)} over ${series.length} months`}
        </Chip>
      }
    >
      {hasLiabilities ? (
        <View style={s.keyRow}>
          <View style={s.keyItem}>
            <Dot color={t.c.green} />
            <Text style={s.muted}>Net</Text>
          </View>
          <View style={s.keyItem}>
            <Dot color={t.c.blue} />
            <Text style={s.muted}>Assets</Text>
          </View>
        </View>
      ) : null}

      <LineChart
        series={lines}
        labels={series.map((r) => fmtMonthShort(r.month))}
        height={220}
        yZero={false}
      />
    </Card>
  );
}

/**
 * Allocation by asset type, with each slice's own gain beside it.
 *
 * The donut answers "where is it", the list under it answers "and is that working" —
 * a 60% equity slice that is down 8% is a different story from one that is up 22%,
 * and a donut alone cannot tell them apart.
 */
function Allocation({ rows, total }: { rows: AllocRow[]; total: number }) {
  const s = useStyles(styles);
  const t = useTheme();

  const slices = rows.map((r) => ({
    label: ASSET_TYPE_LABEL[r.asset_type as AssetType] ?? r.asset_type,
    value: r.value_minor,
    color: ASSET_TYPE_COLOR[r.asset_type as AssetType] ?? t.c.text3,
  }));

  return (
    <Card title="Allocation" note="Current value by type, and how each has done">
      <View style={s.donutWrap}>
        <DonutChart slices={slices} size={200} centreLabel="Assets" centreValue={fmtCompact(total)} />
      </View>

      <View style={s.allocList}>
        {rows.map((r) => {
          const type = r.asset_type as AssetType;
          const gain = r.value_minor - r.invested_minor;
          const color = ASSET_TYPE_COLOR[type] ?? t.c.text3;

          return (
            <View key={r.asset_type} style={s.allocRow}>
              <View style={s.allocLeft}>
                <Dot color={color} />
                <Text style={s.allocLabel} numberOfLines={1}>
                  {ASSET_TYPE_LABEL[type] ?? r.asset_type}
                </Text>
              </View>
              <Text style={s.allocValue}>{fmtWhole(r.value_minor)}</Text>
              <Text style={s.allocShare}>{`${Math.round(pct(r.value_minor, total))}%`}</Text>
              <Text
                style={[
                  s.allocGain,
                  r.invested_minor === 0
                    ? null
                    : { color: gain < 0 ? t.c.red : t.c.green },
                ]}
              >
                {r.invested_minor === 0
                  ? "—"
                  : fmtPct(absoluteReturn(r.invested_minor, r.value_minor))}
              </Text>
            </View>
          );
        })}
      </View>
    </Card>
  );
}

function HoldingList({ rows, kind }: { rows: HoldingRow[]; kind: "asset" | "liability" }) {
  const s = useStyles(styles);

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={kind === "liability" ? "receipt" : "invest"}
        title={kind === "liability" ? "Nothing owed" : "No holdings on this side"}
        body={
          kind === "liability"
            ? "Add a loan or a card balance and net worth becomes a subtraction rather than a guess."
            : undefined
        }
      />
    );
  }

  const total = rows.reduce((sum, h) => sum + h.value_minor, 0);

  return (
    <View style={s.holdingList}>
      {rows.map((h) => (
        <Holding key={h.id} h={h} kind={kind} total={total} />
      ))}
    </View>
  );
}

/** One row of the web's six-column holdings table, stacked for a narrow screen. */
function Holding({
  h,
  kind,
  total,
}: {
  h: HoldingRow;
  kind: "asset" | "liability";
  total: number;
}) {
  const s = useStyles(styles);
  const t = useTheme();
  const router = useRouter();

  const gain = h.value_minor - h.invested_minor;
  // A liability going down is the good direction, so the sign that counts is the
  // reverse of an asset's.
  const good = kind === "liability" ? gain <= 0 : gain >= 0;
  // Assigned to a local so the narrowing survives into the JSX below — the web
  // used a non-null assertion here.
  const valuedOn = h.last_valued_on;
  const color = ASSET_TYPE_COLOR[h.asset_type] ?? t.c.text3;

  const meta = [
    ASSET_TYPE_LABEL[h.asset_type] ?? h.asset_type,
    h.institution,
    h.units !== null ? `${h.units} units` : null,
  ]
    .filter((x): x is string => Boolean(x))
    .join(" · ");

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${h.name} — ${fmtWhole(h.value_minor)}`}
      onPress={() => router.push({ pathname: "/holding/[id]", params: { id: String(h.id) } })}
      style={({ pressed }) => [s.holding, pressed ? s.holdingPressed : null]}
    >
      <IconTile color={color} icon={assetIcon(h.asset_type)} size={34} />

      <View style={s.holdingMain}>
        <Text style={s.holdingName} numberOfLines={1}>
          {h.name}
        </Text>
        <Text style={s.holdingMeta} numberOfLines={1}>
          {meta}
        </Text>
        <Text style={s.holdingMeta}>
          {`${kind === "liability" ? "Borrowed" : "Invested"} ${fmtWhole(h.invested_minor)}`}
        </Text>
        {/* The web's share column — a 96px bar in its own cell. */}
        <View style={s.shareWrap}>
          <ProgressBar value={total > 0 ? h.value_minor / total : 0} color={color} height={6} />
        </View>
      </View>

      <View style={s.holdingRight}>
        <Text style={s.holdingValue}>{fmtWhole(h.value_minor)}</Text>
        <Text
          style={[
            s.holdingGain,
            h.invested_minor === 0 ? null : { color: good ? t.c.green : t.c.red },
          ]}
        >
          {h.invested_minor === 0
            ? "—"
            : kind === "liability"
              ? fmtWhole(Math.max(0, h.invested_minor - h.value_minor))
              : fmtSigned(gain)}
        </Text>
        {valuedOn === null ? (
          <Chip tone="warn">never valued</Chip>
        ) : (
          <Text style={s.holdingDate}>{fmtDate(valuedOn, { year: true })}</Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = (t: Theme) => ({
  // `.stack > * + * { margin-top: 20px }`.
  stack: { gap: space.gap + 4 } as ViewStyle,

  // `.grid.g-4`, wrapped — net worth full width, the rest two-up.
  factGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    rowGap: space.gap + 4,
    columnGap: space.gap,
  } as ViewStyle,
  factWide: { width: "100%" } as ViewStyle,
  fact: { width: "47%" } as ViewStyle,

  // `<strong>` inside a Banner, which supplies the tone colour itself.
  strong: { fontWeight: weight.medium } as TextStyle,

  // ----------------------------------------------------------- net worth card
  // The web put the two colour keys in the card's action row beside the chip. At
  // this width they go under the header instead, above the chart they describe.
  keyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    marginBottom: space.gapSm,
  } as ViewStyle,
  keyItem: { flexDirection: "row", alignItems: "center", gap: 6 } as ViewStyle,
  muted: { ...font.small13, color: t.c.text2 } as TextStyle,

  // ---------------------------------------------------------- allocation card
  donutWrap: { alignItems: "center", marginBottom: space.gap + 4 } as ViewStyle,
  allocList: { gap: space.gapSm } as ViewStyle,
  allocRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.gapSm,
    minHeight: 30,
  } as ViewStyle,
  allocLeft: { flexDirection: "row", alignItems: "center", gap: 8, flex: 1, minWidth: 0 } as ViewStyle,
  allocLabel: { ...font.small13, color: t.c.text, flexShrink: 1 } as TextStyle,
  // Fixed widths so the three numeric columns line up down the list, which is what
  // `.num` was doing in the table. The value gets a `minWidth` rather than a width,
  // because a crore-scale figure has to be allowed to push the others along.
  allocValue: {
    ...font.small13,
    ...tnum,
    color: t.c.text,
    minWidth: 74,
    textAlign: "right",
  } as TextStyle,
  allocShare: {
    ...font.small,
    ...tnum,
    color: t.c.text2,
    width: 38,
    textAlign: "right",
  } as TextStyle,
  allocGain: {
    ...font.small13,
    ...tnum,
    color: t.c.text2,
    width: 58,
    textAlign: "right",
  } as TextStyle,

  // ------------------------------------------------------------ holding rows
  holdingList: { gap: 4 } as ViewStyle,
  holding: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 11,
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderRadius: radius.sm,
  } as ViewStyle,
  holdingPressed: { backgroundColor: t.c.surface2 } as ViewStyle,
  holdingMain: { flex: 1, minWidth: 0, gap: 2 } as ViewStyle,
  holdingName: { ...font.entryTitle, color: t.c.text } as TextStyle,
  holdingMeta: { ...font.small, color: t.c.text3 } as TextStyle,
  shareWrap: { marginTop: 6, maxWidth: 140 } as ViewStyle,

  holdingRight: { alignItems: "flex-end", gap: 3 } as ViewStyle,
  holdingValue: { ...font.entryAmount, ...tnum, color: t.c.text } as TextStyle,
  holdingGain: { ...font.small, ...tnum, color: t.c.text2 } as TextStyle,
  holdingDate: { ...font.small, color: t.c.text3 } as TextStyle,
});
