/**
 * Where the password for an encrypted PDF lives between the upload and the commit.
 *
 * Indian banks ship statements locked with a PAN-and-date-of-birth password, and the
 * review screen re-parses the stored file rather than keeping a copy of the rows, so
 * the password is needed more than once. The three places it could be kept are the
 * database (where it would outlive the import and sit next to the file it opens), the
 * route params (where it would be in the navigation state, and in anything that ever
 * logs or restores one), or here.
 *
 * ---
 *
 * **Re-homed from the web app, not ported.** There the same three functions wrote an
 * httpOnly, `sameSite: "lax"` session cookie scoped to `/journal/statement`: gone when
 * the browser closed, deleted outright on commit or discard. There are no cookies on a
 * phone, and the honest analogue of a *session* cookie is not storage of any kind — it
 * is a variable, because the app process is the session.
 *
 * So: a `Map` at module scope. It is cleared when the app is killed, with nothing to
 * clear up and nothing left behind on the filesystem for a future version of the app,
 * a backup, or anyone holding the unlocked phone to find. **`expo-secure-store` would
 * be the wrong answer** even though it is right there and already used for the Gemini
 * key — the keystore is for a secret that has to survive a restart, and the whole
 * point of this one is that it must not.
 *
 * The three signatures are the web's, `async` kept even though nothing here awaits
 * anything, so that the call sites are the same code on both platforms and a future
 * change of mind about where this lives does not ripple.
 *
 * It never leaves the phone either way — the importer opens no outbound connection,
 * and the one feature that does (Ask, plus the camera scan) cannot see any of this —
 * but a secret with a shorter life is still a smaller secret.
 *
 * ## The one behavioural difference, stated
 *
 * A cookie survived a page reload; this does not survive the app being killed. If
 * Android reclaims the app while the review screen is open, re-opening the batch asks
 * for the password again. That is a worse experience and a better outcome than the
 * alternative, and the review screen already has a password field for exactly this
 * case — it is the same field that handles getting it wrong the first time.
 */

const held = new Map<number, string>();

export async function rememberPassword(id: number, password: string): Promise<void> {
  if (!password) return;
  held.set(id, password);
}

export async function recallPassword(id: number): Promise<string | undefined> {
  return held.get(id);
}

export async function forgetPassword(id: number): Promise<void> {
  held.delete(id);
}
