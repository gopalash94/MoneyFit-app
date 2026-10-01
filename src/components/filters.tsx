/**
 * The two filter controls every list screen shares — `Finance/src/components/filters.tsx`.
 *
 * On the web these were links. `MonthNav` built `?month=2026-09` with `URLSearchParams`
 * and `Tabs` built `?status=upcoming`, the browser navigated, and the server component
 * re-read with the new params. No client JavaScript at all, which was the point.
 *
 * The mechanism here is `router.setParams`, and the semantics are deliberately identical:
 * the params live on the route, not in a screen's state. Which matters for three reasons
 * the web got for free — the back gesture steps through your filters, a screen re-reads
 * because `useLive`'s dependency list contains the param and nothing else has to be told,
 * and nothing needs lifting when a filter is used by two controls at once.
 *
 * **`href()` is gone and nothing replaced it.** It existed to build a URL for a `<Link>`;
 * `setParams` merges into the params already on the route, so the caller no longer has to
 * carry the ones it is not changing. That is why `MonthNav` and `Tabs` lost their `path`
 * and `params` props — there is exactly one route they can be on, the one they are on.
 *
 * **Clearing a param is `""`, not `undefined`.** `setParams` merges, so there is no value
 * that removes a key. Every reader in this app already treats an empty string as absent —
 * the month validator's `/^\d{4}-\d{2}$/` rejects it and falls back to `thisMonth()`,
 * `Number("")` is `0` so a category id fails its `> 0` test, and `pick()` falls through to
 * its first option — so `""` *is* the cleared state, and `setFilters` maps `undefined` to
 * it so call sites can keep saying `{ month: undefined }` exactly as they did on the web.
 */

import { useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import type { TextStyle, ViewStyle } from "react-native";

import { Icon } from "./Icon";
import { addMonthKey, fmtMonth, thisMonth } from "@/lib/date";
import { useStyles, useTheme, type Theme } from "@/theme/ThemeProvider";
import { font, radius, weight } from "@/theme/tokens";

/** Same type as the web's, and the same `undefined` means "clear this one". */
export type Params = Record<string, string | undefined>;

/**
 * Writes filter params onto the current route.
 *
 * The `undefined` → `""` mapping is the whole reason this is a hook and not a direct
 * `router.setParams` call at each site.
 */
export function useSetParams(): (next: Params) => void {
  const router = useRouter();
  return (next) => {
    const out: Record<string, string> = {};
    for (const k of Object.keys(next)) out[k] = next[k] ?? "";
    router.setParams(out);
  };
}

/**
 * Back a month, forward a month, and a way home.
 *
 * The forward control is **disabled rather than hidden** at the current month, exactly as
 * on the web and for the same reason: the row must not change width when you reach the
 * present, or the label jumps sideways under your thumb. The label's `minWidth` is the
 * other half of that — "May 2026" and "September 2026" are 40px apart in Roboto, and a
 * month label that resizes as you step through it looks broken.
 */
export function MonthNav({ month }: { month: string }) {
  const s = useStyles(styles);
  const setParams = useSetParams();
  const now = thisMonth();
  const atNow = month >= now;

  return (
    <View style={s.monthNav}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Previous month"
        onPress={() => setParams({ month: addMonthKey(month, -1) })}
        style={({ pressed }) => [s.iconBtn, pressed ? s.pressed : null]}
      >
        <ChevIcon name="chevronLeft" />
      </Pressable>

      <Text style={s.monthLabel} numberOfLines={1}>
        {fmtMonth(month)}
      </Text>

      {atNow ? (
        // Present but inert. `accessibilityState` so a screen reader says so rather
        // than reading an enabled button that does nothing.
        <View accessibilityRole="button" accessibilityState={{ disabled: true }} style={[s.iconBtn, s.disabled]}>
          <ChevIcon name="chevronRight" />
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Next month"
          onPress={() => setParams({ month: addMonthKey(month, 1) })}
          style={({ pressed }) => [s.iconBtn, pressed ? s.pressed : null]}
        >
          <ChevIcon name="chevronRight" />
        </Pressable>
      )}

      {month !== now ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setParams({ month: undefined })}
          style={({ pressed }) => [s.todayBtn, pressed ? s.pressed : null]}
        >
          <Text style={s.todayLabel}>Today</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function ChevIcon({ name }: { name: "chevronLeft" | "chevronRight" }) {
  const t = useTheme();
  return <Icon name={name} size={20} color={t.c.text2} />;
}

export type Tab = { value: string; label: string; count?: number };

/**
 * A row of pills, one of which is on — the web's `nav.tabs` with its `data-active`.
 *
 * An empty `value` is the "All" tab and clears the param, which is what the web's
 * `t.value || undefined` did.
 */
export function Tabs({
  tabs,
  active,
  name = "tab",
}: {
  tabs: Tab[];
  /** The param's current value; `""` when it is not set. */
  active: string;
  name?: string;
}) {
  const s = useStyles(styles);
  const setParams = useSetParams();

  return (
    <View accessibilityRole="tablist" style={s.tabs}>
      {tabs.map((tab) => {
        const on = tab.value === active;
        return (
          <Pressable
            key={tab.value || "all"}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => setParams({ [name]: tab.value || undefined })}
            style={({ pressed }) => [s.tab, on ? s.tabOn : null, pressed ? s.pressed : null]}
          >
            <Text style={on ? s.tabLabelOn : s.tabLabel}>
              {tab.label}
              {tab.count !== undefined ? <Text style={s.tabCount}>{` ${tab.count}`}</Text> : null}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = (t: Theme) => ({
  // `.month-nav`
  monthNav: { flexDirection: "row", alignItems: "center", gap: 2 } as ViewStyle,
  // `.btn-icon` — 36×36 and round, which is under the 44dp target but is what the
  // design is; the label between them is not pressable, so the two are never confused.
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  } as ViewStyle,
  // The web's `opacity: 0.3` on the disabled span.
  disabled: { opacity: 0.3 } as ViewStyle,
  pressed: { backgroundColor: t.c.surface2 } as ViewStyle,
  // `.month-nav-label`
  monthLabel: {
    ...font.cardTitle,
    color: t.c.text,
    minWidth: 132,
    textAlign: "center",
  } as TextStyle,
  todayBtn: {
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
    marginLeft: 2,
  } as ViewStyle,
  todayLabel: { ...font.buttonSm, color: t.c.blue } as TextStyle,

  // `nav.tabs` — `.tab` is `.pick` by another name: a pill that carries the accent as
  // a 14% tint when it is the one that is on.
  tabs: { flexDirection: "row", flexWrap: "wrap", gap: 8 } as ViewStyle,
  tab: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: t.c.border,
    backgroundColor: t.c.surface,
  } as ViewStyle,
  tabOn: { borderColor: t.c.blue, backgroundColor: t.c.blueDim } as ViewStyle,
  tabLabel: { ...font.small13, fontWeight: weight.medium, color: t.c.text2 } as TextStyle,
  tabLabelOn: { ...font.small13, fontWeight: weight.medium, color: t.c.blue } as TextStyle,
  tabCount: { color: t.c.text3 } as TextStyle,
});
