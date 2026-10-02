/**
 * The shared presentation pieces — `Finance/src/components/ui.tsx`, in React Native.
 *
 * **Every prop signature is unchanged**, deliberately: these thirteen components
 * are what the twenty-odd screens are made of, so keeping `<Card title=… note=…>`
 * and `<StatTile label value tone size>` identical is what lets the screens be
 * ported by swapping their wrappers rather than rewritten. Two signatures had to
 * move, and both are mechanical:
 *
 *   - **`className` → `style`.** There is no cascade; the CSS classes live in the
 *     `styles(t)` factory at the bottom of this file.
 *   - **`cta.href` and `SeeAll`'s `href`** are no longer `string`. `typedRoutes`
 *     is on in app.json, so expo-router's href is a union of the app's real
 *     routes — which is strictly better (a typo in a path is now a type error).
 *     The type is *derived from `Link` itself* rather than imported by name, so
 *     it cannot drift with the router's own naming.
 *
 * Where the CSS used a variable the component now takes a colour from the
 * palette, so `ProgressBar`'s `color`/`track` and `StatTile`'s `tone` resolve
 * through `useTheme()` instead of through `var(--blue)`. `Tone`'s five values map
 * to explicit background/foreground pairs in `chipTone`/`bannerTone`, including
 * the one split the web app needed a dark-mode override for: warn text is the
 * hand-picked `#b06000` in light and `--amber` in dark, which is `warnText`.
 *
 * ### The one rule callers have to know
 *
 * React Native cannot render a bare string inside a `View`. Every `React.ReactNode`
 * slot here (`sub`, `Banner`'s children, `PageHead`'s `sub`) therefore accepts
 * either a plain string — which is wrapped in the right `<Text>` automatically —
 * or elements. What it cannot accept is *mixed inline content*: a fragment of
 * `"text " + <strong> + " more text"` has to be written by the caller as one
 * `<Text>` with nested `<Text>`s, the way `AiNotConfigured` below does it. There
 * is no `<code>`, `<pre>` or `<strong>`, so all three became styled `<Text>`.
 *
 * Two additions beyond the web file, both earned:
 *
 *   - **`Loading`** — the web app had no such state because a server component
 *     had already finished its query before anything rendered. `useLive` has a
 *     first paint with no data, and its own docs point here for this.
 *   - **`LinkButton`** — `.btn` as a real component, because `EmptyState` and
 *     `SeeAll` both needed it and the screens need it for every "Add a bill"
 *     that is a navigation rather than a form submit. `form.tsx` still owns the
 *     buttons that submit.
 *
 * Two copy rewrites, because the words were about the web deployment:
 * `DbUnavailable` talked about Postgres starting up and `docker compose up`, and
 * `AiNotConfigured` talked about `.env` and restarting the stack. On the phone
 * the database is a file that either opened or did not, and the key is a field in
 * Settings.
 */

import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { StyleProp, TextStyle, ViewStyle } from "react-native";
import { Link } from "expo-router";

import { Icon, type IconName } from "@/components/Icon";
import { useStyles, useTheme, type Theme } from "@/theme/ThemeProvider";
import { font, radius, space, tnum } from "@/theme/tokens";

export type Tone = "good" | "warn" | "bad" | "info" | "neutral";

/**
 * The href type, taken from `Link` rather than imported as `Href`.
 *
 * With `experiments.typedRoutes` this resolves to the generated union of the
 * app's routes; without the generated types it is a plain string. Deriving it
 * means this file is correct either way and cannot be broken by the router
 * renaming its own exported type.
 */
export type LinkTarget = React.ComponentProps<typeof Link>["href"];

// --------------------------------------------------------------- text helpers

/**
 * Renders a ReactNode slot that is allowed to be a bare string.
 *
 * `typeof node === "string"` covers the common case (`sub="3 of 8 paid"`) and
 * everything else is passed through untouched, so a caller handing over a
 * `<Text>` or a `<View>` of chips gets exactly what it wrote.
 */
function slot(node: React.ReactNode, style: StyleProp<TextStyle>): React.ReactNode {
  if (node === null || node === undefined || node === false || node === true) return null;
  if (typeof node === "string" || typeof node === "number") {
    return <Text style={style}>{node}</Text>;
  }
  return node;
}

// -------------------------------------------------------------------- tones

/** `.chip[data-tone=…]` — background and foreground, per palette. */
function chipTone(t: Theme, tone: Tone): { bg: string; fg: string } {
  switch (tone) {
    case "good":
      return { bg: t.c.greenDim, fg: t.c.green };
    case "warn":
      return { bg: t.c.amberDim, fg: t.c.warnText };
    case "bad":
      return { bg: t.c.redDim, fg: t.c.red };
    case "info":
      return { bg: t.c.blueDim, fg: t.c.blue };
    default:
      return { bg: t.c.surface2, fg: t.c.text2 };
  }
}

/**
 * `.banner[data-tone=…]`. The same pairs as a chip except for warn, which the CSS
 * gave a darker brown (#7a4b00) than the chip's — the banner carries a sentence
 * rather than two words, so it wants more contrast. Dark mode took `--amber` back
 * for both, which is what `warnText` already is.
 */
function bannerTone(t: Theme, tone: Tone): { bg: string; fg: string } {
  switch (tone) {
    case "good":
      return { bg: t.c.greenDim, fg: t.c.green };
    case "warn":
      return { bg: t.c.amberDim, fg: t.isDark ? t.c.warnText : "#7a4b00" };
    case "bad":
      return { bg: t.c.redDim, fg: t.c.red };
    case "info":
      return { bg: t.c.blueDim, fg: t.c.blue };
    default:
      return { bg: t.c.surface2, fg: t.c.text };
  }
}

/** `.metric-value`'s inline colour. Left undefined, the numeral inherits body text. */
function metricColor(t: Theme, tone?: "pos" | "neg" | "blue" | "green" | "amber"): string | undefined {
  switch (tone) {
    case "pos":
    case "green":
      return t.c.green;
    case "neg":
      return t.c.red;
    case "blue":
      return t.c.blue;
    case "amber":
      return t.c.amber;
    default:
      return undefined;
  }
}

// --------------------------------------------------------------------- Card

export function Card({
  title,
  note,
  action,
  children,
  style,
  pad = true,
}: {
  title?: string;
  note?: string;
  /** Top-right slot: a link, a month switcher, a "see all". */
  action?: React.ReactNode;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  pad?: boolean;
}) {
  const s = useStyles(styles);
  // `note` is in the condition where the web version had only `title || action`.
  // A note with no title rendered nothing there; no call site does that, so this
  // can only add a header where one was silently missing.
  const head = title || note || action;
  return (
    <View style={[s.card, pad ? s.cardPad : s.cardPadTight, style]}>
      {head ? (
        <View style={s.cardHead}>
          <View style={s.cardHeadText}>
            {title ? <Text style={s.cardTitle}>{title}</Text> : null}
            {note ? <Text style={s.cardNote}>{note}</Text> : null}
          </View>
          {action}
        </View>
      ) : null}
      {children}
    </View>
  );
}

// --------------------------------------------------------------------- Chip

export function Chip({
  children,
  tone = "neutral",
  icon,
  title,
}: {
  children: React.ReactNode;
  tone?: Tone;
  icon?: IconName;
  /**
   * Was an HTML tooltip. There is no hover on a phone, so it becomes the
   * accessibility label — which is the same job it was doing: the longer
   * sentence behind a two-word chip.
   */
  title?: string;
}) {
  const t = useTheme();
  const s = useStyles(styles);
  const { bg, fg } = chipTone(t, tone);
  return (
    <View
      style={[s.chip, { backgroundColor: bg }]}
      accessibilityLabel={title}
      accessible={title !== undefined}
    >
      {icon ? <Icon name={icon} size={13} stroke={2.2} color={fg} /> : null}
      {slot(children, [s.chipText, { color: fg }])}
    </View>
  );
}

// ----------------------------------------------------------------- StatTile

/**
 * A labelled number. The `value` is deliberately typed as a string — callers
 * format with money.ts, so no component ever has to know about paise.
 */
export function StatTile({
  label,
  value,
  sub,
  tone,
  size = "md",
  icon,
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
  /** Colours the numeral. Left off, it takes the body colour, which is usually right. */
  tone?: "pos" | "neg" | "blue" | "green" | "amber";
  size?: "sm" | "md" | "xl";
  icon?: IconName;
}) {
  const t = useTheme();
  const s = useStyles(styles);
  const color = metricColor(t, tone);
  const valueStyle = size === "sm" ? s.metricSm : size === "xl" ? s.metricXl : s.metricValue;

  return (
    <View style={s.metric}>
      <View style={s.metricLabelRow}>
        {icon ? <Icon name={icon} size={13} stroke={2.2} color={t.c.text2} /> : null}
        <Text style={s.metricLabel}>{label}</Text>
      </View>
      <Text style={[valueStyle, color ? { color } : null]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      {slot(sub, s.metricSub)}
    </View>
  );
}

// -------------------------------------------------------------- ProgressBar

export function ProgressBar({
  value,
  color,
  height = 6,
  track,
}: {
  /** 0..1. Over 1 is clamped for the bar but the caller usually recolours it. */
  value: number;
  /** Defaults to the palette's blue, which is what `var(--blue)` was. */
  color?: string;
  height?: number;
  /** Defaults to `--surface-3`. */
  track?: string;
}) {
  const t = useTheme();
  const w = Math.max(0, Math.min(1, value));
  const r = height / 2;
  // Two flex children rather than a percentage width: RN types a width as
  // `DimensionValue`, and a `${w}%` template literal widens to plain `string`,
  // which would need a cast at every use. A ratio needs no cast and no maths.
  return (
    <View style={[{ height, borderRadius: r, backgroundColor: track ?? t.c.surface3 }, barTrack]}>
      <View style={{ flex: w, backgroundColor: color ?? t.c.blue, borderRadius: r }} />
      <View style={{ flex: 1 - w }} />
    </View>
  );
}

const barTrack: ViewStyle = { flexDirection: "row", overflow: "hidden" };

// --------------------------------------------------------------- LinkButton

/**
 * `.btn` as a component: a pill that navigates.
 *
 * `variant` covers the three the CSS had — filled accent, ghost (accent text on
 * nothing) and outline. Anything that *submits* belongs to form.tsx's
 * `PendingButton`, which owns the pending state; this one only ever pushes a
 * route.
 */
export function LinkButton({
  href,
  label,
  icon,
  iconAfter,
  variant = "solid",
  small = false,
  style,
}: {
  href: LinkTarget;
  label: string;
  icon?: IconName;
  /** `SeeAll`'s chevron: same glyph, other side. */
  iconAfter?: IconName;
  variant?: "solid" | "ghost" | "outline";
  small?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const s = useStyles(styles);
  const fg = variant === "solid" ? t.c.onAccent : variant === "ghost" ? t.c.blue : t.c.text;

  return (
    <Link href={href} asChild>
      <Pressable
        accessibilityRole="button"
        style={({ pressed }) => [
          s.btn,
          small ? s.btnSm : null,
          variant === "solid" ? { backgroundColor: t.c.blue } : null,
          variant === "outline" ? { borderColor: t.c.border } : null,
          pressed ? s.pressed : null,
          style,
        ]}
      >
        {icon ? <Icon name={icon} size={small ? 15 : 17} stroke={2.2} color={fg} /> : null}
        <Text style={[small ? s.btnLabelSm : s.btnLabel, { color: fg }]}>{label}</Text>
        {iconAfter ? <Icon name={iconAfter} size={small ? 15 : 17} stroke={2.2} color={fg} /> : null}
      </Pressable>
    </Link>
  );
}

// --------------------------------------------------------------- EmptyState

export function EmptyState({
  icon = "wallet",
  title,
  body,
  cta,
}: {
  icon?: IconName;
  title: string;
  body?: string;
  cta?: { href: LinkTarget; label: string };
}) {
  const t = useTheme();
  const s = useStyles(styles);
  return (
    <View style={s.empty}>
      <Icon name={icon} size={38} stroke={1.5} color={t.c.text3} />
      <Text style={s.emptyTitle}>{title}</Text>
      {body ? <Text style={s.emptyBody}>{body}</Text> : null}
      {cta ? <LinkButton href={cta.href} label={cta.label} small style={s.emptyCta} /> : null}
    </View>
  );
}

// ------------------------------------------------------------------- Banner

/**
 * Unlike the other slots this one always wraps its children in a `<Text>` rather
 * than going through `slot()`. On the web a banner's sentence carried a `<strong>`
 * inside it and the emphasis inherited `.banner`'s colour from the cascade; in
 * React Native only a `<Text>` inside a `<Text>` inherits, so the parent has to be
 * there unconditionally or every caller would have to re-derive `fg` itself.
 * Nesting `<Text>` for the bold run is then free.
 */
export function Banner({
  tone = "neutral",
  icon,
  children,
}: {
  tone?: Tone;
  icon?: IconName;
  children: React.ReactNode;
}) {
  const t = useTheme();
  const s = useStyles(styles);
  const { bg, fg } = bannerTone(t, tone);
  return (
    <View style={[s.banner, { backgroundColor: bg }]}>
      {icon ? <Icon name={icon} size={18} color={fg} style={s.bannerIcon} /> : null}
      <View style={s.bannerBody}>
        <Text style={[s.bannerText, { color: fg }]}>{children}</Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------- Dot

/** A coloured dot before a category or series name. */
export function Dot({ color }: { color: string }) {
  return <View style={[dot, { backgroundColor: color }]} />;
}

const dot: ViewStyle = { width: 10, height: 10, borderRadius: 5 };

// ----------------------------------------------------------------- IconTile

/**
 * The round tinted disc behind a category icon, as in Fit's activity list.
 *
 * `${color}22` is a 13% alpha suffix, so `color` must be a six-digit hex — which
 * every caller already is, because they all come from `category-style.ts`,
 * `goal-icon.ts` or `asset-icon.ts`. Unchanged from the web version, including
 * the half-size glyph.
 */
export function IconTile({
  color,
  icon = "receipt",
  size = 38,
}: {
  color: string;
  icon?: IconName;
  size?: number;
}) {
  return (
    <View
      style={[
        iconTile,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: `${color}22` },
      ]}
    >
      <Icon name={icon} size={Math.round(size * 0.5)} color={color} />
    </View>
  );
}

const iconTile: ViewStyle = { alignItems: "center", justifyContent: "center", flexShrink: 0 };

// ------------------------------------------------------------------ Loading

/**
 * First paint, before `useLive`'s query resolves.
 *
 * The web app never needed this — a server component had already run its SQL
 * before any HTML existed. Here the first frame has `data === null`, and a
 * spinner is the honest thing to show for the few milliseconds SQLite takes.
 */
export function Loading({ label }: { label?: string }) {
  const t = useTheme();
  const s = useStyles(styles);
  return (
    <View style={s.loading}>
      <ActivityIndicator color={t.c.blue} />
      {label ? <Text style={s.loadingLabel}>{label}</Text> : null}
    </View>
  );
}

// ------------------------------------------------------------ DbUnavailable

/**
 * Shown when a query threw.
 *
 * Worth its own component for the same reason as on the web — "something went
 * wrong" sends you looking in the wrong place — but the words are different,
 * because the failure is different. There is no server starting up; there is a
 * file on this phone that either opened and migrated or did not. `onRetry` is
 * wired to `useLive`'s `reload`, which is the one thing that can help.
 */
export function DbUnavailable({ detail, onRetry }: { detail?: string; onRetry?: () => void }) {
  const t = useTheme();
  const s = useStyles(styles);
  return (
    <Card>
      <View style={s.empty}>
        <Icon name="alert" size={38} stroke={1.5} color={t.c.amber} />
        <Text style={s.emptyTitle}>Could not read your data</Text>
        <Text style={s.emptyBody}>
          MoneyFit keeps everything in a database file on this phone. Nothing has been lost —
          this is a read that failed, usually because the app was still setting the database up.
          Try again, or reopen the app.
        </Text>
        {onRetry ? (
          <Pressable
            accessibilityRole="button"
            onPress={onRetry}
            style={({ pressed }) => [s.btn, s.btnSm, s.emptyCta, pressed ? s.pressed : null]}
          >
            <Icon name="repeat" size={15} stroke={2.2} color={t.c.blue} />
            <Text style={[s.btnLabelSm, { color: t.c.blue }]}>Try again</Text>
          </Pressable>
        ) : null}
        {detail ? <Text style={s.detail}>{detail}</Text> : null}
      </View>
    </Card>
  );
}

// ----------------------------------------------------------------- NotFound

/**
 * What `notFound()` used to do.
 *
 * On the web a detail page called Next's `notFound()`, which threw a sentinel the
 * framework caught and turned into a 404 page. Nothing throws here: the loader
 * returns `{ bill: null }` and the screen renders this instead — the split
 * `Screen`'s header describes, and the reason a loader must never use a bare
 * `null` to mean "no such row".
 *
 * It is reachable in ordinary use, not only from a hand-typed id: delete a bill on
 * one screen, come back to a stack entry that still points at it, and this is the
 * honest answer.
 *
 * `onBack` rather than an `href` so a caller can hand over `router.back()`. A
 * fixed destination would send someone to the Journal from a screen they reached
 * from Home.
 */
export function NotFound({
  what = "page",
  detail,
  onBack,
}: {
  /** What was being looked for — "bill", "goal", "holding". */
  what?: string;
  detail?: string;
  onBack?: () => void;
}) {
  const t = useTheme();
  const s = useStyles(styles);
  return (
    <Card>
      <View style={s.empty}>
        <Icon name="search" size={38} stroke={1.5} color={t.c.text3} />
        <Text style={s.emptyTitle}>{`No such ${what}`}</Text>
        <Text style={s.emptyBody}>
          {`This ${what} is not in your data any more. It was most likely deleted from another screen while this one was still open.`}
        </Text>
        {onBack ? (
          <Pressable
            accessibilityRole="button"
            onPress={onBack}
            style={({ pressed }) => [s.btn, s.btnSm, s.emptyCta, pressed ? s.pressed : null]}
          >
            <Icon name="chevronLeft" size={15} stroke={2.2} color={t.c.blue} />
            <Text style={[s.btnLabelSm, { color: t.c.blue }]}>Go back</Text>
          </Pressable>
        ) : null}
        {detail ? <Text style={s.detail}>{detail}</Text> : null}
      </View>
    </Card>
  );
}

// --------------------------------------------------------- AiNotConfigured

/** The graceful-degradation state every AI surface falls back to. */
export function AiNotConfigured({ feature }: { feature: string }) {
  const s = useStyles(styles);
  const t = useTheme();
  const { fg } = bannerTone(t, "info");
  return (
    <Banner tone="info" icon="info">
      <Text style={[s.bannerText, { color: fg }]}>
        <Text style={s.strong}>{feature} needs a Gemini API key.</Text>
        {"\n"}
        Add one under Settings, and it is kept in this phone’s keystore rather than in the app’s
        data. Everything else — every chart, forecast and detector in this app — is computed on
        the device and works without it.
      </Text>
    </Banner>
  );
}

// ----------------------------------------------------------------- PageHead

/**
 * Page header.
 *
 * The web app put the title on the left and the controls on the right; at 360dp
 * a 28px title and a month switcher cannot share a line, and the stylesheet
 * already admitted as much by dropping the title's right padding below 860px.
 * So the controls sit underneath, wrapping — which is what the toolbar rule did
 * on the same breakpoint.
 */
export function PageHead({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const s = useStyles(styles);
  return (
    <View style={s.pageHead}>
      <Text style={s.pageTitle}>{title}</Text>
      {slot(sub, s.pageSub)}
      {children ? <View style={s.pageHeadRow}>{children}</View> : null}
    </View>
  );
}

// ------------------------------------------------------------------- SeeAll

export function SeeAll({ href }: { href: LinkTarget }) {
  return <LinkButton href={href} label="See all" iconAfter="chevronRight" variant="ghost" small />;
}

// ------------------------------------------------------------------- styles

const styles = (t: Theme) => ({
  // .card — 22px 24px on the desktop, where the page itself had a 32px gutter.
  // Here the page gutter is 16px, so the card's own padding comes down to match;
  // `space.card` exists for exactly this and keeps every card agreeing.
  card: {
    backgroundColor: t.c.surface,
    borderRadius: radius.md,
    ...t.shadow1,
  } as ViewStyle,
  cardPad: { paddingVertical: space.card, paddingHorizontal: space.card } as ViewStyle,
  cardPadTight: { paddingVertical: space.cardSm, paddingHorizontal: space.cardSm } as ViewStyle,

  cardHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 18,
  } as ViewStyle,
  cardHeadText: { flexShrink: 1, minWidth: 0 } as ViewStyle,
  cardTitle: { ...font.cardTitle, color: t.c.text } as TextStyle,
  cardNote: { ...font.small, color: t.c.text3, marginTop: 2 } as TextStyle,

  // .chip
  chip: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
  } as ViewStyle,
  chipText: { ...font.label } as TextStyle,

  // .metric
  metric: { gap: 2 } as ViewStyle,
  metricLabelRow: { flexDirection: "row", alignItems: "center", gap: 5 } as ViewStyle,
  metricLabel: { ...font.metricLabel, color: t.c.text2 } as TextStyle,
  metricValue: { ...font.metric, ...tnum, color: t.c.text } as TextStyle,
  metricXl: { ...font.metricXl, ...tnum, color: t.c.text } as TextStyle,
  metricSm: { ...font.metricSm, ...tnum, color: t.c.text } as TextStyle,
  metricSub: { ...font.small, color: t.c.text3 } as TextStyle,

  // .btn / .btn-sm / .btn-ghost / .btn-outline
  btn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "flex-start",
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: "transparent",
  } as ViewStyle,
  btnSm: { paddingVertical: 6, paddingHorizontal: 14 } as ViewStyle,
  btnLabel: { ...font.button } as TextStyle,
  btnLabelSm: { ...font.buttonSm } as TextStyle,
  /** `.btn:active`. The CSS had no pressed state because a mouse has hover. */
  pressed: { opacity: 0.65 } as ViewStyle,

  // .empty / .empty-title
  empty: { alignItems: "center", paddingVertical: 32, paddingHorizontal: 12 } as ViewStyle,
  emptyTitle: {
    ...font.sectionTitle,
    color: t.c.text2,
    marginTop: 12,
    marginBottom: 4,
    textAlign: "center",
  } as TextStyle,
  emptyBody: { ...font.small, color: t.c.text3, textAlign: "center", maxWidth: 420 } as TextStyle,
  emptyCta: { marginTop: 18 } as ViewStyle,

  // .banner
  banner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 14,
    paddingVertical: 16,
    paddingHorizontal: 18,
    borderRadius: radius.sm,
  } as ViewStyle,
  bannerIcon: { marginTop: 1 } as ViewStyle,
  bannerBody: { flex: 1, minWidth: 0 } as ViewStyle,
  bannerText: { ...font.small13, lineHeight: 20 } as TextStyle,
  /** `<strong>` — nested inside a Text, which is where RN allows it. */
  strong: { fontWeight: "500" } as TextStyle,

  // The error detail. `<pre>` had a monospace family and wrapped anywhere;
  // "monospace" is the one family name Android is guaranteed to resolve.
  detail: {
    ...font.small,
    fontFamily: "monospace",
    color: t.c.text3,
    marginTop: 16,
    alignSelf: "stretch",
  } as TextStyle,

  loading: { alignItems: "center", justifyContent: "center", paddingVertical: 40, gap: 12 } as ViewStyle,
  loadingLabel: { ...font.small, color: t.c.text3 } as TextStyle,

  // .page-head
  pageHead: { marginBottom: 20 } as ViewStyle,
  pageTitle: { ...font.pageTitle, color: t.c.text } as TextStyle,
  pageSub: { ...font.body, color: t.c.text2, marginTop: 4 } as TextStyle,
  pageHeadRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 14,
  } as ViewStyle,
});
