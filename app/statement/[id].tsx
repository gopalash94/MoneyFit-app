/**
 * The review screen — `Finance/src/app/journal/statement/[id]/page.tsx`.
 *
 * Every line the statement held, before any of it is yours. The web's header is worth
 * repeating almost whole, because the part of it that mattered most survives intact:
 * *"The rows are not read from the database, because they were never written to it. The
 * uploaded file is re-parsed here, which is sound precisely because `parseStatement` is
 * pure: the same file, categories and bills produce the same rows every time. The cost is
 * that an edit in progress does not survive a reload, which is the right trade against two
 * copies of the same facts free to disagree."*
 *
 * The first two sentences are true here as well. The third is the one thing this file
 * improves on, deliberately — see below.
 *
 * **The parse is the loader.** `useLive` runs it, which means `refreshAll()` from anywhere
 * re-reads the file and rebuilds the rows. That is what makes `unlockStatement` work with
 * no return value at all: it stores the password, calls `refreshAll()`, and this screen's
 * loader *is* the re-render the web got from a server round trip.
 *
 * **The parse failure is caught inside the loader and returned as data.** A locked PDF is
 * not a broken database, and `Screen` renders `DbUnavailable` for anything the loader
 * throws — so throwing here would replace a screen that can ask for the password with one
 * that says the database is unavailable. The loader therefore returns `{ failure }` and
 * this file renders the web's two cards from it.
 *
 * **Nothing is parsed when there is nothing left to decide.** The web's comment on the
 * already-imported branch: *"The rows are not re-parsed, because there is nothing left to
 * decide and re-reading the file would only invite a second commit."* The loader checks
 * `committed_at` and `file_name` before it reads a byte, so both of those branches cost
 * one query rather than a WebView round trip.
 *
 * **The table is a row list, and each row is an accordion.** The same substitution
 * `app/(tabs)/track.tsx` documents, with one addition it did not need: the web's row was
 * six *editable* cells, and six inputs per row times two hundred rows is not a screen. So
 * a row shows what it says — tick, merchant, amount, date, category, direction, the
 * statement's own words and its chips — and tapping it opens the six editors for that row
 * alone. One row is open at a time; the edits live in this screen, not in the row, so
 * collapsing one loses nothing.
 *
 * **The editors are written here rather than taken from `form.tsx`, and that is not
 * duplication for its own sake.** `useFormValue` — which every field in `form.tsx` is
 * built on — calls `drop(name)` when it unmounts, faithfully reproducing a browser
 * forgetting an `<input>` that was removed from the page. An accordion unmounts five
 * fields every time a row collapses, so a row edited and then closed would submit nothing
 * at all. The fix is not a flag on `form.tsx`; it is that this screen owns its values and
 * hands `commitStatement` the `FormData` the web's `<form>` would have serialised.
 *
 * **Per-row edits survive a refresh, where the web's survived nothing.** This is the one
 * place the ported screen is better than its source, and it is a consequence rather than a
 * flourish: `useLive` re-runs on every `bump()` from anywhere in the app, so "edits are
 * lost on reload" would mean losing them far more often than a browser ever did — and the
 * `unusable` message literally says *"Fix them in the table below"*, which is only true if
 * the fixes are still there. Keeping them is sound for exactly the reason the web gives for
 * re-parsing at all: the parse is pure, so line numbers are stable, so an edit keyed by
 * line number still belongs to the row it was typed into.
 *
 * **Two bars, not one sticky one.** The web's `.review-bar` is `position: sticky; bottom:
 * 0` and says why: *"The decision belongs beside the rows being decided, and the foot of a
 * 200-row table is a long way from them."* `Screen` is one `ScrollView` with no slot
 * outside it, so there is nothing to make sticky. The same bar rendered at both ends of the
 * list is the closest honest answer — the decision is one flick away from either end, and
 * both read the same live count, so they cannot disagree.
 *
 * **The counts are live.** The web's `{ready} of {rows.length} ticked` was the count of
 * *pre-ticked* rows and could not change, because there was no JavaScript to change it.
 * Here it is what is actually ticked right now, which is what the sentence already claimed
 * to be.
 *
 * **Where a commit goes.** `commitStatement` returns a `CommitResult` where the web
 * returned a URL, and each arm lands in the same place the URL did: `ok` navigates to the
 * Journal with `added` and `skipped`, which it renders as a banner; `gone` goes back to the
 * list with the same `problem` code; and the three the web put back on this screen stay
 * here, rendered by `problemText` below. `stale` needs no arm of its own — the action calls
 * `refreshAll()` whatever happens, so the loader has already re-run into the
 * already-imported card by the time the result is read.
 *
 * **No "Statements" button in the header.** The header's back arrow is that link, and it
 * knows where you came from. Same decision as `app/bill/[id]/index.tsx`.
 */

import { memo, useCallback, useMemo, useState } from "react";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import type { TextStyle, ViewStyle } from "react-native";

import { DangerButton, Field, Form, FormActions, Submit, TextField } from "@/components/form";
import { Icon } from "@/components/Icon";
import { Screen } from "@/components/Screen";
import { Banner, Card, Chip, LinkButton, NotFound, PageHead } from "@/components/ui";
import { commitStatement, deleteBatch, unlockStatement } from "@/lib/actions/statement";
import { fmtDayHeading } from "@/lib/date";
import { readUploadBase64, readUploadText } from "@/lib/files";
import { FormData } from "@/lib/form-data";
import { useLive } from "@/lib/live";
import { toInput } from "@/lib/money";
import { getCategories } from "@/lib/queries/bills";
import { listPaymentAccounts } from "@/lib/queries/holdings";
import { existingSignatures, getBatch, learnedCategories } from "@/lib/queries/statements";
import { parseStatement, statementFormat, type StatementSource } from "@/lib/statement/parse";
import { recallPassword } from "@/lib/statement/password";
import { StatementError } from "@/lib/statement/types";
import type { CandidateRow, ParsedStatement } from "@/lib/statement/types";
import { fmtBytes } from "@/lib/upload-meta";
import type { Category, Kind, PaymentAccount, StatementBatch } from "@/lib/types";
import { useStyles, useTheme, type Theme } from "@/theme/ThemeProvider";
import { font, radius, space, tnum, weight } from "@/theme/tokens";

// ================================================================== the loader

/** Why the file could not be read, and whether a password would fix it. */
type Failure = { message: string; locked: boolean };

type Loaded = {
  /** Null for both "no such batch" and "not a valid id" — one branch renders both. */
  batch: StatementBatch | null;
  categories: Category[];
  accounts: PaymentAccount[];
  /** Null when the batch is committed, its file is gone, or the parse failed. */
  parsed: ParsedStatement | null;
  failure: Failure | null;
};

const NONE: Loaded = { batch: null, categories: [], accounts: [], parsed: null, failure: null };

/**
 * Reads a stored statement the way its format needs — the same six lines as
 * `sourceFor` in `src/lib/actions/statement.ts`, which is private to that module.
 *
 * Copied rather than exported, on purpose. Making it public would put a filesystem read
 * into the importer's public surface for the benefit of one caller, and the layer it
 * really belongs to is neither: `src/lib/statement/parse.ts` takes a `StatementSource`
 * precisely so that *reading* stays outside the pure pipeline. Six lines in two places,
 * each next to the only code that uses them, beats an export that invites a third.
 */
async function sourceFor(fileName: string, mimeType: string): Promise<StatementSource> {
  const format = statementFormat(mimeType);
  return format === "pdf"
    ? { format, base64: await readUploadBase64(fileName) }
    : { format, text: await readUploadText(fileName) };
}

async function load(n: number): Promise<Loaded> {
  if (!Number.isInteger(n) || n <= 0) return NONE;

  const [batch, categories, accounts] = await Promise.all([
    getBatch(n),
    getCategories(),
    listPaymentAccounts(),
  ]);
  if (!batch) return NONE;

  // Neither branch below has rows to show, and re-reading the file for them would be
  // work at best and an invitation to a second commit at worst. See the header.
  if (batch.committed_at || !batch.file_name) {
    return { batch, categories, accounts, parsed: null, failure: null };
  }

  try {
    const [learned, existing] = await Promise.all([learnedCategories(), existingSignatures()]);
    const parsed = await parseStatement({
      source: await sourceFor(batch.file_name, batch.mime_type),
      password: await recallPassword(batch.id),
      categories,
      learned,
      existing,
    });
    return { batch, categories, accounts, parsed, failure: null };
  } catch (e) {
    // The web's two lines, unchanged — `StatementError` is the class the importer
    // throws for the failures a person can act on, and a wrong password is the only
    // one of them that has a next step on this screen.
    const message = e instanceof Error ? e.message : String(e);
    const locked = e instanceof StatementError && /password/i.test(message);
    return { batch, categories, accounts, parsed: null, failure: { message, locked } };
  }
}

// ================================================================== the screen

export default function StatementReviewScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const n = Number(typeof params.id === "string" ? params.id : "");
  // `?seen=1` on the web, set by `uploadStatement` when this exact file had already
  // been uploaded. `StatementUpload` passes it on as a route parameter.
  const seen = params.seen === "1";
  const live = useLive(() => load(n), [n]);

  function back() {
    if (router.canGoBack()) router.back();
    else router.replace("/statement");
  }

  return (
    <>
      <Stack.Screen options={{ title: "Review statement" }} />
      <Screen live={live}>
        {(data) =>
          data.batch ? (
            <Review
              batch={data.batch}
              categories={data.categories}
              accounts={data.accounts}
              parsed={data.parsed}
              failure={data.failure}
              seen={seen}
            />
          ) : (
            <NotFound what="statement" onBack={back} />
          )
        }
      </Screen>
    </>
  );
}

/** A commit's problem code, held in state where the web held it in the URL. */
type Problem = { code: "gone" | "stale" | "none" | "unusable" | "failed"; skipped: number };

/** One row's overrides. An absent key means "whatever the parse said". */
type Edit = {
  on?: boolean;
  merchant?: string;
  date?: string;
  amount?: string;
  kind?: Kind;
  /** `""` is Uncategorised, exactly as the web's `<option value="">` was. */
  category?: string;
};

/** A row's six values, after its overrides have been applied. */
type Values = {
  on: boolean;
  merchant: string;
  date: string;
  amount: string;
  kind: Kind;
  category: string;
};

function valuesFor(row: CandidateRow, e: Edit | undefined): Values {
  return {
    // Pre-ticked is everything that is both readable and not already here. The web's
    // note on the two exclusions: *"they are different in kind: a problem row *cannot*
    // be added, a duplicate *should not* be — but both stay on screen and both can be
    // overridden by one click."*
    on: e?.on ?? (!row.problem && row.duplicate_of === null),
    merchant: e?.merchant ?? row.merchant,
    date: e?.date ?? row.txn_date ?? "",
    amount: e?.amount ?? (row.amount_minor > 0 ? toInput(row.amount_minor) : ""),
    kind: e?.kind ?? row.kind,
    category: e?.category ?? (row.category_id === null ? "" : String(row.category_id)),
  };
}

function Review({
  batch,
  categories,
  accounts,
  parsed,
  failure,
  seen,
}: Loaded & { batch: StatementBatch; seen: boolean }) {
  const s = useStyles(styles);
  const router = useRouter();

  const id = batch.id;

  const [edits, setEdits] = useState<Record<number, Edit>>({});
  const [open, setOpen] = useState<number | null>(null);
  const [holdingId, setHoldingId] = useState("");
  const [problem, setProblem] = useState<Problem | null>(null);
  const [pending, setPending] = useState(false);

  const edit = useCallback((line: number, patch: Edit) => {
    setEdits((prev) => ({ ...prev, [line]: { ...prev[line], ...patch } }));
  }, []);

  const toggleOpen = useCallback((line: number) => {
    setOpen((prev) => (prev === line ? null : line));
  }, []);

  // Both sides of the ledger in one list, grouped — the web's two `<optgroup>`s. A
  // heading is skipped when its side is empty, which a browser could not do.
  const categoryOptions = useMemo<Option[]>(() => {
    const out: Option[] = [{ value: "", label: "Uncategorised" }];
    for (const [kind, heading] of [
      ["expense", "Money out"],
      ["income", "Money in"],
    ] as const) {
      const side = categories.filter((c) => c.kind === kind);
      if (side.length === 0) continue;
      out.push({ group: heading });
      for (const c of side) out.push({ value: String(c.id), label: c.name });
    }
    return out;
  }, [categories]);

  const accountOptions = useMemo<Option[]>(
    () => [
      { value: "", label: "Not recorded" },
      ...accounts.map((a) => ({ value: String(a.id), label: a.name })),
    ],
    [accounts],
  );

  const catName = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of categories) m.set(String(c.id), c.name);
    return m;
  }, [categories]);

  const head = <PageHead title={batch.original_name} sub={describe(batch)} />;

  // -------------------------------------------- already imported, once and only once
  if (batch.committed_at) {
    return (
      <>
        {head}
        <Card title="Already imported">
          <Banner tone="good" icon="check">
            {`${batch.added_count} of ${batch.row_count} rows from this statement were added on ${fmtDayHeading(
              batch.committed_at.slice(0, 10),
            )}. A statement can only be imported once, which is what stops a reload or a back button duplicating it.`}
          </Banner>

          <View style={s.cardActions}>
            <LinkButton href="/journal" label="Open the journal" icon="journal" small />
            {/* The web's was a plain submit with no confirmation step. A destructive
                tap on a phone gets one, which is what `DangerButton` is for. */}
            <DangerButton
              action={() => deleteBatch(id)}
              label="Forget this import"
              confirm={`Forget this import? The file and the record of the upload are removed. The ${batch.added_count} bills it created stay in your journal.`}
              onDone={() => router.replace("/statement")}
            />
          </View>

          <Text style={s.note}>
            {`Forgetting it removes the file and the record of the upload. The ${batch.added_count} bills it created stay where they are — they are yours now, not the importer’s.`}
          </Text>
        </Card>
      </>
    );
  }

  // ------------------------------------------------------- the file is no longer there
  if (!batch.file_name) {
    return (
      <>
        {head}
        <Card>
          <Banner tone="bad" icon="alert">
            The file behind this upload is gone, so its rows cannot be read again. Upload the
            statement afresh.
          </Banner>
        </Card>
      </>
    );
  }

  // ------------------------------------------------------------- it could not be read
  // `!parsed` is unreachable once the two branches above have returned — the loader
  // sets exactly one of `parsed` and `failure` on this path. It is in the condition
  // rather than asserted away so the rows below narrow on their own.
  if (failure || !parsed) {
    const message = failure?.message ?? "That file could not be read.";
    const locked = failure?.locked ?? false;

    return (
      <>
        {head}
        <Card title={locked ? "This PDF is locked" : "That file could not be read"}>
          <Banner tone={locked ? "warn" : "bad"} icon={locked ? "shield" : "alert"}>
            {message}
          </Banner>

          {locked ? (
            // The web's plain form posting straight to an action, and the same reason
            // it works: the password only has to reach the action, and the screen
            // re-renders with the rows if it was right. `unlockStatement` returns
            // nothing and calls `refreshAll()`; this screen's loader is the parse.
            <View style={s.unlock}>
              <Form
                action={async (_prev, fd) => {
                  await unlockStatement(id, fd);
                  return null;
                }}
              >
                <Field
                  label="Statement password"
                  name="password"
                  hint="Most bank statements are locked with your PAN and date of birth."
                >
                  <TextField
                    name="password"
                    secure
                    autoCapitalize="none"
                    placeholder="Statement password"
                  />
                </Field>
                <FormActions>
                  <Submit pendingLabel="Reading the statement…">Unlock and read it</Submit>
                </FormActions>
              </Form>
            </View>
          ) : (
            <Text style={s.note}>
              If this is a scanned statement there is no text in it to read, and no amount of
              retrying will change that — download the PDF again from netbanking, or export the
              same period as CSV.
            </Text>
          )}

          <View style={s.cardActions}>
            <DangerButton
              action={() => deleteBatch(id)}
              label="Throw this upload away"
              confirm="Throw this upload away? The file and the record of it are removed. Nothing was added to your journal."
              onDone={() => router.replace("/statement")}
            />
          </View>
        </Card>
      </>
    );
  }

  // ------------------------------------------------------------------- the review
  const rows = parsed.rows;
  const notes = parsed.notes;

  const duplicates = rows.filter((r) => r.duplicate_of !== null).length;
  const problems = rows.filter((r) => r.problem).length;
  const ticked = rows.reduce((n, r) => n + (valuesFor(r, edits[r.line]).on ? 1 : 0), 0);

  const problemSentence = problem ? problemText(problem.code, problem.skipped) : null;

  async function commit() {
    if (pending) return;
    setPending(true);
    try {
      // The web's `<form>`, serialised by hand. Keys are the web's, which is what
      // keeps every reader in `addTickedRows` the web's code too.
      const fd = new FormData();
      if (holdingId) fd.set("holding_id", holdingId);

      for (const row of rows) {
        const v = valuesFor(row, edits[row.line]);
        // An unticked row contributes nothing at all, exactly as a browser omitted an
        // unchecked box — and `addTickedRows` reads no other field of a row whose
        // `on-N` is absent, so there is nothing to lose by leaving them out.
        if (!v.on) continue;
        fd.set(`on-${row.line}`, "on");
        fd.set(`merchant-${row.line}`, v.merchant);
        fd.set(`date-${row.line}`, v.date);
        fd.set(`amount-${row.line}`, v.amount);
        fd.set(`kind-${row.line}`, v.kind);
        fd.set(`category-${row.line}`, v.category);
      }

      const res = await commitStatement(id, fd);

      if (res.ok) {
        // Where the web's `/journal?added=N&skipped=M` went. `replace`, not `push`:
        // the rows are in, so coming back here with the back gesture could only show
        // the already-imported card.
        router.replace({
          pathname: "/journal",
          params: { added: String(res.added), skipped: String(res.skipped) },
        });
        return;
      }

      if (res.problem === "gone") {
        router.replace({ pathname: "/statement", params: { problem: "gone" } });
        return;
      }

      // `stale` included: `problemText` says nothing for it, and the action's own
      // `refreshAll()` has already sent the loader into the already-imported card.
      setProblem({ code: res.problem, skipped: res.skipped });
    } finally {
      setPending(false);
    }
  }

  const bar = (
    <View style={s.bar}>
      <Text style={s.barText}>
        <Text style={s.barStrong}>{String(ticked)}</Text>
        {` of ${rows.length} ticked`}
        {duplicates > 0 ? ` · ${duplicates} already here` : ""}
        {problems > 0 ? ` · ${problems} need${problems === 1 ? "s" : ""} a fix` : ""}
      </Text>
      <CommitButton onPress={commit} pending={pending} />
    </View>
  );

  return (
    <>
      {head}

      <View style={s.stack}>
        {/*
          Why you are back on this screen. Both of these came from the URL on the web so
          that they survived a reload and said nothing when the page was reached any
          other way; here the first is state set by the commit that failed and the
          second is a route parameter, and both keep that property.
        */}
        {problemSentence ? (
          <Banner tone="bad" icon="alert">
            {problemSentence}
          </Banner>
        ) : null}

        {!problemSentence && seen ? (
          <Banner tone="info" icon="repeat">
            You have uploaded this exact file before, so it was not stored twice — these are the
            rows from that upload, still waiting.
          </Banner>
        ) : null}

        {notes.length > 0 ? (
          <Card title="How this file was read">
            <View style={s.bullets}>
              {notes.map((n, i) => (
                <Bullet key={i}>{n}</Bullet>
              ))}
            </View>
          </Card>
        ) : null}

        {duplicates > 0 ? (
          <Banner tone="warn" icon="repeat">
            {`${duplicates} row${duplicates === 1 ? "" : "s"} match a bill you already have — same date, same amount, same merchant — and ${
              duplicates === 1 ? "has" : "have"
            } been left unticked. Statement ranges overlap, so this is normal. Tick one anyway if it really was a second payment.`}
          </Banner>
        ) : null}

        {accounts.length > 0 ? (
          <Card
            title="Which account is this?"
            note="Optional, and applied to every row — a statement covers one account."
          >
            <GroupedSelect
              label="Paid from"
              value={holdingId}
              options={accountOptions}
              onChange={setHoldingId}
            />
          </Card>
        ) : null}

        {bar}

        <Card title={`${rows.length} row${rows.length === 1 ? "" : "s"}`}>
          {rows.map((row, i) => (
            <RowItem
              key={row.line}
              row={row}
              edit={edits[row.line]}
              open={open === row.line}
              first={i === 0}
              options={categoryOptions}
              catName={catName}
              onEdit={edit}
              onToggleOpen={toggleOpen}
            />
          ))}
        </Card>

        {bar}

        <Card title="Not what you wanted?">
          <Text style={s.note}>
            {`Nothing has been added yet. ${batch.original_name} is ${fmtBytes(
              batch.size_bytes,
            )} and was read on this phone; throwing it away removes the file and the record of the upload.`}
          </Text>
          <View style={s.cardActions}>
            <DangerButton
              action={() => deleteBatch(id)}
              label="Throw this upload away"
              confirm={`Throw ${batch.original_name} away? The file and the record of it are removed. Nothing has been added to your journal.`}
              onDone={() => router.replace("/statement")}
            />
          </View>
        </Card>
      </View>
    </>
  );
}

// ==================================================================== one row

/**
 * One line of the statement: what it says, and — when it is open — six editors.
 *
 * `memo` is load-bearing rather than tidiness. A two-hundred-row statement is the case
 * this screen exists for, and without it every keystroke in one row would re-render the
 * other hundred and ninety-nine. The props are all stable by construction: `onEdit` and
 * `onToggleOpen` are `useCallback`s with no dependencies, `options` and `catName` are
 * memoised on `categories`, and `edit` is a fresh object only for the row that changed.
 */
const RowItem = memo(function RowItem({
  row,
  edit,
  open,
  first,
  options,
  catName,
  onEdit,
  onToggleOpen,
}: {
  row: CandidateRow;
  edit: Edit | undefined;
  open: boolean;
  first: boolean;
  options: Option[];
  catName: Map<string, string>;
  onEdit: (line: number, patch: Edit) => void;
  onToggleOpen: (line: number) => void;
}) {
  const s = useStyles(styles);
  const v = valuesFor(row, edit);
  const income = v.kind === "income";

  const meta = [
    v.date || "no date",
    v.category ? (catName.get(v.category) ?? "Uncategorised") : "Uncategorised",
    income ? "Money in" : "Money out",
  ].join(" · ");

  return (
    <View
      style={[
        s.row,
        first ? null : s.rowSep,
        // `.review tr[data-off] { opacity: 0.55 }`, with the web's note: *"An unticked
        // row is still readable — it is evidence about what the file held, and greying
        // it out to the point of illegibility would hide exactly the rows most worth a
        // second look. Dimmed, not disabled."* Its `:hover` exception becomes this:
        // an open row is never dimmed, because opening it is how you fix it.
        !v.on && !open ? s.rowOff : null,
      ]}
    >
      <View style={s.rowTop}>
        <TickBox
          on={v.on}
          label={`Add ${v.merchant}`}
          onToggle={() => onEdit(row.line, { on: !v.on })}
        />

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={`Edit ${v.merchant}`}
          onPress={() => onToggleOpen(row.line)}
          style={({ pressed }) => [s.rowBody, pressed ? s.rowPressed : null]}
        >
          <View style={s.rowBetween}>
            <Text style={s.rowTitle} numberOfLines={1}>
              {v.merchant || "—"}
            </Text>
            <View style={s.rowEnd}>
              <Text style={income ? s.rowAmountPos : s.rowAmount}>{v.amount || "—"}</Text>
              <Icon name={open ? "chevronDown" : "edit"} size={15} stroke={2.2} />
            </View>
          </View>

          <Text style={s.rowMeta}>{meta}</Text>

          {/* The statement's own words, kept visible. The merchant above is only ever a
              reading of this line, and when the reading is wrong this is the evidence
              that shows how. */}
          <Text style={s.narration}>{row.narration || "—"}</Text>

          <View style={s.flags}>
            {row.duplicate_of !== null ? (
              <Chip tone="warn" icon="repeat" title={`Matches bill #${row.duplicate_of}`}>
                Already have this
              </Chip>
            ) : null}
            {row.problem ? (
              <Chip tone="bad" icon="alert" title={row.problem}>
                {row.problem}
              </Chip>
            ) : null}
            {row.category_source === "learned" ? (
              <Chip
                tone="good"
                icon="sparkle"
                title="Filed where you have filed this merchant before"
              >
                From your history
              </Chip>
            ) : null}
            {row.category_source === "rule" ? (
              <Chip tone="info" icon="tag" title="Recognised by name">
                Recognised
              </Chip>
            ) : null}
            {row.rail ? <Chip tone="neutral">{row.rail.toUpperCase()}</Chip> : null}
          </View>
        </Pressable>
      </View>

      {open ? (
        <View style={s.editor}>
          <CellField
            label="Merchant"
            value={v.merchant}
            onChangeText={(x) => onEdit(row.line, { merchant: x })}
          />

          <View style={s.editorPair}>
            <CellField
              label="Date"
              value={v.date}
              placeholder="YYYY-MM-DD"
              keyboard="numbers-and-punctuation"
              onChangeText={(x) => onEdit(row.line, { date: x })}
            />
            <CellField
              label="Amount"
              value={v.amount}
              keyboard="decimal-pad"
              numeric
              onChangeText={(x) => onEdit(row.line, { amount: x })}
            />
          </View>

          <View style={s.editorField}>
            <Text style={s.editorLabel}>Category</Text>
            <GroupedSelect
              label="Category"
              value={v.category}
              options={options}
              onChange={(x) => onEdit(row.line, { category: x })}
            />
          </View>

          <View style={s.editorField}>
            <Text style={s.editorLabel}>Direction</Text>
            <Direction value={v.kind} onChange={(x) => onEdit(row.line, { kind: x })} />
          </View>
        </View>
      ) : null}
    </View>
  );
});

// ============================================================= the local editors

/** `<input type="checkbox">`, inside a tap target the size of a thumb. */
function TickBox({
  on,
  label,
  onToggle,
}: {
  on: boolean;
  label: string;
  onToggle: () => void;
}) {
  const t = useTheme();
  const s = useStyles(styles);
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
      accessibilityLabel={label}
      onPress={onToggle}
      // `hitSlop` rather than padding: the box has to line up with the merchant beside
      // it, and a 44px padded box would push the whole row down.
      hitSlop={12}
      style={({ pressed }) => [s.tickWrap, pressed ? s.pressed : null]}
    >
      <View
        style={[
          s.tick,
          on ? { backgroundColor: t.c.blue, borderColor: t.c.blue } : { borderColor: t.c.border },
        ]}
      >
        {on ? <Icon name="check" size={14} stroke={2.8} color={t.c.onAccent} /> : null}
      </View>
    </Pressable>
  );
}

/**
 * One editable cell: `.review .input` at 13px, with its column heading as a label.
 *
 * Not `TextField`. That one registers its value with the enclosing `<Form>` through
 * `useFormValue`, which drops the value when it unmounts — and an accordion unmounts
 * these five every time a row closes. See the file header.
 */
function CellField({
  label,
  value,
  placeholder,
  keyboard,
  numeric = false,
  onChangeText,
}: {
  label: string;
  value: string;
  placeholder?: string;
  keyboard?: "decimal-pad" | "numbers-and-punctuation";
  /** Tabular figures, for the one cell that is only ever figures. */
  numeric?: boolean;
  onChangeText: (v: string) => void;
}) {
  const t = useTheme();
  const s = useStyles(styles);
  const [focused, setFocused] = useState(false);

  return (
    <View style={s.editorField}>
      <Text style={s.editorLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={t.c.text3}
        keyboardType={keyboard ?? "default"}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={200}
        accessibilityLabel={label}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[
          s.cellInput,
          numeric ? s.cellInputNum : null,
          focused ? { borderColor: t.c.blue } : null,
        ]}
      />
    </View>
  );
}

/** A row of the sheet: a choosable option, or a heading over the ones below it. */
type Option = { value: string; label: string } | { group: string };

/**
 * `<select>` with `<optgroup>` headings — which `form.tsx`'s `Select` cannot render,
 * its `options` being a flat `{ value, label }[]`.
 *
 * The geometry, the scrim and the sheet are all `Select`'s, so a category picker here
 * looks and behaves exactly like the account picker on a bill form. What it does not
 * do is register with a `<Form>`: the caller owns the value, which is the whole reason
 * this screen has its own editors at all.
 *
 * Used twice — the grouped category list on a row, and the ungrouped "Paid from" above
 * the table. One component, because the second is the first with no headings in it.
 */
function GroupedSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Option[];
  onChange: (v: string) => void;
}) {
  const t = useTheme();
  const s = useStyles(styles);
  const [open, setOpen] = useState(false);

  const current = options.find((o) => !("group" in o) && o.value === value);
  const shown = current && !("group" in current) ? current.label : value;

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [s.cellInput, s.selectRow, pressed ? s.pressed : null]}
      >
        <Text style={s.selectText} numberOfLines={1}>
          {shown}
        </Text>
        <Icon name="chevronDown" size={15} stroke={2.2} color={t.c.text3} />
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={s.scrim} onPress={() => setOpen(false)}>
          <Pressable style={s.sheet} onPress={() => {}}>
            <Text style={s.sheetTitle}>{label}</Text>
            <ScrollView>
              {options.map((o, i) =>
                "group" in o ? (
                  <Text key={`g-${i}`} style={s.sheetGroup}>
                    {o.group}
                  </Text>
                ) : (
                  <Pressable
                    key={o.value}
                    accessibilityRole="button"
                    accessibilityState={{ selected: o.value === value }}
                    onPress={() => {
                      onChange(o.value);
                      setOpen(false);
                    }}
                    style={({ pressed }) => [s.sheetRow, pressed ? s.sheetRowPressed : null]}
                  >
                    <Text
                      style={[s.sheetRowText, o.value === value ? { color: t.c.blue } : null]}
                    >
                      {o.label}
                    </Text>
                    {o.value === value ? (
                      <Icon name="check" size={17} stroke={2.4} color={t.c.blue} />
                    ) : null}
                  </Pressable>
                ),
              )}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

/**
 * The web's two-option Direction `<select>`, as a toggle.
 *
 * A sheet for a choice between two things is a tap too many, and `form.tsx`'s
 * `Segmented` — which is exactly this control — registers with a form. So the geometry
 * is `Segmented`'s, scaled down to sit inside a row.
 */
function Direction({ value, onChange }: { value: Kind; onChange: (v: Kind) => void }) {
  const t = useTheme();
  const s = useStyles(styles);

  return (
    <View style={s.seg} accessibilityRole="radiogroup" accessibilityLabel="Direction">
      {(
        [
          ["expense", "Out"],
          ["income", "In"],
        ] as const
      ).map(([k, label], i) => {
        const active = k === value;
        return (
          <Pressable
            key={k}
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(k)}
            style={({ pressed }) => [
              s.segItem,
              i > 0 ? s.segDivider : null,
              active ? { backgroundColor: t.c.blueDim } : null,
              pressed && !active ? s.pressed : null,
            ]}
          >
            <Text style={[s.segText, { color: active ? t.c.blue : t.c.text2 }]}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * The commit button — `Submit`'s geometry, without `Submit`'s form.
 *
 * `PendingButton` holds its own pending state and would have done, except that it
 * renders at `btnSm` and takes no `pendingLabel`. Both matter here: this is the button
 * the whole screen is for, and pressing it re-parses the file — a WebView round trip for
 * a PDF — before a single row is written, so a bare spinner would read as a hang. That is
 * the same reasoning that gave `Submit` its `pendingLabel` for `app/bill/scan.tsx`.
 */
function CommitButton({ onPress, pending }: { onPress: () => void; pending: boolean }) {
  const t = useTheme();
  const s = useStyles(styles);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: pending }}
      disabled={pending}
      onPress={onPress}
      style={({ pressed }) => [
        s.btn,
        { backgroundColor: t.c.blue },
        pending ? s.disabled : null,
        pressed ? s.pressed : null,
      ]}
    >
      {pending ? (
        <ActivityIndicator size="small" color={t.c.onAccent} />
      ) : (
        <Icon name="check" size={17} stroke={2.2} color={t.c.onAccent} />
      )}
      <Text style={[s.btnLabel, { color: t.c.onAccent }]}>
        {pending ? "Adding the rows…" : "Add the ticked rows"}
      </Text>
    </Pressable>
  );
}

/** One `<li>` of `.bullets` — the same shape `app/statement/index.tsx` uses. */
function Bullet({ children }: { children: React.ReactNode }) {
  const s = useStyles(styles);
  return (
    <View style={s.bullet}>
      <Text style={s.bulletMark}>•</Text>
      <Text style={s.bulletText}>{children}</Text>
    </View>
  );
}

// =================================================================== the words

/**
 * Turns a commit's problem code into a sentence.
 *
 * The action sends a code, not a message, so that what this screen says is written here
 * and cannot be chosen by whoever wrote the link. An unknown code says nothing at all.
 *
 * Two differences from the web's version, both bookkeeping: the parameter is the
 * `CommitResult` union rather than `string | undefined`, because the code now arrives as a
 * return value and cannot be anything else; and `gone` and `stale` fall through to `null`
 * on purpose — the first is rendered by the list screen it navigates to, and the second
 * has already been answered by the loader re-running into the already-imported card.
 */
function problemText(code: Problem["code"], skipped: number): string | null {
  switch (code) {
    case "none":
      return "Nothing was added, because no rows were ticked. Tick the ones you want and submit again.";
    case "unusable":
      return skipped > 0
        ? `None of the ${skipped} row${
            skipped === 1 ? "" : "s"
          } you ticked could be added — each one needs a date, an amount above zero and a name. Fix them in the table below, or untick them.`
        : "None of the rows you ticked could be added — each one needs a date, an amount above zero and a name.";
    case "failed":
      return "Something went wrong while adding those rows, so nothing was added. Nothing is half-imported — the whole batch goes in together or not at all.";
    default:
      return null;
  }
}

function describe(b: StatementBatch): string {
  const parts = [`${b.row_count} row${b.row_count === 1 ? "" : "s"}`];
  if (b.page_count > 0) parts.push(`${b.page_count} page${b.page_count === 1 ? "" : "s"}`);
  parts.push(fmtBytes(b.size_bytes));
  return `${parts.join(" · ")} · nothing is added until you say so`;
}

// ==================================================================== styles

const styles = (t: Theme) => ({
  stack: { gap: space.gap } as ViewStyle,

  /** `<p className="small muted">` under a card's own content. */
  note: { ...font.small13, color: t.c.text2, lineHeight: 20, marginTop: 12 } as TextStyle,
  /** `.row` — a line of buttons that wraps rather than squeezing. */
  cardActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.gapSm,
    marginTop: space.gap,
  } as ViewStyle,
  unlock: { marginTop: space.gapSm } as ViewStyle,

  // ------------------------------------------------------------ the review bar
  bar: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: t.c.borderSoft,
    borderRadius: radius.lg,
    backgroundColor: t.c.surface,
    ...t.shadow2,
  } as ViewStyle,
  barText: { ...font.small, ...tnum, color: t.c.text2, flexShrink: 1 } as TextStyle,
  barStrong: { color: t.c.text, fontWeight: weight.medium } as TextStyle,

  // -------------------------------------------------------------- the row list
  // `app/(tabs)/track.tsx`'s geometry, so every list of rows in the app matches.
  row: { paddingVertical: 12, paddingHorizontal: 4, borderRadius: radius.sm } as ViewStyle,
  rowSep: { borderTopWidth: 1, borderTopColor: t.c.borderSoft } as ViewStyle,
  rowOff: { opacity: 0.55 } as ViewStyle,
  rowTop: { flexDirection: "row", alignItems: "flex-start", gap: 10 } as ViewStyle,
  rowBody: { flex: 1, minWidth: 0, gap: 4, borderRadius: radius.sm } as ViewStyle,
  rowPressed: { backgroundColor: t.c.surface2 } as ViewStyle,
  rowBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  } as ViewStyle,
  rowEnd: { flexDirection: "row", alignItems: "center", gap: 8 } as ViewStyle,
  rowTitle: { ...font.entryTitle, color: t.c.text, flexShrink: 1 } as TextStyle,
  rowAmount: { ...font.entryAmount, ...tnum, color: t.c.text } as TextStyle,
  rowAmountPos: { ...font.entryAmount, ...tnum, color: t.c.green } as TextStyle,
  rowMeta: { ...font.small, ...tnum, color: t.c.text3 } as TextStyle,
  /** `.small.dim.wrap-anywhere` — the statement's own line. */
  narration: { ...font.small, color: t.c.text3, lineHeight: 17 } as TextStyle,
  /** `.review-flags` — 4px apart, wrapping, 5px below the line above. */
  flags: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 1 } as ViewStyle,

  /** The six cells, revealed under the row they belong to. */
  editor: {
    gap: space.gapSm,
    marginTop: 12,
    marginLeft: 32,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: t.c.borderSoft,
  } as ViewStyle,
  editorPair: { flexDirection: "row", gap: space.gapSm } as ViewStyle,
  editorField: { flex: 1, gap: 5 } as ViewStyle,
  editorLabel: { ...font.label, color: t.c.text3 } as TextStyle,

  // ------------------------------------------------------------- the checkbox
  /** `margin-top: 8px` — the box lines up with the merchant, not with the row. */
  tickWrap: { paddingTop: 2 } as ViewStyle,
  tick: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  } as ViewStyle,

  // ------------------------------------------------------- .review .input / .select
  /** `.input` at `.review`'s smaller padding and 13px type. */
  cellInput: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: t.c.border,
    borderRadius: radius.sm,
    backgroundColor: t.c.surface,
    color: t.c.text,
    ...font.small13,
  } as TextStyle,
  cellInputNum: { ...tnum, textAlign: "right" } as TextStyle,
  selectRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  } as ViewStyle,
  selectText: { ...font.small13, color: t.c.text, flexShrink: 1 } as TextStyle,

  // `Select`'s sheet, verbatim, plus the heading row it has no need for.
  scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.42)", justifyContent: "flex-end" } as ViewStyle,
  sheet: {
    backgroundColor: t.c.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingTop: 20,
    paddingBottom: 28,
    paddingHorizontal: 8,
    maxHeight: "70%",
    ...t.shadow2,
  } as ViewStyle,
  sheetTitle: {
    ...font.cardTitle,
    color: t.c.text,
    paddingHorizontal: 16,
    marginBottom: 10,
  } as TextStyle,
  /** `<optgroup label>` — a heading, not a row, so it is not pressable. */
  sheetGroup: {
    ...font.eyebrow,
    color: t.c.text3,
    textTransform: "uppercase",
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 4,
  } as TextStyle,
  sheetRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: radius.sm,
  } as ViewStyle,
  sheetRowPressed: { backgroundColor: t.c.surface2 } as ViewStyle,
  sheetRowText: { ...font.body, color: t.c.text } as TextStyle,

  // ------------------------------------------------------------ .seg, scaled down
  seg: {
    flexDirection: "row",
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: t.c.border,
    borderRadius: radius.pill,
    overflow: "hidden",
  } as ViewStyle,
  segItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 64,
    paddingVertical: 8,
    paddingHorizontal: 14,
  } as ViewStyle,
  segDivider: { borderLeftWidth: 1, borderLeftColor: t.c.border } as ViewStyle,
  segText: { ...font.buttonSm } as TextStyle,

  // ---------------------------------------------------------------- .btn, again
  btn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "flex-start",
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: "transparent",
  } as ViewStyle,
  btnLabel: { ...font.button } as TextStyle,
  pressed: { opacity: 0.65 } as ViewStyle,
  disabled: { opacity: 0.5 } as ViewStyle,

  // ------------------------------------------------------------------ .bullets
  bullets: { gap: 9 } as ViewStyle,
  bullet: { flexDirection: "row", gap: 8 } as ViewStyle,
  bulletMark: { ...font.small13, color: t.c.text3, width: 10, lineHeight: 20 } as TextStyle,
  bulletText: { ...font.small13, color: t.c.text2, flex: 1, lineHeight: 20 } as TextStyle,
});
