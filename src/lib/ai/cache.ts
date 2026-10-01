/**
 * A one-row-per-question cache in front of the API.
 *
 * Home, Insights and the coaching cards re-read on every navigation and on every
 * `bump()`. Without this, walking from Home to Track and back would bill two API
 * calls for an answer about a month that has not changed — and on a phone that is
 * also two round trips over mobile data.
 *
 * The key is `(kind, scope)` — unique in the schema — and the *fingerprint* is a
 * hash of everything the answer depended on. A hit whose fingerprint no longer
 * matches is not deleted, just ignored and then overwritten: the previous answer
 * stays readable until a new one succeeds, so a rate-limited request shows
 * yesterday's insight rather than an error where a card used to be.
 *
 * Two things changed in the port:
 *
 *   - **`node:crypto` is gone.** `expo-crypto`'s digest is asynchronous, and
 *     making `fingerprint()` async would have infected `cached()` and every
 *     caller of it. So it is a synchronous FNV-1a over the same, verbatim
 *     `stable()` serialisation. The comment above only ever asked for
 *     *stability*: this is a cache key, not a security boundary, and the worst a
 *     collision can do is show an insight computed from slightly older figures.
 *   - **`payload` is TEXT, not `jsonb`.** `pg` parsed JSON columns on the way
 *     out; nothing does now, so `readCache` runs the column through `j()`. A row
 *     that will not parse is treated as a miss rather than an error, because a
 *     corrupt cache entry should cost one API call, not a screen.
 */

import { j, q, q1 } from "../db";

export type CacheHit<T> = {
  value: T;
  /** True when the fingerprint still matches — i.e. the inputs have not moved. */
  fresh: boolean;
  /** `datetime('now')` as SQLite rendered it: 'YYYY-MM-DD HH:MM:SS', UTC. Only ever displayed. */
  at: string;
  model: string | null;
};

/**
 * Stable hash of whatever the answer was computed from.
 *
 * Object keys are sorted, because `{a,b}` and `{b,a}` describe the same month and
 * a cache that disagrees is a cache that never hits.
 *
 * Four FNV-1a lanes with different offset bases, concatenated, so the result is
 * the same 32 hex characters the sha256 prefix produced and fits the same column.
 */
export function fingerprint(input: unknown): string {
  const s = stable(input);
  // Arbitrary distinct 32-bit bases: the standard FNV offset basis and three
  // others. Any four constants would do — they only have to differ so the lanes
  // are not four copies of one hash.
  const bases = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b];
  let out = "";
  for (const base of bases) out += fnv1a(s, base);
  return out;
}

function fnv1a(s: string, base: number): string {
  let h = base | 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // Both halves of the code unit, so a non-ASCII string is not folded to its
    // low bytes — 'а' (Cyrillic) and 'a' must not hash alike.
    h = Math.imul(h ^ (c & 0xff), 16777619);
    h = Math.imul(h ^ (c >>> 8), 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, x]) => x !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`).join(",")}}`;
}

export async function readCache<T>(
  kind: string,
  scope: string,
  fp: string,
): Promise<CacheHit<T> | null> {
  const row = await q1<{ payload: string; fingerprint: string; created_at: string; model: string | null }>(
    "SELECT payload, fingerprint, created_at, model FROM ai_cache WHERE kind = ?1 AND scope = ?2",
    [kind, scope],
  );
  if (!row) return null;
  const value = j<T>(row.payload);
  // Unparseable payload: a miss, so the caller recomputes and overwrites it.
  if (value === null) return null;
  return { value, fresh: row.fingerprint === fp, at: row.created_at, model: row.model };
}

export async function writeCache(
  kind: string,
  scope: string,
  fp: string,
  payload: unknown,
  model: string,
): Promise<void> {
  // `ON CONFLICT (kind, scope)` is inferable here: it is a plain UNIQUE
  // constraint, unlike the expression index on `budgets`.
  await q(
    `INSERT INTO ai_cache (kind, scope, fingerprint, payload, model)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (kind, scope) DO UPDATE
        SET fingerprint = excluded.fingerprint,
            payload     = excluded.payload,
            model       = excluded.model,
            created_at  = datetime('now')`,
    [kind, scope, fp, JSON.stringify(payload), model],
  );
}

/**
 * The full read-through: a fresh hit short-circuits, anything else calls `make`.
 *
 * On failure the stale value is returned with the error attached, so a card can
 * show the last good answer *and* say why it is not current — strictly better
 * than a banner where the content was. With nothing cached at all, the error is
 * rethrown for the caller to render.
 */
export async function cached<T>(
  kind: string,
  scope: string,
  inputs: unknown,
  make: () => Promise<{ value: T; model: string }>,
): Promise<CacheHit<T> & { staleReason?: string }> {
  const fp = fingerprint(inputs);
  const hit = await readCache<T>(kind, scope, fp);
  if (hit?.fresh) return hit;

  try {
    const { value, model } = await make();
    await writeCache(kind, scope, fp, value, model);
    return { value, fresh: true, at: new Date().toISOString(), model };
  } catch (e) {
    if (hit) {
      return { ...hit, staleReason: e instanceof Error ? e.message : String(e) };
    }
    throw e;
  }
}

/** Used by the Settings wipe and after an edit that invalidates a whole kind. */
export async function clearCache(kind?: string): Promise<void> {
  if (kind) await q("DELETE FROM ai_cache WHERE kind = ?1", [kind]);
  else await q("DELETE FROM ai_cache");
}
