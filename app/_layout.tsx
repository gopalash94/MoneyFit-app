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
 *   4. **The PDF reader is started here**, because it has to be running before
 *      anyone asks it for anything. `<PdfBridge/>` is an invisible WebView holding
 *      the pdf.js the statement importer reads PDFs with; it draws nothing and
 *      cannot fail in a way this file has to handle.
 *   5. **The greeting is triggered here**, for the same reason: `layout.tsx` checked a
 *      cookie and `middleware.ts` did the redirecting, and neither has an analogue on a
 *      phone. `<WelcomeGate/>` at the foot of this file is the whole of that, and it is
 *      the one deliberate exception to the note below about never editing this file to
 *      add a route.
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

import { Stack, router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider, initialWindowMetrics } from "react-native-safe-area-context";

import { PdfBridge } from "@/components/PdfBridge";
import { DbUnavailable, Loading } from "@/components/ui";
import { migrate, type MigrateResult } from "@/db/migrations";
import { useLive, type LiveState } from "@/lib/live";
import { primeSecrets } from "@/lib/secrets";
import { getSettings } from "@/lib/queries/settings";
import { hasWelcomed } from "@/lib/welcome";
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
  // Reads the stored Gemini key into memory so `apiKeyConfigured()` can answer
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
      {/* The off-screen WebView pdf.js runs in. Here rather than on the import
          screen because loading it takes a moment, and that moment would otherwise
          land on somebody who has just picked a statement and is waiting. It renders
          nothing, and every way it can fail ends up as "PDF reading is unavailable,
          import a CSV instead" on the import screen rather than as an error here. */}
      <PdfBridge />
      <WelcomeGate />
    </View>
  );
}

/**
 * `middleware.ts`, which on the web was 66 lines and here is an effect.
 *
 * It is the exception to the comment above about never editing this file to add a route,
 * and worth stating as one: every other screen is reached because somebody tapped
 * something, so the navigator alone knows about it. This one is reached because the app
 * opened, and the only thing that knows the app has just opened is the root layout.
 *
 * **Why `push` and not `replace`.** The web's middleware redirected to
 * `/welcome?next=<where you were going>` and the button redirected back to it, with
 * `safeNext` in between because that string arrives from outside. Pushing gives the same
 * behaviour with no string and nothing to sanitise: the screen goes *over* the route the
 * app opened on, and `router.back()` in the door reveals it. Replacing would discard it
 * and leave the button guessing.
 *
 * **The empty dependency array, and the flag, are doing different jobs.** The array means
 * this fires on mount and never again for a bump — the theme button must not re-greet you.
 * The flag is what survives a remount, and it is deliberately set by the *button* rather
 * than by this effect, which matches the web precisely: the middleware redirected on every
 * navigation until the cookie existed, so backing out of the greeting without pressing
 * anything got you the greeting again. Here the only thing that remounts the root layout
 * is the database going away and coming back, so "again" is rarer than it was on the web —
 * but it is the same rule, and the alternative, marking it here, would make the button read
 * "Back to the app" on a first run.
 *
 * Three differences from the middleware, all of them things that cannot happen here:
 *
 *   - It does not sniff for a navigation. There is no `Accept` header, no prefetch and no
 *     favicon request to exclude.
 *   - It does not skip non-GET requests. The middleware had to, because redirecting a
 *     Server Action POST turned "a saved bill" into "a trip through a welcome screen with
 *     the form data dropped on the floor". Nothing here is a request.
 *   - It has no `matcher`. The web's listed which paths get greeted; this runs before any
 *     path is chosen, which is simply a better place to stand.
 *
 * Rendering it as a sibling of `<Stack>` rather than a `Stack.Screen` is what makes the
 * push safe: siblings mount in order, so the navigator is already there when this
 * effect runs. `Chrome` only reaches this branch once `boot.data` exists, so the greeting
 * cannot arrive on top of the loading spinner either.
 */
function WelcomeGate() {
  useEffect(() => {
    if (!hasWelcomed()) router.push("/welcome");
  }, []);
  return null;
}
