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
  source: "manual" | "ai";
  created_at: string;
};

/** A bill joined to its category and attachment count — what lists actually need. */
export type BillRow = Bill & {
  category_name: string | null;
  category_color: string | null;
  category_icon: string | null;
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

export type Settings = {
  currency: string;
  display_name: string;
  monthly_budget_minor: number;
  monthly_goal_target_minor: number;
  monthly_invest_target_minor: number;
  month_start_day: number;
  theme: "system" | "light" | "dark";
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
