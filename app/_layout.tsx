/**
 * The root layout — `Finance/src/app/layout.tsx`.
 *
 * The web version was nine lines of JSX around `<Nav/>` and `{children}`, and it
 * could afford to be: the database was already migrated by the time Next.js
 * started, the theme came out of a cookie-free server read before the first byte
 * of HTML, and `export const dynamic = "force-dynamic"` handled freshness. None of
 * those three are true on a phone, so this file does the work that the deployment
 * used to do:
 *
 *   1. **Migrations run here, once, before anything renders.** `migrate()` is the
 *      first thing that touches the file, so no screen can race it and every
 *      query below can assume the schema exists.
 *   2. **The theme preference is read from the database**, because `settings.theme`
 *      is the same row the web app writes. Until that read resolves the app has no
 *      opinion and ThemeProvider's default (light) applies — which is exactly what
 *      `:root` did before any `data-theme` attribute was set.
 *   3. **A failure here is one card, not a blank app.** The plan's rule for every
 *      screen applies hardest to this one: if the database cannot be opened or a
 *      migration throws, this renders `DbUnavailable` with the real message and a
 *      retry, rather than a white rectangle with no explanation.
 *
 * Both reads go through `useLive`, so `bump()` re-runs them — which is how the
 * theme button in the header takes effect: it writes `settings.theme` and bumps,
 * this re-reads, and `pref` changes. `migrate()` runs again on each bump and
 * returns in one `PRAGMA user_version` read once the schema is current, which is
 * cheap enough not to be worth special-casing.
 *
 * Rendering `<Loading/>` instead of the navigator on the first frames is
 * deliberate and supported — it is the same shape as Expo's own font-loading
 * example, which returns `null` until the fonts are in. Nothing can navigate
 * before the navigator mounts, because nothing is on screen to navigate from.
 */

import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider, initialWindowMetrics } from "react-native-safe-area-context";

import { DbUnavailable, Loading } from "@/components/ui";
import { migrate, type MigrateResult } from "@/db/migrations";
import { useLive, type LiveState } from "@/lib/live";
import { primeSecrets } from "@/lib/secrets";
import { getSettings } from "@/lib/queries/settings";
import { ThemeProvider, useTheme } from "@/theme/ThemeProvider";
import { font, space } from "@/theme/tokens";
import type { Settings } from "@/lib/types";

type Boot = { migration: MigrateResult; settings: Settings };

/**
 * Module scope, not a closure: `useLive` captures the loader once on purpose, and
 * a fresh function each render would make every render look like a new query.
 */
async function bootstrap(): Promise<Boot> {
  const migration = await migrate();
  const settings = await getSettings();
  // Reads the stored Anthropic key into memory so `apiKeyConfigured()` can answer
  // synchronously during render, the way the web's `aiConfigured()` does. It never
  // throws, so it cannot turn a missing optional key into a failed launch.
  await primeSecrets();
  return { migration, settings };
}

export default function RootLayout() {
  return (
    // Gesture handler has to be the outermost native view for swipe-back and any
    // future gesture to reach it. SafeAreaProvider is given `initialWindowMetrics`
    // so the first frame already knows the insets instead of laying out at zero
    // and jumping — which matters because app.json turns edge-to-edge on.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
        <Bootstrapper />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function Bootstrapper() {
  const boot = useLive(bootstrap);
  // Before the read lands there is no stored preference, so follow the OS — the
  // same default `getSettings` itself applies when the row is missing.
  const pref = boot.data?.settings.theme ?? "system";
  return (
    <ThemeProvider pref={pref}>
      <Chrome boot={boot} />
    </ThemeProvider>
  );
}

function Chrome({ boot }: { boot: LiveState<Boot> }) {
  const t = useTheme();

  // `html, body { background: var(--bg) }`. The navigator paints its own scenes,
  // but this shows during transitions and behind a screen that is shorter than
  // the window.
  const page = { flex: 1, backgroundColor: t.c.bg } as const;

  if (boot.error) {
    return (
      <View style={[page, { justifyContent: "center", padding: space.page }]}>
        <StatusBar style={t.isDark ? "light" : "dark"} />
        <DbUnavailable detail={boot.error.message} onRetry={boot.reload} />
      </View>
    );
  }

  if (!boot.data) {
    return (
      <View style={[page, { justifyContent: "center" }]}>
        <StatusBar style={t.isDark ? "light" : "dark"} />
        <Loading label="Opening your data…" />
      </View>
    );
  }

  return (
    <View style={page}>
      {/* `<meta name="theme-color">`, in effect: the clock and battery icons have
          to invert with the palette or they disappear against the header. */}
      <StatusBar style={t.isDark ? "light" : "dark"} />
      <Stack
        screenOptions={{
          // The pushed screens (a bill, a goal, an edit form) get a plain themed
          // header with a back arrow. Each screen sets its own `title` from its
          // own file, so adding a route never means editing this one.
          headerStyle: { backgroundColor: t.c.sidebar },
          headerTintColor: t.c.text,
          headerTitleStyle: { ...font.cardTitle, color: t.c.text },
          // `border-right: 1px solid var(--border-soft)` was the sidebar's only
          // edge; a drop shadow under the header is not in the design.
          headerShadowVisible: false,
          contentStyle: { backgroundColor: t.c.bg },
        }}
      >
        {/* The tab group draws its own header, with the brand and the theme
            button, so the stack must not draw a second one above it. */}
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      </Stack>
    </View>
  );
}
