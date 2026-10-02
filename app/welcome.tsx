/**
 * The greeting — `Finance/src/app/welcome/page.tsx` and the `.welcome*` block of
 * `globals.css`, which is where most of this file actually comes from.
 *
 * Reached two ways, exactly as on the web: pushed over the opening route once per run of
 * the app by `WelcomeGate` in `app/_layout.tsx`, or on purpose from Settings. Both land
 * on the same screen, and the only thing that changes between them is the word on the
 * button — see `returning` below.
 *
 * **It is dark in both themes, and that is not an oversight.** `.welcome` sets
 * `color-scheme: dark` and then restates the whole dark palette inside its own scope, so
 * a light-mode browser still gets the near-black screen with the ring watermark. So this
 * file imports `DARK` from the tokens and uses it directly instead of calling
 * `useTheme()` — the one screen in the app that does not theme. For the same reason it
 * renders its own `<StatusBar style="light" />`: the root layout picked the bar to match
 * the user's theme, and on this screen a light-theme user would get dark status-bar icons
 * on a near-black background.
 *
 * It is also outside the shell. On the web `layout.tsx` checks the cookie and renders no
 * nav at all when it is missing, and `.welcome` is additionally `position: fixed; inset:
 * 0; z-index: 60` so that the deliberate visit from Settings looks the same as the
 * first-run one. Here the equivalent is `headerShown: false` plus being a route on the
 * root stack rather than inside `(tabs)` — so no header, no tab bar and no FAB, whichever
 * way you arrive. It deliberately does not use `Screen` or `PlainScreen`: there is nothing
 * to load, nothing to refresh and nothing that can fail.
 *
 * One thing the web had and this does not: a form POST. A link cannot set a cookie, and a
 * GET that does is a GET a prefetcher can fire on your behalf, so the web's button had to
 * be a `<form>` around a Server Action. There is no request here, so it is a `Pressable`
 * that calls `markWelcomed()` and navigates.
 */

import { Stack, router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import type { TextStyle, ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Circle, Svg } from "react-native-svg";

import { Icon, type IconName } from "@/components/Icon";
import { hasWelcomed, markWelcomed } from "@/lib/welcome";
import { DARK, font, radius, shadow, space, weight } from "@/theme/tokens";

/**
 * The three things worth saying before anyone has seen a number, verbatim from the web
 * apart from one word: "computed on this machine" is "computed on this phone", which is
 * the same promise about a different box.
 *
 * Three, not five. The screen is a greeting and the app is one tap away.
 */
const FEATURES: { icon: IconName; title: string; body: string }[] = [
  { icon: "camera", title: "Photograph the bill", body: "Keep the receipt with the entry you type." },
  { icon: "track", title: "Rings, pace and forecasts", body: "Every figure computed on this phone." },
  { icon: "repeat", title: "Subscriptions, found", body: "What repeats, spotted in your own rows." },
];

export default function WelcomeScreen() {
  const insets = useSafeAreaInsets();

  // Snapshotted once, for the same reason the web reads the cookie once per request: a
  // set flag means you came here on purpose, from Settings, so the button should offer
  // the way back rather than pretend to be a beginning. Reading it live would flip the
  // label under your finger, because the press sets it.
  //
  // `useState(hasWelcomed)` and not `useState(hasWelcomed())` — React treats a function
  // argument as a lazy initialiser and calls it on the first render only, which is
  // exactly the once this needs.
  const [returning] = useState(hasWelcomed);

  function enter() {
    markWelcomed();
    // The web redirected to `safeNext(next)`, a string out of the query string. Here
    // "where you were going" is the stack itself: the gate pushed this screen *over* the
    // route the app opened on, so popping it puts you there. `canGoBack` is the house
    // idiom for a pushed screen (ten other sites do the same) and covers the Settings
    // route, where there is always something to go back to, as well as the theoretical
    // case of this being the first entry in the stack.
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }

  return (
    // The fragment is the house idiom for a pushed screen — `Stack.Screen` carries the
    // options and is not part of the layout. Every other pushed screen sets a `title`
    // here; this one takes the header away instead, which is `layout.tsx`'s "no cookie
    // means no shell" with the condition moved into the route.
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={s.root}>
        <StatusBar style="light" />
        <Watermark />

        {/*
          `.welcome` is a flex container whose child takes `margin: auto`, and the
          stylesheet explains why that is not `place-items: center`: centring a box taller
          than the viewport with `place-items` puts the overflow *above* the scroll origin,
          where it cannot be reached. `flexGrow: 1` plus `justifyContent: "center"` on the
          content container is the same arrangement — centred when it fits, scrollable from
          the top when it does not.

          The padding is the stylesheet's `24px 16px calc(24px + env(safe-area-inset-bottom))`,
          with `insets.top` added as well because the app runs edge-to-edge and there is no
          header here to hold the content clear of the status bar.
        */}
        <ScrollView
          contentContainerStyle={[
            s.content,
            { paddingTop: 24 + insets.top, paddingBottom: 24 + insets.bottom },
          ]}
        >
          <View style={s.inner}>
            <View style={s.hero}>
              <View style={s.mark}>
                <Icon name="wallet" size={30} stroke={2} color={ON_ACCENT} />
              </View>
              <Text style={s.title}>MoneyFit</Text>
              <Text style={s.tag}>
                Bills, goals and investments, tracked the way Fit tracks movement.
              </Text>
            </View>

            <View style={s.feats}>
              {FEATURES.map((f) => (
                <View key={f.title} style={s.feat}>
                  <View style={s.featIcon}>
                    <Icon name={f.icon} size={17} color={DARK.blue} />
                  </View>
                  <View style={s.featText}>
                    <Text style={s.featTitle}>{f.title}</Text>
                    <Text style={s.featBody}>{f.body}</Text>
                  </View>
                </View>
              ))}
            </View>

            <View style={s.door}>
              <Pressable
                accessibilityRole="button"
                onPress={enter}
                style={({ pressed }) => [s.btn, pressed ? s.pressed : null]}
              >
                <Text style={s.btnLabel}>{returning ? "Back to the app" : "Start exploring"}</Text>
                <Icon name="chevronRight" size={18} stroke={2.4} color={ON_ACCENT} />
              </Pressable>

              <View style={s.foot}>
                <Icon name="shield" size={13} color={FOOT} />
                <Text style={s.footText}>
                  No account and no sign-in. Everything stays in the database on this phone.
                </Text>
              </View>
            </View>
          </View>
        </ScrollView>
      </View>
    </>
  );
}

// ------------------------------------------------------------------- the watermark

/**
 * The three rings behind the text — `.welcome`'s background layers, as SVG.
 *
 * The geometry is `TripleRing`'s own, which is the point of it: radii 100/78/56 and a
 * stroke 0.16 of the outer radius, so the mark on this screen is the same mark the Track
 * screen draws, scaled up until it is scenery. The stylesheet expressed that in `vmin` so
 * it would scale without a breakpoint; `useWindowDimensions()` is the literal translation,
 * and it is the only place in the app that needs it.
 *
 * Painting order matters and is the stylesheet's, read bottom-up: the glow goes down
 * first so the rings stay crisp through it, and the rings are drawn as scenery with no
 * text, no labels and nothing a screen reader can reach — which on the web was "painted
 * as background layers" and here is `pointerEvents="none"` on a view with no accessible
 * children.
 *
 * **Two deliberate departures from the CSS.**
 *
 *   - The rings there are `repeating-radial-gradient` hard stops with a 1px feather on
 *     each edge, because a bare hard stop renders as a visibly stepped circle. A stroked
 *     SVG circle is antialiased by the renderer, so the feather has nothing to fix.
 *   - The base layer, `radial-gradient(125vmin 105vmin at 50% 30%, #121a24, #0b0d10 72%)`,
 *     is **not** carried. It exists to keep the screen from being a flat black rectangle,
 *     and the honest way to say it is that no gradient is rendered anywhere in this
 *     codebase — there is no `RadialGradient`, `LinearGradient` or `Defs` in any file — so
 *     this would be the first, and an opaque stepped approximation of a 125vmin gradient
 *     bands far more visibly than the flat colour it replaces. The flat `#0b0d10` stays,
 *     and the glow below does most of what the gradient was doing anyway.
 */
function Watermark() {
  const { width, height } = useWindowDimensions();
  const vmin = Math.min(width, height);

  // `circle at 50% 40%` for the rings, `at 50% 34%` for the glow — the glow sits slightly
  // higher so it reads as light falling on them rather than a halo around them.
  const cx = width / 2;
  const ringY = height * 0.4;
  const glowY = height * 0.34;

  // `--ring-r: 46vmin`, `--ring-w: 7.4vmin`, and the inner two at 0.78 and 0.56 of the
  // outer — the three numbers `RING.radii` holds as 100/78/56.
  const r = vmin * 0.46;
  const w = vmin * 0.074;
  const radii = [r, r * 0.78, r * 0.56];

  // The alpha is part of the colour here rather than a separate prop, because that is how
  // the stylesheet writes it: these four `rgba()` values are transcribed from it verbatim.
  // The first three are the dark palette's `--blue`, `--green` and `--amber` — `#8ab4f8`,
  // `#81c995`, `#fdd663` — faded until they are scenery.
  const colors = [
    "rgba(138,180,248,0.16)",
    "rgba(129,201,149,0.15)",
    "rgba(253,214,99,0.13)",
  ];

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg width={width} height={height}>
        {/*
          `radial-gradient(62vmin 50vmin at 50% 34%, rgba(26,115,232,0.22), transparent 70%)`
          as three concentric fills, largest first, each at 0.08 — which compounds to about
          0.22 at the centre and steps down from there. An ellipse 62×50 becomes a circle,
          which costs a little width at this opacity and nothing legible.

          rgba(26,115,232) is `#1a73e8` — the *light* palette's saturated blue, which the
          stylesheet reached for deliberately rather than dark's pale `#8ab4f8`: a glow
          wants the deeper colour, and the pale one over near-black reads as grey haze.
        */}
        {[0.43, 0.3, 0.17].map((k) => (
          <Circle key={k} cx={cx} cy={glowY} r={vmin * k} fill="rgba(26,115,232,0.08)" />
        ))}

        {radii.map((rr, i) => (
          <Circle
            key={rr}
            cx={cx}
            cy={ringY}
            r={rr}
            fill="none"
            stroke={colors[i]}
            strokeWidth={w}
          />
        ))}
      </Svg>
    </View>
  );
}

// ----------------------------------------------------------------------- styles

/**
 * `--on-accent` inside the `.welcome` scope, which is the dark value in both themes
 * because the whole screen is.
 *
 * This is the fourth and last of the web's `var(--on-accent)` consumers to get an Android
 * counterpart — the other three are the tab badge, the filled button and the FAB. Written
 * as `DARK.onAccent` rather than the `#0b1a2e` the stylesheet restates, so it cannot drift
 * away from the palette it came from.
 */
const ON_ACCENT = DARK.onAccent;

/**
 * `.welcome-foot`'s colour, and the one place this file does not simply take the token.
 *
 * `.welcome` restates the dark palette inside its own scope and changes exactly one value
 * while doing it: `--text-3` is lifted from `#80868b` to `#9aa0a6`, because 12px of
 * `#80868b` on near-black lands under 4.5:1. `DARK.text3` is `#949a9f` — the fix the rest
 * of the app got, which is enough against `#131314` but is not the value this screen was
 * measured at. So this follows the stylesheet, and `#9aa0a6` happens to be `DARK.text2`.
 */
const FOOT = DARK.text2;

/**
 * A plain `StyleSheet.create` rather than the `styles = (t: Theme) => …` factory every
 * other screen uses with `useStyles`. The factory exists to rebuild styles when the
 * palette changes; nothing here depends on the palette in force, so there is nothing to
 * rebuild and no reason to make a reader wonder which theme these colours came from.
 */
const s = StyleSheet.create({
  // `background-color: #0b0d10`. See `Watermark` for the gradient that is not here.
  root: { flex: 1, backgroundColor: "#0b0d10" } as ViewStyle,

  content: { flexGrow: 1, justifyContent: "center", paddingHorizontal: space.page } as ViewStyle,

  // `.welcome-inner { width: 100%; max-width: 420px; margin: auto }`, and
  // `.stack > * + * { margin-top: 20px }` — 20, not `space.gap`'s 16. The stack is the
  // web's own prose rhythm and this screen is the only place in the app that borrows it.
  inner: { width: "100%", maxWidth: 420, alignSelf: "center", gap: 20 } as ViewStyle,

  hero: { alignItems: "center" } as ViewStyle,

  // `.welcome-mark` — a 60px blue disc with the wallet in it, carrying `--shadow-2`.
  // `shadow.dark.two` and not a theme lookup, because the screen is dark either way.
  mark: {
    width: 60,
    height: 60,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: DARK.blue,
    ...shadow.dark.two,
  } as ViewStyle,

  // `.welcome-title { margin: 16px 0 0; font-size: 30px; font-weight: 500;
  // letter-spacing: -0.5px }`. Between `font.pageTitle`'s 28 and nothing else in the
  // scale, so it is written out rather than forced into a token.
  title: {
    marginTop: 16,
    fontSize: 30,
    fontWeight: weight.medium,
    letterSpacing: -0.5,
    color: DARK.text,
  } as TextStyle,

  // `.welcome-tag { margin: 6px 0 0; font-size: 14px; line-height: 1.55 }` — 14 × 1.55
  // is 21.7, and RN wants an absolute number.
  tag: {
    marginTop: 6,
    ...font.body,
    lineHeight: 21.7,
    color: DARK.text2,
    textAlign: "center",
  } as TextStyle,

  feats: { gap: 14 } as ViewStyle,
  feat: { flexDirection: "row", alignItems: "flex-start", gap: 12 } as ViewStyle,

  // `.welcome-feat-icon` — 32px disc on `--surface-2`, glyph in `--blue`. `flex: 0 0 auto`
  // is `flexShrink: 0` here; without it a long title squeezes the circle into an oval.
  featIcon: {
    width: 32,
    height: 32,
    flexShrink: 0,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: DARK.surface2,
  } as ViewStyle,

  // `li > span:last-child { display: flex; flex-direction: column; gap: 2px }`, plus
  // `flex: 1` so the body wraps inside the row rather than pushing it wide.
  featText: { flex: 1, gap: 2 } as ViewStyle,

  // The rows are `font-size: 13px`, so `font.small13`, and the title is a `<strong>`.
  // `.strong` and `.bullets strong` are both `font-weight: 500` in this app — emphasis
  // here is one step up, not bold — which is `weight.medium`.
  featTitle: { ...font.small13, fontWeight: weight.medium, color: DARK.text } as TextStyle,
  featBody: { ...font.small13, color: DARK.text2 } as TextStyle,

  door: { gap: 12 } as ViewStyle,

  // `.btn` filled, with `.welcome .btn { width: 100% }`. The geometry is `ui.tsx`'s own
  // `btn` style transcribed — the same 10/20 padding, pill radius and transparent
  // hairline — with `alignSelf` going from `flex-start` to `stretch`, which is that one
  // CSS rule. Transcribed rather than imported because `ui.tsx` does not export its
  // stylesheet, and `LinkButton` is a `<Link>`: this button has to run code before it
  // navigates.
  btn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "stretch",
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: "transparent",
    backgroundColor: DARK.blue,
  } as ViewStyle,
  btnLabel: { ...font.button, color: ON_ACCENT } as TextStyle,
  pressed: { opacity: 0.65 } as ViewStyle,

  // `.welcome-foot` — the shield and the sentence, centred, 12px, `--text-3`.
  foot: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 } as ViewStyle,
  footText: { ...font.small, color: FOOT, textAlign: "center" } as TextStyle,
});
