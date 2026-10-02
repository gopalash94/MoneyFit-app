/**
 * The sidebar's lower half — the five destinations that did not fit in a bottom bar.
 *
 * In `Nav.tsx` these sat below a `.nav-sep`: Year and Profile under the "ANALYSIS"
 * `.nav-label`, then Ask, Insights and Settings under "TOOLS". Ten items in a column
 * is a sidebar; on a phone the five you live in are tabs and these five are one tap
 * behind the header button. The order is the sidebar's, groups and all — Year leads
 * because it leads the Analysis group there, which is also roughly how often you want
 * it relative to Settings.
 *
 * Each row's destination is filled in by the phase that builds it — under typed
 * routes an `href` naming a file that does not exist yet is a compile error, not a
 * broken button, which is the whole reason this list is data rather than five
 * hardcoded `<Link>`s. A row with no `href` renders dimmed and does not respond to
 * a tap, so the app is launchable and honest about what is not built rather than
 * silently doing nothing when pressed.
 */

import { Stack, router } from "expo-router";
import { Pressable, Text, View } from "react-native";

import { PlainScreen } from "@/components/Screen";
import { Icon, type IconName } from "@/components/Icon";
import { PageHead, type LinkTarget } from "@/components/ui";
import { useStyles, useTheme, type Theme } from "@/theme/ThemeProvider";
import { font, radius, space } from "@/theme/tokens";

type Row = {
  icon: IconName;
  label: string;
  sub: string;
  /** Filled in by the phase that builds the screen. */
  href?: LinkTarget;
};

const ROWS: Row[] = [
  {
    icon: "calendar",
    label: "Year",
    sub: "A whole calendar year — cashflow, goals, investing, net worth",
    href: "/year",
  },
  {
    icon: "profile",
    label: "Profile",
    sub: "Net worth, assets and liabilities",
    href: "/profile",
  },
  {
    icon: "ask",
    label: "Ask",
    sub: "A question about your own numbers, in plain English",
    href: "/ask",
  },
  {
    icon: "sparkle",
    label: "Insights",
    sub: "Spending patterns, anomalies and coaching",
    href: "/insights",
  },
  {
    icon: "settings",
    label: "Settings",
    sub: "Budgets, categories, API key and sample data",
    href: "/settings",
  },
];

export default function MoreScreen() {
  const s = useStyles(styles);
  return (
    <>
      <Stack.Screen options={{ title: "More" }} />
      <PlainScreen>
        <PageHead title="More" sub="Everything that is not a tab." />
        <View style={s.list}>
          {ROWS.map((row) => (
            <MoreRow key={row.label} row={row} />
          ))}
        </View>
      </PlainScreen>
    </>
  );
}

function MoreRow({ row }: { row: Row }) {
  const t = useTheme();
  const s = useStyles(styles);

  const body = (
    <>
      {/* `.icon-tile` — a 38px circle at 13% of the accent. */}
      <View style={s.tile}>
        <Icon name={row.icon} size={19} color={t.c.blue} />
      </View>
      <View style={s.rowText}>
        <Text style={s.rowLabel}>{row.label}</Text>
        <Text style={s.rowSub}>{row.sub}</Text>
      </View>
      {row.href ? (
        <Icon name="chevronRight" size={16} stroke={2.2} color={t.c.text3} />
      ) : (
        <Text style={s.soon}>Soon</Text>
      )}
    </>
  );

  if (!row.href) {
    return <View style={[s.row, s.rowOff]}>{body}</View>;
  }

  // Assigned to a local so the narrowing survives into the closure below — a
  // property access would widen back to `LinkTarget | undefined` inside it.
  const href = row.href;
  return (
    <Pressable
      accessibilityRole="link"
      onPress={() => router.push(href)}
      style={({ pressed }) => [s.row, pressed && s.pressed]}
    >
      {body}
    </Pressable>
  );
}

const styles = (t: Theme) => ({
  list: { gap: space.gapSm } as const,

  // `.entry` — a 38px tile, the text, and a trailing affordance.
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    padding: space.cardSm,
    borderRadius: radius.sm,
    backgroundColor: t.c.surface,
  } as const,

  // `.muted-card { opacity: 0.62 }`.
  rowOff: { opacity: 0.62 } as const,
  pressed: { backgroundColor: t.c.surface2 } as const,

  tile: {
    width: 38,
    height: 38,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: `${t.c.blue}22`,
  } as const,

  rowText: { flex: 1, gap: 2 } as const,
  rowLabel: { ...font.entryTitle, color: t.c.text } as const,
  rowSub: { ...font.small, color: t.c.text3 } as const,
  soon: { ...font.small, color: t.c.text3 } as const,
});
