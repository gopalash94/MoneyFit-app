/**
 * Categories — `Finance/src/lib/actions/categories.ts`.
 *
 * The one action module that ports with nothing but `$n` → `?n`. Five exports, same
 * names, same signatures, same validation, same error sentences, same SQL shape
 * including the `sort_order` subquery and the repeated parameter in it — SQLite
 * reuses a numbered parameter exactly as Postgres does, which `queries/stats.ts`
 * already relies on in `budgetStatus`.
 *
 * Two things worth noting rather than changing:
 *
 * **`lower(name) = lower(?1)`** stays as written. SQLite's `lower()` only folds
 * ASCII, so "GROCERIES" and "groceries" collide as they should and a hypothetical
 * accented duplicate would not. The `UNIQUE` constraint on `categories.name` is
 * still the real guarantee; this check exists so the failure reads "Groceries
 * already exists" instead of a constraint message, and it does that just as well.
 *
 * **`setCategoryArchived` passes a boolean.** The column is `INTEGER` here, not
 * `BOOLEAN`, but `bind()` in lib/db.ts converts `true`/`false` to 1/0 on the way in
 * and `b()` converts them back on the way out, so the call site does not change and
 * neither does `types.ts`'s `archived: boolean`.
 */

import { CATEGORY_ICONS, safeColor } from "@/lib/category-style";
import { q } from "@/lib/db";
import { FormData } from "@/lib/form-data";
import {
  done, invalidToState, pick, refreshAll, reqText, str,
  type FormState,
} from "./shared";

const KINDS = ["expense", "income"] as const;

/**
 * Names are unique across both kinds, because `categories.name` is UNIQUE in the
 * schema. Catching it here rather than letting the constraint surface as a raw
 * SQLite error is the difference between "Groceries already exists" and
 * "UNIQUE constraint failed: categories.name".
 */
async function nameTaken(name: string, exceptId?: number): Promise<boolean> {
  const rows = await q<{ id: number }>(
    "SELECT id FROM categories WHERE lower(name) = lower(?1) LIMIT 1",
    [name],
  );
  const hit = rows[0];
  return hit !== undefined && hit.id !== exceptId;
}

function readStyle(fd: FormData): { icon: string; color: string } {
  const icon = str(fd, "icon", 40);
  return {
    // The picker only ever submits a name from this list; anything else came from
    // somewhere else and gets the neutral default rather than a blank tile.
    icon: (CATEGORY_ICONS as readonly string[]).includes(icon) ? icon : "receipt",
    color: safeColor(str(fd, "color", 7)),
  };
}

export async function addCategory(_prev: FormState, fd: FormData): Promise<FormState> {
  const errs: Record<string, string> = {};
  const name = reqText(fd, "name", errs, "Name", 60);
  const kind = pick(fd, "kind", KINDS);
  const { icon, color } = readStyle(fd);

  if (name && (await nameTaken(name))) {
    errs.name = `“${name}” already exists. Reopen it below if it is archived.`;
  }

  try {
    done(errs);
    // New categories sort after the existing ones but before "Other", which the
    // seed parks at 999 so it stays last however many you add.
    await q(
      `INSERT INTO categories (name, icon, color, kind, sort_order)
       VALUES (?1, ?2, ?3, ?4,
               COALESCE((SELECT max(sort_order) FROM categories
                         WHERE kind = ?4 AND sort_order < 900), 0) + 10)`,
      [name, icon, color, kind],
    );
  } catch (e) {
    return invalidToState(e);
  }
  refreshAll();
  return null;
}

/** Rename and restyle. `kind` is deliberately not editable — see the note below. */
export async function saveCategory(id: number, _prev: FormState, fd: FormData): Promise<FormState> {
  const errs: Record<string, string> = {};
  const name = reqText(fd, "name", errs, "Name", 60);
  const { icon, color } = readStyle(fd);

  if (name && (await nameTaken(name, id))) errs.name = `“${name}” already exists.`;

  try {
    done(errs);
    // Not `kind`: flipping a category from expense to income would silently move
    // every bill filed under it from one side of the cashflow chart to the other,
    // rewriting months you have already looked at. Make a new one instead.
    await q("UPDATE categories SET name = ?2, icon = ?3, color = ?4 WHERE id = ?1", [
      id, name, icon, color,
    ]);
  } catch (e) {
    return invalidToState(e);
  }
  refreshAll();
  return null;
}

export async function setCategoryArchived(id: number, archived: boolean): Promise<void> {
  await q("UPDATE categories SET archived = ?2 WHERE id = ?1", [id, archived]);
  refreshAll();
}

/**
 * Deleting is lossy: `bills.category_id` is ON DELETE SET NULL, so every bill
 * filed here becomes "Uncategorised" and the money stays in the totals while
 * dropping out of the breakdown. Archiving keeps all of that and merely hides the
 * category from the pickers, which is why the UI leads with it — the confirm text
 * on this one names the bill count so the cost is on screen before the tap.
 */
export async function deleteCategory(id: number): Promise<void> {
  await q("DELETE FROM categories WHERE id = ?1", [id]);
  refreshAll();
}
