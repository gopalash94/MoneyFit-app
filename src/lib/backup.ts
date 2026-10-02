/**
 * Export and import the whole database as one JSON file.
 *
 * This is the one thing here that the web app does not have, and the reason it
 * exists is that a phone is a single point of failure: the database lives in the
 * app's private storage, so uninstalling MoneyFit — or losing the handset —
 * takes seven months of bills with it. A file you can put in Drive is the whole
 * feature.
 *
 * ## The format
 *
 * One object: an envelope naming the format and the schema version it was taken
 * from, and a `tables` map keyed by table name holding plain row objects whose
 * keys are the schema's own column names.
 *
 * ```json
 * { "format": "moneyfit.backup", "version": 1, "schema_version": 1,
 *   "exported_at": "2026-02-14T09:30:00.000Z",
 *   "counts": { "bills": 212, … },
 *   "tables": { "categories": [ { "id": 1, "name": "Groceries", … } ], … } }
 * ```
 *
 * **Ids are preserved.** That is the decision everything else follows from: with
 * the original ids, `bills.category_id`, `goal_contributions.goal_id` and the
 * rest restore as they are, with no remapping pass and no chance of a
 * contribution landing on the wrong goal.
 *
 * ## What travels, and what does not
 *
 * Thirteen of the fourteen tables. `scan_drafts` is the one left out, and it is
 * left out for the same reason its predecessor `ai_cache` was: it is keyed by the
 * name of a stored file, those files do not travel, so a restored draft would
 * point at nothing. It is also the shortest-lived row in the database — a bill
 * you photographed and have not confirmed yet — so what the exclusion costs is
 * one un-reviewed photo.
 *
 * Everything else travels, including the three tables that are a record of a
 * decision rather than a computation. `detection_dismissals` — "stop suggesting
 * this subscription" — is something you decided. `statement_batches` is the
 * `sha256` ledger that answers "have I imported this file before?", and a restore
 * that dropped it would silently make every statement importable a second time —
 * though its `file_name` is blanked on the way in, because the statement file is
 * one of the files that did not travel and the schema already spells NULL as
 * "that file is gone". `ask_turns` is the audit log of the only feature here
 * that opens an outbound connection; it cannot be recomputed, because the answer
 * it holds is a snapshot of what the figures said on the day, and it is the last
 * thing that should quietly disappear in a restore.
 *
 * **Attachment files do not travel.** Base64 of every photo and PDF would mean
 * building one JavaScript string holding the lot, and on a mid-range Android
 * phone that is a plausible out-of-memory crash on the one path that is supposed
 * to be the safety net. Nobody here can test it, so it is not shipped.
 * Attachment *rows* are exported anyway, as a faithful record of what the
 * database held and so that a future version carrying the bytes is an addition
 * to this format rather than a break — but they are **not** restored, because a
 * row whose file is absent is exactly the broken preview that
 * `wipeEverything()` goes out of its way to avoid. A restored bill keeps its
 * merchant, amount, date, notes and recurrence; it loses its photo.
 *
 * ## Import replaces, it does not merge
 *
 * Merging two sets of rows means remapping every id and deciding what a
 * collision means, and it is not what anyone wants from a backup: restoring one
 * means putting the phone back how it was. So the import clears the database
 * first — including `categories` and `settings`, which `wipeAll()` deliberately
 * spares, because the backup carries its own — and then inserts.
 *
 * It is one transaction. `PRAGMA defer_foreign_keys = ON` is its first
 * statement, which holds every foreign key check until COMMIT and clears itself
 * there: that is what makes `bills.parent_bill_id` — a self-reference, so no
 * insert order can satisfy it row by row — a non-problem, while still refusing a
 * payload whose references do not add up. Nothing is touched until the entire
 * file has been read and checked, so a truncated or hand-edited file is a
 * message rather than half a restore.
 *
 * `closeAll()` exists and is deliberately **not** used. Replacing the database
 * file would mean closing both connections, swapping files, and hoping the WAL
 * went with it; a DELETE-then-INSERT inside one transaction is atomic, needs no
 * handle juggling, and leaves the open connections valid.
 *
 * Every value is a bound parameter, as everywhere else. The table and column
 * names in the generated statements come only from the `TABLES` literals below —
 * never from the file being read, whose keys are used for lookup and nothing
 * else.
 */

import type { Client } from "./db";
import { q1, tx } from "./db";
import { today } from "./date";
import { deleteUpload } from "./files";
import { SCHEMA_VERSION } from "../db/migrations";

import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";

/** Changes only if the shape of the envelope changes, which is not the schema. */
const FORMAT = "moneyfit.backup";
const FORMAT_VERSION = 1;

/**
 * A file bigger than this is not a MoneyFit backup, and reading it into a string
 * to find that out is how a phone runs out of memory. Eighteen months of the
 * sample data is well under one megabyte.
 */
const MAX_BACKUP_BYTES = 24 * 1024 * 1024;

/** Same reasoning and same number as `sample-data.ts`'s `MAX_PARAMS`. */
const MAX_PARAMS = 900;

export class BackupError extends Error {}

/* ------------------------------------------------------------------ the spec */

/**
 * `text` and `int` are SQLite's TEXT and INTEGER; `num` is the one REAL column
 * (`holdings.units`). `null` marks a column the schema allows to be NULL — every
 * other column is NOT NULL, and a row missing one is a corrupt file, not a
 * default to invent.
 */
type ColType = "text" | "int" | "num";
type Col = { name: string; type: ColType; null?: true };

/**
 * One spec per table, serving both directions: it is the SELECT list on the way
 * out and the whitelist on the way in. A column the file carries that is not
 * named here is ignored rather than passed through, which is what keeps a
 * hand-edited file from reaching the generated statement text, and it means each
 * column has exactly one rule rather than one in an export and another in a
 * validator that can drift from it.
 *
 * `key` is the primary key: the ORDER BY on export, and the column the duplicate
 * check watches on import. Order is parent-first, which is the insert order.
 */
type TableSpec = { table: string; key: string; cols: readonly Col[] };

const TABLES: readonly TableSpec[] = [
  {
    table: "categories",
    key: "id",
    cols: [
      { name: "id", type: "int" },
      { name: "name", type: "text" },
      { name: "icon", type: "text" },
      { name: "color", type: "text" },
      { name: "kind", type: "text" },
      { name: "sort_order", type: "int" },
      { name: "archived", type: "int" },
    ],
  },
  {
    // Before `bills`, which references it. The order is cosmetic — see
    // `defer_foreign_keys` in the header — but `bills` referencing something
    // listed after it reads like an oversight, and this one need not.
    table: "statement_batches",
    key: "id",
    cols: [
      { name: "id", type: "int" },
      // NULL once the stored file has been cleaned up, and NULL after a restore
      // for every row, because the files themselves do not travel. The `sha256`
      // is what the table is for and it survives regardless.
      { name: "file_name", type: "text", null: true },
      { name: "original_name", type: "text" },
      { name: "mime_type", type: "text" },
      { name: "size_bytes", type: "int" },
      { name: "sha256", type: "text" },
      { name: "page_count", type: "int" },
      { name: "row_count", type: "int" },
      { name: "added_count", type: "int" },
      { name: "committed_at", type: "text", null: true },
      { name: "created_at", type: "text" },
    ],
  },
  {
    table: "bills",
    key: "id",
    cols: [
      { name: "id", type: "int" },
      { name: "merchant", type: "text" },
      { name: "amount_minor", type: "int" },
      { name: "txn_date", type: "text" },
      { name: "due_date", type: "text", null: true },
      { name: "status", type: "text" },
      { name: "kind", type: "text" },
      { name: "category_id", type: "int", null: true },
      { name: "notes", type: "text", null: true },
      { name: "recurrence", type: "text" },
      { name: "parent_bill_id", type: "int", null: true },
      { name: "source", type: "text" },
      // `holdings` is still listed after this table, so this one reference does
      // lean on `defer_foreign_keys` — the same thing `parent_bill_id` already
      // leans on, and moving `holdings` up would only move the problem.
      { name: "holding_id", type: "int", null: true },
      { name: "statement_batch_id", type: "int", null: true },
      { name: "created_at", type: "text" },
    ],
  },
  {
    // Exported, never restored — see the header. It stays in the list so the
    // export is a complete record and so `RESTORED` below is the only place
    // that has to know about the exception.
    table: "attachments",
    key: "id",
    cols: [
      { name: "id", type: "int" },
      { name: "bill_id", type: "int" },
      { name: "file_name", type: "text" },
      { name: "original_name", type: "text" },
      { name: "mime_type", type: "text" },
      { name: "size_bytes", type: "int" },
      { name: "created_at", type: "text" },
    ],
  },
  {
    table: "budgets",
    key: "id",
    cols: [
      { name: "id", type: "int" },
      { name: "category_id", type: "int", null: true },
      { name: "month", type: "text", null: true },
      { name: "limit_minor", type: "int" },
    ],
  },
  {
    table: "goals",
    key: "id",
    cols: [
      { name: "id", type: "int" },
      { name: "name", type: "text" },
      { name: "target_minor", type: "int" },
      { name: "target_date", type: "text", null: true },
      { name: "icon", type: "text" },
      { name: "color", type: "text" },
      { name: "notes", type: "text", null: true },
      { name: "archived", type: "int" },
      { name: "started_on", type: "text" },
      { name: "created_at", type: "text" },
    ],
  },
  {
    table: "goal_contributions",
    key: "id",
    cols: [
      { name: "id", type: "int" },
      { name: "goal_id", type: "int" },
      { name: "amount_minor", type: "int" },
      { name: "txn_date", type: "text" },
      { name: "note", type: "text", null: true },
      { name: "created_at", type: "text" },
    ],
  },
  {
    table: "holdings",
    key: "id",
    cols: [
      { name: "id", type: "int" },
      { name: "name", type: "text" },
      { name: "side", type: "text" },
      { name: "asset_type", type: "text" },
      { name: "units", type: "num", null: true },
      { name: "institution", type: "text", null: true },
      { name: "notes", type: "text", null: true },
      { name: "archived", type: "int" },
      { name: "created_at", type: "text" },
    ],
  },
  {
    table: "holding_contributions",
    key: "id",
    cols: [
      { name: "id", type: "int" },
      { name: "holding_id", type: "int" },
      { name: "amount_minor", type: "int" },
      { name: "txn_date", type: "text" },
      { name: "note", type: "text", null: true },
      { name: "created_at", type: "text" },
    ],
  },
  {
    table: "valuations",
    key: "id",
    cols: [
      { name: "id", type: "int" },
      { name: "holding_id", type: "int" },
      { name: "as_of", type: "text" },
      { name: "value_minor", type: "int" },
      { name: "created_at", type: "text" },
    ],
  },
  {
    table: "settings",
    key: "key",
    cols: [
      { name: "key", type: "text" },
      { name: "value", type: "text" },
    ],
  },
  {
    table: "detection_dismissals",
    key: "signature",
    cols: [
      { name: "signature", type: "text" },
      { name: "created_at", type: "text" },
    ],
  },
  {
    // Last, and referenced by nothing — deliberately, see the table's comment in
    // `db/schema.ts`. An answer is a snapshot of what the figures said when you
    // asked, so editing a bill afterwards must not change what the thread claims
    // was true, or delete the question through a cascade.
    table: "ask_turns",
    key: "id",
    cols: [
      { name: "id", type: "int" },
      { name: "question", type: "text" },
      { name: "status", type: "text" },
      { name: "sql_text", type: "text", null: true },
      { name: "model", type: "text", null: true },
      { name: "note", type: "text", null: true },
      // JSON in a TEXT column. Exported and restored as the string it is: this
      // module never parses a payload, which is also what stops a hand-edited
      // file's object from reaching a generated statement.
      { name: "result_cols", type: "text", null: true },
      { name: "result_rows", type: "text", null: true },
      { name: "row_count", type: "int" },
      { name: "truncated", type: "int" },
      { name: "ms", type: "int", null: true },
      { name: "created_at", type: "text" },
    ],
  },
];

/** The one table the import skips. The header says why. */
const SKIP_RESTORE: readonly string[] = ["attachments"];

/**
 * Children first, and longer than `sample-data.ts`'s `WIPE_ORDER` by three:
 * `categories` and `settings`, because the backup brings its own and keeping the
 * current ones would leave a bill pointing at a category that is not the one it
 * was filed under; and `scan_drafts`, which is not restored but must still go,
 * because a draft keyed on a file this phone no longer has would be offered on
 * the new-bill form forever.
 *
 * Every table is here, including the two the backup does restore but whose rows
 * must not survive a replace: a `statement_batches` row from before the restore
 * would claim a `sha256` the restored `bills` know nothing about, and an
 * `ask_turns` row would put an answer about the old figures in the same thread as
 * the new ones.
 *
 * With `defer_foreign_keys` on, the order no longer has to be right — listing it
 * anyway costs nothing and does not depend on a PRAGMA having taken.
 */
const CLEAR_ORDER: readonly string[] = [
  "attachments",
  "bills",
  "goal_contributions",
  "goals",
  "holding_contributions",
  "valuations",
  "holdings",
  "budgets",
  "statement_batches",
  "ask_turns",
  "scan_drafts",
  "detection_dismissals",
  "settings",
  "categories",
];

/**
 * Every table declared `AUTOINCREMENT`, which is every one with an `INTEGER
 * PRIMARY KEY` — `settings`, `detection_dismissals` and `scan_drafts` have TEXT
 * keys and never appear in `sqlite_sequence`.
 *
 * Clearing these is all the sequence handling the import needs: inserting an
 * explicit rowid higher than the stored value raises it, so after a restore the
 * next generated id is one past the highest one in the backup.
 */
const CLEAR_SEQUENCES: readonly string[] = [
  "attachments",
  "bills",
  "goal_contributions",
  "goals",
  "holding_contributions",
  "valuations",
  "holdings",
  "budgets",
  "statement_batches",
  "ask_turns",
  "categories",
];

/* ---------------------------------------------------------------- the export */

export type ExportSummary = {
  fileName: string;
  uri: string;
  bytes: number;
  /** Rows per table, in `TABLES` order. */
  counts: Record<string, number>;
  /** Total across every table, for one number in the UI. */
  rows: number;
  /** Attachment rows recorded; the same count of files that did not travel. */
  attachments: number;
  /** False when the share sheet is unavailable, so the file is only on disk. */
  shared: boolean;
};

/**
 * Writes the backup into the cache directory and offers it to the share sheet.
 *
 * The cache rather than the documents directory because the file's purpose is to
 * leave: once it is in Drive or a mail draft the copy here is litter, and
 * Android is allowed to reclaim it. The share sheet is guarded the way
 * `openAttachment` guards it — returning `shared: false` rather than throwing,
 * so the screen can say where the file is instead of showing an error for
 * something that worked.
 *
 * The reads run inside a transaction so the file is one consistent moment. They
 * are reads, so it costs nothing worth measuring, and it means an export taken
 * while something is being saved cannot catch a bill without its attachment row.
 */
export async function exportBackup(): Promise<ExportSummary> {
  const dir = FileSystem.cacheDirectory;
  if (!dir) throw new BackupError("No cache directory on this platform.");

  const tables: Record<string, Record<string, unknown>[]> = {};
  const counts: Record<string, number> = {};

  await tx(async (c) => {
    for (const spec of TABLES) {
      const cols = spec.cols.map((col) => col.name).join(", ");
      const { rows } = await c.query<Record<string, unknown>>(
        `SELECT ${cols} FROM ${spec.table} ORDER BY ${spec.key}`,
      );
      tables[spec.table] = rows;
      counts[spec.table] = rows.length;
    }
  });

  const payload = {
    format: FORMAT,
    version: FORMAT_VERSION,
    schema_version: SCHEMA_VERSION,
    exported_at: new Date().toISOString(),
    // Stated in the file itself, so someone opening it in a text editor a year
    // from now does not have to guess why their photos are missing.
    note: "Attachment rows are included; the image and PDF files behind them are not.",
    counts,
    tables,
  };

  const fileName = `moneyfit-backup-${today()}.json`;
  const uri = `${dir}${fileName}`;
  // Two spaces: a backup you can read and, if it comes to it, repair by hand is
  // worth more than the twenty per cent a minified file would save.
  await FileSystem.writeAsStringAsync(uri, JSON.stringify(payload, null, 2));

  // The real size, from the real file, for the same reason `saveUpload`
  // re-measures: a string's length is not its byte count once a merchant name
  // has a rupee sign in it.
  const info = await FileSystem.getInfoAsync(uri);
  const bytes = info.exists ? info.size : 0;

  let shared = false;
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, { mimeType: "application/json", UTI: "public.json" });
    shared = true;
  }

  const rows = Object.values(counts).reduce((a, n) => a + n, 0);
  return {
    fileName,
    uri,
    bytes,
    counts,
    rows,
    attachments: counts.attachments ?? 0,
    shared,
  };
}

/* ---------------------------------------------------------------- the import */

/** A file chosen from the device, in the shape `importBackup` wants. */
export type PickedBackup = { uri: string; size?: number };

/**
 * Asks for a backup file and returns it, or `null` if the picker was dismissed.
 *
 * This lives here rather than in a component because the import is one tap with
 * no form behind it: `importData` in actions/settings.ts calls this and then
 * `importBackup`, so the screen has a single no-argument action to hand a button.
 *
 * The type filter is a list rather than `"application/json"` alone because the
 * MIME type Android reports for a `.json` file depends on which provider it came
 * from — Downloads, Drive and a file manager do not agree, and
 * `application/octet-stream` is a common answer. Being generous here costs
 * nothing: a file that is not a backup is rejected by `envelope()` with a
 * sentence that says so, whereas a filter that hides the right file looks like
 * the feature is broken. `copyToCacheDirectory` for the same reason as in
 * `form.tsx` — a `content://` URI can stop resolving once the picker closes.
 */
export async function pickBackup(): Promise<PickedBackup | null> {
  const res = await DocumentPicker.getDocumentAsync({
    type: ["application/json", "text/plain", "application/octet-stream"],
    multiple: false,
    copyToCacheDirectory: true,
  });
  if (res.canceled) return null;

  const asset = res.assets[0];
  if (!asset) return null;
  return { uri: asset.uri, size: asset.size ?? undefined };
}

export type ImportSummary = {
  /** The envelope's timestamp, so the screen can say what was restored. */
  exportedAt: string | null;
  /** Rows inserted per table. */
  counts: Record<string, number>;
  rows: number;
  /** Attachment rows the file held and the import deliberately dropped. */
  attachmentsDropped: number;
  /** Files belonging to the replaced data, deleted after the transaction. */
  filesDeleted: number;
};

/** One table's rows, checked, flattened, and ready to bind. */
type Prepared = {
  table: string;
  cols: readonly string[];
  rows: (string | number | null)[][];
};

/**
 * Replaces everything in the database with the contents of `file`.
 *
 * The whole payload is read and checked before a single row is touched, which is
 * the property that makes this safe to offer at all: a file that is not a
 * MoneyFit backup, is from a newer version, or has a bad value in its last row
 * leaves the app exactly as it was.
 *
 * The filesystem half runs after the transaction has committed, keeping
 * `wipeEverything()`'s ordering: an orphaned file wastes a few kilobytes,
 * whereas a row pointing at a deleted file is a broken preview.
 */
export async function importBackup(file: PickedBackup): Promise<ImportSummary> {
  const text = await readBackupFile(file);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BackupError("That file is not valid JSON, so it is not a MoneyFit backup.");
  }

  const env = envelope(parsed);
  const prepared: Prepared[] = [];
  const counts: Record<string, number> = {};
  let attachmentsDropped = 0;

  for (const spec of TABLES) {
    const rows = rowsFor(env.tables, spec);
    if (SKIP_RESTORE.includes(spec.table)) {
      attachmentsDropped = rows.length;
      continue;
    }
    const checked = check(spec, rows);
    prepared.push({ table: spec.table, cols: spec.cols.map((c) => c.name), rows: checked });
    counts[spec.table] = checked.length;
  }

  // A backup with no categories and no settings would restore an app with no
  // categories to file a bill under — which only happens if someone emptied the
  // `tables` map by hand, but it is a cheap thing to refuse.
  if ((counts.categories ?? 0) === 0) {
    throw new BackupError("That backup has no categories, so restoring it would leave the app unusable.");
  }

  const files = await restore(prepared);
  for (const name of files) await deleteUpload(name);

  return {
    exportedAt: env.exportedAt,
    counts,
    rows: Object.values(counts).reduce((a, n) => a + n, 0),
    attachmentsDropped,
    filesDeleted: files.length,
  };
}

/**
 * Size-checked twice for the reason `saveUpload` gives: the declared size is a
 * claim, and it is free, so it is used to reject the obvious case before any
 * bytes move; the real one is measured from the file.
 */
async function readBackupFile(file: PickedBackup): Promise<string> {
  if (file.size !== undefined && file.size > MAX_BACKUP_BYTES) throw tooBig(file.size);

  const info = await FileSystem.getInfoAsync(file.uri);
  if (!info.exists) throw new BackupError("That file could not be opened.");
  if (info.size === 0) throw new BackupError("That file is empty.");
  if (info.size > MAX_BACKUP_BYTES) throw tooBig(info.size);

  return FileSystem.readAsStringAsync(file.uri);
}

function tooBig(size: number): BackupError {
  return new BackupError(
    `That file is ${(size / 1048576).toFixed(1)} MB. A MoneyFit backup is a fraction of that, so this is something else.`,
  );
}

type Envelope = { exportedAt: string | null; tables: Record<string, unknown> };

/**
 * Checks the four envelope fields that decide whether to go on. The version
 * comparisons are deliberately asymmetric: a *newer* format or schema is refused
 * because this code cannot know what changed, whereas an older one is accepted,
 * since every column the spec names has existed since the first release.
 */
function envelope(parsed: unknown): Envelope {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BackupError("That file is not a MoneyFit backup.");
  }
  const o = parsed as Record<string, unknown>;

  if (o.format !== FORMAT) {
    throw new BackupError("That file is not a MoneyFit backup — its format field does not match.");
  }
  if (typeof o.version !== "number" || o.version > FORMAT_VERSION) {
    throw new BackupError(
      "That backup was written by a newer version of MoneyFit. Update the app and try again.",
    );
  }
  if (typeof o.schema_version === "number" && o.schema_version > SCHEMA_VERSION) {
    throw new BackupError(
      `That backup is from database version ${o.schema_version}; this app understands ${SCHEMA_VERSION}. Update the app and try again.`,
    );
  }
  if (typeof o.tables !== "object" || o.tables === null || Array.isArray(o.tables)) {
    throw new BackupError("That backup has no tables in it.");
  }

  return {
    exportedAt: typeof o.exported_at === "string" ? o.exported_at : null,
    tables: o.tables as Record<string, unknown>,
  };
}

/**
 * A table the file does not mention is empty rather than an error, so a backup
 * taken before a table existed still restores. A table that is present but is
 * not a list of rows is an error, because that is a damaged file rather than an
 * old one.
 */
function rowsFor(tables: Record<string, unknown>, spec: TableSpec): Record<string, unknown>[] {
  const value = tables[spec.table];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new BackupError(`The ${spec.table} section of that backup is not a list of rows.`);
  }
  return value.map((row, i) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new BackupError(`${spec.table} row ${i + 1} is not a row.`);
    }
    return row as Record<string, unknown>;
  });
}

/**
 * Turns one table's row objects into bindable arrays in column order, failing on
 * the first thing that is wrong.
 *
 * Checking types here rather than letting SQLite sort it out is the point:
 * SQLite's columns are dynamically typed, so a string "500" in `amount_minor`
 * would be stored happily and then quietly fail to add up months later.
 */
function check(spec: TableSpec, rows: Record<string, unknown>[]): (string | number | null)[][] {
  const seen = new Set<string | number>();
  const out: (string | number | null)[][] = [];

  // `cols[0]` is not assumed — the key is named in the spec, and this is the
  // position its value lands in below. Every spec satisfies this; the throw is
  // here so a future table that does not fails at the first row rather than
  // silently skipping the duplicate check.
  const at = spec.cols.findIndex((c) => c.name === spec.key);
  if (at < 0) throw new BackupError(`${spec.table}: ${spec.key} is not one of its columns.`);

  rows.forEach((row, i) => {
    const values: (string | number | null)[] = [];
    for (const col of spec.cols) values.push(cell(row[col.name], col, spec.table, i));

    const key = values[at];
    if (key === null) throw new BackupError(`${spec.table} row ${i + 1} has no ${spec.key}.`);
    if (seen.has(key)) {
      throw new BackupError(`That backup has two ${spec.table} rows with ${spec.key} ${key}.`);
    }
    seen.add(key);

    out.push(values);
  });

  return out;
}

function cell(
  value: unknown,
  col: Col,
  table: string,
  index: number,
): string | number | null {
  const at = `${table} row ${index + 1}: ${col.name}`;

  if (value === null || value === undefined) {
    if (col.null) return null;
    throw new BackupError(`${at} is missing.`);
  }

  if (col.type === "text") {
    if (typeof value !== "string") throw new BackupError(`${at} should be text.`);
    return value;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BackupError(`${at} should be a number.`);
  }
  if (col.type === "int" && !Number.isInteger(value)) {
    throw new BackupError(`${at} should be a whole number.`);
  }
  return value;
}

/**
 * The one transaction: defer the foreign keys, clear everything, insert
 * everything, and hand back the file names of the stored files that just lost
 * their rows, so the caller can delete them once this has committed.
 *
 * Three tables name a file and all three are read, for the same reason
 * `wipeAll()` reads all three: the restored `statement_batches` rows carry their
 * `file_name` across but the files do not, and a `scan_drafts` row is not
 * restored at all, so both leave bytes behind unless they are collected here.
 *
 * A failure at COMMIT is almost always a foreign key that does not resolve —
 * SQLite reports deferred violations there, by which point nothing it names is
 * still in scope — so it is rephrased into something a person can act on rather
 * than passed through.
 */
async function restore(prepared: readonly Prepared[]): Promise<string[]> {
  try {
    return await tx(async (c) => {
      // First statement in the transaction, and it clears itself at COMMIT.
      // Every check still runs — they are deferred, not skipped — which is what
      // lets `bills.parent_bill_id` reference a row inserted later in the same
      // statement while still refusing a parent that is not in the file at all.
      await c.query("PRAGMA defer_foreign_keys = ON");

      // UNION rather than UNION ALL, so a name held by two tables is unlinked
      // once. See `wipeAll()`, which does the same read for the same reason.
      const { rows } = await c.query<{ file_name: string }>(
        `SELECT file_name FROM attachments
         UNION
         SELECT file_name FROM statement_batches WHERE file_name IS NOT NULL
         UNION
         SELECT file_name FROM scan_drafts`,
      );

      for (const table of CLEAR_ORDER) await c.query(`DELETE FROM ${table}`);

      // Same existence check and same reasoning as `wipeAll()`: the table only
      // appears once something has used AUTOINCREMENT, and looking is cheaper
      // than an exception handler that would have to guess what it caught.
      const seq = await c.query<{ n: number }>(
        "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'",
      );
      if ((seq.rows[0]?.n ?? 0) > 0) {
        await c.query(
          `DELETE FROM sqlite_sequence WHERE name IN (${CLEAR_SEQUENCES.map(() => "?").join(", ")})`,
          [...CLEAR_SEQUENCES],
        );
      }

      for (const p of prepared) await insertRows(c, p);

      // The one column the restore blanks rather than trusts. A batch's
      // `file_name` is carried through the format so the export is a complete
      // record, but the file itself did not travel, and the schema already
      // spells NULL as "the stored file is gone" — which, on this phone, it is.
      // Leaving the name would point the review screen at nothing; nulling it
      // keeps the `sha256`, which is the part worth restoring.
      await c.query("UPDATE statement_batches SET file_name = NULL");

      return rows.map((r) => r.file_name);
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/FOREIGN KEY/i.test(message)) {
      throw new BackupError(
        "That backup's rows do not fit together — something refers to a bill, goal, holding or category the file does not contain. Nothing was changed.",
      );
    }
    throw e;
  }
}

/**
 * `sample-data.ts`'s `insertMany`, with the same documented exception: `table`
 * and the column names are interpolated into the statement text, which
 * `lib/db.ts` says never to do. So, explicitly — both come from the `TABLES`
 * literals at the top of this file and from nowhere else, and in particular
 * never from the backup being read, whose keys are only ever used to look values
 * up. Every *value* is still a bound parameter.
 */
async function insertRows(c: Client, p: Prepared): Promise<void> {
  if (!p.rows.length) return;
  const perRow = `(${p.cols.map(() => "?").join(", ")})`;
  const chunk = Math.max(1, Math.floor(MAX_PARAMS / p.cols.length));

  for (let i = 0; i < p.rows.length; i += chunk) {
    const slice = p.rows.slice(i, i + chunk);
    const params: unknown[] = [];
    for (const row of slice) for (const v of row) params.push(v);
    await c.query(
      `INSERT INTO ${p.table} (${p.cols.join(", ")})
       VALUES ${slice.map(() => perRow).join(", ")}`,
      params,
    );
  }
}

/* ----------------------------------------------------------------- the badge */

/**
 * What the Settings card shows before anything is pressed: how much there is to
 * back up, so the button is not an unknown quantity. Cheap enough to run with
 * the rest of that screen's reads.
 */
export async function backupSize(): Promise<{ rows: number; attachments: number }> {
  const row = await q1<{ rows: number; attachments: number }>(
    `SELECT (SELECT count(*) FROM categories)
          + (SELECT count(*) FROM bills)
          + (SELECT count(*) FROM budgets)
          + (SELECT count(*) FROM goals)
          + (SELECT count(*) FROM goal_contributions)
          + (SELECT count(*) FROM holdings)
          + (SELECT count(*) FROM holding_contributions)
          + (SELECT count(*) FROM valuations)
          + (SELECT count(*) FROM settings)
          + (SELECT count(*) FROM detection_dismissals) AS rows,
            (SELECT count(*) FROM attachments)          AS attachments`,
  );
  return { rows: row?.rows ?? 0, attachments: row?.attachments ?? 0 };
}
