/**
 * Holdings: the "how is my investing going" half of the app —
 * `Finance/src/lib/actions/holdings.ts`.
 *
 * Two dated series per holding and nothing else stored. Contributions are what you put
 * in; valuations are what it is worth. Cost basis, gain, XIRR, allocation and drawdown
 * are all derived from those two at read time — which is the only reason a portfolio
 * built from manual snapshots can ever be internally consistent. A cached cost or value
 * column would be wrong the first time a back-dated contribution was entered.
 *
 * A liability is a holding too: `side = 'liability'`, whose latest valuation is the
 * outstanding balance. That is what lets net worth be a subtraction rather than a
 * number you maintain by hand.
 *
 * Seven exports, every one keeping its name, parameters, validation and error
 * sentences. What changed:
 *
 * **Navigation comes back as a value**, as in `actions/goals.ts` and for the same
 * reason — `saveHolding` returns `{ savedId }` for the screen to `router.replace` to
 * `/holding/[id]`, and `deleteHolding` returns `void` and its screen goes back to the
 * Invest tab. The transaction returns the new id rather than assigning an outer `let`.
 *
 * **Three dialect edits.** `$n` → `?n`; the new holding's id comes from
 * `lastInsertRowId`; and both `INSERT … SELECT … FROM holdings WHERE id = ?1`
 * statements keep `RETURNING id`, because a zero-row insert leaves `lastInsertRowId`
 * holding the *previous* insert's value and would report success for a holding that no
 * longer exists.
 *
 * **`addValuation`'s upsert survives intact**, which is worth a note. `UNIQUE
 * (holding_id, as_of)` is a plain table constraint in `schema.ts`, not an expression
 * index, so SQLite can infer it from `ON CONFLICT (holding_id, as_of)` exactly as
 * Postgres did — no DELETE-then-INSERT dance like `budgets` needs. The one SQLite
 * quirk here is a parsing one: an upsert attached to an `INSERT … SELECT` is ambiguous
 * unless the SELECT has a `WHERE`, or the parser may read `ON CONFLICT` as a join's
 * `ON`. The `WHERE id = ?1` that makes the statement a no-op for a missing holding is
 * also what resolves that, so the guard and the fix are the same clause.
 */

import { q, q1, tx } from "@/lib/db";
import { FormData } from "@/lib/form-data";
import { ASSET_TYPE_LABEL, type AssetType, type Side } from "@/lib/types";
import {
  bool, done, invalidToState, optNum, optStr,
  pick, refreshAll, reqAmount, reqDate, reqText, type FormState,
} from "./shared";

const SIDES = ["asset", "liability"] as const satisfies readonly Side[];

/**
 * Derived from the label map rather than written out again, so the CHECK
 * constraint in `src/db/schema.ts`, the type union and this list cannot drift
 * apart three files at a time.
 */
const ASSET_TYPES = Object.keys(ASSET_TYPE_LABEL) as AssetType[];

/** Liability types, so a home loan cannot be filed as "Gold". */
const LIABILITY_TYPES: AssetType[] = ["loan", "credit_card", "other"];

export async function saveHolding(
  id: number | null,
  _prev: FormState,
  fd: FormData,
): Promise<FormState> {
  const errs: Record<string, string> = {};

  const name = reqText(fd, "name", errs, "Name", 200);
  const side = pick(fd, "side", SIDES);
  const asset_type = pick(fd, "asset_type", ASSET_TYPES);
  // Units are optional and free-form on purpose: 12.4567 units of a fund, 30
  // grams of gold, 1 flat. Nothing derives money from them — they are a note to
  // yourself that happens to be numeric.
  const units = optNum(fd, "units");
  const institution = optStr(fd, "institution", 200);
  const notes = optStr(fd, "notes", 2000);

  if (side === "liability" && !LIABILITY_TYPES.includes(asset_type)) {
    errs.asset_type = "A liability has to be a loan, a credit card, or Other.";
  }
  if (side === "asset" && (asset_type === "loan" || asset_type === "credit_card")) {
    errs.asset_type = "Loans and credit cards are liabilities, not assets.";
  }
  if (units !== null && units < 0) {
    errs.units = "Units cannot be negative.";
  }

  // An opening position, entered on the create form only. Without it a holding
  // you already own starts with a cost basis of zero, and every return figure on
  // the page is a fiction until you remember to come back and add one.
  const openingAmount = reqAmountOpt(fd, errs, "opening_amount", "Invested so far");
  const openingDate = reqDate(fd, "opening_date", errs, "As of");
  const openingValue = reqAmountOpt(fd, errs, "opening_value", "Value today");

  try {
    done(errs);

    const holdingId = await tx(async (c): Promise<number> => {
      if (id !== null) {
        const row = await c.query(
          `UPDATE holdings SET name=?2, side=?3, asset_type=?4, units=?5,
                               institution=?6, notes=?7
           WHERE id=?1`,
          [id, name, side, asset_type, units, institution, notes],
        );
        if (row.rowCount === 0) throw new Error("That holding no longer exists.");
        return id;
      }

      const ins = await c.query(
        `INSERT INTO holdings (name, side, asset_type, units, institution, notes)
         VALUES (?1,?2,?3,?4,?5,?6)`,
        [name, side, asset_type, units, institution, notes],
      );
      const rowId = ins.lastInsertRowId;

      if (openingAmount !== null) {
        await c.query(
          `INSERT INTO holding_contributions (holding_id, amount_minor, txn_date, note)
           VALUES (?1,?2,?3,'Opening position')`,
          [rowId, openingAmount, openingDate],
        );
      }
      // Defaulting the first valuation to what was put in is the honest reading of
      // "I own this and have not valued it yet" — it makes net worth include the
      // holding immediately without claiming a gain.
      const firstValue = openingValue ?? openingAmount;
      if (firstValue !== null) {
        await c.query(
          `INSERT INTO valuations (holding_id, as_of, value_minor) VALUES (?1,?2,?3)`,
          [rowId, openingDate, firstValue],
        );
      }

      return rowId;
    });

    refreshAll();
    return { savedId: holdingId };
  } catch (e) {
    return invalidToState(e);
  }
}

/**
 * Money in (or out, as a negative) — the cashflow half. Withdrawals matter: a
 * redemption that is not recorded makes XIRR read as a loss.
 */
export async function addHoldingContribution(
  holdingId: number,
  _prev: FormState,
  fd: FormData,
): Promise<FormState> {
  const errs: Record<string, string> = {};

  const amount_minor = reqAmount(fd, "amount", errs, "Amount", { allowNegative: true });
  const txn_date = reqDate(fd, "txn_date", errs, "Date");
  const note = optStr(fd, "note", 500);
  const withdraw = bool(fd, "withdraw");

  try {
    done(errs);
    const signed = withdraw ? -Math.abs(amount_minor) : amount_minor;

    const row = await q1<{ id: number }>(
      `INSERT INTO holding_contributions (holding_id, amount_minor, txn_date, note)
       SELECT ?1, ?2, ?3, ?4 FROM holdings WHERE id = ?1 RETURNING id`,
      [holdingId, signed, txn_date, note],
    );
    if (!row) throw new Error("That holding no longer exists.");
  } catch (e) {
    return invalidToState(e);
  }

  refreshAll();
  return null;
}

export async function deleteHoldingContribution(id: number): Promise<void> {
  await q("DELETE FROM holding_contributions WHERE id = ?1", [id]);
  refreshAll();
}

/**
 * A value snapshot. One per holding per day, so re-entering today's value
 * corrects a typo rather than stacking a second row on the same date — which
 * would double-count in every SUM over the latest valuation.
 */
export async function addValuation(
  holdingId: number,
  _prev: FormState,
  fd: FormData,
): Promise<FormState> {
  const errs: Record<string, string> = {};

  // Zero is allowed: a loan you have finished paying off is worth exactly zero,
  // and that is the snapshot that takes it out of your liabilities.
  const value_minor = reqAmount(fd, "value", errs, "Value", { allowZero: true });
  const as_of = reqDate(fd, "as_of", errs, "As of");

  try {
    done(errs);

    const row = await q1<{ id: number }>(
      `INSERT INTO valuations (holding_id, as_of, value_minor)
       SELECT ?1, ?2, ?3 FROM holdings WHERE id = ?1
       ON CONFLICT (holding_id, as_of) DO UPDATE SET value_minor = excluded.value_minor
       RETURNING id`,
      [holdingId, as_of, value_minor],
    );
    if (!row) throw new Error("That holding no longer exists.");
  } catch (e) {
    return invalidToState(e);
  }

  refreshAll();
  return null;
}

export async function deleteValuation(id: number): Promise<void> {
  await q("DELETE FROM valuations WHERE id = ?1", [id]);
  refreshAll();
}

/**
 * Closed, sold, paid off. Archiving keeps the history — the contributions and
 * valuations that prove what the thing did — while dropping it out of net worth,
 * the allocation donut and the amber ring.
 */
export async function setHoldingArchived(id: number, archived: boolean): Promise<void> {
  await q("UPDATE holdings SET archived = ?2 WHERE id = ?1", [id, archived]);
  refreshAll();
}

export async function deleteHolding(id: number): Promise<void> {
  // Contributions and valuations go with it via ON DELETE CASCADE.
  await q("DELETE FROM holdings WHERE id = ?1", [id]);
  refreshAll();
}

/**
 * An optional money field that still has to be a *valid* amount when present.
 * `reqAmount` would report "required" for a blank opening position, which is a
 * perfectly reasonable thing to leave empty.
 */
function reqAmountOpt(
  fd: FormData,
  errs: Record<string, string>,
  name: string,
  label: string,
): number | null {
  const raw = fd.get(name);
  if (typeof raw !== "string" || raw.trim() === "") return null;
  return reqAmount(fd, name, errs, label, { allowZero: true });
}
