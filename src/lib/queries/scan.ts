/**
 * Reading back what a scan left behind.
 *
 * In the web app this was kept out of `actions/scan.ts` because that file is
 * `"use server"` and every export there becomes a callable POST endpoint. There
 * are no server actions here, so that reason is gone — but the file stays, because
 * the new-bill screen imports `getScanDraft` and `ScanDraft` from exactly here and
 * matching the import graph is worth more than saving a file.
 *
 * The type and the gate below are unchanged. The one dialect edit is inside
 * `readCache`, not in this file.
 */

import { readCache } from "@/lib/ai/cache";
import type { SavedFile } from "@/lib/files";
import type { BillStatus, Kind } from "@/lib/types";
import type { Recurrence } from "@/lib/recurrence";
import { STORED_NAME } from "@/lib/upload-meta";

/**
 * A scanned bill waiting to be confirmed.
 *
 * It lives in `ai_cache` under `kind = 'scan'`, `scope = <stored file name>`,
 * which is doing two jobs at once. It carries the draft across the navigation
 * without a drafts table, and — because the file metadata is read back from here
 * rather than from hidden inputs — the attachment a bill adopts cannot be swapped
 * for another one by editing the form.
 */
export type ScanDraft = {
  file: SavedFile;
  values: {
    merchant: string;
    amount_minor: number;
    txn_date: string;
    due_date: string | null;
    status: BillStatus;
    kind: Kind;
    category_id: number | null;
    notes: string | null;
    recurrence: Recurrence;
  };
  confidence: "high" | "medium" | "low";
  caveat: string | null;
};

/**
 * `?scan=` arrives as a route parameter, so it is checked against the stored-name
 * shape before it becomes a query parameter — the same gate `resolveStored` uses.
 * Nothing here touches the filesystem, but a scope of `%` should not be a way to
 * go fishing in the cache table either.
 */
export async function getScanDraft(fileName: string): Promise<ScanDraft | null> {
  if (!STORED_NAME.test(fileName)) return null;
  // Fingerprint is irrelevant for a one-shot draft: a fresh UUID per upload means
  // this row is written once and read once, so freshness has nothing to compare.
  const hit = await readCache<ScanDraft>("scan", fileName, "");
  return hit?.value ?? null;
}
