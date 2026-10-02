/**
 * The Gemini API key, on a device.
 *
 * On the web this file does not exist: the key is `GEMINI_API_KEY` in `.env`, read
 * by the server, and the browser never sees it. A phone has no server and no
 * `.env`, so the key has to be *typed in* once and kept somewhere — and the one
 * place it must never be is the source tree or the bundle, both of which ship to
 * anyone who has the APK.
 *
 * So it lives in `expo-secure-store`, which on Android is SharedPreferences whose
 * values are encrypted with a key held in the Android Keystore. That is the same
 * facility the platform gives its own credential storage; it is not perfect against
 * a rooted device with the screen unlocked, and nothing on a phone is, but it is
 * categorically better than AsyncStorage (plaintext, readable by `adb backup` on a
 * debuggable build) and it is the right tool by name.
 *
 * ## Why there is a synchronous mirror
 *
 * The web's `aiConfigured()` is synchronous, and six places call it *during render*
 * to decide between a feature and an `<AiNotConfigured/>` card. SecureStore is
 * asynchronous, so a faithful port needs one of two things: make `aiConfigured()`
 * async and thread a promise through all six, or read the key once before anything
 * renders and answer from memory afterwards.
 *
 * This file does the second. `primeSecrets()` runs inside `bootstrap()` in
 * `app/_layout.tsx`, alongside `migrate()`, and nothing is on screen until it
 * resolves — so by the time any screen asks, the answer is known. `saveApiKey` and
 * `clearApiKey` update the mirror before they return, and both are followed by
 * `refreshAll()` at their call site, which is what makes Settings take effect on
 * the Ask and Insights screens without a restart.
 *
 * The mirror holds the key in memory for the life of the process. That is not a new
 * exposure — it has to be in memory to be sent — but it is the reason nothing here
 * logs it, returns it in an error, or puts it anywhere a screen could render it by
 * accident. `maskApiKey` exists precisely so Settings never has to hold the real
 * thing to show that it is set.
 */

import * as SecureStore from "expo-secure-store";

/**
 * Dots, dashes and underscores are the punctuation SecureStore permits in a key
 * name, so this is a legal identifier as well as a readable one.
 */
const STORE_KEY = "moneyfit.gemini.api.key";

/**
 * Where the Anthropic key used to live, kept only to be deleted.
 *
 * Renaming the store key is the right thing to do — a slot called
 * `moneyfit.anthropic.api.key` holding a Google credential is a lie that whoever
 * reads the keystore next has to untangle — but a rename orphans whatever is already
 * in the old slot. An orphaned key is not harmless: it is a working credential,
 * sitting in the keystore of a phone, that nothing in the app will ever use again
 * and nothing in the UI will ever offer to remove. So `primeSecrets()` deletes it
 * once, on the first launch after the upgrade, and this constant can go the next
 * time this file is touched for any other reason.
 */
const LEGACY_STORE_KEY = "moneyfit.anthropic.api.key";

/** The mirror. `null` means "no key"; `primed` distinguishes that from "not read yet". */
let cache: string | null = null;
let primed = false;

/**
 * Read the stored key into memory. Called once from `bootstrap()`.
 *
 * A failure here is deliberately swallowed. The keystore can refuse a value it can
 * no longer decrypt — a restored backup, a changed screen lock on some OEM builds —
 * and if that happened, the honest state of the app is "no key configured", which
 * shows the same card a first launch shows and offers the same fix: paste it again
 * in Settings. Throwing instead would take the whole app down over an optional
 * feature, which is exactly the failure mode the port is built to avoid.
 */
export async function primeSecrets(): Promise<void> {
  try {
    const stored = await SecureStore.getItemAsync(STORE_KEY);
    const trimmed = stored?.trim();
    cache = trimmed ? trimmed : null;
  } catch {
    cache = null;
  }
  primed = true;

  // After `primed`, so that whatever happens to the old slot cannot affect whether
  // the app believes it has a key — the two are unrelated and should stay that way.
  // A failure is swallowed for the same reason as the read above: there is nothing
  // the person holding the phone could do about it, and the worst case is that the
  // next launch tries again.
  try {
    await SecureStore.deleteItemAsync(LEGACY_STORE_KEY);
  } catch {
    // Already gone, which is the case on every launch but the first after upgrading.
  }
}

/**
 * The web's `aiConfigured()` in everything but name — synchronous, cheap, and safe
 * to call during render.
 *
 * Before priming this answers `false`. That is not a wrong answer waiting to be
 * corrected: nothing renders before `bootstrap()` resolves, so the only way to
 * observe the unprimed state is to call this from module scope, which nothing does.
 */
export function apiKeyConfigured(): boolean {
  return cache !== null;
}

/**
 * The authoritative read, for the request path. Primes on demand so a caller that
 * somehow runs before bootstrap still gets the real answer rather than a guess.
 */
export async function getApiKey(): Promise<string | null> {
  if (!primed) await primeSecrets();
  return cache;
}

/**
 * Store a key typed into Settings.
 *
 * The value is trimmed, because a key pasted from a browser or an email arrives
 * with a trailing newline more often than not and a key with whitespace on the end
 * fails authentication in a way that looks like a wrong key. Beyond that there is
 * no format check: a rejected key already produces one clear sentence from
 * `statusError()` in `ai/gemini.ts` ("The Gemini API key was rejected"), whereas a
 * prefix test here would lock the app out of a key format that has not been invented
 * yet — and that is not hypothetical. Google AI Studio issued `AIza…` keys for
 * years and now issues keys beginning `AQ.`, so a check written against the first
 * form would have rejected the second.
 */
export async function saveApiKey(raw: string): Promise<void> {
  const key = raw.trim();
  if (!key) {
    await clearApiKey();
    return;
  }
  try {
    await SecureStore.setItemAsync(STORE_KEY, key);
  } catch {
    // The message must not echo the value, so it says what failed and nothing else.
    throw new Error("The key could not be saved to the device's secure storage.");
  }
  cache = key;
  primed = true;
}

export async function clearApiKey(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(STORE_KEY);
  } catch {
    // Already absent, or unreadable — either way there is nothing left to remove.
  }
  cache = null;
  primed = true;
}

/**
 * What Settings displays. Enough to recognise which key is stored, not enough to
 * use: the first seven characters are a public prefix on every key Google AI Studio
 * issues (`AIzaSy…` on the older form, `AQ.Ab8…` on the current one), and four
 * trailing characters identify it among the two or three a person might have.
 *
 * The seven is unchanged from when this masked an `sk-ant-api03-` key, and still
 * reveals only prefix either way — but it is a judgement, not a rule, so if a future
 * key format carries entropy in its first seven characters this number has to come
 * down with it.
 */
export function maskApiKey(key: string): string {
  const k = key.trim();
  if (k.length <= 12) return "•".repeat(Math.max(k.length, 4));
  return `${k.slice(0, 7)}…${k.slice(-4)}`;
}
