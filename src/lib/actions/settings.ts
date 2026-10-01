/**
 * Settings writes — `Finance/src/lib/actions/settings.ts`.
 *
 * Six exports on the web, nine here: five of the web's six keep their name, their
 * parameter list, their validation and their error sentences, one is gone, two are new
 * because a phone has to be told a secret that `.env` used to hold, and two more are new
 * because a phone is otherwise a data island. The differences:
 *
 * **`put`'s client is ours.** It took an `import("pg").PoolClient` so it could write
 * inside the caller's transaction; here that is `Client` from lib/db.ts, which exists
 * for exactly this reason. The function is still the only way a settings row gets
 * written from an action, and `saveTargets` is still why it takes a client at all.
 *
 * **`unnest` becomes a loop**, twice — in `put` and in `saveCategoryBudgets`. SQLite
 * has no `unnest` and no array parameters; `bind()` in lib/db.ts throws on an array
 * rather than quietly stringify one. `queries/settings.ts` made the same substitution
 * for the same reason and its note applies here too: both loops already run inside
 * `tx()`, so the property that mattered — every key or none — is untouched, and at
 * four settings keys and a couple of dozen categories the extra round trips are not
 * measurable. `sample-data.ts`'s generated multi-row `VALUES` is for its ~250-row
 * inserts; reaching for it here would generate SQL to save nothing.
 *
 * **`setTheme` is gone**, and this is the one behaviour that moved rather than being
 * ported. It existed for the corner toggle, which on the web was a one-field form
 * posting to a server action. There is no form in the corner of a phone header: the
 * toggle is `ThemeButton` in `app/(tabs)/_layout.tsx`, and it calls
 * `setSettings({ theme: next }).then(bump)` directly — which is precisely what this
 * function did (`put("theme", …)` then `refreshAll()`), minus the round trip through
 * a `FormData` nobody would construct. Keeping it here would be a dead export whose
 * existence implied a caller. `theme` is still editable the other way it always was,
 * as a three-way control in Settings, through `saveProfile`.
 *
 * **`saveAiKey` and `clearAiKey` are new**, and they are the only two functions in this
 * file with no web counterpart at all. On the web the Anthropic key is
 * `ANTHROPIC_API_KEY` in `.env`, read by the server, and there is nothing for a form to
 * do with it. Here it is typed into Settings, so it needs an action shaped like every
 * other form on that screen — `(prev, fd) => Promise<FormState>` — around
 * `saveApiKey`, which takes a plain string. Neither function goes near the database:
 * the key lives in `expo-secure-store` and `lib/secrets.ts` is the only module that
 * touches it. Both end in `refreshAll()` for the same reason the others do — six
 * screens decide between a feature and an `AiNotConfigured` card by asking whether a
 * key is set, and they have to find out without a restart.
 *
 * Two properties of that pair are deliberate. **An empty field is an error, not a
 * delete.** `saveApiKey("")` clears the key, which is exactly wrong here: the field
 * cannot be pre-filled with a secret, so it is empty on every mount, and a stray tap on
 * Save would silently throw away a working key. Removing one is the explicit button
 * instead. And **no message either function can produce contains the key** — the one
 * failure `saveApiKey` throws is a fixed sentence about secure storage, and the
 * validation error names the field without quoting what was in it.
 *
 * **`exportData` and `importData` are new too**, and they have no web counterpart either —
 * the web app has no export at all, which is a gap you can live with when the data sits in
 * a Postgres volume on a machine you own, and cannot when it sits in one app's private
 * storage on one phone. Both are thin: `lib/backup.ts` does the work, and these two exist
 * to be the shape a button wants and to put the `refreshAll()` in the one place it is
 * needed. Like `wipeEverything` they are plain `Promise<T>` functions rather than
 * `(prev, fd) => Promise<FormState>`, because a button is not a form; `ActionButton`
 * surfaces anything they throw as red text under itself, which is how a `BackupError`
 * reaches the screen without a `FormState` carrying it.
 *
 * Everything else is the dialect map: `$n` → `?n`, `EXCLUDED` → `excluded`.
 */

import {
  exportBackup, importBackup, pickBackup,
  type ExportSummary, type ImportSummary,
} from "@/lib/backup";
import type { Client } from "@/lib/db";
import { tx } from "@/lib/db";
import { deleteUpload } from "@/lib/files";
import { FormData } from "@/lib/form-data";
import { parseAmount } from "@/lib/money";
import { loadSample, wipeAll } from "@/lib/sample-data";
import { clearApiKey, saveApiKey } from "@/lib/secrets";
import {
  done, fail, invalidToState, optInt, pick, refreshAll, reqAmount, reqText, str,
  type FormState,
} from "./shared";

/**
 * A settings row, written through the same connection as everything else in the
 * enclosing transaction. `queries/settings.ts` has a `setSettings` that does this
 * on its own pool, but the targets form has to write the `budgets` table in the
 * same breath — see `saveTargets` — so it needs the client passed in.
 *
 * `ON CONFLICT (key) DO UPDATE` works because `settings` has a plain primary key.
 * The `budgets` table in `saveTargets` is the one that does not, which is why that
 * one has to delete first.
 */
async function put(c: Client, patch: Record<string, string>): Promise<void> {
  for (const [key, value] of Object.entries(patch)) {
    await c.query(
      `INSERT INTO settings (key, value) VALUES (?1, ?2)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }
}

export async function saveProfile(_prev: FormState, fd: FormData): Promise<FormState> {
  const errs: Record<string, string> = {};
  const name = reqText(fd, "display_name", errs, "Name", 60);
  const theme = pick(fd, "theme", ["system", "light", "dark"] as const);
  const day = optInt(fd, "month_start_day") ?? 1;
  // monthBounds() clamps to 1–28 anyway; rejecting it here means the number you
  // see saved is the number that is used, rather than a 31 quietly becoming 28.
  if (day > 28) {
    errs.month_start_day = "Pick a day from 1 to 28 — later days would skip February.";
  }

  try {
    done(errs);
    await tx((c) => put(c, { display_name: name, theme, month_start_day: String(day) }));
  } catch (e) {
    return invalidToState(e);
  }
  refreshAll();
  return null;
}

/**
 * The three ring targets — and the overall budget row that has to agree with the
 * first of them.
 *
 * `overallBudget()` reads `budgets (category_id IS NULL, month IS NULL)` *before*
 * falling back to `settings.monthly_budget_minor`, and `SEED_SQL` in `db/schema.ts`
 * inserts exactly that row on a fresh install. So writing only the setting would
 * look like it worked and leave the blue ring stubbornly scaled to the old number.
 * Both, in one transaction, or neither.
 *
 * DELETE-then-INSERT rather than ON CONFLICT: `budgets_scope_uq` is an expression
 * index over `COALESCE(category_id, 0), COALESCE(month, '0000-00')`, which neither
 * Postgres nor SQLite will infer a conflict target from.
 */
export async function saveTargets(_prev: FormState, fd: FormData): Promise<FormState> {
  const errs: Record<string, string> = {};
  const budget = reqAmount(fd, "monthly_budget", errs, "Monthly budget");
  const goalTarget = reqAmount(fd, "monthly_goal_target", errs, "Saving target");
  const investTarget = reqAmount(fd, "monthly_invest_target", errs, "Investing target");

  try {
    done(errs);
    await tx(async (c) => {
      await put(c, {
        monthly_budget_minor: String(budget),
        monthly_goal_target_minor: String(goalTarget),
        monthly_invest_target_minor: String(investTarget),
      });
      await c.query("DELETE FROM budgets WHERE category_id IS NULL AND month IS NULL");
      await c.query(
        "INSERT INTO budgets (category_id, month, limit_minor) VALUES (NULL, NULL, ?1)",
        [budget],
      );
    });
  } catch (e) {
    return invalidToState(e);
  }
  refreshAll();
  return null;
}

/**
 * Per-category default budgets, saved as one set rather than one row at a time.
 *
 * Reading the field names out of the FormData means this never has to be told
 * which categories exist — anything named `budget_<id>` is a limit, a blank one
 * is "no budget", and a category deleted elsewhere simply has no field.
 *
 * `fd.entries()` is an array here rather than the DOM's iterator (see
 * `lib/form-data.ts`), which reads the same and cannot be exhausted twice by
 * accident. The `typeof value !== "string"` guard is still needed, and for a better
 * reason than on the web: a `FormValue` can be a `PickedFile`.
 */
export async function saveCategoryBudgets(_prev: FormState, fd: FormData): Promise<FormState> {
  const errs: Record<string, string> = {};
  const rows: [number, number][] = [];

  for (const [key, value] of fd.entries()) {
    const m = /^budget_(\d+)$/.exec(key);
    if (!m || typeof value !== "string") continue;
    const raw = value.trim();
    if (!raw) continue;

    const minor = parseAmount(raw);
    if (minor === null || minor < 0) {
      errs[key] = `“${raw}” is not an amount.`;
      continue;
    }
    rows.push([Number(m[1]), minor]);
  }

  try {
    done(errs);
    await tx(async (c) => {
      // Clearing every default first is what makes an emptied field mean
      // "remove this budget" rather than "leave the old one alone".
      await c.query("DELETE FROM budgets WHERE category_id IS NOT NULL AND month IS NULL");
      for (const [cat, lim] of rows) {
        await c.query(
          "INSERT INTO budgets (category_id, month, limit_minor) VALUES (?1, NULL, ?2)",
          [cat, lim],
        );
      }
    });
  } catch (e) {
    return invalidToState(e);
  }
  refreshAll();
  return null;
}

/**
 * Store the Anthropic key typed into Settings.
 *
 * No format check, deliberately: `secrets.ts` explains why at length — a wrong key
 * already produces one clear sentence from the API, whereas a prefix test here would
 * lock the app out of a key format that has not been invented yet. All this does is
 * refuse a blank submission and hand the rest to `saveApiKey`, which trims it.
 *
 * The 200-character cap matches the field's own `maxLength`; a key is about 110.
 */
export async function saveAiKey(_prev: FormState, fd: FormData): Promise<FormState> {
  const key = str(fd, "api_key", 200);
  if (!key) {
    // Not "required" — the field is empty on every mount by design, so the message has
    // to say what the blank case means rather than that something is missing.
    return fail("Nothing was pasted.", {
      api_key: "Paste a key here, or use Remove below to delete the stored one.",
    });
  }

  try {
    await saveApiKey(key);
  } catch (e) {
    // The only thing `saveApiKey` throws is its fixed secure-storage sentence, which
    // deliberately does not quote the value. Nothing here adds to it.
    return invalidToState(e);
  }
  refreshAll();
  return null;
}

/**
 * Forget the stored key.
 *
 * Returns `void`, like `wipeEverything`, because it is a button rather than a form.
 * Safe to call with nothing stored: `clearApiKey` swallows an absent value.
 */
export async function clearAiKey(): Promise<void> {
  await clearApiKey();
  refreshAll();
}

/**
 * Eighteen months of plausible history, so every chart in the app has something
 * to draw before you have typed a single real bill.
 *
 * Returns a FormState rather than void so the one thing that can go wrong — data
 * already being here — arrives as a banner instead of an unhandled rejection.
 */
export async function loadSampleData(_prev: FormState, _fd: FormData): Promise<FormState> {
  try {
    await loadSample();
  } catch (e) {
    return invalidToState(e);
  }
  refreshAll();
  return null;
}

/**
 * Everything except categories and settings, plus the uploaded files behind the
 * attachment rows. The database half is one transaction; the filesystem half is
 * not and cannot be, so it runs after the rows are certainly gone — an orphaned
 * file wastes a few kilobytes, whereas a row pointing at a deleted file is a
 * broken preview.
 */
export async function wipeEverything(): Promise<void> {
  const { files } = await wipeAll();
  for (const name of files) await deleteUpload(name);
  refreshAll();
}

/**
 * Writes the whole database to a JSON file and offers it to the share sheet.
 *
 * No `refreshAll()`: this reads and writes a file, and nothing on screen is now
 * out of date. The summary comes back so the card can say what was in it.
 */
export async function exportData(): Promise<ExportSummary> {
  return await exportBackup();
}

/**
 * Asks for a backup file and replaces everything with it.
 *
 * `null` means the picker was dismissed, which is not a failure and must not look
 * like one — the card leaves its message alone when it sees `null`, so a tap on
 * Cancel does nothing at all.
 *
 * `refreshAll()` here is not optional. Every screen is reading through `useLive`,
 * the whole database has just been replaced underneath them, and `importBackup`
 * has already committed; without the bump the app would keep showing the data
 * that no longer exists until something else happened to trigger a reload.
 */
export async function importData(): Promise<ImportSummary | null> {
  const file = await pickBackup();
  if (!file) return null;

  const summary = await importBackup(file);
  refreshAll();
  return summary;
}
