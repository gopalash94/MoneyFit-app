import type { ISODate, MonthKey } from "./date";
import type { Recurrence } from "./recurrence";

export type Kind = "expense" | "income";
export type BillStatus = "paid" | "upcoming";
export type Side = "asset" | "liability";

export type AssetType =
  | "equity" | "mutual_fund" | "ppf" | "epf" | "nps" | "fd" | "gold"
  | "real_estate" | "crypto" | "bonds" | "cash" | "loan" | "credit_card" | "other";

export const ASSET_TYPE_LABEL: Record<AssetType, string> = {
  equity: "Stocks",
  mutual_fund: "Mutual funds",
  ppf: "PPF",
  epf: "EPF",
  nps: "NPS",
  fd: "Fixed deposits",
  gold: "Gold",
  real_estate: "Property",
  crypto: "Crypto",
  bonds: "Bonds",
  cash: "Cash & savings",
  loan: "Loan",
  credit_card: "Credit card",
  other: "Other",
};

/** Ring-adjacent palette, reused by the allocation donut. */
export const ASSET_TYPE_COLOR: Record<AssetType, string> = {
  equity: "#1A73E8",
  mutual_fund: "#1E8E3E",
  ppf: "#F9AB00",
  epf: "#E8710A",
  nps: "#9334E6",
  fd: "#12B5CB",
  gold: "#F4B400",
  real_estate: "#795548",
  crypto: "#AB47BC",
  bonds: "#00897B",
  cash: "#5F6368",
  loan: "#D93025",
  credit_card: "#EA4335",
  other: "#80868B",
};

export type Category = {
  id: number;
  name: string;
  icon: string;
  color: string;
  kind: Kind;
  sort_order: number;
  archived: boolean;
};

export type Bill = {
  id: number;
  merchant: string;
  amount_minor: number;
  txn_date: ISODate;
  due_date: ISODate | null;
  status: BillStatus;
  kind: Kind;
  category_id: number | null;
  notes: string | null;
  recurrence: Recurrence;
  parent_bill_id: number | null;
  /**
   * Whether this row was typed in or read off a photograph.
   *
   * **The web app no longer has this column.** `db/060_drop_ai.sql` dropped it when
   * the camera scan went, on the grounds that with nothing to set it to `'ai'` it was
   * "not information". The scan is kept here — see the README's list of deliberate
   * differences — so the column still distinguishes two real things and stays.
   *
   * It is also the one column that would be expensive to change its mind about.
   * SQLite will not `ALTER TABLE … DROP COLUMN` a column named in a `CHECK`, and this
   * one is; the alternative is rebuilding `bills`, and `DROP TABLE bills` with
   * `PRAGMA foreign_keys = ON` — which `db.ts` sets — would cascade into
   * `attachments` and take every stored receipt with it.
   */
  source: "manual" | "ai";
  /** The card, wallet or loan this was paid from. Null for most manual entries. */
  holding_id: number | null;
  // `statement_batch_id` is deliberately absent, as it is on the web. The column
  // exists, `commitStatement` writes it and `batchBillCount` counts it, but nothing
  // reads it back onto a bill — so typing it would promise a field no screen is
  // given. Add it here on the day something renders "from the March statement".
  created_at: string;
};

/** A bill joined to its category and attachment count — what lists actually need. */
export type BillRow = Bill & {
  category_name: string | null;
  category_color: string | null;
  category_icon: string | null;
  holding_name: string | null;
  attachment_count: number;
};

export type Attachment = {
  id: number;
  bill_id: number;
  file_name: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
};

export type Goal = {
  id: number;
  name: string;
  target_minor: number;
  target_date: ISODate | null;
  icon: string;
  color: string;
  notes: string | null;
  archived: boolean;
  started_on: ISODate;
  created_at: string;
};

export type GoalRow = Goal & { saved_minor: number; contribution_count: number };

export type Contribution = {
  id: number;
  amount_minor: number;
  txn_date: ISODate;
  note: string | null;
};

export type Holding = {
  id: number;
  name: string;
  side: Side;
  asset_type: AssetType;
  units: number | null;
  institution: string | null;
  notes: string | null;
  archived: boolean;
  created_at: string;
};

export type HoldingRow = Holding & {
  invested_minor: number;
  value_minor: number;
  last_valued_on: ISODate | null;
  valuation_count: number;
};

export type Valuation = { id: number; as_of: ISODate; value_minor: number };

/** The subset of a holding the "paid from" picker needs. */
export type PaymentAccount = Pick<Holding, "id" | "name" | "asset_type">;

export type Settings = {
  currency: string;
  display_name: string;
  monthly_budget_minor: number;
  monthly_goal_target_minor: number;
  monthly_invest_target_minor: number;
  month_start_day: number;
  theme: "system" | "light" | "dark";
};

/**
 * One uploaded bank statement.
 *
 * The file itself stays on disk under `file_name`, which is what lets the review
 * screen re-parse it instead of the database holding a second, divergent copy of the
 * rows. `sha256` is what stops the same file being imported twice; `committed_at` is
 * null while the batch is still sitting on the review screen.
 *
 * `file_name` is `string | null` here where the web's type says `string`. The column
 * is nullable in both schemas and the review screen on both platforms checks it —
 * the web's own page has a "that file is gone" card — so this is the type the web
 * meant. It also earns its keep under `strict`: `commitStatement` cannot pass the
 * name on until it has made that check.
 */
export type StatementBatch = {
  id: number;
  file_name: string | null;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  page_count: number;
  row_count: number;
  added_count: number;
  committed_at: string | null;
  created_at: string;
};

/** The three-ring hero on Home. */
export type RingData = {
  month: MonthKey;
  spentMinor: number;
  budgetMinor: number;
  goalFundedMinor: number;
  goalTargetMinor: number;
  investedMinor: number;
  investTargetMinor: number;
};

/** A column of an Ask answer. `num` only decides alignment — the cell is already text. */
export type AskColumn = { name: string; num: boolean };

/**
 * A chart the model asked for, with the series already extracted.
 *
 * `label` and `value` are the two column names it chose, kept for the axis caption.
 * `labels` and `values` are the plottable form of those two columns, and they are
 * stored rather than derived for one unavoidable reason: the rows saved beside this
 * are *rendered strings*, so "₹1,23,456" is what a chart rebuilt from them would try
 * to plot. The numbers have to be kept while they are still numbers.
 */
export type AskChart = {
  kind: "bar" | "line";
  label: string;
  value: string;
  labels: string[];
  values: number[];
};

/**
 * One question in the Ask thread, and whatever came of it.
 *
 * `status` is the only field that is always meaningful: a refusal has a `note` and no
 * SQL, a failure has a `note` and sometimes SQL, and an answer has everything. The
 * answer is stored as rendered text (`AskColumn[]` plus rows of strings) because the
 * types of a generated query's columns are a property of that query, not of the app.
 *
 * `assumptions` and `chart` have no counterpart in the web's `ask_turns`, because the
 * web's answer has neither. They are here so that a turn read back from the database
 * is the *same* answer you saw when you asked it, rather than a reduced copy that
 * would have forced this screen to render two shapes.
 *
 * `result_cols`, `result_rows`, `assumptions` and `chart` are `jsonb` on Postgres and
 * TEXT holding JSON here, so `queries/ask.ts` is where `JSON.parse` and
 * `JSON.stringify` live — one boundary, both directions, with a null guard. Everything
 * above that boundary sees these types and nothing else.
 */
export type AskTurn = {
  id: number;
  question: string;
  status: "answered" | "refused" | "failed";
  sql_text: string | null;
  model: string | null;
  note: string | null;
  assumptions: string[] | null;
  chart: AskChart | null;
  result_cols: AskColumn[] | null;
  result_rows: string[][] | null;
  row_count: number;
  truncated: boolean;
  ms: number | null;
  created_at: string;
};
