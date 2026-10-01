/**
 * The page wrapper — what every web page's `try { return await Inner() } catch`
 * was doing, made into a component.
 *
 * On the web each list page looked like this:
 *
 * ```tsx
 * export default async function Page({ searchParams }) {
 *   try { return await Journal(await searchParams); }
 *   catch (e) { return <DbUnavailable detail={String(e)} />; }
 * }
 * ```
 *
 * Three things were free there and are not here. A server component had already
 * finished its query before any HTML existed, so there was no loading state. The
 * page arrived fresh on every navigation because of `force-dynamic`, so there was
 * no refresh gesture. And `.main`'s padding came from a stylesheet rather than
 * from a scroll container. `Screen` supplies all three in one place, so the twenty
 * screens after this one are a `useLive` call and a render function:
 *
 * ```tsx
 * const live = useLive(load);
 * return <Screen live={live}>{(data) => <>…</>}</Screen>;
 * ```
 *
 * The render prop is what keeps this honest. `children` cannot be plain JSX,
 * because JSX is evaluated before it is passed — a screen written that way would
 * have to read `live.data!` with a non-null assertion and would crash on the first
 * frame, which is precisely the failure the web pattern existed to prevent. Taking
 * a function means the body only ever runs with data in hand, and `data` is typed
 * non-nullable inside it.
 *
 * **One rule for the detail screens.** `null` is how `useLive` says "no data yet",
 * so a loader must never return `null` to mean "no such row" — a bill id that does
 * not exist would leave the screen spinning forever instead of saying so. Return a
 * wrapper: `{ bill: Bill | null }`, and let the render function decide between
 * `<NotFound/>` and the page. That is the same split the web pages made, where
 * `load(n)` returning falsy called `notFound()` outside the try.
 */

import { RefreshControl, ScrollView, View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";

import { DbUnavailable, Loading } from "@/components/ui";
import type { LiveState } from "@/lib/live";
import { useTheme } from "@/theme/ThemeProvider";
import { space } from "@/theme/tokens";

/** `.main { padding: 20px 16px 96px }` plus clearance for the tab bar. */
function padding(): ViewStyle {
  return {
    paddingHorizontal: space.page,
    paddingTop: space.pageTop,
    paddingBottom: space.scrollFoot,
  };
}

export function Screen<T>({
  live,
  children,
  contentStyle,
}: {
  live: LiveState<T>;
  children: (data: T) => React.ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();

  // A failed read is one card with the real message and a retry — never a blank
  // screen, and never the whole app.
  if (live.error) {
    return (
      <View style={[{ flex: 1, backgroundColor: t.c.bg }, padding()]}>
        <DbUnavailable detail={live.error.message} onRetry={live.reload} />
      </View>
    );
  }

  if (live.data === null) {
    return (
      <View style={{ flex: 1, backgroundColor: t.c.bg, justifyContent: "center" }}>
        <Loading />
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: t.c.bg }}
      contentContainerStyle={[padding(), contentStyle]}
      // `keyboardShouldPersistTaps` so tapping a button inside a form screen
      // registers on the first tap instead of being eaten by the keyboard
      // dismissing. Harmless on screens with no inputs.
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          // `refreshing` and not `loading`: the data is already on screen, this is
          // the second-and-later read. `useLive` separates the two for exactly
          // this reason.
          refreshing={live.refreshing}
          onRefresh={live.reload}
          colors={[t.c.blue]}
          tintColor={t.c.blue}
          progressBackgroundColor={t.c.surface}
        />
      }
    >
      {children(live.data)}
    </ScrollView>
  );
}

/**
 * The same container for a screen with nothing to load — `more`, and the
 * placeholders standing in for screens that arrive in a later phase. No refresh
 * control, because there is nothing to refresh.
 */
export function PlainScreen({
  children,
  contentStyle,
}: {
  children: React.ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: t.c.bg }}
      contentContainerStyle={[padding(), contentStyle]}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}
