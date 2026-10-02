/**
 * Journal — `Finance/src/app/journal/page.tsx`.
 *
 * Every bill, grouped by the day it belongs to, with the month switcher, the status
 * tabs, the filter row and a per-day total. The six reads of the web page's query
 * string become six reads of the route's params, and everything downstream of them —
 * the `/^\d{4}-\d{2}$/` month guard, the `Number(sp.cat) > 0` test, the "a search is a
 * search of everything" rule that drops the month scope — is the web's code unchanged.
 *
 * **The filter row is a `<Form>`.** On the web it was a `<form method="get">`: the
 * browser turned the fields into a query string, navigated, and the server re-read. The
 * `<Form>` here does the same thing in two fewer steps — its action reads the same
 * `FormData` with the same `optStr`/`optInt`/`pick` helpers and hands the result to
 * `setParams`, which is the navigation. It returns `null` because there is nothing that
 * can go wrong; `Form` treats that as success and there is no banner to show.
 *
 * Three consequences worth naming:
 *
 * **The two hidden inputs are gone.** `<input type="hidden" name="month">` and its
 * `status` twin existed because a GET form submits *only* its own fields, so anything
 * not in the form was lost on Apply. `setParams` merges into the params already on the
 * route, so the month and the status tab survive without being carried.
 *
 * **Clear clears the filter row, not the screen.** The web's Clear was `href="/journal"`
 * — a bare URL, which also reset the month and the status tab. Here those two have their
 * own visible controls directly above, and a button that silently reaches up and resets
 * them reads as a bug rather than a feature. So Clear resets the three fields it sits
 * next to, and `Filtered` below still counts `status` for the empty-state copy, exactly
 * as the web's did.
 *
 * **The form is keyed on the applied filters.** `TextField` and `Select` are
 * uncontrolled — they take a `defaultValue` and then own their value, which is what
 * makes typing cheap. That also means neither notices when the params change underneath
 * it, so Clear would leave the old text sitting in a box that no longer filters
 * anything. Keying the form on the values it was built from remounts the fields when,
 * and only when, the applied filters actually change.
 *
 * **Layout.** `.toolbar` was one horizontal row with `flex-wrap: wrap` — at 360dp it
 * would have wrapped to three lines anyway, so it is three lines on purpose: the search
 * box, the two selects side by side, then the buttons. The selects keep the web's trick
 * of labelling themselves through their "all" option ("All categories", "Money in and
 * out") rather than growing a label above each one.
 *
 * **Scan sits to the left of Add**, and is the quieter of the two, which is the web's own
 * ordering and its own reasoning: scanning is the faster path when you have the file to
 * hand, and the wrong one when you do not. `/bill/scan` explains itself when there is no
 * API key, so the button needs no condition here.
 *
 * **Where a statement import lands.** `commitStatement` sends you here with `added` and
 * `skipped`, exactly as the web's `/journal?added=5&skipped=1` did, and the banner below
 * is the web's. One difference, and it is forced: a browser's query string is replaced by
 * the next navigation, but a route's params are *merged* by `setParams` — so left alone,
 * `added` would survive a month change and the banner would sit there congratulating you
 * on an import you did two screens ago. The counts are therefore read once into state and
 * cleared off the route immediately. The effect is the web's: the message survives a
 * refresh of this screen, and says nothing when the screen is reached any other way.
 */

import { useEffect, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import type { TextStyle, ViewStyle } from "react-native";

import { MonthNav, Tabs, useSetParams } from "@/components/filters";
import { ActionButton, Form, FormActions, Select, Submit, TextField } from "@/components/form";
import { catIcon } from "@/components/Icon";
import { Screen } from "@/components/Screen";
import { Banner, Card, Chip, EmptyState, IconTile, LinkButton, PageHead } from "@/components/ui";
import { optInt, optStr, pick } from "@/lib/actions/shared";
import { fmtDayHeading, fmtDue, fmtMonth, thisMonth, type ISODate } from "@/lib/date";
import { useLive } from "@/lib/live";
import { fmtWhole } from "@/lib/money";
import { getCategories, listBills } from "@/lib/queries/bills";
import { listPaymentAccounts } from "@/lib/queries/holdings";
import { getSettings } from "@/lib/queries/settings";
import { RECURRENCE_LABEL } from "@/lib/recurrence";
import type { BillRow, BillStatus, Category, PaymentAccount } from "@/lib/types";
import { useStyles, type Theme } from "@/theme/ThemeProvider";
import { font, radius, space, tnum, weight } from "@/theme/tokens";

/** `pick`'s first entry is its fallback, so the unset value has to lead. */
const KINDS = ["", "expense", "income"] as const;

const KIND_OPTIONS = [
  { value: "", label: "Money in and out" },
  { value: "expense", label: "Expenses only" },
  { value: "income", label: "Income only" },
];

type Filters = {
  month: string;
  status: BillStatus | null;
  kind: "expense" | "income" | null;
  catId: number | null;
  accId: number | null;
  q: string;
};

type Loaded = { bills: BillRow[]; categories: Category[]; accounts: PaymentAccount[] };

async function load(f: Filters): Promise<Loaded> {
  const settings = await getSettings();
  const [bills, categories, accounts] = await Promise.all([
    listBills({
      // A search is a search of everything — scoping it to one month is the single
      // most annoying way to build a search box.
      month: f.q ? null : f.month,
      monthStartDay: settings.month_start_day,
      search: f.q,
      categoryId: f.catId,
      kind: f.kind,
      status: f.status,
      holdingId: f.accId,
      limit: 400,
    }),
    getCategories(),
    listPaymentAccounts(),
  ]);
  return { bills, categories, accounts };
}

export default function JournalScreen() {
  const setParams = useSetParams();
  const sp = useLocalSearchParams();

  const month = str(sp.month);
  const monthKey = /^\d{4}-\d{2}$/.test(month) ? month : thisMonth();
  const rawStatus = str(sp.status);
  const status: BillStatus | null =
    rawStatus === "paid" || rawStatus === "upcoming" ? rawStatus : null;
  const rawKind = str(sp.kind);
  const kind = rawKind === "income" || rawKind === "expense" ? rawKind : null;
  const catId = Number(str(sp.cat)) > 0 ? Number(str(sp.cat)) : null;
  const accId = Number(str(sp.acc)) > 0 ? Number(str(sp.acc)) : null;
  const q = str(sp.q).trim();

  const searching = q.length > 0;

  // Where a statement import lands — see the header. The counts are read off the route
  // into state and then cleared from it, which is a one-way door: `landed` is set by the
  // import that caused it and by nothing else afterwards.
  //
  // An effect rather than a `useState` initialiser, because this is a tab: the screen is
  // already mounted when `commitStatement` navigates here, so an initialiser would have
  // run long before the counts existed. The guard is `rawAdded <= 0`, and clearing the
  // params makes it true, so this runs exactly once per import.
  //
  // `setParams` is deliberately not a dependency: `useSetParams` returns a fresh closure
  // on every render, so listing it would mean "run every render" — which the guard would
  // survive, but which says the wrong thing about when this is meant to fire.
  const [landed, setLanded] = useState<{ added: number; skipped: number } | null>(null);
  const rawAdded = Math.max(0, Number(str(sp.added)) || 0);
  const rawSkipped = Math.max(0, Number(str(sp.skipped)) || 0);
  useEffect(() => {
    if (rawAdded <= 0) return;
    setLanded({ added: rawAdded, skipped: rawSkipped });
    setParams({ added: "", skipped: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawAdded, rawSkipped]);

  // Six primitives, always six — `useLive` re-runs its effect on this list and
  // React requires a stable length. `added` and `skipped` are not among them: they
  // change what is *said* above the list, never which rows are in it.
  const live = useLive(
    () => load({ month: monthKey, status, kind, catId, accId, q }),
    [monthKey, status ?? "", kind ?? "", catId ?? 0, accId ?? 0, q],
  );

  const s = useStyles(styles);

  return (
    <Screen live={live}>
      {({ bills, categories, accounts }) => {
        const groups = groupByDay(bills);
        const expense = sum(bills, "expense");
        const income = sum(bills, "income");
        // `status` counts here, as it did on the web: with the Upcoming tab on and
        // nothing upcoming, "nothing matches those filters" is the true sentence.
        const filtered = Boolean(q || catId || kind || status || accId);
        // The Clear button owns four of those five, so it appears for four of them.
        const rowFiltered = Boolean(q || catId || kind || accId);

        return (
          <>
            <PageHead
              title="Journal"
              sub={
                searching
                  ? `${bills.length} result${bills.length === 1 ? "" : "s"} for “${q}” across all months`
                  : `${bills.length} entr${bills.length === 1 ? "y" : "ies"} in ${fmtMonth(monthKey)} · ${fmtWhole(expense)} out${income ? ` · ${fmtWhole(income)} in` : ""}`
              }
            >
              {searching ? null : <MonthNav month={monthKey} />}
              {/* The web's order was MonthNav → Import → Add, and Import keeps its place
                  in it: it goes before Scan rather than between Scan and Add, so that
                  "Scan sits to the left of Add" above stays true of the row as built.
                  Four controls fit because `pageHeadRow` wraps — at 360dp this becomes
                  two lines rather than three squeezed buttons. */}
              <LinkButton
                href="/statement"
                label="Import a statement"
                icon="upload"
                variant="outline"
                small
              />
              <LinkButton href="/bill/scan" label="Scan" icon="sparkle" variant="outline" small />
              <LinkButton href="/bill/new" label="Add bill" icon="plus" small />
            </PageHead>

            {/* The web's import banner, unchanged in wording. `Banner` puts a single
                `<Text>` around its children, so the `<strong>` is a nested one. */}
            {landed ? (
              <View style={s.landed}>
                <Banner tone="good" icon="check">
                  <Text style={s.landedStrong}>
                    {`${landed.added} ${landed.added === 1 ? "row" : "rows"} added from your statement.`}
                  </Text>
                  {" "}
                  {landed.skipped > 0
                    ? `${landed.skipped} ticked row${
                        landed.skipped === 1 ? "" : "s"
                      } could not be added — each needs a date, an amount and a name.`
                    : "Every row you ticked went in."}
                </Banner>
              </View>
            ) : null}

            <View style={s.tabsWrap}>
              <Tabs
                name="status"
                active={status ?? ""}
                tabs={[
                  { value: "", label: "All" },
                  { value: "paid", label: "Paid" },
                  { value: "upcoming", label: "Upcoming" },
                ]}
              />
            </View>

            <Form
              key={`${q}|${catId ?? ""}|${kind ?? ""}|${accId ?? ""}`}
              style={s.toolbar}
              action={async (_prev, fd) => {
                const nextCat = optInt(fd, "cat");
                const nextKind = pick(fd, "kind", KINDS);
                const nextAcc = optInt(fd, "acc");
                setParams({
                  q: optStr(fd, "q", 120) ?? undefined,
                  cat: nextCat ? String(nextCat) : undefined,
                  kind: nextKind || undefined,
                  // Undefined when the picker is not on screen at all, which is the
                  // same thing it means when the picker is on screen set to "All".
                  acc: nextAcc ? String(nextAcc) : undefined,
                });
                return null;
              }}
            >
              <TextField
                name="q"
                defaultValue={q}
                placeholder="Search merchant or notes…"
                maxLength={120}
                autoCapitalize="none"
              />

              <View style={s.toolbarRow}>
                <View style={s.toolbarCell}>
                  <Select
                    name="cat"
                    label="Category"
                    defaultValue={catId ? String(catId) : ""}
                    options={[
                      { value: "", label: "All categories" },
                      ...categories.map((c) => ({ value: String(c.id), label: c.name })),
                    ]}
                  />
                </View>
                <View style={s.toolbarCell}>
                  <Select name="kind" label="Direction" defaultValue={kind ?? ""} options={KIND_OPTIONS} />
                </View>
              </View>

              {/* Only once there is something to filter by. An import stamps its
                  account onto every bill it creates, which is what makes this worth
                  having — by hand the field is usually left blank.

                  Its own row rather than a third cell beside the other two: three
                  selects across 360dp would truncate all three to nothing, and an
                  account name is the longest of the three. */}
              {accounts.length > 0 ? (
                <Select
                  name="acc"
                  label="Account"
                  defaultValue={accId ? String(accId) : ""}
                  options={[
                    { value: "", label: "All accounts" },
                    ...accounts.map((a) => ({ value: String(a.id), label: a.name })),
                  ]}
                />
              ) : null}

              <FormActions>
                {rowFiltered ? (
                  <ActionButton
                    variant="ghost"
                    action={async () =>
                      setParams({ q: undefined, cat: undefined, kind: undefined, acc: undefined })
                    }
                  >
                    Clear
                  </ActionButton>
                ) : null}
                {/* `Submit` says "Saving…" while it runs. It runs for one frame — the
                    action's only await is the one wrapping `setParams`. */}
                <Submit icon="filter">Apply</Submit>
              </FormActions>
            </Form>

            {bills.length === 0 ? (
              <Card>
                <EmptyState
                  icon="journal"
                  title={filtered ? "Nothing matches those filters" : `No entries in ${fmtMonth(monthKey)}`}
                  body={
                    filtered
                      ? "Try clearing the search or widening the category and kind filters."
                      : "Every bill you log lands here, grouped by day — the way Fit lists your workouts."
                  }
                  cta={filtered ? undefined : { href: "/bill/new", label: "Add a bill" }}
                />
              </Card>
            ) : (
              <Card pad={false}>
                {/* The card carries no padding so each entry's own 14px reaches the
                    edge, the way `.entry` did inside `.card[data-pad=false]`. The
                    vertical breathing room a 24px corner radius needs is here. */}
                <View style={s.dayList}>
                  {groups.map(([day, rows], i) => (
                    <View key={day} style={i === 0 ? undefined : s.dayGroup}>
                      <View style={s.dayHead}>
                        <Text style={s.dayName}>{fmtDayHeading(day)}</Text>
                        <Text style={s.dayTotal}>{dayTotal(rows)}</Text>
                      </View>
                      {rows.map((b) => (
                        <Entry key={b.id} bill={b} />
                      ))}
                    </View>
                  ))}
                </View>
              </Card>
            )}
          </>
        );
      }}
    </Screen>
  );
}

// ------------------------------------------------------------------ the pieces

/**
 * One bill. `.entry` was a three-column grid — tile, text, amount — and stays one
 * row here, with `minWidth: 0` on the middle cell so a long merchant name truncates
 * instead of pushing the amount off the screen.
 *
 * `router.push` rather than a `<Link>`: the whole row is the tap target.
 */
function Entry({ bill: b }: { bill: BillRow }) {
  const s = useStyles(styles);
  const router = useRouter();

  const due = b.status === "upcoming" && b.due_date ? fmtDue(b.due_date) : null;
  const income = b.kind === "income";

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${b.merchant}, ${fmtWhole(b.amount_minor)}`}
      onPress={() => router.push({ pathname: "/bill/[id]", params: { id: String(b.id) } })}
      style={({ pressed }) => [s.entry, pressed ? s.entryPressed : null]}
    >
      <IconTile color={b.category_color ?? "#80868B"} icon={catIcon(b.category_icon)} />

      <View style={s.entryMain}>
        <Text style={s.entryTitle} numberOfLines={1}>
          {b.merchant}
        </Text>
        <View style={s.entryMeta}>
          <Text style={s.entryMetaText}>{b.category_name ?? "Uncategorised"}</Text>
          {due ? (
            <Chip tone={due.overdue ? "bad" : due.soon ? "warn" : "info"}>{due.label}</Chip>
          ) : null}
          {b.status === "upcoming" && !due ? <Chip tone="info">upcoming</Chip> : null}
          {b.recurrence !== "none" ? (
            <Chip icon="repeat" title="Recurring">
              {RECURRENCE_LABEL[b.recurrence]}
            </Chip>
          ) : null}
          {b.attachment_count > 0 ? (
            <Chip icon="attach" title={`${b.attachment_count} attachment(s)`}>
              {b.attachment_count}
            </Chip>
          ) : null}
          {b.source === "ai" ? (
            <Chip icon="sparkle" title="Extracted from an upload by Gemini">
              AI
            </Chip>
          ) : null}
        </View>
      </View>

      <Text style={income ? s.entryAmountPos : s.entryAmount}>
        {(income ? "+" : "") + fmtWhole(b.amount_minor)}
      </Text>
    </Pressable>
  );
}

// ----------------------------------------------------------------- the helpers

/** A param can legitimately arrive twice; the first spelling of it wins. */
function str(v: string | string[] | undefined): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return "";
}

function sum(bills: BillRow[], kind: "expense" | "income"): number {
  return bills.filter((b) => b.kind === kind).reduce((s, b) => s + b.amount_minor, 0);
}

/**
 * Groups into day buckets on the date the entry belongs to — an upcoming bill
 * sits on its due date, a paid one on the date it was paid. `listBills` already
 * sorts by that same expression, so insertion order is the display order.
 */
function groupByDay(bills: BillRow[]): [ISODate, BillRow[]][] {
  const map = new Map<ISODate, BillRow[]>();
  for (const b of bills) {
    const day = b.due_date && b.status === "upcoming" ? b.due_date : b.txn_date;
    const list = map.get(day);
    if (list) list.push(b);
    else map.set(day, [b]);
  }
  return [...map.entries()];
}

function dayTotal(rows: BillRow[]): string {
  const out = sum(rows, "expense");
  const inn = sum(rows, "income");
  if (out && inn) return `${fmtWhole(out)} out · ${fmtWhole(inn)} in`;
  if (inn) return `${fmtWhole(inn)} in`;
  return fmtWhole(out);
}

const styles = (t: Theme) => ({
  tabsWrap: { marginBottom: space.gap } as ViewStyle,

  /** The web's `<div style={{ marginBottom: 20 }}>` around the import banner. */
  landed: { marginBottom: 20 } as ViewStyle,
  /** Its `<strong>`. Colour is inherited from the banner; only the weight is ours. */
  landedStrong: { fontWeight: weight.semi } as TextStyle,

  // `.toolbar` — `gap: 10px; margin-bottom: 18px`, stacked rather than wrapped.
  toolbar: { gap: space.gapSm, marginBottom: 18 } as ViewStyle,
  toolbarRow: { flexDirection: "row", gap: space.gapSm } as ViewStyle,
  toolbarCell: { flex: 1, minWidth: 0 } as ViewStyle,

  // ------------------------------------------------------------- the day list
  dayList: { paddingVertical: 12 } as ViewStyle,
  // `.day-group + .day-group { margin-top: 26px }`.
  dayGroup: { marginTop: 26 } as ViewStyle,
  // `.day-head` — `padding: 0 4px 10px`, baseline-aligned, total pushed right.
  dayHead: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: space.gapSm,
    paddingHorizontal: 4,
    paddingBottom: 10,
  } as ViewStyle,
  dayName: { ...font.small13, fontWeight: weight.medium, color: t.c.text2 } as TextStyle,
  dayTotal: { ...font.small13, ...tnum, marginLeft: "auto", color: t.c.text3 } as TextStyle,

  // ---------------------------------------------------------------- the entry
  entry: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: radius.sm,
  } as ViewStyle,
  // `.entry:hover { background: var(--surface-2) }` — there is no hover, so it is
  // the press state instead.
  entryPressed: { backgroundColor: t.c.surface2 } as ViewStyle,
  entryMain: { flex: 1, minWidth: 0 } as ViewStyle,
  entryTitle: { ...font.entryTitle, color: t.c.text } as TextStyle,
  entryMeta: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 3,
  } as ViewStyle,
  entryMetaText: { ...font.small, color: t.c.text3 } as TextStyle,
  entryAmount: { ...font.entryAmount, ...tnum, textAlign: "right", color: t.c.text } as TextStyle,
  entryAmountPos: { ...font.entryAmount, ...tnum, textAlign: "right", color: t.c.green } as TextStyle,
});
