/**
 * Goals: the "how is my planning going" half of the app — `Finance/src/lib/actions/goals.ts`.
 *
 * A goal is a target amount, an optional deadline, and a list of dated contributions.
 * Everything else — progress, pace, required-per-month, projected completion — is
 * derived at read time by `computePace()`, never stored. A cached `saved_minor` column
 * would drift the first time a contribution was edited. That reasoning is the whole
 * design and it ports across untouched, because it never had anything to do with the
 * server: `pace.ts` is one of the files copied byte for byte.
 *
 * Five exports, same names, same parameter lists, same validation, same error
 * sentences. Three differences:
 *
 * **Navigation comes back as a value.** The web ended `saveGoal` with
 * `redirect(`/goals/${goalId}`)` and `deleteGoal` with `redirect("/goals")`. There is
 * no router inside a module here, so `saveGoal` returns `{ savedId }` and the screen
 * does the `router.replace`; `deleteGoal` returns `void` and its screen goes back to
 * the Goals tab. The destination is `/goal/[id]` — singular — because `/goals` is a
 * tab, and a tab cannot also be a stack of goal screens. `actions/bills.ts` explains
 * that split at length.
 *
 * **The transaction returns the id** rather than assigning an outer `let goalId`. The
 * web could leave it `number | null` and interpolate it, because `redirect()` threw
 * and the function never actually returned; a caller that has to navigate needs a
 * `number`. Taking it as the transaction's result is how it gets one without an
 * assertion. Do not "simplify" this back.
 *
 * **Two dialect edits and nothing else.** `$n` → `?n`, and the new goal's id comes
 * from `lastInsertRowId` rather than `RETURNING id`. The two contribution statements
 * deliberately keep `RETURNING`: `INSERT … SELECT … FROM goals WHERE id = ?1` inserts
 * nothing when the goal is gone, and `lastInsertRowId` is a property of the
 * *connection*, so on a zero-row insert it still holds whatever the previous insert
 * left there. `RETURNING id` through `q1` gives null, which is what the web's `q1`
 * gave, and null is what "that goal no longer exists" is read from.
 */

import { q, q1, tx } from "@/lib/db";
import { FormData } from "@/lib/form-data";
import {
  bool, done, invalidToState, optDate, optStr,
  refreshAll, reqAmount, reqDate, reqText, str, type FormState,
} from "./shared";

/** A CSS colour the ring and progress bars can use without escaping anything. */
const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Create (id === null) or update one goal.
 *
 * Bound as `saveGoal.bind(null, id)` so the signature matches what `<Form>` calls.
 */
export async function saveGoal(
  id: number | null,
  _prev: FormState,
  fd: FormData,
): Promise<FormState> {
  const errs: Record<string, string> = {};

  const name = reqText(fd, "name", errs, "Name", 200);
  const target_minor = reqAmount(fd, "target", errs, "Target");
  const target_date = optDate(fd, "target_date", errs, "Target date");
  // Not `reqDate` with a today fallback by accident: a goal you have been saving
  // toward for a year has to be enterable honestly, and the pace line starts here.
  const started_on = reqDate(fd, "started_on", errs, "Started on");
  const notes = optStr(fd, "notes", 2000);
  const icon = str(fd, "icon", 40) || "flag";
  const rawColor = str(fd, "color", 20);
  const color = HEX.test(rawColor) ? rawColor : "#0f9d58";

  // A deadline before the start makes every pace figure nonsense — negative
  // months remaining, a required-per-month of Infinity.
  if (target_date && target_date < started_on) {
    errs.target_date = "The deadline is before the start date.";
  }

  try {
    done(errs);

    const goalId = await tx(async (c): Promise<number> => {
      if (id === null) {
        const ins = await c.query(
          `INSERT INTO goals (name, target_minor, target_date, icon, color, notes, started_on)
           VALUES (?1,?2,?3,?4,?5,?6,?7)`,
          [name, target_minor, target_date, icon, color, notes, started_on],
        );
        return ins.lastInsertRowId;
      }

      const row = await c.query(
        `UPDATE goals SET name=?2, target_minor=?3, target_date=?4, icon=?5, color=?6,
                          notes=?7, started_on=?8
         WHERE id=?1`,
        [id, name, target_minor, target_date, icon, color, notes, started_on],
      );
      if (row.rowCount === 0) throw new Error("That goal no longer exists.");
      return id;
    });

    refreshAll();
    return { savedId: goalId };
  } catch (e) {
    return invalidToState(e);
  }
}

/**
 * Put money toward a goal. Withdrawals are allowed as negative amounts — raiding
 * the emergency fund is a thing that happens, and a goal that can only go up
 * would quietly lie about where you stand.
 */
export async function addGoalContribution(
  goalId: number,
  _prev: FormState,
  fd: FormData,
): Promise<FormState> {
  const errs: Record<string, string> = {};

  const amount_minor = reqAmount(fd, "amount", errs, "Amount", { allowNegative: true });
  const txn_date = reqDate(fd, "txn_date", errs, "Date");
  const note = optStr(fd, "note", 500);
  // The switch is the readable way to say "this was a withdrawal" without asking
  // anyone to type a minus sign into a money field.
  const withdraw = bool(fd, "withdraw");

  try {
    done(errs);
    const signed = withdraw ? -Math.abs(amount_minor) : amount_minor;

    const row = await q1<{ id: number }>(
      `INSERT INTO goal_contributions (goal_id, amount_minor, txn_date, note)
       SELECT ?1, ?2, ?3, ?4 FROM goals WHERE id = ?1 RETURNING id`,
      [goalId, signed, txn_date, note],
    );
    if (!row) throw new Error("That goal no longer exists.");
  } catch (e) {
    return invalidToState(e);
  }

  refreshAll();
  return null;
}

export async function deleteGoalContribution(id: number): Promise<void> {
  await q("DELETE FROM goal_contributions WHERE id = ?1", [id]);
  refreshAll();
}

/**
 * Archive rather than delete, by default. A finished goal is the most
 * interesting row in the table — it is the evidence the app worked — so it keeps
 * its contributions and drops out of the lists and the monthly ring.
 */
export async function setGoalArchived(id: number, archived: boolean): Promise<void> {
  // The boolean goes in as a boolean: `bind()` in `db.ts` turns it into the 0 or 1
  // the column's `CHECK (archived IN (0, 1))` wants, so call sites keep reading the
  // way the web's did.
  await q("UPDATE goals SET archived = ?2 WHERE id = ?1", [id, archived]);
  refreshAll();
}

export async function deleteGoal(id: number): Promise<void> {
  // Contributions go with it via ON DELETE CASCADE.
  await q("DELETE FROM goals WHERE id = ?1", [id]);
  refreshAll();
}
