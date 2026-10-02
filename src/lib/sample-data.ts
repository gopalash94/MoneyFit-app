/**
 * Sample data, generated in TypeScript rather than seeded from SQL.
 *
 * `SEED_SQL` deliberately stops at categories and defaults — a real install must
 * not start out holding someone else's spending. But every chart in this app is an
 * empty box until months of history sit behind it, and "enter forty bills by hand
 * on a phone keyboard to find out whether you like the app" is an even less
 * reasonable first request than it was on a desktop. So this builds a plausible
 * eighteen months.
 *
 * Deterministic on purpose. The same seed produces the same rows every time, so a
 * screenshot, a bug report and the README all describe the same numbers; it is
 * pseudo-random, not arbitrary. Everything lands in one transaction, because a
 * half-loaded sample — bills but no valuations — would look like a bug in the app
 * rather than an interrupted insert.
 *
 * **Everything above the inserts is byte-identical to the web app**: the PRNG, the
 * bill specs, the four goals, the nine holdings, the shared market series with its
 * deliberate dip, the ten budgets. That is the point — the sample data is the one
 * thing that can be compared between the two apps by eye, so it has to be the same
 * eighteen months on both. Three things changed, all below the `inserts` rule:
 *
 *   - **`PoolClient` → `Client`** from lib/db.ts.
 *   - **`unnest` → multi-row `VALUES`.** SQLite has no unnest and `bind()` throws
 *     on an array parameter rather than coerce one, so the four bulk inserts go
 *     through `insertMany` below. Still a handful of statements for ~250 rows, not
 *     250 of them.
 *   - **`TRUNCATE … RESTART IDENTITY CASCADE` → ordered `DELETE`s plus
 *     `sqlite_sequence`.** SQLite has no TRUNCATE; the identity reset is a real
 *     part of the behaviour, not a detail, so it is reproduced explicitly.
 */

import type { Client } from "./db";
import { tx } from "./db";
import { addDays, addMonthKey, thisMonth, today, type ISODate, type MonthKey } from "./date";
import type { AssetType, Kind, Side } from "./types";
import type { Recurrence } from "./recurrence";

/** Months of bills, current month included. Enough for a trend and a forecast. */
const BILL_MONTHS = 7;
/**
 * Goals and holdings reach further back than the bills do. That is not an
 * oversight: a portfolio is usually older than the habit of logging receipts,
 * and the twelve-month net worth line on Profile should be a full line rather
 * than one that ramps out of nowhere.
 */
const HISTORY_MONTHS = 18;

const SEED = 20260214;

export type SampleSummary = {
  bills: number;
  goals: number;
  holdings: number;
  valuations: number;
  months: number;
};

/** True when there is nothing to overwrite — the only state a load is allowed from. */
export async function isPristine(c: Client): Promise<boolean> {
  const { rows } = await c.query<{ n: number }>(
    `SELECT (SELECT count(*) FROM bills)
          + (SELECT count(*) FROM goals)
          + (SELECT count(*) FROM holdings) AS n`,
  );
  return Number(rows[0]?.n ?? 0) === 0;
}

export class NotPristine extends Error {
  constructor() {
    super(
      "There is already data here. Sample data is only loaded into an empty app — " +
        "clear everything first if you really want it.",
    );
  }
}

export async function loadSample(): Promise<SampleSummary> {
  return tx(async (c) => {
    if (!(await isPristine(c))) throw new NotPristine();

    const cats = await categoryIds(c);
    const r = mulberry32(SEED);

    const bills = buildBills(r, cats);
    const goals = buildGoals();
    const holdings = buildHoldings(r);

    await insertBills(c, bills);
    for (const g of goals) await insertGoal(c, g);
    for (const h of holdings) await insertHolding(c, h);
    await insertBudgets(c, cats);

    return {
      bills: bills.length,
      goals: goals.length,
      holdings: holdings.length,
      valuations: holdings.reduce((s, h) => s + h.valuations.length, 0),
      months: BILL_MONTHS,
    };
  });
}

// --------------------------------------------------------------------- randomness

/**
 * mulberry32 — thirty lines short of a PRNG library and entirely sufficient
 * here. `Math.random()` would make every load different, which sounds harmless
 * until a chart looks wrong and there is no way to reproduce it.
 */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const intIn = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const oneOf = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
/** Rupees to paise. Every amount below is written in rupees for readability. */
const paise = (rupees: number) => Math.round(rupees * 100);

function lastDayOf(mk: MonthKey): number {
  const [y, m] = mk.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0)).getUTCDate();
}

const dayIn = (mk: MonthKey, day: number): ISODate => `${mk}-${String(day).padStart(2, "0")}`;

// ------------------------------------------------------------------------- bills

type BillSpec = {
  category: string;
  merchants: readonly string[];
  /** Rupees: one fixed amount, or [min, max] sampled per occurrence. */
  amount: number | readonly [number, number];
  /** A fixed day of the month. Mutually exclusive with `times`. */
  day?: number;
  /** [min, max] occurrences per month, on days picked at random. */
  times?: readonly [number, number];
  /** Only every Nth month — gas cylinders, quarterly interest. */
  every?: number;
  recurrence?: Recurrence;
  kind?: Kind;
  note?: string;
};

/**
 * The bills that arrive whether or not you do anything: same day, same payee.
 * These are what the subscription detector is supposed to find, so they are
 * genuinely regular — only the metered ones vary.
 */
const FIXED: readonly BillSpec[] = [
  { category: "Rent", merchants: ["Flat rent"], amount: 32000, day: 2, recurrence: "monthly" },
  { category: "Internet", merchants: ["ACT Fibernet"], amount: 1180, day: 5, recurrence: "monthly" },
  { category: "Electricity", merchants: ["BESCOM"], amount: [2150, 4380], day: 8, recurrence: "monthly" },
  { category: "Water", merchants: ["BWSSB"], amount: 480, day: 9, recurrence: "monthly" },
  { category: "Mobile", merchants: ["Airtel postpaid"], amount: 749, day: 12, recurrence: "monthly" },
  { category: "Subscriptions", merchants: ["Netflix"], amount: 649, day: 14, recurrence: "monthly" },
  { category: "Subscriptions", merchants: ["Spotify Premium"], amount: 119, day: 17, recurrence: "monthly" },
  { category: "Subscriptions", merchants: ["Google One 200 GB"], amount: 130, day: 22, recurrence: "monthly" },
  { category: "Insurance", merchants: ["HDFC Life term cover"], amount: 2480, day: 20, recurrence: "monthly" },
  // A cylinder lasts about two months, which is the kind of near-regular the
  // detector should rank below the true monthlies rather than miss entirely.
  { category: "Gas", merchants: ["Indane refill"], amount: 1105, day: 11, every: 2 },
];

/** Everything discretionary: a different number of entries every month. */
const VARIABLE: readonly BillSpec[] = [
  { category: "Groceries", merchants: ["BigBasket", "Reliance Fresh", "More Supermarket", "Local kirana"], amount: [850, 3900], times: [4, 6] },
  { category: "Dining", merchants: ["Swiggy", "Zomato", "Third Wave Coffee", "Truffles", "Empire"], amount: [240, 2100], times: [4, 8] },
  { category: "Transport", merchants: ["Uber", "Namma Metro", "Rapido", "Ola"], amount: [45, 620], times: [5, 9] },
  { category: "Fuel", merchants: ["HP Petrol Pump", "Indian Oil"], amount: [1800, 3200], times: [1, 2] },
  { category: "Shopping", merchants: ["Amazon", "Flipkart", "Myntra", "Decathlon"], amount: [640, 6400], times: [1, 3] },
  { category: "Health", merchants: ["Apollo Pharmacy", "1mg", "Practo consult"], amount: [320, 2400], times: [0, 2] },
  { category: "Entertainment", merchants: ["PVR Cinemas", "BookMyShow"], amount: [350, 1400], times: [0, 2] },
  { category: "Household", merchants: ["Urban Company", "Hardware store"], amount: [280, 2600], times: [0, 2] },
  { category: "Gifts", merchants: ["Ferns N Petals", "Present for family"], amount: [500, 3500], times: [0, 1] },
  { category: "Fees & Charges", merchants: ["Bank charges", "Card annual fee"], amount: [50, 590], times: [0, 2] },
];

const INCOME: readonly BillSpec[] = [
  { category: "Salary", merchants: ["Monthly salary"], amount: 148500, day: 1, recurrence: "monthly", kind: "income" },
  { category: "Interest", merchants: ["Savings interest"], amount: [380, 1250], day: 28, every: 3, kind: "income" },
];

/**
 * Bills that have not happened yet, so Home's upcoming card and the overdue
 * badge both have something to show. One is deliberately late: an overdue chip
 * nobody can see is a feature nobody trusts.
 */
const UPCOMING: readonly { category: string; merchant: string; amount: number; inDays: number }[] = [
  { category: "Fees & Charges", merchant: "Society maintenance", amount: 3400, inDays: -3 },
  { category: "Insurance", merchant: "Two-wheeler insurance renewal", amount: 4120, inDays: 4 },
  { category: "Education", merchant: "Online course instalment", amount: 6500, inDays: 11 },
  { category: "Taxes", merchant: "Advance tax instalment", amount: 18000, inDays: 24 },
];

type BillRowIn = {
  merchant: string;
  amount_minor: number;
  txn_date: ISODate;
  due_date: ISODate | null;
  status: "paid" | "upcoming";
  kind: Kind;
  category_id: number | null;
  notes: string | null;
  recurrence: Recurrence;
};

function buildBills(r: () => number, cats: Map<string, number>): BillRowIn[] {
  const now = today();
  const mk = thisMonth();
  const months = Array.from({ length: BILL_MONTHS }, (_, i) => addMonthKey(mk, i - (BILL_MONTHS - 1)));
  const out: BillRowIn[] = [];

  const push = (
    spec: BillSpec,
    date: ISODate,
    amountRupees: number,
  ) => {
    // The current month is only partly over. A "paid" bill dated next week is a
    // lie that would inflate the spend ring and flatten the burn-down line.
    if (date > now) return;
    out.push({
      merchant: oneOf(r, spec.merchants),
      amount_minor: paise(amountRupees),
      txn_date: date,
      due_date: null,
      status: "paid",
      kind: spec.kind ?? "expense",
      category_id: cats.get(spec.category) ?? null,
      notes: spec.note ?? null,
      recurrence: spec.recurrence ?? "none",
    });
  };

  const sample = (spec: BillSpec) =>
    Array.isArray(spec.amount)
      ? intIn(r, spec.amount[0]!, spec.amount[1]!)
      : (spec.amount as number);

  months.forEach((month, i) => {
    const last = lastDayOf(month);
    const isCurrent = month === mk;
    // Scale the current month's discretionary count by how much of it has
    // happened, so the newest bar is short because the month is young rather
    // than because you suddenly stopped eating.
    const elapsed = isCurrent ? Math.max(1, Number(now.slice(8, 10))) / last : 1;

    for (const spec of [...FIXED, ...INCOME]) {
      if (spec.every && i % spec.every !== 0) continue;
      push(spec, dayIn(month, Math.min(spec.day ?? 1, last)), sample(spec));
    }

    for (const spec of VARIABLE) {
      const [lo, hi] = spec.times ?? [1, 1];
      const n = Math.round(intIn(r, lo!, hi!) * elapsed);
      for (let k = 0; k < n; k++) {
        push(spec, dayIn(month, intIn(r, 1, isCurrent ? Math.max(1, Number(now.slice(8, 10))) : last)), sample(spec));
      }
    }
  });

  for (const u of UPCOMING) {
    const due = addDays(now, u.inDays);
    out.push({
      merchant: u.merchant,
      amount_minor: paise(u.amount),
      txn_date: due,
      due_date: due,
      status: "upcoming",
      kind: "expense",
      category_id: cats.get(u.category) ?? null,
      notes: null,
      recurrence: "none",
    });
  }

  return out.sort((a, b) => a.txn_date.localeCompare(b.txn_date));
}

// ------------------------------------------------------------------------- goals

type GoalIn = {
  name: string;
  target: number;
  icon: string;
  color: string;
  notes: string;
  startedMonthsAgo: number;
  /** Months from now, or null for a goal with no deadline. */
  deadlineIn: number | null;
  perMonth: number;
  archived?: boolean;
  /** Months to skip, counted from the start — a month you could not contribute. */
  skip?: readonly number[];
};

/**
 * Four goals, chosen to land on four different pace verdicts: no deadline,
 * behind, ahead, and finished-and-archived. A sample set where everything says
 * "on track" proves only that the label renders.
 */
const GOALS: readonly GoalIn[] = [
  {
    name: "Emergency fund",
    target: 600000,
    icon: "shield",
    color: "#1e8e3e",
    notes: "Six months of expenses, parked where it can be reached the same day.",
    startedMonthsAgo: 17,
    deadlineIn: null,
    perMonth: 22000,
    skip: [6],
  },
  {
    name: "Japan in spring",
    target: 260000,
    icon: "plane",
    color: "#1a73e8",
    notes: "Flights, a JR pass and two weeks of hotels for two.",
    startedMonthsAgo: 8,
    deadlineIn: 7,
    perMonth: 9000,
  },
  {
    name: "New laptop",
    target: 185000,
    icon: "bag",
    color: "#f9ab00",
    notes: "The current one is eight years old and thermally throttled.",
    startedMonthsAgo: 5,
    deadlineIn: 3,
    perMonth: 32000,
  },
  {
    name: "Wedding fund",
    target: 400000,
    icon: "heart",
    color: "#9334e6",
    notes: "Done and spent. Kept for the record.",
    startedMonthsAgo: 17,
    deadlineIn: -2,
    perMonth: 40000,
    archived: true,
  },
];

type GoalBuilt = GoalIn & {
  started_on: ISODate;
  target_date: ISODate | null;
  contributions: { amount_minor: number; txn_date: ISODate; note: string | null }[];
};

function buildGoals(): GoalBuilt[] {
  const mk = thisMonth();
  const now = today();

  return GOALS.map((g) => {
    const startMonth = addMonthKey(mk, -g.startedMonthsAgo);
    const started_on = dayIn(startMonth, 3);
    const contributions: GoalBuilt["contributions"] = [];
    let saved = 0;

    for (let i = 0; i <= g.startedMonthsAgo; i++) {
      if (g.skip?.includes(i)) continue;
      const date = dayIn(addMonthKey(startMonth, i), 3);
      if (date > now) break;
      // Stop at the target rather than sailing past it: a goal showing 118%
      // funded is a rounding bug in every app that has one.
      const amount = Math.min(paise(g.perMonth), paise(g.target) - saved);
      if (amount <= 0) break;
      saved += amount;
      contributions.push({ amount_minor: amount, txn_date: date, note: null });
    }

    return {
      ...g,
      started_on,
      target_date: g.deadlineIn === null ? null : dayIn(addMonthKey(mk, g.deadlineIn), 28),
      contributions,
    };
  });
}

// ---------------------------------------------------------------------- holdings

type HoldingIn = {
  name: string;
  side: Side;
  asset_type: AssetType;
  institution: string;
  notes?: string;
  monthsAgo: number;
  /** Rupees added every month. */
  sip?: number;
  /** Rupees put in once, at the start. */
  lump?: number;
  /** Monthly return when the holding does not follow the market (PPF, FDs, cash). */
  fixedRate?: number;
  /** How hard the holding moves with the shared market series. 0 = not at all. */
  beta?: number;
  /** Liabilities only: rupees of principal cleared each month. */
  repay?: number;
};

const ASSETS: readonly HoldingIn[] = [
  {
    name: "Parag Parikh Flexi Cap",
    side: "asset",
    asset_type: "mutual_fund",
    institution: "Zerodha Coin",
    notes: "Core equity SIP, 5th of every month.",
    monthsAgo: 17,
    sip: 12000,
    beta: 1,
  },
  {
    name: "Nifty 50 Index Fund",
    side: "asset",
    asset_type: "mutual_fund",
    institution: "Groww",
    monthsAgo: 13,
    sip: 8000,
    beta: 1.15,
  },
  {
    name: "PPF",
    side: "asset",
    asset_type: "ppf",
    institution: "State Bank of India",
    notes: "7.1% a year, credited annually. Locked until 2039.",
    monthsAgo: 17,
    sip: 12500,
    fixedRate: 0.0058,
  },
  {
    name: "Digital gold",
    side: "asset",
    asset_type: "gold",
    institution: "MMTC-PAMP",
    monthsAgo: 11,
    sip: 3000,
    beta: 0.55,
  },
  {
    name: "Liquid fund",
    side: "asset",
    asset_type: "cash",
    institution: "HDFC AMC",
    notes: "Where the emergency fund actually sits.",
    monthsAgo: 17,
    sip: 6000,
    fixedRate: 0.0052,
  },
  {
    name: "SBI fixed deposit",
    side: "asset",
    asset_type: "fd",
    institution: "State Bank of India",
    monthsAgo: 9,
    lump: 200000,
    fixedRate: 0.0055,
  },
  {
    name: "Flat in Whitefield",
    side: "asset",
    asset_type: "real_estate",
    institution: "Self-occupied",
    notes: "Bought with the home loan below. Valued off nearby listings, so treat it as an estimate.",
    monthsAgo: 17,
    lump: 1400000, // the down payment; the rest is the loan
    fixedRate: 0.0045,
  },
];

const DEBTS: readonly HoldingIn[] = [
  {
    name: "Home loan",
    side: "liability",
    asset_type: "loan",
    institution: "HDFC Bank",
    notes: "8.6% floating, 20 years. The EMI's principal component is recorded as a repayment.",
    monthsAgo: 17,
    lump: 4200000,
    repay: 11500,
  },
  {
    name: "Credit card",
    side: "liability",
    asset_type: "credit_card",
    institution: "HDFC Regalia",
    notes: "Cleared in full most months. The balance here is what is outstanding on the statement.",
    monthsAgo: 11,
    lump: 42000,
    repay: 1600,
  },
];

type HoldingBuilt = {
  spec: HoldingIn;
  contributions: { amount_minor: number; txn_date: ISODate; note: string | null }[];
  valuations: { as_of: ISODate; value_minor: number }[];
};

function buildHoldings(r: () => number): HoldingBuilt[] {
  const mk = thisMonth();
  const now = today();

  /**
   * One shared market series for every holding with a beta, rather than
   * independent noise per fund. A real portfolio falls together, and
   * portfolio-level drawdown measures nothing at all without that correlation —
   * so there is a deliberate bad month five months back for it to find.
   */
  const dip = HISTORY_MONTHS - 6;
  const market = Array.from({ length: HISTORY_MONTHS + 1 }, (_, i) =>
    i === dip ? -0.081 : i === dip + 1 ? -0.024 : 0.0095 + (r() - 0.45) * 0.042,
  );

  return [...ASSETS, ...DEBTS].map((spec) => {
    const startMonth = addMonthKey(mk, -spec.monthsAgo);
    const contributions: HoldingBuilt["contributions"] = [];
    const valuations: HoldingBuilt["valuations"] = [];
    let value = 0;

    for (let i = 0; i <= spec.monthsAgo; i++) {
      const month = addMonthKey(startMonth, i);
      const last = lastDayOf(month);
      const contribDate = dayIn(month, Math.min(5, last));
      if (contribDate > now) break;

      if (i === 0 && spec.lump) {
        contributions.push({ amount_minor: paise(spec.lump), txn_date: contribDate, note: "Opening balance" });
        value += paise(spec.lump);
      }
      if (spec.sip) {
        contributions.push({ amount_minor: paise(spec.sip), txn_date: contribDate, note: null });
        value += paise(spec.sip);
      }
      if (spec.repay && i > 0) {
        // A repayment is a withdrawal: it reduces what you have drawn, which is
        // exactly the semantics the Invest detail page describes.
        const amount = Math.min(paise(spec.repay), value);
        if (amount > 0) {
          contributions.push({ amount_minor: -amount, txn_date: contribDate, note: "EMI principal" });
          value -= amount;
        }
      }

      // Liabilities do not appreciate; the outstanding balance is what it is.
      if (spec.side === "asset") {
        const rate = spec.fixedRate ?? (spec.beta ?? 1) * market[i]!;
        value = Math.round(value * (1 + rate));
      }

      const valueDate = i === spec.monthsAgo ? minDate(dayIn(month, last), now) : dayIn(month, last);
      if (valueDate <= now) valuations.push({ as_of: valueDate, value_minor: Math.max(0, value) });
    }

    return { spec, contributions, valuations };
  });
}

const minDate = (a: ISODate, b: ISODate): ISODate => (a < b ? a : b);

// ------------------------------------------------------------------------ inserts

/**
 * Cap on bind parameters per statement.
 *
 * SQLite's own limit is 32766 in anything built this decade, and expo-sqlite
 * compiles its own copy — but 999 was the historical default and there is no way
 * to check from here, so this stays under it. At nine columns that is 100 bills
 * per statement: three statements for a sample load instead of 250.
 */
const MAX_PARAMS = 900;

/**
 * The replacement for `INSERT … SELECT * FROM unnest(…)`.
 *
 * `table` and `columns` are interpolated into the statement text, which is the
 * one thing lib/db.ts says never to do — so, explicitly: both come only from the
 * literal strings below, in this file, and never from a row, a form or a setting.
 * Every *value* is still a bound parameter. Naming the columns is also what keeps
 * the budgets insert honest, for the same reason the Postgres version had to name
 * them: a positional `SELECT *` silently put the limit in `month`.
 */
async function insertMany(
  c: Client,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
): Promise<void> {
  if (!rows.length) return;
  const perRow = `(${columns.map(() => "?").join(", ")})`;
  const chunk = Math.max(1, Math.floor(MAX_PARAMS / columns.length));

  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const params: unknown[] = [];
    for (const row of slice) for (const v of row) params.push(v);
    await c.query(
      `INSERT INTO ${table} (${columns.join(", ")})
       VALUES ${slice.map(() => perRow).join(", ")}`,
      params,
    );
  }
}

async function categoryIds(c: Client): Promise<Map<string, number>> {
  const { rows } = await c.query<{ id: number; name: string }>("SELECT id, name FROM categories");
  return new Map(rows.map((x) => [x.name, x.id]));
}

async function insertBills(c: Client, rows: BillRowIn[]): Promise<void> {
  await insertMany(
    c,
    "bills",
    ["merchant", "amount_minor", "txn_date", "due_date", "status", "kind", "category_id", "notes", "recurrence"],
    rows.map((b) => [
      b.merchant, b.amount_minor, b.txn_date, b.due_date,
      b.status, b.kind, b.category_id, b.notes, b.recurrence,
    ]),
  );
}

async function insertGoal(c: Client, g: GoalBuilt): Promise<void> {
  // `lastInsertRowId` rather than `RETURNING id`: it comes back from every insert
  // on every SQLite version, and inside an exclusive transaction it cannot be the
  // id of somebody else's row.
  const res = await c.query(
    `INSERT INTO goals (name, target_minor, target_date, icon, color, notes, started_on, archived)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    [g.name, paise(g.target), g.target_date, g.icon, g.color, g.notes, g.started_on, g.archived ?? false],
  );
  const id = res.lastInsertRowId;

  await insertMany(
    c,
    "goal_contributions",
    ["goal_id", "amount_minor", "txn_date", "note"],
    g.contributions.map((x) => [id, x.amount_minor, x.txn_date, x.note]),
  );
}

async function insertHolding(c: Client, h: HoldingBuilt): Promise<void> {
  const res = await c.query(
    `INSERT INTO holdings (name, side, asset_type, institution, notes)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
    [h.spec.name, h.spec.side, h.spec.asset_type, h.spec.institution, h.spec.notes ?? null],
  );
  const id = res.lastInsertRowId;

  await insertMany(
    c,
    "holding_contributions",
    ["holding_id", "amount_minor", "txn_date", "note"],
    h.contributions.map((x) => [id, x.amount_minor, x.txn_date, x.note]),
  );

  await insertMany(
    c,
    "valuations",
    ["holding_id", "as_of", "value_minor"],
    h.valuations.map((x) => [id, x.as_of, x.value_minor]),
  );
}

/**
 * Per-category budgets, so Track's budget card has rows to draw.
 *
 * Set close to what the generated bills actually come to, and deliberately not
 * all comfortable: two of these are usually breached by the end of the month,
 * because a budget screen where everything is green teaches you nothing.
 */
const BUDGETS: readonly [string, number][] = [
  ["Rent", 32000],
  ["Groceries", 13000],
  ["Dining", 7000],
  ["Transport", 3000],
  ["Fuel", 5000],
  ["Shopping", 6000],
  ["Electricity", 4000],
  ["Subscriptions", 1000],
  ["Entertainment", 2000],
  ["Health", 3000],
];

async function insertBudgets(c: Client, cats: Map<string, number>): Promise<void> {
  const rows = BUDGETS.map(([name, rupees]) => [cats.get(name), paise(rupees)] as const).filter(
    (x): x is readonly [number, number] => x[0] !== undefined,
  );
  await insertMany(
    c,
    "budgets",
    ["category_id", "month", "limit_minor"],
    // NULL month: these are the defaults every month falls back to.
    rows.map((x) => [x[0], null, x[1]]),
  );
}

/**
 * Tables the wipe empties, children before parents.
 *
 * `ON DELETE CASCADE` would have handled most of this, but listing the order
 * explicitly costs nothing and does not depend on `PRAGMA foreign_keys` having
 * been switched on for whichever connection runs it. `categories` and `settings`
 * are absent on purpose: they are the two things a fresh install already has.
 */
const WIPE_ORDER: readonly string[] = [
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
];

/**
 * The ones with AUTOINCREMENT, so identity restarts. `detection_dismissals` and
 * `scan_drafts` have text keys and never appear in `sqlite_sequence`.
 */
const WIPE_SEQUENCES: readonly string[] = [
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
];

/**
 * Deletes everything the app owns, leaving categories and settings — the two
 * things a fresh install already has. Attachment rows go with their bills, but
 * the files behind them are removed by the caller, which is the half of this
 * that touches the filesystem.
 *
 * Three tables store a file name, so three contribute to that list: `attachments`
 * (receipts), `statement_batches` (the imported statement itself) and
 * `scan_drafts` — whose key *is* the file name of a photographed bill nobody
 * confirmed. Miss any of them and a wipe leaves files in the documents directory
 * that no row will ever name again, which is storage nothing can reclaim.
 *
 * The Postgres version was one `TRUNCATE … RESTART IDENTITY CASCADE`. SQLite has
 * no TRUNCATE, so this is a DELETE per table plus a delete from `sqlite_sequence`
 * — which is how identity is restarted, and it matters: a wiped app really does
 * look new rather than starting its next bill at id 214.
 */
export async function wipeAll(): Promise<{ files: string[] }> {
  return tx(async (c) => {
    // UNION, not UNION ALL: one name twice would be a second unlink of a file
    // that is already gone, and the caller's unlink is best-effort rather than
    // checked. `statement_batches.file_name` is nullable, hence the guard.
    const { rows } = await c.query<{ file_name: string }>(
      `SELECT file_name FROM attachments
       UNION
       SELECT file_name FROM statement_batches WHERE file_name IS NOT NULL
       UNION
       SELECT file_name FROM scan_drafts`,
    );

    for (const table of WIPE_ORDER) await c.query(`DELETE FROM ${table}`);

    // sqlite_sequence only exists once something has used AUTOINCREMENT. It
    // always will here, but checking is cheaper than an exception handler that
    // would have to guess which failures to swallow.
    const seq = await c.query<{ n: number }>(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'",
    );
    if ((seq.rows[0]?.n ?? 0) > 0) {
      await c.query(
        `DELETE FROM sqlite_sequence WHERE name IN (${WIPE_SEQUENCES.map(() => "?").join(", ")})`,
        [...WIPE_SEQUENCES],
      );
    }

    return { files: rows.map((r) => r.file_name) };
  });
}
