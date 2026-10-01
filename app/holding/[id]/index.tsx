/**
 * One holding, with the return worked out rather than asserted —
 * `Finance/src/app/invest/[id]/page.tsx`.
 *
 * The web's header still says what the chart is for: it draws money in against what
 * the thing is worth, because that pairing is the whole story of an investment. Two
 * lines converging is a bad year, the gap widening is a good one, and a single
 * current-value figure shows neither. Both are sampled on one shared axis of dates so
 * they are directly comparable — and the axis starts at the first valuation, because
 * before that date nobody knows what the thing was worth and drawing a line there
 * would be an invention.
 *
 * The same four substitutions as the goal screen beside it, for the same reasons.
 * `notFound()` became a `{ holding: null }` loader result and a `<NotFound/>` render,
 * which also covers a junk id. The `.grid.g-4` of return figures wraps two-up at 47%.
 * Both tables became row lists. And the two forms come before the two lists, which on
 * the web sat beside each other in a `g-2-1` — one column can only keep one of those,
 * and burying "log several in a row" under forty rows of history makes the note a lie.
 *
 * One thing this screen has that the goal screen does not: **three banners that can
 * all be true at once** — closed, stale, never valued. They stay in the web's order,
 * because it runs from the most to the least conclusive.
 */

import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Text, View } from "react-native";
import type { TextStyle, ViewStyle } from "react-native";

import { LineChart, type Series } from "@/components/charts";
import { ContributionForm } from "@/components/ContributionForm";
import { ActionButton, DangerButton } from "@/components/form";
import { Screen } from "@/components/Screen";
import {
  Banner, Card, Chip, Dot, EmptyState, IconTile, LinkButton, NotFound, PageHead, StatTile,
} from "@/components/ui";
import { ValuationForm } from "@/components/ValuationForm";
import {
  addHoldingContribution, addValuation, deleteHolding, deleteHoldingContribution,
  deleteValuation, setHoldingArchived,
} from "@/lib/actions/holdings";
import { assetIcon } from "@/lib/asset-icon";
import { daysBetween, fmtDate, today, type ISODate } from "@/lib/date";
import { useLive } from "@/lib/live";
import { fmt, fmtSigned, fmtWhole } from "@/lib/money";
import { getHolding, holdingContributions, holdingValuations } from "@/lib/queries/holdings";
import {
  ASSET_TYPE_COLOR, ASSET_TYPE_LABEL,
  type Contribution, type HoldingRow, type Valuation,
} from "@/lib/types";
import { absoluteReturn, fmtPct, holdingFlows, maxDrawdown, xirr } from "@/lib/xirr";
import { useStyles, useTheme, type Theme } from "@/theme/ThemeProvider";
import { font, radius, space, tnum } from "@/theme/tokens";

type Loaded = {
  /** Null for both "no such row" and "not a valid id" — one branch renders both. */
  holding: HoldingRow | null;
  contributions: Contribution[];
  valuations: Valuation[];
};

const NONE: Loaded = { holding: null, contributions: [], valuations: [] };

async function load(n: number): Promise<Loaded> {
  if (!Number.isInteger(n) || n <= 0) return NONE;

  const holding = await getHolding(n);
  if (!holding) return NONE;

  const [contributions, valuations] = await Promise.all([
    holdingContributions(n),
    holdingValuations(n),
  ]);
  return { holding, contributions, valuations };
}

export default function HoldingScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const n = Number(typeof params.id === "string" ? params.id : "");
  const live = useLive(() => load(n), [n]);

  function back() {
    if (router.canGoBack()) router.back();
    else router.replace("/invest");
  }

  return (
    <>
      <Stack.Screen options={{ title: live.data?.holding?.name ?? "Holding" }} />
      <Screen live={live}>
        {(data) =>
          data.holding ? (
            <Detail
              holding={data.holding}
              contributions={data.contributions}
              valuations={data.valuations}
            />
          ) : (
            <NotFound what="holding" onBack={back} />
          )
        }
      </Screen>
    </>
  );
}

function Detail({ holding: h, contributions, valuations }: Loaded & { holding: HoldingRow }) {
  const s = useStyles(styles);
  const t = useTheme();
  const router = useRouter();

  const id = h.id;
  const now = today();
  const liability = h.side === "liability";
  const color = ASSET_TYPE_COLOR[h.asset_type] ?? t.c.blue;
  const latest = valuations.length ? valuations[valuations.length - 1] : null;

  const gainMinor = h.value_minor - h.invested_minor;
  const abs = absoluteReturn(h.invested_minor, h.value_minor);
  // XIRR is only meaningful for something that can appreciate. A loan's flows are
  // the reverse shape and the rate it would produce is not the interest rate.
  const rate = liability ? null : xirr(holdingFlows(contributions, latest));
  const dd = liability ? null : maxDrawdown(valuations);

  const staleDays = latest ? daysBetween(latest.as_of, now) : null;
  // Bundled rather than tested twice, so the banner needs no non-null assertion.
  const stale =
    latest !== null && staleDays !== null && staleDays > 45 && !h.archived
      ? { asOf: latest.as_of, days: staleDays }
      : null;
  const withdrawals = contributions.filter((c) => c.amount_minor < 0);

  const subline = [
    ASSET_TYPE_LABEL[h.asset_type] ?? h.asset_type,
    h.institution,
    h.units !== null ? `${h.units} units` : null,
  ]
    .filter((x): x is string => !!x)
    .join(" · ");

  return (
    <>
      <PageHead title={h.name} sub={subline}>
        <LinkButton
          href={{ pathname: "/holding/[id]/edit", params: { id: String(id) } }}
          label="Edit"
          icon="edit"
          variant="outline"
          small
        />

        <ActionButton
          action={() => setHoldingArchived(id, !h.archived)}
          icon={h.archived ? "undo" : "check"}
        >
          {h.archived ? "Reopen" : liability ? "Mark paid off" : "Mark closed"}
        </ActionButton>

        <DangerButton
          action={() => deleteHolding(id)}
          label="Delete"
          confirm={
            contributions.length || valuations.length
              ? `Delete “${h.name}”, its ${contributions.length} contribution${
                  contributions.length === 1 ? "" : "s"
                } and ${valuations.length} valuation${
                  valuations.length === 1 ? "" : "s"
                }? This cannot be undone — close it instead to keep the history.`
              : `Delete “${h.name}”? This cannot be undone.`
          }
          onDone={() => router.replace("/invest")}
        />
      </PageHead>

      {h.archived ? (
        <View style={s.bannerWrap}>
          <Banner tone="neutral" icon="info">
            This holding is closed. It keeps its history here but is left out of net worth,
            the allocation donut and the portfolio return. Contributions you made stay
            counted in the month you made them — closing it now does not unspend that money.
          </Banner>
        </View>
      ) : null}

      {stale ? (
        <View style={s.bannerWrap}>
          <Banner tone="warn" icon="clock">
            {`Last valued ${fmtDate(stale.asOf, { year: true })} — ${stale.days} days ago. Every figure below still uses that snapshot, so the return is as old as the number it came from.`}
          </Banner>
        </View>
      ) : null}

      {valuations.length === 0 ? (
        <View style={s.bannerWrap}>
          <Banner tone="warn" icon="alert">
            Never valued. Until you record what this is worth it counts as zero in net
            worth — record a value below, even if it is just what you put in.
          </Banner>
        </View>
      ) : null}

      <View style={s.stack}>
        <Card>
          <View style={s.heroRow}>
            <IconTile color={color} icon={assetIcon(h.asset_type)} size={52} />
            <View style={s.heroMain}>
              <StatTile
                label={liability ? "Outstanding" : "Worth today"}
                value={fmt(h.value_minor)}
                size="xl"
                tone={liability ? "neg" : undefined}
                sub={
                  <View style={s.chipRow}>
                    {h.invested_minor > 0 ? (
                      <Chip
                        tone={
                          gainMinor === 0
                            ? "neutral"
                            : (liability ? gainMinor < 0 : gainMinor > 0)
                              ? "good"
                              : "bad"
                        }
                        icon={gainMinor < 0 ? "arrowDown" : gainMinor > 0 ? "arrowUp" : undefined}
                      >
                        {liability
                          ? `${fmtWhole(Math.max(0, h.invested_minor - h.value_minor))} repaid`
                          : `${fmtSigned(gainMinor)} · ${fmtPct(abs)}`}
                      </Chip>
                    ) : null}
                    {rate !== null ? (
                      <Chip tone={rate < 0 ? "bad" : "good"}>{`${fmtPct(rate)} a year`}</Chip>
                    ) : null}
                    {latest ? (
                      <Chip
                        tone={staleDays !== null && staleDays > 45 ? "warn" : "neutral"}
                        icon="clock"
                      >
                        {`valued ${fmtDate(latest.as_of, { year: true })}`}
                      </Chip>
                    ) : null}
                  </View>
                }
              />
            </View>
          </View>

          <View style={s.factGrid}>
            <View style={s.fact}>
              <StatTile
                label={liability ? "Borrowed in total" : "Money in"}
                value={fmtWhole(h.invested_minor)}
                size="sm"
                sub={
                  withdrawals.length
                    ? `net of ${withdrawals.length} withdrawal${
                        withdrawals.length === 1 ? "" : "s"
                      }`
                    : `${contributions.length} entr${contributions.length === 1 ? "y" : "ies"}`
                }
              />
            </View>
            <View style={s.fact}>
              <StatTile
                label={liability ? "Still owed" : "Gain"}
                value={
                  h.invested_minor === 0
                    ? "—"
                    : liability
                      ? fmtWhole(h.value_minor)
                      : fmtSigned(gainMinor)
                }
                size="sm"
                tone={
                  h.invested_minor === 0
                    ? undefined
                    : liability
                      ? "neg"
                      : gainMinor < 0
                        ? "neg"
                        : "pos"
                }
                sub={h.invested_minor === 0 ? "nothing in yet" : fmtPct(abs)}
              />
            </View>
            <View style={s.fact}>
              <StatTile
                label="Annualised"
                value={fmtPct(rate)}
                size="sm"
                tone={rate === null ? undefined : rate < 0 ? "neg" : "pos"}
                sub={
                  liability
                    ? "not meaningful for a debt"
                    : rate === null
                      ? "needs two dated flows"
                      : "XIRR — timing counts"
                }
              />
            </View>
            <View style={s.fact}>
              <StatTile
                label="Worst fall"
                value={dd ? fmtPct(dd.depth) : "—"}
                size="sm"
                tone={dd && dd.depth > 0.1 ? "neg" : undefined}
                sub={
                  dd
                    ? `${fmtDate(dd.peakOn)} → ${fmtDate(dd.troughOn)}`
                    : liability
                      ? "not tracked for a debt"
                      : "no drop recorded yet"
                }
              />
            </View>
          </View>

          {h.notes ? (
            <View style={s.notesWrap}>
              <Text style={s.kvK}>Notes</Text>
              <Text style={s.kvText}>{h.notes}</Text>
            </View>
          ) : null}
        </Card>

        <Progress
          contributions={contributions}
          valuations={valuations}
          color={color}
          liability={liability}
        />

        <Card title={liability ? "Draw or repay" : "Add money"} note="Stays on this screen — log several in a row.">
          <ContributionForm
            action={(prev, fd) => addHoldingContribution(id, prev, fd)}
            today={now}
            verb={liability ? "Record" : "Add contribution"}
            withdrawLabel={liability ? "This was a repayment" : "This was a withdrawal"}
          />
        </Card>

        <Card
          title={liability ? "Update the balance" : "Record a value"}
          note={
            liability
              ? "What is outstanding today. Zero once it is paid off."
              : "A snapshot from the app or statement. The more you record, the better the chart."
          }
        >
          <ValuationForm
            action={(prev, fd) => addValuation(id, prev, fd)}
            today={now}
            label={liability ? "Outstanding" : "Worth today"}
            hint={
              latest
                ? `Last recorded: ${fmtWhole(latest.value_minor)} on ${fmtDate(latest.as_of, {
                    year: true,
                  })}`
                : undefined
            }
          />
        </Card>

        <Card
          title={
            contributions.length
              ? `${liability ? "Borrowing & repayments" : "Contributions"} · ${contributions.length}`
              : liability
                ? "Borrowing & repayments"
                : "Contributions"
          }
          note={
            liability ? "A repayment is a withdrawal — it reduces what you've drawn." : undefined
          }
        >
          {contributions.length === 0 ? (
            <EmptyState
              icon="coins"
              title="Nothing recorded"
              body="Add what you've put in, back-dated to when it actually went in. XIRR is computed from these dates, so honest dates give an honest rate."
            />
          ) : (
            <View style={s.rowList}>
              {contributions.map((c) => (
                <ContributionRow key={c.id} c={c} />
              ))}
            </View>
          )}
        </Card>

        {valuations.length > 0 ? (
          <Card title={`Value history · ${valuations.length}`}>
            <ValueHistory valuations={valuations} liability={liability} />
          </Card>
        ) : null}
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
    <View style={s.listRow}>
      <View style={s.rowText}>
        <Text style={s.muted}>{fmtDate(c.txn_date, { year: true })}</Text>
        {c.note ? (
          <Text style={s.dim} numberOfLines={2}>
            {c.note}
          </Text>
        ) : null}
      </View>
      <Text style={out ? s.amountBad : s.amount}>{fmtSigned(c.amount_minor)}</Text>
      <DangerButton
        action={() => deleteHoldingContribution(c.id)}
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
 * The value-history table, newest first.
 *
 * The web read the previous snapshot as `rows[i + 1]` and relied on the last row's
 * lookup being `undefined`. That still works, but without `noUncheckedIndexedAccess`
 * TypeScript would not admit it can be — so the bound is checked explicitly rather
 * than left to a type the compiler believes is always present.
 */
function ValueHistory({
  valuations,
  liability,
}: {
  valuations: Valuation[];
  liability: boolean;
}) {
  const s = useStyles(styles);
  const rows = [...valuations].reverse();

  return (
    <View style={s.rowList}>
      {rows.map((v, i) => {
        const prev = i + 1 < rows.length ? rows[i + 1] : null;
        const delta = prev ? v.value_minor - prev.value_minor : null;
        const deltaStyle =
          delta === null || delta === 0
            ? s.dim
            : (liability ? delta < 0 : delta > 0)
              ? s.deltaGood
              : s.deltaBad;

        return (
          <View key={v.id} style={s.listRow}>
            <View style={s.rowText}>
              <Text style={s.muted}>{fmtDate(v.as_of, { year: true })}</Text>
              <Text style={deltaStyle}>{delta === null ? "first" : fmtSigned(delta)}</Text>
            </View>
            <Text style={s.amount}>{fmtWhole(v.value_minor)}</Text>
            <DangerButton
              action={() => deleteValuation(v.id)}
              label="Remove"
              confirm={`Remove the ${fmtWhole(v.value_minor)} snapshot from ${fmtDate(v.as_of, {
                year: true,
              })}?`}
            />
          </View>
        );
      })}
    </View>
  );
}

/**
 * Money in against what it is worth, on one shared axis.
 *
 * The axis is the union of valuation dates and any contribution dated after the
 * first valuation — every date on which one of the two lines actually changes.
 * Contributions made before the first valuation are not dropped: they are already
 * inside the invested line's opening level. Between valuations the value line is
 * carried flat, which is the last thing actually known rather than an interpolation
 * through days nobody measured.
 *
 * The one edit from the web is the colour: `"var(--text-3)"` became `t.c.text3`,
 * because `react-native-svg` has no custom properties to resolve.
 */
function Progress({
  contributions,
  valuations,
  color,
  liability,
}: {
  contributions: Contribution[];
  valuations: Valuation[];
  color: string;
  liability: boolean;
}) {
  const s = useStyles(styles);
  const t = useTheme();

  if (valuations.length < 2) {
    return (
      <Card title={liability ? "Balance over time" : "Value over time"}>
        <EmptyState
          icon="track"
          title="One more snapshot and this becomes a chart"
          body={
            liability
              ? "Record the outstanding balance a second time and this plots what you owe against what you've drawn."
              : "Record a value a second time and this plots what it's worth against what you've put in — which is the only way to see whether the gap is widening."
          }
        />
      </Card>
    );
  }

  const start = valuations[0].as_of;
  const dates = new Set<ISODate>(valuations.map((v) => v.as_of));
  for (const c of contributions) if (c.txn_date > start) dates.add(c.txn_date);
  const axis = [...dates].sort();

  const investedAt = (date: ISODate) =>
    contributions.reduce((sum, c) => (c.txn_date <= date ? sum + c.amount_minor : sum), 0);

  const valueAt = (date: ISODate) => {
    let v = valuations[0].value_minor;
    for (const snap of valuations) {
      if (snap.as_of > date) break;
      v = snap.value_minor;
    }
    return v;
  };

  const series: Series[] = [
    { points: axis.map(investedAt), color: t.c.text3, dashed: true, label: "In" },
    { points: axis.map(valueAt), color, fill: true, label: "Worth" },
  ];

  return (
    <Card
      title={liability ? "Balance over time" : "Value over time"}
      note={
        liability
          ? "Outstanding against total drawn — the gap is what you've repaid"
          : "Worth against money in — the gap is the gain"
      }
      action={
        <View style={s.legend}>
          <View style={s.legendItem}>
            <Dot color={color} />
            <Text style={s.muted}>{liability ? "Outstanding" : "Worth"}</Text>
          </View>
          <View style={s.legendItem}>
            <Dot color={t.c.text3} />
            <Text style={s.muted}>{liability ? "Drawn" : "Money in"}</Text>
          </View>
        </View>
      }
    >
      <LineChart
        series={series}
        labels={axis.map((d) => fmtDate(d))}
        height={220}
        yZero={false}
      />
    </Card>
  );
}

const styles = (t: Theme) => ({
  // `.stack > * + * { margin-top: 20px }`.
  stack: { gap: space.gap + 4 } as ViewStyle,
  bannerWrap: { marginBottom: space.gap } as ViewStyle,

  heroRow: { flexDirection: "row", alignItems: "flex-start", gap: space.gap } as ViewStyle,
  heroMain: { flex: 1, minWidth: 0 } as ViewStyle,
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 } as ViewStyle,

  // `.grid.g-4`, wrapped two-up — the same arithmetic as the bill screen's `.kv`.
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
  amountBad: { ...font.small13, ...tnum, color: t.c.red, textAlign: "right" } as TextStyle,
  deltaGood: { ...font.small, ...tnum, color: t.c.green } as TextStyle,
  deltaBad: { ...font.small, ...tnum, color: t.c.red } as TextStyle,

  // -------------------------------------------------- contributions & history
  rowList: { gap: 2 } as ViewStyle,
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.gapSm,
    minHeight: 48,
    paddingHorizontal: 4,
    borderRadius: radius.sm,
  } as ViewStyle,
  rowText: { flex: 1, minWidth: 0, gap: 2 } as ViewStyle,

  legend: { flexDirection: "row", alignItems: "center", gap: 14 } as ViewStyle,
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 } as ViewStyle,
});
