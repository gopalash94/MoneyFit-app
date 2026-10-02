/**
 * Reading back what a scan left behind.
 *
 * In the web app this was kept out of `actions/scan.ts` because that file is
 * `"use server"` and every export there becomes a callable POST endpoint. There
 * are no server actions here, so that reason is gone — but the file stays, because
 * the new-bill screen imports `getScanDraft` and `ScanDraft` from exactly here and
 * matching the import graph is worth more than saving a file.
 *
 * The type and the gate below are unchanged. What did change is where the draft
 * is read from: the old general-purpose `ai_cache` table is gone, replaced by
 * `scan_drafts`, which exists for this one job. The read is three lines, so it
 * lives here now rather than behind a cache module that cached nothing else.
 */

import { j, q1 } from "@/lib/db";
import type { SavedFile } from "@/lib/files";
import type { BillStatus, Kind } from "@/lib/types";
import type { Recurrence } from "@/lib/recurrence";
import { STORED_NAME } from "@/lib/upload-meta";

/**
 * A scanned bill waiting to be confirmed.
 *
 * It lives in `scan_drafts`, keyed by the stored file name, which is doing two
 * jobs at once. It carries the draft across the navigation without a route
 * param big enough to hold it, and — because the file metadata is read back
 * from here rather than from hidden inputs — the attachment a bill adopts
 * cannot be swapped for another one by editing the form.
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
 * Nothing here touches the filesystem, but a key of `%` should not be a way to go
 * fishing in the drafts table either.
 */
export async function getScanDraft(fileName: string): Promise<ScanDraft | null> {
  if (!STORED_NAME.test(fileName)) return null;

  const row = await q1<{ payload: string }>(
    "SELECT payload FROM scan_drafts WHERE file_name = ?1",
    [fileName],
  );
  if (!row) return null;

  // A payload that will not parse is treated as absent, not as an error: the cost
  // is one more tap on the camera, where throwing would be a broken screen.
  return j<ScanDraft>(row.payload);
}
