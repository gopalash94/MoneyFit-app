/**
 * A `FormData` that actually works on the device.
 *
 * ### Why this file exists
 *
 * The whole forms substitution in this port rests on one claim: every action keeps
 * its web signature, `(prev: FormState, fd: FormData) => Promise<FormState>`, and
 * `actions/shared.ts` copies over verbatim. That works because React 19's
 * `useActionState` accepts any async function and because React Native ships a
 * `FormData`.
 *
 * It ships a *stub*. `react-native/Libraries/Network/FormData.js` implements three
 * methods — `append()`, `getAll()` and `getParts()` — and nothing else. It exists
 * to feed `XMLHttpRequest` a multipart body, which is all it was ever asked to do.
 * There is no `get()`, no `has()`, no `set()`, no `delete()` and no iteration.
 *
 * And every reader in `shared.ts` is built on `fd.get(name)`.
 *
 * The trap is that this does not show up as a type error. `expo/tsconfig.base`
 * includes the DOM lib, so TypeScript types the global `FormData` from the DOM
 * declaration — the full interface — while the value at runtime is the stub. So
 * `fd.get(name)` compiles cleanly and then throws `fd.get is not a function` the
 * first time anyone saves a bill. On a project nobody can run before shipping,
 * that is the worst failure shape available.
 *
 * So this is our own class, and it is deliberately **named `FormData`**. Importing
 * it shadows the global lexically, which means `shared.ts`'s `fd: FormData`
 * annotation resolves to this class and every reader in it is unchanged from the
 * web — which is the point. The subset is faithful to the DOM spec for the six
 * methods it has, including `set()`'s replace-first-drop-the-rest behaviour and
 * the insertion-ordered entry list.
 *
 * ### The one hazard, stated plainly
 *
 * A module that *forgets* the import silently falls back to the DOM type and still
 * compiles — you get the stub back, with no warning. **Every file that touches a
 * `FormData` must import it from here**, actions and form components alike. There
 * is no way to make the compiler enforce that without dropping the DOM lib, which
 * would cost more than it saves (the `fetch`/`AbortController` types in
 * `lib/ai/gemini.ts` come from the same lib).
 *
 * ### One type difference from the web
 *
 * React Native has no `File`. A file entry is a `PickedFile` — what
 * `expo-image-picker` and `expo-document-picker` hand back, normalised in
 * `files.ts` — so the value type is `string | PickedFile` where the DOM's is
 * `string | File`. The web's `fd.getAll("files").filter(f => f instanceof File)`
 * becomes `pickedFiles(fd, "files")` in `shared.ts`, which is the same filter
 * against the same shape.
 */

import type { PickedFile } from "@/lib/files";

/** What an entry can hold. `string | File` on the web; there is no `File` here. */
export type FormValue = string | PickedFile;

/**
 * The subset of the DOM's `FormData` this app uses, faithful to the spec for each
 * method it implements.
 *
 * Entries are an ordered list of `[name, value]` pairs and a name may repeat —
 * that is not an implementation detail, it is what `getAll("files")` depends on.
 */
export class FormData {
  /**
   * Insertion-ordered, duplicates allowed. `private` rather than a `#` field: both
   * work under Hermes, but `private` is erased at compile time and so cannot be
   * affected by however the bundler chooses to downlevel class syntax.
   */
  private entryList: [string, FormValue][] = [];

  /** Adds an entry, keeping any existing entries under the same name. */
  append(name: string, value: FormValue): void {
    this.entryList.push([name, value]);
  }

  /**
   * Replaces every entry under `name` with one entry.
   *
   * Per the spec the replacement takes the *position of the first* match rather
   * than moving to the end, so a form that re-sets a field does not reorder
   * itself. Nothing in this app depends on entry order, but a faithful subset is
   * cheaper to reason about than a nearly-faithful one.
   */
  set(name: string, value: FormValue): void {
    const first = this.entryList.findIndex(([k]) => k === name);
    if (first === -1) {
      this.entryList.push([name, value]);
      return;
    }
    this.entryList = this.entryList.filter(([k], i) => k !== name || i === first);
    this.entryList[first] = [name, value];
  }

  /** The first value under `name`, or `null`. The DOM returns `null`, not `undefined`. */
  get(name: string): FormValue | null {
    const hit = this.entryList.find(([k]) => k === name);
    return hit ? hit[1] : null;
  }

  /** Every value under `name`, in insertion order. Empty array when there are none. */
  getAll(name: string): FormValue[] {
    return this.entryList.filter(([k]) => k === name).map(([, v]) => v);
  }

  has(name: string): boolean {
    return this.entryList.some(([k]) => k === name);
  }

  /** Removes every entry under `name`. */
  delete(name: string): void {
    this.entryList = this.entryList.filter(([k]) => k !== name);
  }

  /**
   * A copy of the entry list.
   *
   * Not part of the web usage — the DOM's iterator is what a caller would reach
   * for — but `<Form>` builds one of these from a record of controlled inputs and
   * it is worth being able to read one back while debugging, without anyone
   * reaching into `entryList`.
   */
  entries(): [string, FormValue][] {
    return [...this.entryList];
  }
}

/**
 * Runtime narrowing for a file entry — the stand-in for the web's
 * `f instanceof File`.
 *
 * `PickedFile` is a plain object, so there is no constructor to test against;
 * this checks the two fields every consumer actually reads. `size` is optional on
 * `PickedFile` (a document picker does not always report one), which is why it is
 * not part of the test.
 */
export function isPickedFile(v: FormValue | null | undefined): v is PickedFile {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as PickedFile).uri === "string" &&
    typeof (v as PickedFile).mimeType === "string"
  );
}
