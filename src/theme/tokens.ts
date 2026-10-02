/**
 * MoneyFit design tokens — a direct transcription of the web app's globals.css.
 *
 * Every hex value, radius and font size below is copied from
 * `Finance/src/app/globals.css`, so the phone and the desktop app are the same
 * product rather than two that resemble each other. The CSS had three palette
 * blocks — `:root` (light), the `prefers-color-scheme: dark` media query and
 * `:root[data-theme="dark"]` — but the last two hold identical values, so there
 * are only two palettes here. Which one applies is decided in ThemeProvider,
 * which is the one place the three-valued `system | light | dark` preference is
 * resolved.
 *
 * Two CSS facts that had to become tokens rather than rules:
 *   • `--on-accent` is the text that goes on a filled accent surface: white in
 *     light mode, #0b1a2e in dark, because the dark palette's blue is a *light*
 *     blue and white-on-light-blue is unreadable. A palette fact, so `onAccent`
 *     carries it — which is also how the web now states it.
 *
 *     It used to be a rule there, and the rule was a bug worth recording. The
 *     dark override was written as `:root[data-theme="dark"] .btn { color: … }`,
 *     a selector of specificity (0,3,0) — and every variant that *un*-fills a
 *     button, `.btn-ghost` and `.btn-outline`, is a single class at (0,1,0). So
 *     the override beat all of them and painted near-black text on a
 *     near-black transparent background: invisible, in exactly the places a
 *     button has no accent fill to sit on. A token cannot do that, because it
 *     is read by whoever draws the fill rather than applied to everything that
 *     happens to be a button.
 *   • `.chip[data-tone="warn"]` needs a hand-picked brown in light mode
 *     (#b06000, the one hardcoded colour in the stylesheet) and takes --amber
 *     back in dark. That is `warnText`.
 *
 * No font family is set anywhere. The CSS asked for "Google Sans", Roboto —
 * Roboto *is* Android's system font, so React Native's default is already the
 * intended fallback, and naming a family that may not exist is how you get a
 * silent substitution that looks wrong on one device and right on another.
 */

import type { TextStyle } from "react-native";

export type ThemeName = "light" | "dark";

export type Palette = {
  // Metric accents. Blue = spending, green = goals, amber = investing.
  blue: string;
  blueDim: string;
  green: string;
  greenDim: string;
  amber: string;
  amberDim: string;
  red: string;
  redDim: string;
  purple: string;
  teal: string;

  // Surfaces
  bg: string;
  surface: string;
  surface2: string;
  surface3: string;
  /** The web app's sidebar colour; here it is the header and tab bar. */
  sidebar: string;
  border: string;
  borderSoft: string;

  // Text
  text: string;
  text2: string;
  text3: string;
  /** Text on a filled accent surface — a button, the FAB. */
  onAccent: string;
  /** Amber-on-amber needs its own foreground; see the header. */
  warnText: string;
};

export const LIGHT: Palette = {
  blue: "#1a73e8",
  blueDim: "#a8c7fa",
  green: "#1e8e3e",
  greenDim: "#a8dab5",
  amber: "#f9ab00",
  amberDim: "#fde293",
  red: "#d93025",
  redDim: "#f6aea9",
  purple: "#9334e6",
  teal: "#12b5cb",

  bg: "#f1f3f4",
  surface: "#ffffff",
  surface2: "#f8f9fa",
  surface3: "#e8eaed",
  sidebar: "#ffffff",
  border: "#dadce0",
  borderSoft: "#e8eaed",

  text: "#202124",
  text2: "#5f6368",
  text3: "#80868b",
  onAccent: "#ffffff",
  warnText: "#b06000",
};

export const DARK: Palette = {
  blue: "#8ab4f8",
  // Raised from #2d4a73 with the dark-palette legibility pass. It is the tint behind
  // a selected chip and a progress track, and against #1e1f20 the old value was too
  // close to the surface to read as a fill at all.
  blueDim: "#28405f",
  green: "#81c995",
  greenDim: "#2a4a34",
  amber: "#fdd663",
  amberDim: "#5c4813",
  red: "#f28b82",
  redDim: "#5c2b27",
  purple: "#c58af9",
  teal: "#78d9ec",

  bg: "#131314",
  surface: "#1e1f20",
  surface2: "#282a2c",
  surface3: "#35363a",
  sidebar: "#1b1c1d",
  border: "#3c4043",
  borderSoft: "#2d2f31",

  text: "#e8eaed",
  text2: "#9aa0a6",
  // Lifted from #80868b, which is the *light* palette's third text colour and was
  // carried into this one unchanged. On #131314 it fell under 4.5:1, and this app puts
  // real content at `text3` — a column heading, a metric's label, a row's figures — so
  // it is not decoration that can afford to be dim.
  text3: "#949a9f",
  onAccent: "#0b1a2e",
  warnText: "#fdd663",
};

export const PALETTES: Record<ThemeName, Palette> = { light: LIGHT, dark: DARK };

// ------------------------------------------------------------------- scales

/** `--radius-lg`, `--radius`, `--radius-sm`, `--radius-pill`. */
export const radius = { lg: 24, md: 20, sm: 12, pill: 999 } as const;

/**
 * The gutters the CSS actually used, named. `page` is `.main`'s narrow-screen
 * padding (20px 16px), `card` is a card's 20px inner padding, `gap` the 16px
 * between cards in a `.stack`.
 */
export const space = {
  page: 16,
  pageTop: 20,
  card: 20,
  cardSm: 14,
  gap: 16,
  gapSm: 10,
  gapXs: 6,
  /** Clearance for the tab bar plus the FAB above it. `.main` used 96px. */
  scrollFoot: 112,
} as const;

/**
 * Font weights, as React Native's string literals. The CSS leans on 300 for
 * the big numerals and 500 for labels; 400 is body text and 600 is the
 * letter-spaced micro-caps used for table headers and section eyebrows.
 */
export const weight = {
  light: "300",
  regular: "400",
  medium: "500",
  semi: "600",
} as const;

/**
 * Text styles, keyed to the CSS class each one replaces. Colour is deliberately
 * absent — it comes from the palette at the point of use, because these same
 * sizes serve both themes.
 *
 * Named `font` and not `type`, which is what it describes and what it was first
 * called: `import { type } from "@/theme/tokens"` is the one import specifier
 * TypeScript's grammar had to write a special rule for, because `{ type X }` is
 * how an inline type-only import is spelled. It does resolve — a bare `type` is
 * read as the binding name — but every file in the app imports this, so a naming
 * choice that rests on a disambiguation rule is not worth the cleverness.
 */
export const font = {
  /** `.page-title` */
  pageTitle: { fontSize: 28, fontWeight: weight.regular, letterSpacing: -0.4 },
  /** `.page-sub`, and body text generally (html font-size: 14px) */
  body: { fontSize: 14, fontWeight: weight.regular },
  /** `.card-title` */
  cardTitle: { fontSize: 15, fontWeight: weight.medium, letterSpacing: 0.1 },
  /** `.card-note`, `.hint`, `.metric-sub`, `.small` */
  small: { fontSize: 12, fontWeight: weight.regular },
  /** `.error`, `.table`, `.entry-meta`-adjacent 13px text */
  small13: { fontSize: 13, fontWeight: weight.regular },
  /** `.metric-value` — 40px at 300 weight is the whole Google Fit look. */
  metric: { fontSize: 40, fontWeight: weight.light, letterSpacing: -1.4 },
  /** `.metric-value.xl` — the number inside the rings. */
  metricXl: { fontSize: 56, fontWeight: weight.light, letterSpacing: -2 },
  /** `.metric-value.sm` */
  metricSm: { fontSize: 26, fontWeight: weight.light, letterSpacing: -0.6 },
  /** `.metric-label` */
  metricLabel: { fontSize: 12, fontWeight: weight.medium, letterSpacing: 0.3 },
  /** `.chip`, `.btn` label, `.field > label` */
  label: { fontSize: 12, fontWeight: weight.medium },
  /** `.btn` */
  button: { fontSize: 14, fontWeight: weight.medium },
  /** `.btn-sm`, `.seg-item` */
  buttonSm: { fontSize: 13, fontWeight: weight.medium },
  /** `.nav-label`, `.table th`, `.kv-k` — letter-spaced micro-caps. */
  eyebrow: { fontSize: 11, fontWeight: weight.semi, letterSpacing: 0.7 },
  /** `.entry-title` */
  entryTitle: { fontSize: 14, fontWeight: weight.medium },
  /** `.entry-amount`, `.kv-v` */
  entryAmount: { fontSize: 15, fontWeight: weight.regular },
  /** `.empty-title`, `.dialog h2` at its smaller size */
  sectionTitle: { fontSize: 15, fontWeight: weight.medium },
  /** `.amount-input input` */
  amount: { fontSize: 22, fontWeight: weight.light, letterSpacing: -0.4 },
} as const;

/**
 * `font-variant-numeric: tabular-nums` — spread into any Text showing a figure
 * that sits in a column or animates, so digits do not jiggle.
 *
 * Annotated `TextStyle` rather than `as const`: `as const` would make the array
 * `readonly ["tabular-nums"]`, and a readonly array is not assignable to the
 * mutable `FontVariant[]` that TextStyle declares — so every style object this
 * is spread into would fail to satisfy StyleSheet.create's constraint. The
 * annotation is also the only reason this file imports from react-native, and
 * `import type` is erased, so nothing is pulled in at runtime.
 */
export const tnum: TextStyle = { fontVariant: ["tabular-nums"] };

/**
 * `--shadow-1` / `--shadow-2`. CSS box-shadow has no single React Native
 * equivalent: iOS reads shadowColor/Offset/Opacity/Radius and Android reads
 * `elevation` only, so both are given and the elevation values are chosen to
 * land in the same visual place. Dark mode's shadows were near-black at higher
 * opacity, which Android's elevation cannot express — so dark leans on the
 * palette's own surface contrast and keeps elevation low.
 */
export const shadow = {
  light: {
    one: {
      shadowColor: "#3c4043",
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.16,
      shadowRadius: 3,
      elevation: 2,
    },
    two: {
      shadowColor: "#3c4043",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.24,
      shadowRadius: 8,
      elevation: 6,
    },
  },
  dark: {
    one: {
      shadowColor: "#000000",
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.4,
      shadowRadius: 3,
      elevation: 1,
    },
    two: {
      shadowColor: "#000000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.5,
      shadowRadius: 8,
      elevation: 4,
    },
  },
} as const;

/**
 * `--ease: cubic-bezier(0.2, 0, 0, 1)` — Material's standard curve. React
 * Native's Easing.bezier takes the same four numbers, so ThemeProvider does not
 * need to know about this; whoever animates imports it.
 */
export const EASE = [0.2, 0, 0, 1] as const;

/** The ring sweep in the CSS was 900ms; the bar and line reveals were 600ms. */
export const duration = { ring: 900, chart: 600, quick: 140 } as const;

/** Where the hero rings are drawn. Unchanged from charts.tsx's TripleRing. */
export const RING = {
  box: 240,
  radii: [100, 78, 56] as const,
  strokeWidth: 16,
} as const;

/**
 * One switch for the ring sweep. Static rings are the fallback: if the animation
 * misbehaves on a device this cannot be tested against, flipping this to false
 * costs the sweep and nothing else on the screen.
 */
export const ANIMATE_RINGS = true;
