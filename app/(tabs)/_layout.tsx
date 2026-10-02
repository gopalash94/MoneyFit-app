/**
 * The tab shell — `Finance/src/components/Nav.tsx`, rearranged for a phone.
 *
 * The web sidebar had nine destinations in one column: Home, Journal, Track,
 * Goals, Invest, then a separator, then Ask, Insights, Settings, with Profile
 * above them. A bottom bar holds five before the labels start eliding, so the
 * five that are *places you keep going back to* are tabs, and the four you visit
 * on purpose sit behind the header button, exactly one tap further away. The tab
 * set is the `TABS` array below — reordering or swapping one is a one-line edit.
 *
 * Four things the sidebar did that are worth keeping:
 *
 *   - **The brand is still the three rings.** `.brand` was a Logo plus the word,
 *     at 20px/500/-0.2; it is the header title here, at the same size.
 *   - **The active item is blue on `--blue-dim`.** A bottom bar cannot paint a
 *     pill behind the active item without looking unlike every other Android app,
 *     so the tint carries it and the icon's stroke thickens from 1.8 to 2.2 — the
 *     same trick `.nav-item[data-active]` was doing with colour alone.
 *   - **Journal carries a count of what is overdue.** `.nav-item .badge`, fed by
 *     `countOverdue()`. This one was missed when the sidebar became a tab bar, and
 *     `queries/bills.ts` has been carrying a doc comment promising "the badge on
 *     the tab bar" ever since. It is the reason the tab shell reads from the
 *     database at all: a number on a tab is the only thing in this app that tells
 *     you something needs doing without being asked.
 *   - **The theme button stays in the top-right corner**, where `.theme-toggle`
 *     put it (`position: fixed; top: 22px; right: 30px`).
 *
 * **The FAB is here, and it is complete.** `Fab` read the current route and offered
 * the matching "add" — `newHrefFor` and `fabLabelFor`, the same three-way branch
 * written twice, merged into `addFor` below. All three destinations now exist, so
 * every tab has a button and `addFor` always returns one — the only case that hides
 * the FAB is the web's own `/new`|`/edit` guard.
 *
 * It is positioned rather than laid out, as `.fab` was (`position: fixed; right:
 * 32px; bottom: 28px`): a sibling of the navigator, painted after it, so it floats
 * over whichever tab is showing. `space.scrollFoot` is the other half of that —
 * every screen already reserves 112px at the foot of its scroll content so the last
 * row cannot hide under the bar and the button above it.
 */

import { Link, Tabs, router, usePathname } from "expo-router";
import { Pressable, Text, View } from "react-native";
import type { TextStyle, ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon, Logo, type IconName } from "@/components/Icon";
import type { LinkTarget } from "@/components/ui";
import { bump, useLive } from "@/lib/live";
import { countOverdue } from "@/lib/queries/bills";
import { setSettings } from "@/lib/queries/settings";
import { useStyles, useTheme, type Theme } from "@/theme/ThemeProvider";
import { font, radius, space, weight } from "@/theme/tokens";

const TABS: { name: string; title: string; icon: IconName }[] = [
  { name: "index", title: "Home", icon: "home" },
  { name: "journal", title: "Journal", icon: "journal" },
  { name: "track", title: "Track", icon: "track" },
  { name: "goals", title: "Goals", icon: "goals" },
  { name: "invest", title: "Invest", icon: "invest" },
];

/**
 * React Navigation's own default bottom-tab height on Android. The navigator adds
 * the safe-area inset to this itself, so the FAB has to add both — and the 12px gap
 * below means being a pixel out here is not something you could see.
 */
const TAB_BAR_H = 49;

export default function TabsLayout() {
  const t = useTheme();
  const s = useStyles(styles);

  // The badge's count. `useLive` rather than a one-shot read, because the number has to
  // fall the moment a bill is marked paid — every write goes through an action that
  // calls `refreshAll()`, which bumps the version this subscribes to, so the tab bar is
  // refreshed by the same signal the lists are.
  //
  // `?? 0` covers both the first render and a failed read. The web wrote that as a
  // `let overdue = 0` around a `try`/`catch` whose empty body said "left at the defaults
  // on purpose": a database the shell cannot reach is reported by the screen inside it,
  // which has room to explain, and not by a piece of chrome that can only be a number.
  const overdue = useLive(() => countOverdue(), []).data ?? 0;

  return (
    // The navigator cannot have a non-Screen child, so the FAB is its sibling and
    // this wrapper is what they share. Last child, so it paints on top — `.fab`
    // used `z-index: 40` for the same reason.
    <View style={s.shell}>
      <Tabs
        screenOptions={{
          headerStyle: { backgroundColor: t.c.sidebar },
          headerShadowVisible: false,
          headerTitleAlign: "left",
          headerTitle: () => <Brand />,
          headerRight: () => <HeaderActions />,

          tabBarActiveTintColor: t.c.blue,
          tabBarInactiveTintColor: t.c.text2,
          tabBarStyle: {
            backgroundColor: t.c.sidebar,
            // The sidebar's only edge was a hairline; the tab bar's is the same
            // one, turned ninety degrees.
            borderTopColor: t.c.borderSoft,
          },
          tabBarLabelStyle: font.label,
        }}
      >
        {TABS.map((tab) => (
          <Tabs.Screen
            key={tab.name}
            name={tab.name}
            options={{
              title: tab.title,
              tabBarIcon: ({ color, focused }) => (
                <Icon name={tab.icon} size={24} stroke={focused ? 2.2 : 1.8} color={color} />
              ),
              // `{it.href === "/journal" && overdue > 0 && …}` on the web, and the same
              // two conditions here — `undefined` is how this prop says "no badge", so
              // a zero is not rendered as a nought. Written as a ternary inside the
              // shared `options` rather than a branch around it, because every other
              // option on every tab is identical and splitting the object to give one
              // tab one extra line would hide that.
              tabBarBadge:
                tab.name === "journal" && overdue > 0 ? overdue : undefined,
              tabBarBadgeStyle: s.badge,
            }}
          />
        ))}
      </Tabs>

      <Fab />
    </View>
  );
}

/** `.brand` — the mark and the word, at the sidebar's own size. */
function Brand() {
  const s = useStyles(styles);
  return (
    <View style={s.brand}>
      <Logo size={26} />
      <Text style={s.brandName}>MoneyFit</Text>
    </View>
  );
}

function HeaderActions() {
  const s = useStyles(styles);
  return (
    <View style={s.actions}>
      <ThemeButton />
      <MoreButton />
    </View>
  );
}

/**
 * `.theme-btn` — the sun/moon swap.
 *
 * The web version was a form posting to the `setTheme` action; here it writes the
 * same `settings.theme` row and bumps the live-data counter, which is precisely
 * what that action did (`put("theme", …)` then `refreshAll()`). The root layout
 * re-reads the row and the whole tree re-themes.
 *
 * It carries the web app's one caveat unchanged: this writes an explicit "light"
 * or "dark", so once you press it the app stops following the system setting.
 * Settings has a three-way control for going back to "system".
 */
function ThemeButton() {
  const t = useTheme();
  const s = useStyles(styles);
  const next = t.isDark ? "light" : "dark";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Switch to ${next} theme`}
      hitSlop={8}
      onPress={() => {
        // Fire and forget, then bump: a failed settings write is not worth a
        // dialog, and the theme simply stays as it is.
        setSettings({ theme: next })
          .then(bump)
          .catch(() => {});
      }}
      style={({ pressed }) => [s.iconBtn, pressed && s.pressed]}
    >
      {/* `.theme-to-dark` / `.theme-to-light` were two icons with a CSS display
          swap, because the server could not know which theme was active. Here it
          is one icon and a conditional — the moon offers dark, the sun offers
          light, same as the stylesheet's pairing. */}
      <Icon name={t.isDark ? "sun" : "moon"} size={20} color={t.c.text2} />
    </Pressable>
  );
}

/** The sidebar's lower half — Profile, Ask, Insights, Settings — one tap away. */
function MoreButton() {
  const t = useTheme();
  const s = useStyles(styles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Profile and more"
      hitSlop={8}
      onPress={() => router.push("/more")}
      style={({ pressed }) => [s.iconBtn, s.avatar, pressed && s.pressed]}
    >
      <Icon name="profile" size={19} stroke={2} color={t.c.blue} />
    </Pressable>
  );
}

// ---------------------------------------------------------------------- the FAB

type Add = { href: LinkTarget; label: string };

/**
 * `newHrefFor` and `fabLabelFor`, which were the same three-way branch written
 * twice, returning one object instead. Same three branches, same precedence, same
 * labels — and, as the web's comment put it, what "add" means depends on where you
 * are, which is exactly how Fit's FAB behaves.
 */
function addFor(pathname: string): Add {
  if (pathname.startsWith("/goals")) return { href: "/goal/new", label: "New goal" };
  if (pathname.startsWith("/invest")) return { href: "/holding/new", label: "New holding" };
  return { href: "/bill/new", label: "Add bill" };
}

/**
 * The extended floating action button — `.fab`, bottom-right, at the same 15×22
 * padding, 20px radius, `--shadow-2` and `--on-accent` text the stylesheet gave it.
 * Dark mode's `color: #0b1a2e` override is `onAccent`'s dark value, so one token
 * covers both themes.
 *
 * **Two things it sits above.** The tab bar's own height, and the gesture area
 * below it — hence `insets.bottom`, which the navigator adds to its own height and
 * this has to add again.
 *
 * The web hid the FAB on any route ending `/new` or `/edit`, because an add button
 * on the add form is nonsense. That check is kept, though it is now defensive
 * rather than load-bearing: those screens are pushed onto the root stack *over*
 * this layout, so they already cover it.
 */
function Fab() {
  const t = useTheme();
  const s = useStyles(styles);
  const insets = useSafeAreaInsets();
  const pathname = usePathname();

  if (/\/(new|edit)$/.test(pathname)) return null;

  const add = addFor(pathname);

  return (
    <Link href={add.href} asChild>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={add.label}
        style={({ pressed }) => [
          s.fab,
          { bottom: insets.bottom + TAB_BAR_H + 12 },
          pressed ? s.fabPressed : null,
        ]}
      >
        <Icon name="plus" size={22} stroke={2.2} color={t.c.onAccent} />
        <Text style={s.fabLabel}>{add.label}</Text>
      </Pressable>
    </Link>
  );
}

const styles = (t: Theme) => ({
  shell: { flex: 1 } as const,

  brand: { flexDirection: "row", alignItems: "center", gap: 12 } as const,
  // `.brand { font-size: 20px; font-weight: 500; letter-spacing: -0.2px }` — the
  // one size in the stylesheet that no other element uses, so it is not a token.
  brandName: {
    fontSize: 20,
    fontWeight: weight.medium,
    letterSpacing: -0.2,
    color: t.c.text,
  } as const,

  /**
   * `.nav-item .badge` — the overdue count on the Journal tab.
   *
   * Four of the web's nine declarations are here and five are not, and the split is
   * the point. `margin-left: auto` and `display: grid` placed the badge at the end of
   * a sidebar row; the navigator places this one itself. `min-width: 18px; height:
   * 18px; border-radius: 9px` is the pill, and React Navigation's badge already draws
   * an 18px round one — so it is left alone rather than restated, because restating a
   * height without the line height that centres a digit inside it is how you clip the
   * digit.
   *
   * What is left is colour and size, and the colour is carrying the web's reason
   * verbatim: *"Not #fff: --red is a deep red in light mode but a pale #f28b82 in dark,
   * where white on it is 2.39:1 — a count you cannot read. --on-accent flips with the
   * palette, which is exactly the flip this needs."* This is the most load-bearing use
   * of `onAccent` in either codebase: on a button the token is a refinement, here it is
   * the difference between a number and a smudge.
   */
  badge: {
    backgroundColor: t.c.red,
    color: t.c.onAccent,
    fontSize: 11,
    fontWeight: weight.semi,
  } as TextStyle,

  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.gapSm,
    // The header's own right edge is flush with the screen; `.theme-toggle` sat
    // 30px in on the desktop and 12px in below 860px, which is this.
    paddingRight: space.page - 4,
  } as const,

  // `.btn-icon` — 36×36, round, no background until pressed.
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  } as const,

  // The avatar reads as a filled chip rather than a bare glyph, so the two
  // buttons beside each other are not mistaken for a pair of the same thing.
  avatar: { backgroundColor: t.c.blueDim } as const,

  pressed: { opacity: 0.6 } as const,

  // `.fab` — `right: 32px` against a 32px page gutter, so it is the page gutter
  // here too. `bottom` is supplied by the component, which is the only thing that
  // knows how tall the bar below it is.
  fab: {
    position: "absolute",
    right: space.page,
    flexDirection: "row",
    alignItems: "center",
    gap: space.gapSm,
    paddingVertical: 15,
    paddingHorizontal: 22,
    borderRadius: radius.md,
    backgroundColor: t.c.blue,
    ...t.shadow2,
  } as ViewStyle,
  // `.fab:hover` lifted the button a pixel and deepened its shadow. A finger is
  // already on it, so the press goes the other way: down and slightly dimmed.
  //
  // `as ViewStyle` and not `as const`: a const assertion would make the transform
  // a *readonly* array, which is not assignable to the mutable one RN declares.
  fabPressed: { opacity: 0.92, transform: [{ translateY: 1 }] } as ViewStyle,
  fabLabel: { ...font.button, color: t.c.onAccent } as TextStyle,
});
