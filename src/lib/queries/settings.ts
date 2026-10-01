/**
 * Settings reads — `Finance/src/lib/queries/settings.ts`, in SQLite.
 *
 * `getSettings` is untouched: it was already pure TypeScript over a key/value
 * table, and the coercion it does is exactly the coercion SQLite needs.
 *
 * `setSettings` is the one function in the whole port that could not be
 * translated statement-for-statement. It wrote every key in one round trip with
 * `INSERT … SELECT * FROM unnest($1::text[], $2::text[])`, and SQLite has no
 * unnest and no array parameters at all — `bind()` in lib/db.ts throws on an
 * array rather than let one be coerced to a string and inserted as nonsense. So
 * it becomes a loop of single-row upserts inside `tx()`, which keeps the property
 * that actually mattered: either every key in the patch is saved or none is.
 * `ON CONFLICT (key) DO UPDATE` still works, because `settings` has a plain
 * primary key rather than an expression index.
 */

import { b, q, q1, tx } from "../db";
import type { Category, Settings } from "../types";

const DEFAULTS: Settings = {
  currency: "INR",
  display_name: "You",
  monthly_budget_minor: 5_000_000,
  monthly_goal_target_minor: 1_500_000,
  monthly_invest_target_minor: 2_000_000,
  month_start_day: 1,
  theme: "system",
};

/**
 * Settings live as text key/value pairs so adding one never needs a migration.
 * Coercion happens here, once, and every caller gets a typed object with
 * defaults already applied — a missing row is not an error.
 */
export async function getSettings(): Promise<Settings> {
  const rows = await q<{ key: string; value: string }>("SELECT key, value FROM settings");
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const num = (k: keyof Settings, d: number) => {
    const v = Number(map.get(k));
    return Number.isFinite(v) ? v : d;
  };
  return {
    currency: map.get("currency") ?? DEFAULTS.currency,
    display_name: map.get("display_name") ?? DEFAULTS.display_name,
    monthly_budget_minor: num("monthly_budget_minor", DEFAULTS.monthly_budget_minor),
    monthly_goal_target_minor: num("monthly_goal_target_minor", DEFAULTS.monthly_goal_target_minor),
    monthly_invest_target_minor: num("monthly_invest_target_minor", DEFAULTS.monthly_invest_target_minor),
    month_start_day: num("month_start_day", DEFAULTS.month_start_day),
    theme: (map.get("theme") as Settings["theme"]) ?? DEFAULTS.theme,
  };
}

export async function setSettings(patch: Record<string, string>): Promise<void> {
  const entries = Object.entries(patch);
  if (!entries.length) return;
  // One transaction rather than one statement — see the header. A settings save
  // is at most seven rows, so the difference is unmeasurable, and a half-saved
  // patch is still impossible.
  await tx(async (c) => {
    for (const [key, value] of entries) {
      await c.query(
        `INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        [key, value],
      );
    }
  });
}

/**
 * Every category with the two things the Settings page has to say about it: the
 * default budget it currently carries, and how many bills would be orphaned by
 * deleting it. Both in one pass, because twenty-seven categories would otherwise
 * be fifty-four queries.
 */
export type CategoryAdmin = Category & { limit_minor: number | null; bill_count: number };

export async function categoriesForAdmin(): Promise<CategoryAdmin[]> {
  const rows = await q<CategoryAdmin>(
    `SELECT c.*,
            b.limit_minor     AS limit_minor,
            COALESCE(u.n, 0)  AS bill_count
     FROM categories c
     LEFT JOIN budgets b ON b.category_id = c.id AND b.month IS NULL
     LEFT JOIN (SELECT category_id, count(*) AS n FROM bills GROUP BY 1) u
            ON u.category_id = c.id
     ORDER BY c.kind, c.archived, c.sort_order, c.name`,
  );
  return rows.map((r) => ({ ...r, archived: b(r.archived) }));
}

/** Row counts for the danger zone, so "delete everything" can say what everything is. */
export async function dataCounts(): Promise<{
  bills: number; attachments: number; goals: number;
  holdings: number; valuations: number; budgets: number;
}> {
  const row = await q1<{
    bills: number; attachments: number; goals: number;
    holdings: number; valuations: number; budgets: number;
  }>(
    `SELECT (SELECT count(*) FROM bills)       AS bills,
            (SELECT count(*) FROM attachments) AS attachments,
            (SELECT count(*) FROM goals)       AS goals,
            (SELECT count(*) FROM holdings)    AS holdings,
            (SELECT count(*) FROM valuations)  AS valuations,
            (SELECT count(*) FROM budgets)     AS budgets`,
  );
  return row ?? { bills: 0, attachments: 0, goals: 0, holdings: 0, valuations: 0, budgets: 0 };
}
