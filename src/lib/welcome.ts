/**
 * The welcome screen's one piece of state — `Finance/src/lib/welcome.ts`, with the
 * cookie taken out and nothing put in its place.
 *
 * `/welcome` is a greeting, not a door. The web app's version of this file opens by
 * saying so, and the reason it can is that there are no accounts and nothing behind
 * that screen is protected. The same is true here for a different reason: the data is
 * a SQLite file inside the app's own sandbox (`src/lib/db.ts:36`), so what guards it
 * is Android's process isolation, not anything this module does.
 *
 * **Why a module-level `let` and not storage.** The web's cookie is a *session*
 * cookie — no `maxAge`, no `expires`, so the browser drops it when it closes — and
 * that omission is the entire mechanism: a new browser session sees the screen again,
 * clicking around inside one does not. The honest analogue on a phone is a variable
 * that lives as long as the process, because the app process *is* the session. Writing
 * this to `expo-secure-store` or to a `settings` row would be easy and would be a
 * different feature: "greeted once, ever" rather than "greeted when I open the app".
 *
 * Android may kill the process in the background and start a fresh one when you come
 * back, which re-runs module initialisation and sets this to false again. That is not a
 * bug to paper over — it is the same event as reopening the browser, and it produces
 * the same greeting.
 *
 * **Three of the web's four exports have no counterpart here**, and each absence is
 * worth naming rather than noticing later:
 *
 *   - `welcomeCookieOptions(secure)` — there is no cookie, so no `httpOnly`, no
 *     `sameSite` and no path scope.
 *   - `isSecureOrigin(…)` — it existed to decide whether to mark that cookie `Secure`,
 *     guessing towards `false` because a `Secure` cookie on plain `http://localhost` is
 *     silently dropped and the screen would return forever. Nothing here is sent over a
 *     transport at all.
 *   - `safeNext(next)` — the sharpest one. On the web "where you were going" is a
 *     string out of a query string going into a redirect, which is exactly how an open
 *     redirect gets built, so `//evil.example` had to be rejected as a *URL* dressed as
 *     a path. Here "where you were going" is the navigation stack itself: the gate in
 *     `app/_layout.tsx` pushes this screen *over* whatever route the app opened on, and
 *     the door pops it. There is no string, so there is nothing to sanitise and nothing
 *     for anyone to supply.
 *
 * The web's cookie is unsigned and unencrypted on purpose, because forging it buys you
 * a skipped greeting. This goes one further: there is no value to forge. Nothing
 * outside this module can read it or set it, and the two functions below are the whole
 * surface.
 */

let welcomed = false;

/**
 * Whether this run of the app has shown the greeting.
 *
 * Synchronous, and that is load-bearing in two places: the gate reads it in an effect
 * on the first frame after the navigator mounts, and the screen reads it during render
 * to decide whether the button says "Start exploring" or "Back to the app". Neither can
 * await anything without a flash of the wrong state.
 */
export function hasWelcomed(): boolean {
  return welcomed;
}

/**
 * Records that the greeting has been shown — the `jar.set(WELCOME_COOKIE, "1")` in the
 * web's `enter` action, and the only thing the button does besides navigating.
 *
 * Called from the door and not from the gate, which is the web's rule rather than a
 * convenience: the middleware redirected on every navigation until the cookie existed, so
 * leaving the greeting without pressing anything got you it again. Backing out with the
 * system gesture therefore leaves this false on purpose. See `WelcomeGate` in
 * `app/_layout.tsx` for what that does and does not cause.
 */
export function markWelcomed(): void {
  welcomed = true;
}
