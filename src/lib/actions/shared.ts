/**
 * Shared plumbing for every action in the app — `Finance/src/lib/actions/shared.ts`.
 *
 * Almost all of this is the web file byte for byte: `FormState`, `fail`, `Invalid`,
 * `invalidToState`, all six readers, all four validators with their exact error
 * sentences, and `done()`. That is the payoff of keeping the action signature
 * `(prev: FormState, fd: FormData) => Promise<FormState>` — the validation layer of
 * this app never had anything to do with servers, so it does not have to be ported,
 * only moved.
 *
 * Five things changed, and nothing else did.
 *
 * **`FormData` is ours.** Imported from `@/lib/form-data`, which shadows the global
 * for this module. React Native's built-in `FormData` implements `append`, `getAll`
 * and `getParts` and nothing else — no `get`, which is what all six readers below
 * are built on — and because Expo's tsconfig includes the DOM lib, calling
 * `fd.get()` on it type-checks and *then* throws at runtime. That file explains it
 * at length; the rule is that every module touching a `FormData` imports it.
 *
 * **`refreshAll()` bumps a counter.** `revalidatePath("/", "layout")` told Next to
 * drop its Router Cache; there is no router cache here, there are mounted screens
 * holding query results. `bump()` invalidates all of them and every `useLive` re-runs
 * its loader. Every call site in every action is unchanged.
 *
 * **`isControlFlow()` is gone**, rather than kept as a no-op. It existed because
 * Next implemented `redirect()` and `notFound()` by throwing a sentinel, so a broad
 * `catch` had to let those two back out. Here navigation is `router.replace()`, which
 * returns, and a missing row is a `<NotFound/>` render — neither one throws, so there
 * is nothing for a broad catch to re-raise. A function named `isControlFlow` that
 * always returned `false` would be a trap for whoever read it next.
 *
 * **`pickedFiles()` is new**, and is the one reader the web did not need. Its actions
 * wrote `fd.getAll("files").filter((f): f is File => f instanceof File && f.size > 0)`.
 * There is no `File` in React Native, so that same filter lives here once, against
 * `PickedFile`.
 *
 * **`FormState` gains `savedId` and `scan`.** The web's actions ended in `redirect()`,
 * which threw; navigation is the screen's job here, and it needs either the id of the row
 * that was just written or — for `scanBill` alone — the name of the file that was just
 * read. Both fields are documented at length on the type below.
 */

import { today, type ISODate } from "@/lib/date";
import type { PickedFile } from "@/lib/files";
import { FormData, isPickedFile } from "@/lib/form-data";
import { bump } from "@/lib/live";
import { parseAmount } from "@/lib/money";

export type FormState = {
  error?: string;
  /** Keyed by input `name`, rendered under the field it belongs to. */
  fields?: Record<string, string>;
  /**
   * The row the action just created or updated. **The one field the web's type did
   * not have.**
   *
   * On the web a successful mutation ended `redirect(`/journal/${billId}`)`, and
   * because `redirect` threw, the action never returned at all — a non-null
   * `FormState` therefore always meant failure. Here navigation belongs to the
   * screen, which has the router, and the screen has no other way to learn the id of
   * a row that did not exist when it rendered. So a successful create returns
   * `{ savedId }` and `<Form>`'s `onDone(state)` hands it over.
   *
   * Two consequences worth being explicit about, both handled: a non-null state no
   * longer implies an error, so every reader tests `state.error` rather than
   * `state` — `<Form>` does, and so does its auto-banner; and an action that has
   * nothing to navigate to still returns plain `null`, exactly as before.
   */
  savedId?: number;
  /**
   * The stored file name of a scan that was just read, for the same reason as `savedId`
   * and used by exactly one action.
   *
   * `scanBill` ended in ``redirect(`/journal/new?scan=${saved.file_name}`)`` on the web.
   * The destination is the ordinary new-bill form, which reads the draft back out of
   * `ai_cache` by this name — so the screen needs the name, and a UUID will not fit in
   * `savedId`. Everything else on the trip is identical: still a route parameter, still
   * gated by `STORED_NAME` before it reaches `getScanDraft`.
   */
  scan?: string;
} | null;

export function fail(error: string, fields?: Record<string, string>): FormState {
  return { error, fields };
}

/** Collects field errors, then throws once with all of them. */
export class Invalid extends Error {
  constructor(
    readonly fields: Record<string, string>,
    message = "Some fields need another look.",
  ) {
    super(message);
  }
}

export function invalidToState(e: unknown): FormState {
  if (e instanceof Invalid) return { error: e.message, fields: e.fields };
  return { error: e instanceof Error ? e.message : String(e) };
}

// ------------------------------------------------------------------ field readers

export function str(fd: FormData, name: string, max = 500): string {
  const v = fd.get(name);
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export function optStr(fd: FormData, name: string, max = 2000): string | null {
  const v = str(fd, name, max);
  return v === "" ? null : v;
}

export function bool(fd: FormData, name: string): boolean {
  const v = fd.get(name);
  return v === "on" || v === "true" || v === "1";
}

export function optInt(fd: FormData, name: string): number | null {
  const n = Number(str(fd, name, 20));
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function optNum(fd: FormData, name: string): number | null {
  const raw = str(fd, name, 30).replace(/,/g, "");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** One of a fixed set, falling back to the first value rather than erroring. */
export function pick<T extends string>(fd: FormData, name: string, allowed: readonly T[]): T {
  const v = str(fd, name, 40) as T;
  return allowed.includes(v) ? v : allowed[0];
}

/**
 * Every file entry under `name` that is worth uploading.
 *
 * The web's line was
 * `fd.getAll("files").filter((f): f is File => f instanceof File && f.size > 0)`.
 * Two differences, both forced: there is no `File` constructor to test against, so
 * `isPickedFile` checks the shape; and `size` is optional on a `PickedFile` because
 * `expo-document-picker` does not always report one. A missing size is *kept* here
 * rather than dropped — `saveUpload` measures the copied file itself and throws
 * `UploadError` if it is over the limit, so the real check is downstream either way,
 * and dropping a picked PDF for not declaring its size would lose the user's file
 * silently.
 */
export function pickedFiles(fd: FormData, name = "files"): PickedFile[] {
  return fd
    .getAll(name)
    .filter(isPickedFile)
    .filter((f) => f.size === undefined || f.size > 0);
}

// ------------------------------------------------------------------ validators
// Each records into `errs` and returns a usable value, so one pass over the form
// collects every problem instead of surfacing them one reload at a time.

export function reqText(
  fd: FormData,
  name: string,
  errs: Record<string, string>,
  label: string,
  max = 200,
): string {
  const v = str(fd, name, max);
  if (!v) errs[name] = `${label} is required.`;
  return v;
}

/** Money in paise. `allowZero` is for adjustments; a bill of ₹0 is a mistake. */
export function reqAmount(
  fd: FormData,
  name: string,
  errs: Record<string, string>,
  label = "Amount",
  opts: { allowZero?: boolean; allowNegative?: boolean } = {},
): number {
  const raw = str(fd, name, 30);
  if (!raw) {
    errs[name] = `${label} is required.`;
    return 0;
  }
  const minor = parseAmount(raw);
  if (minor === null) {
    errs[name] = `“${raw}” is not an amount. Try 1250, 1,250.50 or 1.2L.`;
    return 0;
  }
  if (!opts.allowNegative && minor < 0) {
    errs[name] = `${label} cannot be negative.`;
    return 0;
  }
  if (!opts.allowZero && minor === 0) {
    errs[name] = `${label} must be more than zero.`;
    return 0;
  }
  return minor;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function reqDate(
  fd: FormData,
  name: string,
  errs: Record<string, string>,
  label: string,
  fallbackToday = true,
): ISODate {
  const v = str(fd, name, 10);
  if (!v) {
    if (fallbackToday) return today();
    errs[name] = `${label} is required.`;
    return today();
  }
  if (!ISO.test(v)) {
    errs[name] = `${label} must be a date.`;
    return today();
  }
  return v;
}

export function optDate(fd: FormData, name: string, errs: Record<string, string>, label: string): ISODate | null {
  const v = str(fd, name, 10);
  if (!v) return null;
  if (!ISO.test(v)) {
    errs[name] = `${label} must be a date.`;
    return null;
  }
  return v;
}

export function done(errs: Record<string, string>): void {
  if (Object.keys(errs).length) throw new Invalid(errs);
}

/**
 * Tells every mounted screen its data is stale.
 *
 * The web called `revalidatePath("/", "layout")`: every page was a `force-dynamic`
 * server component, so there was no fetch cache to bust, but the client Router Cache
 * would happily serve a stale Journal after a write. Here the stale thing is a
 * `useLive` result sitting in component state — so `bump()` raises a module-level
 * version that every one of them subscribes to, and they all re-run their loaders.
 * Same bluntness, same reasoning: refreshing the whole tree is the honest thing to do
 * for an app this size.
 */
export function refreshAll(): void {
  bump();
}
