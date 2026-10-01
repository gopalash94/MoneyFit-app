/**
 * `revalidatePath`, rebuilt out of a counter.
 *
 * On the web every action ended with `refreshAll()`, which called
 * `revalidatePath("/", "layout")`; Next threw away the cached render and the
 * server components re-ran their SQL. There is no server here and no cache to
 * invalidate, so the same effect is produced by the smallest thing that can do
 * it: a module-level version number that screens watch.
 *
 * `bump()` increments it. `useLive(fn, deps)` runs `fn` and re-runs it whenever
 * the number changes. Because `refreshAll()` in actions/shared.ts calls `bump()`,
 * **every existing call site is unchanged** — the actions still end the same line.
 *
 * Deliberately coarse, exactly as `revalidatePath("/", "layout")` was: one
 * counter for the whole app, so adding a bill refreshes Home's rings, the
 * journal, the budget card and the net-worth chart without any of them
 * declaring a dependency on bills. Against one person's data, over SQLite on the
 * device, re-running every mounted screen's query costs single-digit
 * milliseconds; a fine-grained scheme would cost a class of bug where a screen
 * silently shows yesterday's number.
 *
 * Screens are not re-queried on focus, and do not need to be: a tab that has
 * been sitting mounted while you edited something elsewhere was refreshed by the
 * `bump()` that edit caused. Only data changing behind the app's back would need
 * focus, and nothing can change it — there is no server and no second writer.
 *
 * (The plan called this file live.tsx. It holds no JSX — the render side of the
 * pattern, the loading and DbUnavailable states every screen wraps itself in,
 * lives in components/ui.tsx where the rest of the presentation is.)
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

// ------------------------------------------------------------------ the store

let version = 0;
const listeners = new Set<() => void>();

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getSnapshot(): number {
  return version;
}

/**
 * Marks every live read as stale. Called by `refreshAll()` after a mutation.
 *
 * Synchronous on purpose: an action that awaits its writes and then calls this
 * has, by the time it returns, already told every mounted screen to re-read. So
 * the form can navigate away immediately and the list it lands on is correct.
 */
export function bump(): void {
  version += 1;
  for (const fn of listeners) fn();
}

/** The current version, for code outside a component. Used by nothing yet. */
export function liveVersion(): number {
  return version;
}

// -------------------------------------------------------------------- the hook

export type LiveState<T> = {
  /** null until the first load resolves. Keeps the previous value during a reload. */
  data: T | null;
  /** Whatever the loader threw. Screens render DbUnavailable from it, as the web pages did. */
  error: Error | null;
  /** True only while there is nothing to show yet, so a reload does not blank the screen. */
  loading: boolean;
  /** True during any load, including one that is refreshing data already on screen. */
  refreshing: boolean;
  /** Pull-to-refresh, and the "try again" button on the error card. */
  reload: () => void;
};

/**
 * Runs `load` now, again whenever `bump()` fires, and again when `deps` change.
 *
 * This is the phone's version of a server component's body. The try/catch that
 * every web page wrapped around `Inner()` is here instead, which is why a failing
 * query costs one card rather than the whole screen.
 *
 *   const { data, error } = useLive(() => getBills(sp), [sp.month, sp.archived]);
 *   if (error) return <DbUnavailable detail={error.message} />;
 *   if (!data) return <Loading />;
 *
 * `deps` must keep the same length across renders, like any dependency list, and
 * should hold primitives — a fresh object or array each render would re-query on
 * every render. `load` itself is deliberately *not* a dependency: it is nearly
 * always an inline closure, so depending on it would mean exactly that bug.
 */
export function useLive<T>(load: () => Promise<T>, deps: readonly unknown[] = []): LiveState<T> {
  const v = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [refreshing, setRefreshing] = useState(true);

  // Manual reloads, independent of the global counter.
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  // The loader is read through a ref so a new closure each render does not
  // retrigger the effect, while the effect still calls the *current* one.
  const loadRef = useRef(load);
  loadRef.current = load;

  // Guards against an out-of-order resolve: two loads in flight, the slower one
  // started first, and its answer must not overwrite the newer one.
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    let alive = true;
    setRefreshing(true);

    loadRef
      .current()
      .then((next) => {
        if (!alive || mine !== seq.current) return;
        setData(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!alive || mine !== seq.current) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!alive || mine !== seq.current) return;
        setRefreshing(false);
      });

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v, nonce, ...deps]);

  return { data, error, loading: data === null && refreshing, refreshing, reload };
}
