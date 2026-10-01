/**
 * The whole icon set, as one component.
 *
 * Stroke outlines on a 24×24 grid rather than filled Material paths: at 20–22px
 * a 1.8px stroke is what gives Fit's UI its light, drawn feel, and geometry this
 * simple is legible at every size without a second weight. No icon font, no
 * sprite sheet, no network request — they are inlined into the bundle.
 *
 * **Every path string below is byte-identical to the web app's.** `react-native-svg`
 * implements the same four primitives with the same props, so the port is the
 * element names and nothing else: `<path>` → `<Path>`, `<circle>` → `<Circle>`,
 * `<rect>` → `<Rect>`, `<ellipse>` → `<Ellipse>`. Two real differences:
 *
 *   - **`currentColor` is gone.** There is no cascade, so an icon cannot inherit
 *     the text colour of whatever contains it. `color` is a prop, defaulting to
 *     the theme's body text — which is what `currentColor` resolved to in the
 *     great majority of the web app's call sites, so most of them stay as short as
 *     they were. Everywhere the CSS set a colour on the parent, the call site now
 *     passes it.
 *   - **`className` is gone**, replaced by `style`. There was only ever one class
 *     used this way (`.theme-to-dark`/`.theme-to-light`), and that swap is a
 *     conditional in the header button now.
 *
 * `stroke` (the *width*) keeps its name and its 1.8 default even though `stroke`
 * means the colour in SVG, because forty-odd call sites pass it and matching them
 * is worth more than fixing the naming.
 */

import { Circle, Ellipse, G, Path, Rect, Svg } from "react-native-svg";
import type { StyleProp, ViewStyle } from "react-native";

import { useTheme } from "@/theme/ThemeProvider";

export type IconName =
  // UI
  | "home" | "journal" | "track" | "goals" | "invest" | "profile" | "settings" | "ask"
  | "plus" | "close" | "check" | "chevronRight" | "chevronLeft" | "chevronDown"
  | "edit" | "trash" | "alert" | "search" | "filter" | "download" | "upload"
  | "camera" | "file" | "image" | "wallet" | "target" | "calendar" | "repeat"
  | "arrowUp" | "arrowDown" | "more" | "info" | "sparkle" | "attach" | "bank"
  | "clock" | "tag" | "wand" | "eye" | "flame" | "sun" | "moon"
  // Category glyphs — these names are the `icon` column in `categories`.
  | "cart" | "bolt" | "droplet" | "wifi" | "phone" | "car" | "fuel" | "utensils"
  | "heart" | "shield" | "book" | "bag" | "film" | "plane" | "wrench" | "gift"
  | "receipt" | "percent" | "coins" | "undo";

/** Each entry is the inner geometry for a 24×24 viewBox. */
const PATHS: Record<IconName, React.ReactNode> = {
  home: <Path d="M3 10.6 12 3.4l9 7.2V20a1 1 0 0 1-1 1h-5v-6.5H10V21H4a1 1 0 0 1-1-1z" />,

  journal: (
    <>
      <Path d="M5 3h14v18l-2.33-1.6L14.33 21 12 19.4 9.67 21 7.33 19.4 5 21z" />
      <Path d="M8.5 8.5h7M8.5 12.5h7" />
    </>
  ),

  track: <Path d="M4 20h16M7.5 20v-5.5M12 20V8M16.5 20v-8.5" />,

  goals: <Path d="M6 21V4h12l-2.6 4.6L18 13.2H6" />,

  invest: (
    <>
      <Path d="M3 17.5 9 11l4 4 7-7.5" />
      <Path d="M15.5 7.5H20v4.5" />
    </>
  ),

  profile: (
    <>
      <Circle cx="12" cy="8" r="4" />
      <Path d="M4.5 21c0-4.2 3.4-6.8 7.5-6.8s7.5 2.6 7.5 6.8" />
    </>
  ),

  // Material's "tune" rather than a gear: fewer strokes, reads better small.
  settings: (
    <>
      <Path d="M4 7.5h9M18.5 7.5H20M4 16.5h1.5M11 16.5h9" />
      <Circle cx="15.5" cy="7.5" r="2.5" />
      <Circle cx="8.5" cy="16.5" r="2.5" />
    </>
  ),

  ask: (
    <>
      <Path d="M11 3.5l1.7 4.8 4.8 1.7-4.8 1.7L11 16.5l-1.7-4.8L4.5 10l4.8-1.7z" />
      <Path d="M18 15l.6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6z" />
    </>
  ),

  plus: <Path d="M12 5v14M5 12h14" />,
  close: <Path d="M6 6l12 12M18 6 6 18" />,
  check: <Path d="M4.5 12.5l5 5L20 6.5" />,
  chevronRight: <Path d="M9 5l7 7-7 7" />,
  chevronLeft: <Path d="M15 5l-7 7 7 7" />,
  chevronDown: <Path d="M5 9l7 7 7-7" />,

  edit: (
    <>
      <Path d="M4 20h4L18.5 9.5l-4-4L4 16z" />
      <Path d="M14.5 5.5l4 4" />
    </>
  ),

  trash: <Path d="M4 7h16M9.5 7V4h5v3M6.5 7l1 14h9l1-14M10.5 11v6M13.5 11v6" />,

  alert: (
    <>
      <Path d="M12 3.5 21.5 20.5h-19z" />
      <Path d="M12 9.5v5M12 17.5h.01" />
    </>
  ),

  search: (
    <>
      <Circle cx="10.5" cy="10.5" r="6.5" />
      <Path d="M15.3 15.3 21 21" />
    </>
  ),

  filter: <Path d="M4 6.5h16M7 12h10M10 17.5h4" />,
  download: <Path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M4.5 20h15" />,
  upload: <Path d="M12 15.5V4.5M7.5 9 12 4.5 16.5 9M4.5 20h15" />,

  camera: (
    <>
      <Path d="M4 8.5h3.2L8.7 6h6.6l1.5 2.5H20V19H4z" />
      <Circle cx="12" cy="13.5" r="3.2" />
    </>
  ),

  file: (
    <>
      <Path d="M6.5 3h7.5l4 4v14h-11.5z" />
      <Path d="M14 3v4h4" />
    </>
  ),

  image: (
    <>
      <Rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <Circle cx="8.8" cy="9.8" r="1.6" />
      <Path d="M4.5 18l4.8-4.8 3.7 3.7 3-3 4 4" />
    </>
  ),

  wallet: (
    <>
      <Path d="M3.5 8.2A2.2 2.2 0 0 1 5.7 6h12.6a2.2 2.2 0 0 1 2.2 2.2v8.6a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2z" />
      <Path d="M20.5 10.8h-4.2a1.7 1.7 0 0 0 0 3.4h4.2" />
    </>
  ),

  target: (
    <>
      <Circle cx="12" cy="12" r="8.2" />
      <Circle cx="12" cy="12" r="4.4" />
      <Circle cx="12" cy="12" r="1" />
    </>
  ),

  calendar: (
    <>
      <Rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <Path d="M3.5 10h17M8.5 3v4M15.5 3v4" />
    </>
  ),

  repeat: (
    <>
      <Path d="M4 10V8a2.5 2.5 0 0 1 2.5-2.5H18" />
      <Path d="M15 2.5 18.5 5.5 15 8.5" />
      <Path d="M20 14v2a2.5 2.5 0 0 1-2.5 2.5H6" />
      <Path d="M9 21.5 5.5 18.5 9 15.5" />
    </>
  ),

  arrowUp: <Path d="M12 19.5V5M6 11l6-6 6 6" />,
  arrowDown: <Path d="M12 4.5V19M6 13l6 6 6-6" />,

  more: (
    <>
      <Circle cx="12" cy="5.5" r="1.4" />
      <Circle cx="12" cy="12" r="1.4" />
      <Circle cx="12" cy="18.5" r="1.4" />
    </>
  ),

  info: (
    <>
      <Circle cx="12" cy="12" r="8.8" />
      <Path d="M12 11.2v5.6M12 7.8h.01" />
    </>
  ),

  sparkle: <Path d="M12 3.2l1.9 5.4 5.4 1.9-5.4 1.9L12 17.8l-1.9-5.4L4.7 10.5l5.4-1.9z" />,

  attach: (
    <>
      <Path d="M14.5 7.5 8.6 13.4a3 3 0 0 0 4.2 4.2l6-6a5.2 5.2 0 0 0-7.3-7.3L5 10.8a7.3 7.3 0 0 0 10.3 10.3L18.3 18" />
    </>
  ),

  bank: <Path d="M4 10 12 5l8 5M5.5 10v9M18.5 10v9M9.5 13v6M14.5 13v6M4 19.5h16" />,

  clock: (
    <>
      <Circle cx="12" cy="12" r="8.8" />
      <Path d="M12 7v5.3l3.4 2.1" />
    </>
  ),

  tag: (
    <>
      <Path d="M12.6 3.5H20.5v7.9L11 21 3 13z" />
      <Circle cx="16.8" cy="7.2" r="1.4" />
    </>
  ),

  wand: (
    <>
      <Path d="M5 19 16.5 7.5M14.5 5.5l4 4" />
      <Path d="M8.5 3v3M7 4.5h3M19 14v3M17.5 15.5h3" />
    </>
  ),

  eye: (
    <>
      <Path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z" />
      <Circle cx="12" cy="12" r="3" />
    </>
  ),

  flame: (
    <>
      <Path d="M12 3s5.5 4.2 5.5 9.2A5.5 5.5 0 0 1 12 21a5.5 5.5 0 0 1-5.5-8.8C6.5 7.2 12 3 12 3z" />
      <Path d="M12 17.5a2.4 2.4 0 0 0 2.4-2.4c0-1.8-2.4-3.6-2.4-3.6s-2.4 1.8-2.4 3.6A2.4 2.4 0 0 0 12 17.5z" />
    </>
  ),

  /* Eight rays rather than a dial of dots: at 18px, dots turn to mush and the
     rays still read as a sun. */
  sun: (
    <>
      <Circle cx="12" cy="12" r="4.2" />
      <Path d="M12 2.4v2.2M12 19.4v2.2M2.4 12h2.2M19.4 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6" />
    </>
  ),

  /* One path, so the crescent is a shape and not a circle with a bite taken out
     of it — a masked circle needs a fill, and everything here is stroked. */
  moon: <Path d="M20.5 14.6A9 9 0 0 1 9.4 3.5a9 9 0 1 0 11.1 11.1z" />,

  /* ---------------------------------------------------- category glyphs */

  cart: (
    <>
      <Path d="M2.8 4h2.4l2.6 10.6h9.6L20 7.2H6.4" />
      <Circle cx="9.6" cy="19" r="1.5" />
      <Circle cx="17" cy="19" r="1.5" />
    </>
  ),

  bolt: <Path d="M13.6 2.6 6 13.6h5l-.6 7.8 7.6-11h-5z" />,

  droplet: <Path d="M12 3.2c3 3.6 5.5 6.4 5.5 9.4a5.5 5.5 0 0 1-11 0c0-3 2.5-5.8 5.5-9.4z" />,

  wifi: (
    <>
      <Path d="M2.8 9.2a13 13 0 0 1 18.4 0" />
      <Path d="M6.3 12.8a8 8 0 0 1 11.4 0" />
      <Path d="M9.7 16.3a3.2 3.2 0 0 1 4.6 0" />
      <Path d="M12 19.8h.01" />
    </>
  ),

  phone: (
    <>
      <Rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />
      <Path d="M10.5 5.5h3M10.5 18.4h3" />
    </>
  ),

  car: (
    <>
      <Path d="M4.5 16.5v-4l2.2-5.5h10.6l2.2 5.5v4" />
      <Path d="M4.5 12.5h15" />
      <Circle cx="8.2" cy="17.6" r="1.6" />
      <Circle cx="15.8" cy="17.6" r="1.6" />
    </>
  ),

  fuel: (
    <>
      <Path d="M4 21V4.5a1 1 0 0 1 1-1h7.5a1 1 0 0 1 1 1V21" />
      <Path d="M4 11h9.5" />
      <Path d="M13.5 9h3a1.8 1.8 0 0 1 1.8 1.8v5.4a1.7 1.7 0 0 0 3.4 0V8l-2-2.8" />
      <Path d="M2.8 21h12" />
    </>
  ),

  utensils: (
    <>
      <Path d="M6.5 3v6.5a2.8 2.8 0 0 0 5.6 0V3" />
      <Path d="M9.3 12.3V21" />
      <Path d="M17.5 21V3c1.9 1.3 2.8 3.2 2.8 5.6s-.9 4-2.8 4.6" />
    </>
  ),

  heart: <Path d="M12 20.3 4.8 13.1a4.6 4.6 0 0 1 6.5-6.5l.7.7.7-.7a4.6 4.6 0 0 1 6.5 6.5z" />,

  shield: <Path d="M12 3 20 5.8v6.4c0 4.4-3.3 7.6-8 9.3-4.7-1.7-8-4.9-8-9.3V5.8z" />,

  book: (
    <>
      <Path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H10a2.5 2.5 0 0 1 2 1 2.5 2.5 0 0 1 2-1h4.5A1.5 1.5 0 0 1 20 4.5v13a1.5 1.5 0 0 1-1.5 1.5H14a2.5 2.5 0 0 0-2 1 2.5 2.5 0 0 0-2-1H5.5A1.5 1.5 0 0 1 4 17.5z" />
      <Path d="M12 4.2v16" />
    </>
  ),

  bag: (
    <>
      <Path d="M5 8h14l-1.1 12.2a1 1 0 0 1-1 .8H7.1a1 1 0 0 1-1-.8z" />
      <Path d="M8.8 8V6.2a3.2 3.2 0 0 1 6.4 0V8" />
    </>
  ),

  film: (
    <>
      <Rect x="3" y="4.5" width="18" height="15" rx="2" />
      <Path d="M8 4.5v15M16 4.5v15M3 12h18M3 8.2h5M3 15.8h5M16 8.2h5M16 15.8h5" />
    </>
  ),

  // Top-down aircraft, not a paper plane — a paper plane reads as "send".
  plane: (
    <Path d="M12 2.8c.9 0 1.5 1.3 1.5 2.9v4.1l6.8 4V16l-6.8-2v3.6l2.4 1.9v1.7L12 20l-3.9 1.2v-1.7l2.4-1.9V14L3.7 16v-2.2l6.8-4V5.7c0-1.6.6-2.9 1.5-2.9z" />
  ),

  wrench: (
    <Path d="M15.5 2.5a5.5 5.5 0 0 0-4.4 8.8l-7.3 7.3a1.5 1.5 0 0 0 0 2.1l.5.5a1.5 1.5 0 0 0 2.1 0l7.3-7.3A5.5 5.5 0 0 0 21 9.5c0-.9-.2-1.7-.6-2.5l-2.9 2.9-2.4-2.4 2.9-2.9a5.4 5.4 0 0 0-2.5-.6z" />
  ),

  gift: (
    <>
      <Rect x="3.5" y="8.5" width="17" height="12.5" rx="1.5" />
      <Path d="M3.5 13h17M12 8.5V21" />
      <Path d="M12 8.5C10.5 8.5 7 8.3 7 5.9A2.4 2.4 0 0 1 12 5.4a2.4 2.4 0 0 1 5 .5c0 2.4-3.5 2.6-5 2.6z" />
    </>
  ),

  // A plain lined document. `journal` is the notched-ribbon shape, so the two
  // silhouettes stay distinguishable at 20px.
  receipt: (
    <>
      <Rect x="5" y="3" width="14" height="18" rx="2" />
      <Path d="M8.5 7.5h7M8.5 11h7M8.5 14.5h4" />
    </>
  ),

  percent: (
    <>
      <Path d="M19 5 5 19" />
      <Circle cx="7.5" cy="7.5" r="2.5" />
      <Circle cx="16.5" cy="16.5" r="2.5" />
    </>
  ),

  coins: (
    <>
      <Ellipse cx="12" cy="6.5" rx="7" ry="3" />
      <Path d="M5 6.5v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5" />
      <Path d="M5 11.5v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5" />
    </>
  ),

  undo: (
    <>
      <Path d="M3.8 9.5h9.7a5.5 5.5 0 0 1 0 11H7" />
      <Path d="M7.6 5.6 3.7 9.5l3.9 3.9" />
    </>
  ),
};

/**
 * Category icons arrive from the database as free text, so a user-renamed or
 * hand-edited category must not render a blank square. Unknown names fall back
 * to the lined-document glyph.
 */
const ICON_ALIAS: Record<string, IconName> = {
  landmark: "bank", // Taxes — the same columned facade as `bank`
  cash: "wallet",
  money: "wallet",
  bill: "receipt",
  food: "utensils",
  transport: "car",
  health: "heart",
  travel: "plane",
  shopping: "bag",
  electricity: "bolt",
};

export function catIcon(name: string | null | undefined): IconName {
  if (!name) return "receipt";
  if (name in PATHS) return name as IconName;
  return ICON_ALIAS[name] ?? "receipt";
}

export function Icon({
  name,
  size = 22,
  stroke = 1.8,
  color,
  style,
}: {
  name: IconName;
  size?: number;
  /** Thinner for large glyphs, heavier for 14px inline use. This is the *width*. */
  stroke?: number;
  /** What `currentColor` used to resolve to. Defaults to the theme's body text. */
  color?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  return (
    // The presentation props sit on a <G> rather than on <Svg> because
    // react-native-svg's inheritance is implemented on group nodes; putting them
    // one level down is the shape its own examples use and removes the question.
    <Svg width={size} height={size} viewBox="0 0 24 24" style={style}>
      <G
        fill="none"
        stroke={color ?? t.c.text}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {PATHS[name]}
      </G>
    </Svg>
  );
}

/**
 * The app mark: the three rings, at whatever size the header needs.
 *
 * The web version referenced `var(--blue)` and friends, so it re-coloured itself
 * with the theme for free. Here the three colours are read from the palette —
 * which is the same three values, and means the mark still follows the theme.
 *
 * Geometry is untouched: a 32×32 box, radii 13 / 8.6 / 4.2, a 3.4 stroke, and the
 * dasharray/offset pairs that make the three arcs sweep 71%, 63% and 58%. This is
 * *not* the hero ring — that is `TripleRing` in charts.tsx, at 240×240.
 */
export function Logo({ size = 28 }: { size?: number }) {
  const t = useTheme();
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32">
      <G fill="none" strokeWidth="3.4" strokeLinecap="round" transform="rotate(-90 16 16)">
        <Circle cx="16" cy="16" r="13" stroke={t.c.blue} strokeDasharray="81.7" strokeDashoffset="24" />
        <Circle cx="16" cy="16" r="8.6" stroke={t.c.green} strokeDasharray="54" strokeDashoffset="20" />
        <Circle cx="16" cy="16" r="4.2" stroke={t.c.amber} strokeDasharray="26.4" strokeDashoffset="11" />
      </G>
    </Svg>
  );
}
