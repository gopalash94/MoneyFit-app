/**
 * Ask — `Finance/src/app/ask/page.tsx` plus `Finance/src/components/AskForm.tsx`.
 *
 * The escape hatch. Every other screen answers a question somebody decided in advance was
 * worth a card; this one exists for the rest — the question you have once, about a category
 * nobody built a chart for, over a range nobody put in a dropdown. The answer comes out of
 * SQLite, not out of the model: Claude only writes the query, and the query is shown.
 *
 * **Two web files, one screen**, for the reason `bill/scan.tsx` gives: the web split was
 * forced by the server/client boundary, and there is no such boundary here.
 *
 * **`ask` does not return a `FormState`, so it is wrapped rather than handed over.** It
 * returns `AskState` — `{ question, error?, answer? }` — because the answer is the point and
 * `FormState` has nowhere to put it. `<Form>` is hardcoded to `FormState`, and making it
 * generic would touch eight forms that work in order to serve one that does not, so instead
 * this screen holds the answer in its own state and gives `<Form>` only the half it
 * understands:
 *
 * ```
 * const next = await ask(null, fd);
 * setAnswer(next?.answer ?? null);
 * return next?.error ? { error: next.error } : null;
 * ```
 *
 * Four things come free from that: `<Form>`'s own error banner, which is exactly the
 * `{state?.error && <Banner tone="bad" icon="alert">}` the web wrote by hand; `TextField
 * name="question"` registering itself so `str(fd, "question", 400)` reads unchanged;
 * `Submit`'s `pendingLabel`, which reproduces the web's one-off `AskSubmit` down to the
 * string; and the render prop's `submit`, which the example buttons need. Clearing `answer`
 * on an error is deliberate and matches the web, where an error replaced the whole state.
 *
 * **The example buttons go through a remount, not a value.** On the web they wrote into the
 * input and called `requestSubmit()`. `TextField` here is uncontrolled and registers its
 * value from inside a `useEffect`, so setting state and calling `submit()` in the same tick
 * would send the *previous* question. Instead a tap bumps `example.n`: the `TextField` is
 * keyed on it, so it remounts with the new `defaultValue`, and `<AutoSubmit>` — rendered
 * immediately *after* it — fires the submit from its own effect. React runs a commit's
 * effects in tree order, so the field's `put()` has already happened by the time
 * `AutoSubmit` runs. That ordering is the whole mechanism; moving `<AutoSubmit>` above the
 * field would break it silently. (The web's comment about HTML entry lists being built in
 * tree order is moot here — there is no entry list until `submit` builds one.)
 *
 * **Layout is stacked, not side by side.** `.row` put the box and the button on one line;
 * `TextField` takes no `style`, a bare `TextInput` has no intrinsic width inside a row, and
 * at 360dp it would wrap anyway — the same reasoning as the Journal's toolbar.
 *
 * **The results table.** React Native has no `<table>`, so it is a header row plus body rows
 * inside a horizontal `ScrollView`, every column a fixed `COL_W` wide. Fixed rather than
 * minimum: let content size the cells and the header stops lining up with the body, which is
 * the one thing a table has to get right. Numeric columns are right-aligned with tabular
 * figures, as `.num.tnum` was.
 *
 * **`<details>` becomes a `Pressable` and a chevron; `<pre>` becomes monospace `<Text>`** in
 * its own horizontal scroller so a long line scrolls instead of wrapping. The note under it
 * is rewritten: the web names `moneyfit_ro`, a Postgres role that does not exist on a phone.
 * The real limits are named in `Footer` and they are the ones `lib/ai/sql.ts` implements.
 */

import { Stack } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { TextStyle, ViewStyle } from "react-native";

import { LineChart } from "@/components/charts";
import { Form, FormActions, Submit, TextField } from "@/components/form";
import { Icon } from "@/components/Icon";
import { PlainScreen } from "@/components/Screen";
import {
  AiNotConfigured,
  Banner,
  Card,
  Chip,
  EmptyState,
  LinkButton,
  PageHead,
  ProgressBar,
  StatTile,
} from "@/components/ui";
import { ANALYTICS_VIEWS } from "@/db/views";
import { ask } from "@/lib/actions/ask";
import { aiConfigured } from "@/lib/ai/client";
import { MAX_ROWS, type Answer } from "@/lib/ai/sql";
import { fmtCompact, fmtWhole, groupIndian } from "@/lib/money";
import { useStyles, useTheme, type Theme } from "@/theme/ThemeProvider";
import { font, radius, space, tnum, weight } from "@/theme/tokens";

/** Offered as buttons rather than prose, because a blank box is the hardest prompt. */
const EXAMPLES = [
  "What did I spend the most on last month?",
  "Which categories went up compared to three months ago?",
  "How much have I spent on food each month this year?",
  "What is still due this month?",
  "Which of my goals is furthest behind?",
  "How much have I put into investments in total?",
];

/**
 * One column's width in the results table.
 *
 * Wide enough for a grouped money figure at 13px and a two-line heading, narrow enough that
 * three columns fit a 360dp screen without scrolling.
 */
const COL_W = 136;

export default function AskScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Ask" }} />
      <PlainScreen>{aiConfigured() ? <Ask /> : <NoKey />}</PlainScreen>
    </>
  );
}

function Ask() {
  const s = useStyles(styles);

  const [answer, setAnswer] = useState<Answer | null>(null);
  /**
   * What an example button left behind: `q` is the text, `n` both remounts the box so it
   * picks the text up and acts as the token that fires the submit. One object rather than
   * two states so a tap is one update and the field and the trigger can never disagree.
   */
  const [example, setExample] = useState({ q: "", n: 0 });

  return (
    <>
      <PageHead
        title="Ask"
        sub="A question in English, a read-only query, and the rows it returned."
      />

      <View style={s.stack}>
        <Form
          action={async (_prev, fd) => {
            const next = await ask(null, fd);
            setAnswer(next?.answer ?? null);
            return next?.error ? { error: next.error } : null;
          }}
        >
          {({ submit }) => (
            <Card
              title="Ask about your own numbers"
              note="Claude writes a read-only query, the database answers it, and you see both."
            >
              <TextField
                key={example.n}
                name="question"
                defaultValue={example.q}
                placeholder="How much did I spend on groceries in August?"
                maxLength={400}
                autoCapitalize="none"
              />
              {/* Must stay below the field — see the note at the top of this file. */}
              <AutoSubmit token={example.n} submit={submit} />

              <FormActions>
                <Submit icon="ask" pendingLabel="Working it out…">
                  Ask
                </Submit>
              </FormActions>

              <View style={s.examples}>
                {EXAMPLES.map((q) => (
                  <ExampleChip
                    key={q}
                    label={q}
                    onPress={() => setExample((prev) => ({ q, n: prev.n + 1 }))}
                  />
                ))}
              </View>

              <Text style={s.note}>
                Writing the query takes ten to twenty seconds; running it takes milliseconds.
                Nothing is sent anywhere except the question itself — your figures are never part
                of the request.
              </Text>
            </Card>
          )}
        </Form>

        {answer ? <Result answer={answer} /> : null}
      </View>

      <Footer />
    </>
  );
}

/**
 * Submits the enclosing form once, after an example button has filled the box.
 *
 * Renders nothing and exists only for its effect's position in the tree. `submit` comes from
 * `<Form>`'s render prop and is a `useCallback(…, [])`, so its identity never changes and
 * this fires exactly once per tap. `token === 0` is the first render, when nobody has tapped
 * anything.
 */
function AutoSubmit({ token, submit }: { token: number; submit: () => void }) {
  useEffect(() => {
    if (token === 0) return;
    submit();
  }, [token, submit]);
  return null;
}

/**
 * `.chip.chip-btn` — a neutral chip that is also a button.
 *
 * `ui.tsx`'s `Chip` is a `View`, and the one tappable chip in `form.tsx` is private to that
 * file, so the pill is restated here. The numbers are `chipTone`'s neutral pair and `.chip`'s
 * own padding, with press state standing in for the web's `:hover`.
 */
function ExampleChip({ label, onPress }: { label: string; onPress: () => void }) {
  const s = useStyles(styles);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [s.chip, pressed ? s.chipPressed : null]}
    >
      <Text style={s.chipText}>{label}</Text>
    </Pressable>
  );
}

// ----------------------------------------------------------------- the answer

function Result({ answer: a }: { answer: Answer }) {
  const s = useStyles(styles);

  if (!a.answerable) {
    return (
      <Card title="Not something this app can answer">
        <Text style={s.prose}>{a.explanation}</Text>
      </Card>
    );
  }

  const rows = a.result?.rows ?? [];
  const cols = a.result?.columns ?? [];
  const single = rows.length === 1 && cols.length === 1;

  return (
    <Card
      title={a.question}
      action={
        <Chip tone="info" icon="sparkle">
          {a.result
            ? `${a.result.rows.length} row${a.result.rows.length === 1 ? "" : "s"} in ${a.result.ms} ms`
            : "no rows"}
        </Chip>
      }
    >
      <Text style={s.prose}>{a.explanation}</Text>

      {a.assumptions.length > 0 ? (
        <View style={s.assumptions}>
          {a.assumptions.map((note) => (
            <Chip key={note} tone="neutral" icon="info">
              {note}
            </Chip>
          ))}
        </View>
      ) : null}

      {rows.length === 0 ? (
        <View style={s.empty}>
          <EmptyState
            icon="search"
            title="The query ran and found nothing"
            body="That is an answer too — either there is no data matching, or the question needs to be narrower. The SQL below shows exactly what was looked for."
          />
        </View>
      ) : single ? (
        /* One number deserves to be read as one number, not as a 1×1 table. `StatTile` at
           `size="xl"` is the web's `.metric` with `.metric-value.xl.tnum`, to the pixel. */
        <View style={s.metric}>
          <StatTile label={pretty(cols[0])} value={cell(rows[0][cols[0]], cols[0])} size="xl" />
        </View>
      ) : (
        <>
          {a.chart ? <AnswerChart answer={a} /> : null}
          <Table cols={cols} rows={rows} />
        </>
      )}

      {a.result?.truncated ? (
        <View style={s.after}>
          <Banner tone="info" icon="info">
            {`Only the first ${rows.length} rows are shown. Ask for a total, or a top ten, to see the whole picture in one answer.`}
          </Banner>
        </View>
      ) : null}

      {a.staleNote ? (
        <View style={s.after}>
          <Banner tone="warn" icon="clock">
            {`Claude could not be reached, so the query saved for this same question was reused. The figures are current — they were fetched just now. (${a.staleNote})`}
          </Banner>
        </View>
      ) : null}

      {a.sql ? <Sql sql={a.sql} limitAdded={a.limitAdded} /> : null}
    </Card>
  );
}

/**
 * A bar or line chart from two named columns.
 *
 * `line` needs at least two points and ordered labels; anything else falls back to bars,
 * which are honest about being unordered. The bars are hand-rolled for the web's reason —
 * `BarRows` formats every value as paise, and here the number can be rupees, a count or a
 * percentage — and for one more: this app's `BarChart` is *vertical*, which turns a category
 * name into three legible characters.
 */
function AnswerChart({ answer: a }: { answer: Answer }) {
  const t = useTheme();
  const s = useStyles(styles);

  const chart = a.chart;
  const rows = a.result?.rows ?? [];
  if (!chart || rows.length < 2) return null;

  const labels = rows.map((r) => String(r[chart.label_column] ?? ""));
  const values = rows.map((r) => Number(r[chart.value_column] ?? 0));
  if (values.some((v) => !Number.isFinite(v))) return null;

  const money = isMoney(chart.value_column);
  // The web's `format` multiplied every money value by 100, which is right for a `*_rupees`
  // column and wrong for a `*_minor` one — a distinction its own `cell()` makes two
  // functions further down. Made here too, so a chart and the table under it agree.
  const alreadyMinor = /_minor$/.test(chart.value_column);
  const format = (v: number) =>
    money ? fmtCompact(alreadyMinor ? Math.round(v) : Math.round(v * 100)) : compactNumber(v);

  if (chart.kind === "line") {
    return (
      <View style={s.chart}>
        <LineChart
          series={[{ points: values, color: t.c.blue, fill: true }]}
          labels={labels}
          format={format}
        />
      </View>
    );
  }

  const top = Math.max(...values.map(Math.abs), 1);

  return (
    <View style={s.chart}>
      {values.map((v, i) => (
        <View key={`${labels[i]}-${i}`} style={s.barRow}>
          <View style={s.barHead}>
            <Text style={s.barLabel} numberOfLines={1}>
              {labels[i]}
            </Text>
            <Text style={s.barValue}>{format(v)}</Text>
          </View>
          {/* `.bar-fill` had `width: max(2%, …)` so a tiny value is still visible. */}
          <ProgressBar
            value={Math.max(0.02, Math.abs(v) / top)}
            color={v < 0 ? t.c.red : t.c.blue}
            height={8}
          />
        </View>
      ))}
    </View>
  );
}

/**
 * `.table`, as rows of `<View>`.
 *
 * Every cell is `COL_W` wide and nothing measures anything, which is what keeps the heading
 * over its column. The row borders stop at the last column rather than running to the edge of
 * the scroll content, because the content *is* exactly that wide.
 */
function Table({ cols, rows }: { cols: string[]; rows: Record<string, unknown>[] }) {
  const s = useStyles(styles);

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.tableScroll}>
      <View style={{ width: cols.length * COL_W }}>
        <View style={s.theadRow}>
          {cols.map((c) => (
            <Text key={c} style={[s.th, numeric(c) ? s.alignRight : null]} numberOfLines={2}>
              {pretty(c)}
            </Text>
          ))}
        </View>
        {rows.map((r, i) => (
          // There is no id to key on — the shape of the result is whatever was asked for —
          // and the list is rebuilt wholesale for every answer, so the index is stable for
          // as long as it needs to be.
          <View key={i} style={s.tbodyRow}>
            {cols.map((c) => (
              <Text
                key={c}
                style={[s.td, numeric(c) ? s.tdNum : null]}
                numberOfLines={2}
              >
                {cell(r[c], c)}
              </Text>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

/**
 * The SQL, behind one tap.
 *
 * Shown on purpose, not as a debugging leftover: every other AI surface in this app hands you
 * a sentence and asks you to trust it, and this one hands you the question it actually asked
 * the database, so a wrong answer is something you can see the reason for.
 */
function Sql({ sql, limitAdded }: { sql: string; limitAdded: boolean }) {
  const t = useTheme();
  const s = useStyles(styles);
  const [open, setOpen] = useState(false);

  return (
    <View style={s.disclosure}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((v) => !v)}
        style={({ pressed }) => [s.summary, pressed ? s.summaryPressed : null]}
      >
        <Icon
          name={open ? "chevronDown" : "chevronRight"}
          size={15}
          stroke={2.2}
          color={t.c.text3}
        />
        <Text style={s.summaryText}>The query that produced this</Text>
      </Pressable>

      {open ? (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.sqlScroll}>
            <Text style={s.sql}>{sql}</Text>
          </ScrollView>
          <Text style={s.sqlNote}>
            {`Run on a second connection opened with PRAGMA query_only = ON, which can read the analytics_ views and nothing else — no write of any kind is possible on it${
              limitAdded ? ", and the LIMIT was added by the app" : ""
            }.`}
          </Text>
        </>
      ) : null}
    </View>
  );
}

/**
 * No key — the web's second card, with its words, plus two buttons.
 *
 * The web named Track and Insights in the prose and left them as prose. On a phone the
 * sentence that names the alternative should be the way to it, which is the same call
 * `bill/scan.tsx` made for the manual form.
 */
function NoKey() {
  const s = useStyles(styles);

  return (
    <>
      <PageHead
        title="Ask"
        sub="A question in English, a read-only query, and the rows it returned."
      />

      <View style={s.stack}>
        <AiNotConfigured feature="Asking questions" />

        <Card title="What this would do">
          <Text style={s.prose}>
            With a key set, you could type{" "}
            <Text style={s.em}>“how much did I spend on fuel each month this year?”</Text> and get
            the answer out of your own database, alongside the SQL that produced it. Until then,
            Track and Insights cover the same ground with fixed charts — both work entirely
            without an API key.
          </Text>
          <View style={s.proseActions}>
            <LinkButton href="/track" label="Track" variant="outline" small />
            <LinkButton href="/insights" label="Insights" variant="outline" small />
          </View>
        </Card>
      </View>

      <Footer />
    </>
  );
}

/**
 * The closing paragraph, rewritten for the device.
 *
 * The web's version named `moneyfit_ro` and its `statement_timeout`. Neither exists here, and
 * a footnote that describes a barrier the app does not have is worse than none. These four
 * are what `lib/db.ts` and `lib/ai/sql.ts` actually enforce, and the view count is read from
 * the allowlist itself so the sentence cannot drift away from it.
 */
function Footer() {
  const s = useStyles(styles);
  return (
    <Text style={s.footer}>
      {`Queries run on a second SQLite connection opened with PRAGMA query_only = ON, against a fixed list of ${ANALYTICS_VIEWS.length} analytics views and nothing else, with a five-second limit and a cap of ${MAX_ROWS} rows. There is no way for a question to change or delete anything, whatever it is phrased as.`}
    </Text>
  );
}

// ---------------------------------------------------------------- formatting

/**
 * Whether a column holds money.
 *
 * The analytics views name every money column `*_rupees` or `*_minor`, and the prompt asks
 * for snake_case aliases built from them — so this is a convention check, not a guess about
 * content. When it is wrong the number is still right, just missing a ₹.
 */
function isMoney(col: string): boolean {
  return (
    /rupees|_minor$|amount|spend|spent|total|income|expense|net|value|invested|gain|limit|target|saved/.test(
      col.toLowerCase(),
    ) && !/count|pct|percent|days|months|years|rate/.test(col.toLowerCase())
  );
}

function numeric(col: string): boolean {
  return (
    isMoney(col) || /count|pct|percent|_id$|^id$|days|months|years|rate|number/.test(col.toLowerCase())
  );
}

function pretty(col: string): string {
  return col
    .replace(/_rupees$/, " (₹)")
    .replace(/_minor$/, " (paise)")
    .replace(/_pct$|^pct_/, " %")
    .replace(/_/g, " ")
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

/**
 * One cell. SQLite hands back dates as strings and everything numeric as a number, so the
 * only real work is money and nulls.
 */
function cell(v: unknown, col: string): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") {
    if (/_minor$/.test(col)) return fmtWhole(v);
    if (isMoney(col)) return fmtWhole(Math.round(v * 100));
    if (/pct|percent|rate/.test(col.toLowerCase())) return `${round(v)}%`;
    return compactNumber(v);
  }
  // A SUM over an empty set, or a cast in the generated SQL, can still produce a string.
  if (typeof v === "string" && v !== "" && !Number.isNaN(Number(v)) && isMoney(col)) {
    return fmtWhole(Math.round(Number(v) * 100));
  }
  return String(v).trim();
}

/**
 * A plain number, grouped the Indian way.
 *
 * The web used `toLocaleString("en-IN")`. Hermes ships without full ICU, so that request can
 * fall back to en-US grouping and print 12,345,678 where every other number in this app reads
 * 1,23,45,678 — which is exactly why `money.ts` wrote the lakh/crore rule out by hand instead
 * of reaching for `Intl`. `groupIndian` is that rule, and it takes paise, hence the ×100. It
 * emits no decimal part when the paise are zero, so a whole number stays whole; a fraction
 * comes back at two places rather than the web's "up to two".
 */
function compactNumber(v: number): string {
  return groupIndian(Math.round(v * 100));
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

const styles = (t: Theme) => ({
  /** `.stack` — `> * + * { margin-top: 20px }`. */
  stack: { gap: space.gap } as ViewStyle,

  // ------------------------------------------------------------- the ask form
  examples: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: space.gap,
  } as ViewStyle,
  chip: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
    backgroundColor: t.c.surface2,
  } as ViewStyle,
  chipPressed: { backgroundColor: t.c.surface3 } as ViewStyle,
  chipText: { ...font.label, color: t.c.text2 } as TextStyle,

  /** The web's `<p className="small dim" style={{ marginBottom: 0 }}>`. */
  note: { ...font.small, color: t.c.text3, lineHeight: 18, marginTop: space.gap } as TextStyle,

  prose: { ...font.small13, color: t.c.text2, lineHeight: 20 } as TextStyle,
  em: { fontStyle: "italic" } as TextStyle,
  proseActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 16,
  } as ViewStyle,

  // -------------------------------------------------------------- the results
  assumptions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 14,
    marginBottom: 4,
  } as ViewStyle,

  empty: { marginTop: 10 } as ViewStyle,
  metric: { marginTop: 18 } as ViewStyle,
  /** Both banners sat at `margin-top: 16px`, and `Banner` carries none of its own. */
  after: { marginTop: 16 } as ViewStyle,

  chart: { marginTop: 18, marginBottom: 4 } as ViewStyle,
  barRow: { marginTop: 14, gap: 6 } as ViewStyle,
  barHead: { flexDirection: "row", alignItems: "baseline", gap: 10 } as ViewStyle,
  barLabel: {
    ...font.small,
    fontWeight: weight.medium,
    color: t.c.text,
    flex: 1,
    minWidth: 0,
  } as TextStyle,
  barValue: { ...font.small, ...tnum, color: t.c.text2 } as TextStyle,

  tableScroll: { marginTop: 18 } as ViewStyle,
  theadRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: t.c.border,
    paddingBottom: 8,
  } as ViewStyle,
  tbodyRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: t.c.borderSoft,
    paddingVertical: 10,
  } as ViewStyle,
  th: { width: COL_W, paddingRight: 10, ...font.label, color: t.c.text3 } as TextStyle,
  td: { width: COL_W, paddingRight: 10, ...font.small13, color: t.c.text } as TextStyle,
  tdNum: { ...tnum, textAlign: "right" } as TextStyle,
  alignRight: { textAlign: "right" } as TextStyle,

  // ------------------------------------------------------------ the SQL panel
  disclosure: { marginTop: 20 } as ViewStyle,
  summary: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 4,
  } as ViewStyle,
  summaryPressed: { opacity: 0.65 } as ViewStyle,
  summaryText: { ...font.small, color: t.c.text3 } as TextStyle,
  sqlScroll: {
    marginTop: 10,
    borderRadius: radius.sm,
    backgroundColor: t.c.surface2,
  } as ViewStyle,
  /** `<pre className="sql">` — the monospace idiom `ui.tsx`'s `detail` already uses. */
  sql: {
    ...font.small,
    fontFamily: "monospace",
    color: t.c.text2,
    lineHeight: 19,
    padding: 14,
  } as TextStyle,
  sqlNote: { ...font.small, color: t.c.text3, lineHeight: 18, marginTop: 10 } as TextStyle,

  footer: { ...font.small, color: t.c.text3, lineHeight: 18, marginTop: 26 } as TextStyle,
});
