/**
 * The one place the three-valued theme preference is resolved.
 *
 * The web app pushed this into CSS: `data-theme` on <html> plus a
 * `prefers-color-scheme` media query, which is why the corner toggle could work
 * without the server knowing which palette "system" had landed on. React Native
 * has no cascade, so the resolution happens here instead and every component
 * reads the answer through `useTheme()`.
 *
 * The preference itself arrives as a prop rather than being read here, for the
 * same reason the web app read it in the layout: it lives in the `settings`
 * table, so the database is its owner and this file stays free of any query.
 * Before the first read lands, "system" is the honest default.
 */

import * as SystemUI from "expo-system-ui";
import { createContext, useContext, useEffect, useMemo } from "react";
import { StyleSheet, useColorScheme } from "react-native";

import { PALETTES, shadow, type Palette, type ThemeName } from "./tokens";

/** What `settings.theme` stores. Matches the web app's Segmented options. */
export type ThemePref = "system" | "light" | "dark";

export type Theme = {
  /** The palette actually in force — never "system". */
  name: ThemeName;
  isDark: boolean;
  /** Shorthand, because it appears in almost every style: `t.c.blue`. */
  c: Palette;
  shadow1: typeof shadow.light.one;
  shadow2: typeof shadow.light.two;
};

function build(name: ThemeName): Theme {
  return {
    name,
    isDark: name === "dark",
    c: PALETTES[name],
    shadow1: shadow[name].one,
    shadow2: shadow[name].two,
  };
}

const LIGHT_THEME = build("light");
const DARK_THEME = build("dark");

// Light is the default for the same reason :root is the light palette in the
// stylesheet: it is what you get before anything has been decided.
const Ctx = createContext<Theme>(LIGHT_THEME);

export function ThemeProvider({
  pref,
  children,
}: {
  pref: ThemePref;
  children: React.ReactNode;
}) {
  // null when the OS has no preference — treated as light, as the media query did.
  const system = useColorScheme();
  const name: ThemeName =
    pref === "system" ? (system === "dark" ? "dark" : "light") : pref;
  const theme = name === "dark" ? DARK_THEME : LIGHT_THEME;

  // `html, body { background: var(--bg) }`. Without this the window behind the
  // navigator keeps its default colour and shows as a flash on push or rotate.
  useEffect(() => {
    SystemUI.setBackgroundColorAsync(theme.c.bg).catch(() => {
      // Cosmetic only — a failure here is not worth surfacing to the user.
    });
  }, [theme]);

  return <Ctx.Provider value={theme}>{children}</Ctx.Provider>;
}

export function useTheme(): Theme {
  return useContext(Ctx);
}

/**
 * The palette a *stored* preference resolves to, for code outside the tree.
 *
 * `setTheme` on the web wrote "light" or "dark" and let CSS work out which
 * button to show next. The header button needs the same answer before it
 * renders, and it gets it from `useTheme().name` — this helper exists for the
 * non-React callers, currently only the status-bar style in the root layout.
 */
export function resolve(pref: ThemePref, system: "light" | "dark" | null): ThemeName {
  if (pref === "light" || pref === "dark") return pref;
  return system === "dark" ? "dark" : "light";
}

/**
 * Per-component stylesheets, rebuilt only when the palette changes.
 *
 * Define the factory at module scope, not inline in the component — it is
 * captured on first render and deliberately not a dependency, because a new
 * closure on every render would defeat the memo and rebuild a StyleSheet each
 * time. Colour-free styles need no hook at all; use StyleSheet.create directly.
 *
 *   const styles = (t: Theme) => ({ card: { backgroundColor: t.c.surface } });
 *   ...
 *   const s = useStyles(styles);
 */
export function useStyles<T extends StyleSheet.NamedStyles<T>>(
  factory: (t: Theme) => T,
): T {
  const t = useTheme();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => StyleSheet.create(factory(t)), [t]);
}
