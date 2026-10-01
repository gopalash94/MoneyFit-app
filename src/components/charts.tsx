/**
 * Every chart in the app — `Finance/src/components/charts.tsx`, in React Native.
 *
 * No chart library here either, for the same reason: the rings need exact control
 * over cap shape, track opacity and sweep direction, and these six components are
 * less code than bending a general-purpose library into this look. On the phone
 * there is a second reason — `react-native-svg` gives `<Path>`, `<Circle>`,
 * `<Rect>`, `<Line>`, `<G>` and `<Text>` with the same props as their HTML
 * counterparts, so the port is element names and nothing else. **Every geometry
 * string, radius, stroke width and threshold below is the web app's.**
 *
 * Four real differences, all forced by the platform rather than chosen:
 *
 * 1. **`width="100%"` does not exist.** A browser gives an `<svg>` with a viewBox
 *    and no height an intrinsic aspect ratio and sizes it from the box it is in.
 *    React Native has no intrinsic sizing, so `BarChart` and `LineChart` measure
 *    their container with `onLayout` and draw at that width.
 *
 *    That measurement also fixes a bug the naive port would have had. The web
 *    charts drew into a fixed 720-unit viewBox that the browser then scaled down
 *    to the card — which scales the 10px and 11px axis labels with it. Rendered at
 *    288dp, a 720-wide viewBox is scaled by 0.4 and an 11px label lands at 4.4dp:
 *    present, and unreadable. So **the measured width *is* the coordinate system**
 *    — one SVG unit is one dp, and a `fontSize={11}` label is 11dp on the glass.
 *    Everything else in the geometry was already expressed relative to `W`.
 *
 * 2. **Axis labels are thinned.** `LineChart` already aimed for ~8 x labels; on a
 *    phone `BarChart` needs the same treatment, because a 31-day month gives each
 *    bar about 9dp and thirty-one day numbers cannot share that. The rule is the
 *    web app's own: every `step`-th label plus the last one.
 *
 * 3. **`var(--blue)` is gone.** Colours that the CSS supplied as variables are now
 *    read from the palette at the point of use, so every `color` prop that had a
 *    `var(…)` default becomes optional and falls back to `useTheme()`. Call sites
 *    that passed an explicit colour still pass one — they just pass `t.c.text3`
 *    where they used to pass `"var(--text-3)"`.
 *
 * 4. **The ring sweep is `Animated`, not a CSS keyframe.** `@keyframes ring-draw`
 *    animated `stroke-dashoffset` from "empty" to the arc's real offset; here that
 *    is an `Animated.Value` on an animated `<Circle>`, with the same 900ms, the
 *    same `cubic-bezier(0.2, 0, 0, 1)` and the same 0/90/180ms stagger. It is
 *    React Native's built-in `Animated` and not Reanimated, which is deliberately
 *    not a dependency of this project. `useNativeDriver` is false because
 *    `strokeDashoffset` is an SVG attribute, not a view transform.
 *
 *    The whole thing sits behind `ANIMATE_RINGS` in tokens.ts. If the sweep
 *    misbehaves on a device this port cannot be tested against, flipping that one
 *    constant to `false` gives static rings drawn at their final offsets and
 *    changes nothing else on the screen.
 *
 * `BarRows` still takes **paise only** — it hardcodes `fmtWhole`. The eleven
 * analytics views expose `*_rupees` columns, so a row built from one of those must
 * not be handed to it. That constraint is the reason this note exists in both
 * copies of the file.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Animated, Easing, Text, View } from "react-native";
import type { LayoutChangeEvent, TextStyle, ViewStyle } from "react-native";
import { Circle, G, Line, Path, Rect, Svg, Text as SvgText } from "react-native-svg";

import { Dot, ProgressBar } from "@/components/ui";
import { fmtDayNum, fmtDayShort, type ISODate } from "@/lib/date";
import { fmtCompact, fmtWhole, pct } from "@/lib/money";
import type { RingData } from "@/lib/types";
import { useStyles, useTheme, type Theme } from "@/theme/ThemeProvider";
import {
  ANIMATE_RINGS,
  EASE,
  RING,
  duration,
  font,
  tnum,
  weight,
  type Palette,
} from "@/theme/tokens";

/* ------------------------------------------------------------- measurement */

/**
 * The container width, once React Native has laid it out.
 *
 * Zero on the first frame, which is why both callers reserve their full height and
 * draw nothing until the width arrives — a chart that changed height on the second
 * frame would shove the rest of the card down as you were reading it.
 */
function useChartWidth(): [number, (e: LayoutChangeEvent) => void] {
  const [w, setW] = useState(0);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const next = Math.round(e.nativeEvent.layout.width);
    // Guarded because onLayout fires on every re-measure, and an unconditional
    // setState in a layout callback is how you get a render loop.
    setW((prev) => (prev === next ? prev : next));
  }, []);
  return [w, onLayout];
}

/* ------------------------------------------------------------------ rings */

/** Blue carries the judgement, because a full spend ring is bad news. */
function spendColor(ratio: number, c: Palette): string {
  if (ratio >= 1) return c.red;
  if (ratio >= 0.85) return c.amber;
  return c.blue;
}

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

function Arc({
  r,
  frac,
  color,
  width,
  delay,
  track,
}: {
  r: number;
  frac: number;
  color: string;
  width: number;
  delay: number;
  track: string;
}) {
  const c = 2 * Math.PI * r;
  const shown = Math.max(0, Math.min(1, frac));
  const target = c * (1 - shown);

  // Starts at `c` — a full dash offset, which is an empty ring — so the first
  // frame is the same "empty" the CSS keyframe's `--dash-from` described.
  const offset = useRef(new Animated.Value(ANIMATE_RINGS ? c : target)).current;

  useEffect(() => {
    if (!ANIMATE_RINGS) {
      offset.setValue(target);
      return;
    }
    offset.setValue(c);
    const anim = Animated.timing(offset, {
      toValue: target,
      duration: duration.ring,
      delay,
      easing: Easing.bezier(EASE[0], EASE[1], EASE[2], EASE[3]),
      useNativeDriver: false,
    });
    anim.start();
    return () => anim.stop();
  }, [offset, c, target, delay]);

  const centre = RING.box / 2;

  return (
    <>
      <Circle cx={centre} cy={centre} r={r} fill="none" stroke={track} strokeWidth={width} />
      {/* A zero-length arc is omitted rather than drawn, exactly as on the web:
          a round cap on a zero-length dash paints a dot at twelve o'clock. */}
      {shown > 0 ? (
        <AnimatedCircle
          cx={centre}
          cy={centre}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={width}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          // `rotate(-90 …)` starts the sweep at twelve o'clock, not three.
          transform={`rotate(-90 ${centre} ${centre})`}
        />
      ) : null}
    </>
  );
}

/**
 * The hero. Three concentric rings: spend (outer, blue), goals (middle, green),
 * investing (inner, amber).
 *
 * The spend ring fills *as you spend* and the centre shows what is left — a fuel
 * gauge, the way every budgeting app reads. That inverts Fit's "full = good", so
 * colour does the interpreting: blue while comfortable, amber past 85%, red once
 * over. The other two fill toward a monthly target, where full genuinely is good.
 */
export function TripleRing({ data, size = 260 }: { data: RingData; size?: number }) {
  const t = useTheme();
  const s = useStyles(styles);

  const spendRatio = data.budgetMinor > 0 ? data.spentMinor / data.budgetMinor : 0;
  const goalRatio = data.goalTargetMinor > 0 ? data.goalFundedMinor / data.goalTargetMinor : 0;
  const investRatio = data.investTargetMinor > 0 ? data.investedMinor / data.investTargetMinor : 0;

  const leftMinor = data.budgetMinor - data.spentMinor;
  const over = leftMinor < 0;
  const [outer, middle, inner] = RING.radii;

  return (
    <View
      style={[s.ringWrap, { width: size, height: size }]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={`Spent ${fmtWhole(data.spentMinor)} of ${fmtWhole(data.budgetMinor)} budget`}
    >
      <Svg
        width={size}
        height={size}
        viewBox={`0 0 ${RING.box} ${RING.box}`}
        style={s.ringSvg}
      >
        <Arc r={outer} frac={spendRatio} color={spendColor(spendRatio, t.c)} width={RING.strokeWidth} delay={0} track={t.c.surface3} />
        <Arc r={middle} frac={goalRatio} color={t.c.green} width={RING.strokeWidth} delay={90} track={t.c.surface3} />
        <Arc r={inner} frac={investRatio} color={t.c.amber} width={RING.strokeWidth} delay={180} track={t.c.surface3} />
      </Svg>

      {/* Centre readout as Text rather than SVG <Text>, so it uses the app's font
          and tabular numerals — the same reason the web version used a div. */}
      <View style={[s.ringCentre, { width: size * 0.64 }]} pointerEvents="none">
        <Text style={[s.ringLabel, over ? { color: t.c.red } : null]}>
          {over ? "Over budget" : "Left to spend"}
        </Text>
        <Text
          style={[s.ringValue, over ? { color: t.c.red } : null]}
          numberOfLines={1}
          adjustsFontSizeToFit
        >
          {fmtCompact(Math.abs(leftMinor))}
        </Text>
        <Text style={s.ringSub}>of {fmtCompact(data.budgetMinor)}</Text>
      </View>
    </View>
  );
}

export function RingLegend({ data }: { data: RingData }) {
  const t = useTheme();
  const s = useStyles(styles);

  const rows = [
    {
      color: spendColor(data.budgetMinor > 0 ? data.spentMinor / data.budgetMinor : 0, t.c),
      label: "Spent",
      value: data.spentMinor,
      target: data.budgetMinor,
    },
    { color: t.c.green, label: "Into goals", value: data.goalFundedMinor, target: data.goalTargetMinor },
    { color: t.c.amber, label: "Invested", value: data.investedMinor, target: data.investTargetMinor },
  ];

  return (
    <View style={s.legendCol}>
      {rows.map((r) => (
        <View key={r.label}>
          <View style={[s.rowBetween, s.rowAboveBar]}>
            <View style={s.dotRow}>
              <Dot color={r.color} />
              <Text style={s.rowLabelStrong}>{r.label}</Text>
            </View>
            <Text style={s.rowValue}>
              {fmtWhole(r.value)} <Text style={s.rowValueDim}>/ {fmtWhole(r.target)}</Text>
            </Text>
          </View>
          <ProgressBar value={r.target > 0 ? r.value / r.target : 0} color={r.color} />
        </View>
      ))}
    </View>
  );
}

/* ------------------------------------------------------------- bar charts */

export type Bar = { label: string; value: number; color?: string; highlight?: boolean };

/**
 * Vertical bars — spend per day. Zero-value days still occupy their slot, which
 * is why `dailySpend` fills gaps in SQL: a compressed week would misread badly.
 */
export function BarChart({
  bars,
  height = 150,
  color,
  format = fmtCompact,
  showValues = false,
}: {
  bars: Bar[];
  height?: number;
  /** Defaults to the palette's blue, which is what `var(--blue)` was. */
  color?: string;
  format?: (minor: number) => string;
  showValues?: boolean;
}) {
  const t = useTheme();
  const [W, onLayout] = useChartWidth();

  if (!bars.length) return null;

  const max = Math.max(...bars.map((b) => b.value), 1);
  const H = height;
  const padBottom = 22;
  const padTop = showValues ? 18 : 6;
  const plot = H - padBottom - padTop;
  const slot = W / bars.length;
  const barW = Math.min(38, Math.max(4, slot * 0.56));

  // A label needs about 26dp to stand clear of its neighbour. Seven days always
  // fit; a 31-day month does not, so it gets every third or fourth day number —
  // the same "thin it and always keep the last one" rule LineChart uses.
  const labelStep = Math.max(1, Math.ceil(bars.length / Math.max(2, Math.floor(W / 26))));

  return (
    <View onLayout={onLayout} style={{ width: "100%", height: H }}>
      {W > 0 ? (
        <Svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
          {bars.map((b, i) => {
            const h = Math.max(b.value > 0 ? 3 : 0, (b.value / max) * plot);
            const x = i * slot + (slot - barW) / 2;
            const y = padTop + plot - h;
            const fill = b.color ?? color ?? t.c.blue;
            const labelled = i % labelStep === 0 || i === bars.length - 1;
            return (
              <G key={i}>
                {/* An empty day is a faint stub, not nothing — the gap still reads as a day. */}
                {b.value > 0 ? (
                  <Rect x={x} y={y} width={barW} height={h} rx={Math.min(6, barW / 2)} fill={fill} />
                ) : (
                  <Rect x={x} y={padTop + plot - 3} width={barW} height={3} rx={1.5} fill={t.c.surface3} />
                )}
                {showValues && b.value > 0 && labelled ? (
                  <SvgText
                    x={x + barW / 2}
                    y={y - 6}
                    textAnchor="middle"
                    fontSize={11}
                    fill={t.c.text3}
                  >
                    {format(b.value)}
                  </SvgText>
                ) : null}
                {labelled ? (
                  <SvgText
                    x={x + barW / 2}
                    y={H - 6}
                    textAnchor="middle"
                    fontSize={11}
                    fill={b.highlight ? t.c.text : t.c.text3}
                    fontWeight={b.highlight ? weight.semi : weight.regular}
                  >
                    {b.label}
                  </SvgText>
                ) : null}
              </G>
            );
          })}
        </Svg>
      ) : null}
    </View>
  );
}

/** Horizontal bars in category colours — the "where did it go" card. */
export function BarRows({
  rows,
  max,
}: {
  rows: { label: string; value: number; color: string; note?: string }[];
  /** Defaults to the largest row, so the top bar always fills. */
  max?: number;
}) {
  const t = useTheme();
  const s = useStyles(styles);
  const top = max ?? Math.max(...rows.map((r) => r.value), 1);

  return (
    <View style={s.barRows}>
      {rows.map((r) => (
        <View key={r.label}>
          <View style={[s.rowBetween, s.rowAboveBar]}>
            <Text style={s.rowLabelStrong} numberOfLines={1}>
              {r.label}
            </Text>
            <Text style={s.rowValue}>
              {fmtWhole(r.value)}
              {r.note ? <Text style={s.rowValueDim}> · {r.note}</Text> : null}
            </Text>
          </View>
          {/* `.bar-track` / `.bar-fill` — 8px rather than the progress bar's 6px,
              and it is its own row beneath the labels, as the CSS grid had it. */}
          <View style={[s.barTrack, { backgroundColor: t.c.surface3 }]}>
            <View style={{ flex: Math.max(2, pct(r.value, top)), backgroundColor: r.color, borderRadius: 4 }} />
            <View style={{ flex: Math.max(0, 100 - Math.max(2, pct(r.value, top))) }} />
          </View>
        </View>
      ))}
    </View>
  );
}

/* ------------------------------------------------------------ line charts */

export type Series = {
  points: number[];
  color: string;
  /** Dashed = projected, not observed. Used by the net-worth trajectory. */
  dashed?: boolean;
  fill?: boolean;
  label?: string;
};

/**
 * Multi-series line chart. Shares one y-scale across every series, because the
 * whole point of overlaying budget-vs-actual or actual-vs-projected is that the
 * two are directly comparable.
 */
export function LineChart({
  series,
  labels,
  height = 180,
  yZero = true,
  format = fmtCompact,
}: {
  series: Series[];
  /** X labels; thinned automatically so they never collide. */
  labels?: string[];
  height?: number;
  /** False lets the y-axis start at the data minimum — right for net worth. */
  yZero?: boolean;
  format?: (minor: number) => string;
}) {
  const t = useTheme();
  const [W, onLayout] = useChartWidth();

  const all = series.flatMap((sr) => sr.points);
  if (all.length < 2) return null;

  const H = height;
  const padL = 54;
  const padR = 10;
  const padT = 10;
  const padB = labels?.length ? 24 : 10;

  const rawMin = Math.min(...all);
  const rawMax = Math.max(...all);
  const lo = yZero ? Math.min(0, rawMin) : rawMin - (rawMax - rawMin) * 0.1;
  const hi = rawMax === lo ? lo + 1 : rawMax + (rawMax - lo) * 0.08;

  const n = Math.max(...series.map((sr) => sr.points.length));
  const x = (i: number) => padL + (i / Math.max(1, n - 1)) * (W - padL - padR);
  const y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);

  const ticks = [lo, lo + (hi - lo) / 2, hi];
  // Aim for ~8 x labels regardless of series length.
  const step = labels?.length ? Math.max(1, Math.ceil(labels.length / 8)) : 1;

  return (
    <View onLayout={onLayout} style={{ width: "100%", height: H }}>
      {W > 0 ? (
        <Svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
          {ticks.map((tick, i) => (
            <G key={i}>
              <Line x1={padL} x2={W - padR} y1={y(tick)} y2={y(tick)} stroke={t.c.borderSoft} strokeWidth={1} />
              <SvgText x={padL - 8} y={y(tick) + 4} textAnchor="end" fontSize={10} fill={t.c.text3}>
                {format(tick)}
              </SvgText>
            </G>
          ))}

          {series.map((sr, si) => {
            const d = sr.points
              .map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`)
              .join(" ");
            return (
              <G key={si}>
                {sr.fill ? (
                  <Path
                    d={`${d} L${x(sr.points.length - 1).toFixed(1)} ${y(lo).toFixed(1)} L${x(0).toFixed(1)} ${y(lo).toFixed(1)} Z`}
                    fill={sr.color}
                    opacity={0.1}
                  />
                ) : null}
                <Path
                  d={d}
                  fill="none"
                  stroke={sr.color}
                  strokeWidth={2.4}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray={sr.dashed ? "5 5" : undefined}
                />
              </G>
            );
          })}

          {labels?.map((l, i) =>
            i % step === 0 || i === labels.length - 1 ? (
              <SvgText key={i} x={x(i)} y={H - 6} textAnchor="middle" fontSize={10} fill={t.c.text3}>
                {l}
              </SvgText>
            ) : null,
          )}
        </Svg>
      ) : null}
    </View>
  );
}

/** A bare trend line with no axes — for inline use inside a stat tile. */
export function Sparkline({
  points,
  color,
  width = 180,
  height = 44,
}: {
  points: number[];
  color?: string;
  width?: number;
  height?: number;
}) {
  const t = useTheme();
  if (points.length < 2) return null;

  const stroke = color ?? t.c.blue;
  const lo = Math.min(...points);
  const hi = Math.max(...points);
  const span = hi - lo || 1;
  const x = (i: number) => (i / (points.length - 1)) * (width - 4) + 2;
  const y = (v: number) => height - 3 - ((v - lo) / span) * (height - 8);

  const d = points.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const last = points.length - 1;
  // `points[last]` is safe: length >= 2 was checked above. Noted because the
  // project does not enable `noUncheckedIndexedAccess`, so nothing else says so.
  const lastValue = points[last] as number;

  // No viewBox: this one was always sized in real pixels, so its units already
  // are dp and its coordinates need no scaling.
  return (
    <Svg width={width} height={height}>
      <Path
        d={`${d} L${x(last).toFixed(1)} ${height} L${x(0).toFixed(1)} ${height} Z`}
        fill={stroke}
        opacity={0.12}
      />
      <Path d={d} fill="none" stroke={stroke} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Circle cx={x(last)} cy={y(lastValue)} r={3} fill={stroke} />
    </Svg>
  );
}

/* ----------------------------------------------------------------- donut */

/**
 * Allocation donut.
 *
 * Built from stroked arcs on a shared radius rather than wedge paths: one
 * `strokeDasharray` per slice is far less arithmetic than four arc commands, and
 * there is no seam where two filled wedges meet.
 */
export function DonutChart({
  slices,
  size = 200,
  thickness = 26,
  centreLabel,
  centreValue,
}: {
  slices: { label: string; value: number; color: string }[];
  size?: number;
  thickness?: number;
  centreLabel?: string;
  centreValue?: string;
}) {
  const t = useTheme();
  const s = useStyles(styles);

  const total = slices.reduce((sum, sl) => sum + sl.value, 0);
  if (total <= 0) return null;

  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let acc = 0;

  return (
    <View
      style={[s.ringWrap, { width: size, height: size }]}
      accessible
      accessibilityRole="image"
      accessibilityLabel="Allocation"
    >
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={s.ringSvg}>
        <Circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={t.c.surface3} strokeWidth={thickness} />
        {slices.map((sl) => {
          const len = (sl.value / total) * c;
          // A 1.5px gap between slices reads as separation without a border.
          const seg = Math.max(0, len - 1.5);
          const el = (
            <Circle
              key={sl.label}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={sl.color}
              strokeWidth={thickness}
              strokeDasharray={`${seg} ${c - seg}`}
              strokeDashoffset={-acc}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          );
          acc += len;
          return el;
        })}
      </Svg>
      {centreLabel || centreValue ? (
        <View style={[s.ringCentre, { width: size - thickness * 2 - 8 }]} pointerEvents="none">
          {centreLabel ? <Text style={s.ringLabel}>{centreLabel}</Text> : null}
          {centreValue ? (
            <Text style={s.donutValue} numberOfLines={1} adjustsFontSizeToFit>
              {centreValue}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** Shared legend for the donut and any multi-series chart. */
export function Legend({
  items,
  total,
}: {
  items: { label: string; value: number; color: string }[];
  /** Supplied to show a share percentage beside each row. */
  total?: number;
}) {
  const s = useStyles(styles);
  return (
    <View style={s.legendColTight}>
      {items.map((i) => (
        <View key={i.label} style={s.rowBetween}>
          <View style={s.dotRow}>
            <Dot color={i.color} />
            <Text style={s.rowLabel} numberOfLines={1}>
              {i.label}
            </Text>
          </View>
          <Text style={s.rowValue}>
            {fmtCompact(i.value)}
            {total ? <Text style={s.rowValueDim}> · {pct(i.value, total).toFixed(0)}%</Text> : null}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * Dates in, labelled bars out. Weekday names for a week-length range, day
 * numbers past that — thirty "Wed"s would be unreadable.
 */
export function toDayBars(rows: { day: ISODate; total_minor: number }[], todayIso: ISODate): Bar[] {
  const label = rows.length > 10 ? fmtDayNum : fmtDayShort;
  return rows.map((r) => ({
    label: label(r.day),
    value: r.total_minor,
    highlight: r.day === todayIso,
  }));
}

/* ------------------------------------------------------------------ styles */

const styles = (t: Theme) => ({
  // The shared shape of TripleRing and DonutChart: a fixed square with the SVG
  // behind and the centre readout laid out normally on top of it.
  ringWrap: { alignItems: "center", justifyContent: "center" } as ViewStyle,
  ringSvg: { position: "absolute", top: 0, left: 0 } as ViewStyle,
  ringCentre: { alignItems: "center" } as ViewStyle,

  // `.metric-label` / `.metric-value` at the ring's own 34px / -1.2px / `.metric-sub`.
  ringLabel: { ...font.metricLabel, color: t.c.text2, textAlign: "center" } as TextStyle,
  ringValue: {
    fontSize: 34,
    fontWeight: weight.light,
    letterSpacing: -1.2,
    ...tnum,
    color: t.c.text,
    textAlign: "center",
  } as TextStyle,
  ringSub: { ...font.small, color: t.c.text3, textAlign: "center" } as TextStyle,
  /** The donut's centre figure was 24px / -0.6px. */
  donutValue: {
    fontSize: 24,
    fontWeight: weight.light,
    letterSpacing: -0.6,
    ...tnum,
    color: t.c.text,
    textAlign: "center",
  } as TextStyle,

  // RingLegend's `.col` at 16px, Legend's at 10px.
  legendCol: { gap: 16 } as ViewStyle,
  legendColTight: { gap: 10 } as ViewStyle,

  // `.row-between` — the label on the left, the figure on the right.
  rowBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  } as ViewStyle,
  /** Only where a bar sits underneath: Legend's rows are flush, as the CSS had them. */
  rowAboveBar: { marginBottom: 6 } as ViewStyle,
  dotRow: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1, minWidth: 0 } as ViewStyle,
  rowLabel: { ...font.small, color: t.c.text, flexShrink: 1 } as TextStyle,
  /** `.small.strong` */
  rowLabelStrong: { ...font.small, fontWeight: weight.medium, color: t.c.text, flexShrink: 1 } as TextStyle,
  /** `.small.tnum.muted` */
  rowValue: { ...font.small, ...tnum, color: t.c.text2 } as TextStyle,
  /** `.dim` — the nested "/ target" and "· 34%" halves. */
  rowValueDim: { color: t.c.text3 } as TextStyle,

  // `.bar-row` / `.bar-track`
  barRows: { gap: 14 } as ViewStyle,
  barTrack: { height: 8, borderRadius: 4, flexDirection: "row", overflow: "hidden" } as ViewStyle,
});
