/**
 * Ask — `Finance/src/app/ask/page.tsx` plus `Finance/src/components/AskBox.tsx`.
 *
 * The escape hatch. Every other screen answers a question somebody decided in advance was
 * worth a card; this one exists for the rest — the question you have once, about a category
 * nobody built a chart for, over a range nobody put in a dropdown. The answer comes out of
 * SQLite, not out of the model: Gemini only writes the query, and the query is shown.
 *
 * **Two web files, one screen**, for the reason `bill/scan.tsx` gives: the web split was
 * forced by the server/client boundary, and there is no such boundary here.
 *
 * **The answer is read from the database, not held in state.** This is the change `ask_turns`
 * brought, and it is why the screen is shorter than the one it replaces. There used to be a
 * `useState<Answer>` here and a closure around the action to fill it, because `ask` returned
 * an `AskState` that `<Form>` could not carry. Now `askQuestion` writes the turn and returns
 * a plain `FormState`, so it is handed to `<Form action={…}>` directly, and the thread below
 * is a `useLive(listTurns)` like every other list in this app. One rendering path for the
 * answer you just asked for and the one you asked yesterday — the thing the old screen could
 * not have had, because its answer did not survive a navigation.
 *
 * **The thread is newest first, under the box.** `queries/ask.ts` explains the ordering: this
 * is a notebook rather than a conversation, so the input stays at the top and the answer
 * appears directly beneath it. Each turn carries its own SQL, because an answer you cannot
 * check is not an answer — and the only way to tell a wrong figure from a wrong question is
 * to read the query that produced it.
 *
 * **The example buttons go through a remount, not a value.** On the web they wrote into the
 * input and called `requestSubmit()`. `TextField` here is uncontrolled and registers its
 * value from inside a `useEffect`, so setting state and calling `submit()` in the same tick
 * would send the *previous* question. Instead a tap bumps a counter: the `TextField` is keyed
 * on it, so it remounts with the new `defaultValue`, and `<AutoSubmit>` — rendered
 * immediately *after* it — fires the submit from its own effect. React runs a commit's
 * effects in tree order, so the field's `put()` has already happened by the time `AutoSubmit`
 * runs. That ordering is the whole mechanism; moving `<AutoSubmit>` above the field would
 * break it silently.
 *
 * **Layout is stacked, not side by side.** `.row` put the box and the button on one line;
 * `TextField` takes no `style`, a bare `TextInput` has no intrinsic width inside a row, and
 * at 360dp it would wrap anyway — the same reasoning as the Journal's toolbar.
 *
 * **The results table.** React Native has no `<table>`, so it is a header row plus body rows
 * inside a horizontal `ScrollView`, every column a fixed `COL_W` wide. Fixed rather than
 * minimum: let content size the cells and the header stops lining up with the body, which is
 * the one thing a table has to get right. Numeric columns are right-aligned with tabular
 * figures, as `.num.tnum` was — and the flag that decides which is read off the stored
 * column rather than recomputed, so the alignment of a turn can never drift from the cells
 * it was rendered with.
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
import { DangerButton, Form, FormActions, Submit, TextField } from "@/components/form";
import { Icon } from "@/components/Icon";
import { Screen } from "@/components/Screen";
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
import { askQuestion, clearThread, removeTurn } from "@/lib/actions/ask";
import { AI_MODEL, aiConfigured } from "@/lib/ai/gemini";
import { MAX_ROWS } from "@/lib/ai/sql";
import { fmtDate } from "@/lib/date";
import { useLive } from "@/lib/live";
import { fmtCompact } from "@/lib/money";
import { compactNumber, isMoney, listTurns, pretty } from "@/lib/queries/ask";
import type { AskChart, AskColumn, AskTurn } from "@/lib/types";
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

/**
 * How much of the thread is read back.
 *
 * The same 30 the web's page uses, and the number is in two places on purpose: it is the
 * `LIMIT` and it is what the caption needs to know in order to say "last 30" rather than
 * "30 questions" when there may well be a hundred.
 */
const THREAD_LIMIT = 30;

export default function AskScreen() {
  const live = useLive(() => listTurns(THREAD_LIMIT), []);

  return (
    <>
      <Stack.Screen options={{ title: "Ask" }} />
      {/* `Screen` rather than `PlainScreen`: the thread is loaded data now, so this gets the
          pull-to-refresh and — more to the point — the error branch, which renders
          `DbUnavailable` exactly as the web page's own try/catch around `Ask()` did. */}
      <Screen live={live}>{(turns) => <Ask turns={turns} />}</Screen>
    </>
  );
}

function Ask({ turns }: { turns: AskTurn[] }) {
  const s = useStyles(styles);

  // Read during render, which `secrets.ts` supports through its synchronous in-memory
  // mirror. A key added in Settings calls `refreshAll()`, which bumps the live version this
  // screen is subscribed to — so coming back here re-renders and this is true again.
  const enabled = aiConfigured();

  /**
   * What the input is showing, and why it is showing it.
   *
   * `q` is the text, `key` remounts the uncontrolled `TextField` so it picks `q` up, and
   * `send` is the token `<AutoSubmit>` watches. Two counters rather than one, because the two
   * jobs came apart when the thread arrived: an example tap bumps both — fill the box, then
   * submit it — while a question that went through bumps only `key`, to empty the box and
   * submit nothing. One shared counter would make every answer ask itself again, forever.
   */
  const [box, setBox] = useState({ q: "", key: 0, send: 0 });

  return (
    <>
      <PageHead
        title="Ask"
        sub={
          enabled
            ? "A question in English, a read-only query, and the rows it returned."
            : "Not switched on. Nothing here can reach the network until it is."
        }
      >
        <LinkButton href="/track" label="Fixed charts" variant="outline" small />
      </PageHead>

      <View style={s.stack}>
        {enabled ? (
          <Form
            action={askQuestion}
            // Fires only when the action came back without an error, which for `askQuestion`
            // means a turn was written — the same edge the web's `AskBox` watched with
            // `wasPending.current && !pending && !state?.error`. The web also re-focused the
            // box; deliberately not done here, because on a phone that raises the keyboard
            // over the answer that has just appeared.
            onDone={() => setBox((prev) => ({ q: "", key: prev.key + 1, send: prev.send }))}
          >
            {({ submit }) => (
              <Card
                title="Ask about your own numbers"
                note={`Answers are capped at ${MAX_ROWS} rows · ${AI_MODEL}`}
              >
                <TextField
                  key={box.key}
                  name="question"
                  defaultValue={box.q}
                  placeholder="How much did I spend on groceries in August?"
                  maxLength={400}
                  autoCapitalize="none"
                />
                {/* Must stay below the field — see the note at the top of this file. */}
                <AutoSubmit token={box.send} submit={submit} />

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
                      onPress={() =>
                        setBox((prev) => ({ q, key: prev.key + 1, send: prev.send + 1 }))
                      }
                    />
                  ))}
                </View>

                <Text style={s.note}>
                  Writing the query takes ten to twenty seconds; running it takes milliseconds.
                  Nothing is sent anywhere except the question itself — your figures are never
                  part of the request.
                </Text>
              </Card>
            )}
          </Form>
        ) : (
          <SwitchedOff />
        )}

        {/* The thread is shown whether or not a key is set. Removing the key does not make
            what you already asked any less a record of what left this phone. */}
        {turns.length > 0 ? (
          <View style={s.rowBetween}>
            <Text style={s.threadCount}>
              {`${
                turns.length === THREAD_LIMIT
                  ? `Last ${THREAD_LIMIT} questions`
                  : `${turns.length} question${turns.length === 1 ? "" : "s"}`
              } · newest first`}
            </Text>
            <DangerButton
              action={clearThread}
              label="Clear thread"
              confirm="Delete every question and answer here? The answers are not recoverable."
            />
          </View>
        ) : null}

        {turns.map((t) => (
          <Turn key={t.id} turn={t} />
        ))}

        {turns.length === 0 && enabled ? (
          <Card>
            <EmptyState
              icon="ask"
              title="Nothing asked yet"
              body="Ask in your own words. Every question and the query it became is kept here, so an answer can be checked rather than taken on trust."
            />
          </Card>
        ) : null}
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

/**
 * The off state, which is the state every fresh install is in — the web's `NotConfigured`.
 *
 * It explains what switching it on means in the same breath as how, because "add your key"
 * is not informed consent on its own: this is the feature that sends the most anywhere, and
 * a free API tier is usually free because the traffic is used for something.
 *
 * Two sentences of the web's are wrong on a phone and are rewritten rather than carried:
 * there is no `.env` to edit and no `docker compose up -d` to restart, and this is not quite
 * "the only feature in the app that uses the network at all" — the camera bill scan, which
 * the web dropped and this app kept, uses the same key. Saying so is the point of the card.
 */
function SwitchedOff() {
  const s = useStyles(styles);

  return (
    <>
      <AiNotConfigured feature="Asking questions" />

      <Card title="Switched off">
        <Text style={s.prose}>
          Turning a typed question into SQL means sending the question to a model running on
          someone else's computer. MoneyFit will do that only if you give it a key, and does
          nothing of the kind otherwise. With a key set, you could type{" "}
          <Text style={s.em}>“how much did I spend on fuel each month this year?”</Text> and
          get the answer out of your own database, alongside the SQL that produced it.
        </Text>

        <Text style={[s.prose, s.after]}>
          To switch it on, paste a Google AI Studio key into Settings. It is kept in this
          phone's keystore rather than in the app's data, and the only other feature that uses
          it is the camera bill scan.
        </Text>

        <View style={s.after}>
          <Banner tone="warn" icon="alert">
            <Text>Worth knowing before you do: on Google's </Text>
            <Text style={s.strong}>free</Text>
            <Text>
              {" "}
              tier, the text you send may be read by people and used to improve their models.
              Your figures are never part of a request — only the question and the names of
              the views — but a question can itself be revealing. A paid key is excluded from
              that; so is not switching this on.
            </Text>
          </Banner>
        </View>

        <Text style={[s.prose, s.after]}>
          Track, Year and Insights cover most of the same ground with fixed charts and a
          written summary, computed entirely on this phone.
        </Text>
        <View style={s.proseActions}>
          <LinkButton href="/track" label="Track" variant="outline" small />
          <LinkButton href="/year" label="Year" variant="outline" small />
          <LinkButton href="/insights" label="Insights" variant="outline" small />
        </View>
      </Card>
    </>
  );
}

// ------------------------------------------------------------------ the thread

/**
 * One question and whatever came of it.
 *
 * The explanation goes above the figures and the SQL below them, which is the order this
 * screen has always used rather than the web's: a sentence answers the question, a table
 * evidences it, and the query is the working you check when the two disagree.
 *
 * Nothing here recomputes anything. The cells are strings `queries/ask.ts` rendered on the
 * way in, the chart's two series are the numbers it kept while they were still numbers, and
 * `num` is the alignment flag it stored per column. A turn renders the same way a year from
 * now as it did the second it was written, which is what makes it a record.
 */
function Turn({ turn: t }: { turn: AskTurn }) {
  const s = useStyles(styles);

  // `created_at` is `datetime('now')`, so "YYYY-MM-DD HH:MM:SS" with a space where the web's
  // TIMESTAMPTZ has a T. Both put the time at index 11, so the slices are the web's.
  const when = `${fmtDate(t.created_at.slice(0, 10), { year: true })} · ${t.created_at.slice(11, 16)}`;
  const cols = t.result_cols ?? [];
  const rows = t.result_rows ?? [];
  const answered = t.status === "answered";
  const single = answered && cols.length === 1 && rows.length === 1;

  return (
    <Card
      title={t.question}
      note={[when, t.ms !== null ? `${t.ms} ms` : null, t.model].filter(Boolean).join(" · ")}
      // `Card` takes one node here where the web had a `div.row`, so the chip and the button
      // need a wrapper of their own.
      action={
        <View style={s.turnActions}>
          <Status turn={t} />
          <DangerButton
            action={() => removeTurn(t.id)}
            label="Delete"
            confirm="Delete this question and its answer?"
          />
        </View>
      }
    >
      {!answered && t.note ? (
        <Banner tone={t.status === "failed" ? "bad" : "warn"} icon="alert">
          {t.note}
        </Banner>
      ) : null}

      {answered && t.note ? <Text style={s.prose}>{t.note}</Text> : null}

      {t.assumptions && t.assumptions.length > 0 ? (
        <View style={s.assumptions}>
          {t.assumptions.map((note) => (
            <Chip key={note} tone="neutral" icon="info">
              {note}
            </Chip>
          ))}
        </View>
      ) : null}

      {answered && rows.length === 0 ? (
        <Text style={[s.prose, s.after]}>
          The query ran and matched nothing. That is an answer — there are no such rows.
        </Text>
      ) : null}

      {/* One number deserves to be read as one number, not as a 1×1 table. `StatTile` at
          `size="xl"` is the web's `.metric` with `.metric-value.xl.tnum`, to the pixel. */}
      {single ? (
        <View style={s.metric}>
          <StatTile label={pretty(cols[0].name)} value={rows[0][0]} size="xl" />
        </View>
      ) : answered && rows.length > 0 ? (
        <>
          {t.chart ? <AnswerChart chart={t.chart} /> : null}
          <Table cols={cols} rows={rows} />
        </>
      ) : null}

      {t.truncated ? (
        <View style={s.after}>
          <Banner tone="info" icon="info">
            {`More rows matched than this page will show. The first ${MAX_ROWS} are above; narrow the question to see the rest.`}
          </Banner>
        </View>
      ) : null}

      {t.sql_text ? <Sql sql={t.sql_text} ran={t.status !== "refused"} /> : null}
    </Card>
  );
}

/**
 * What became of the question, in one chip.
 *
 * `truncated` turns the answered chip from good to warn rather than adding a second one: a
 * partial answer is not a clean result, and the sentence under the table says the rest.
 */
function Status({ turn: t }: { turn: AskTurn }) {
  if (t.status === "refused") {
    return (
      <Chip tone="warn" icon="alert">
        Not answered
      </Chip>
    );
  }
  if (t.status === "failed") {
    return (
      <Chip tone="bad" icon="alert">
        Failed
      </Chip>
    );
  }
  return (
    <Chip tone={t.truncated ? "warn" : "good"} icon="check">
      {t.truncated
        ? `First ${t.row_count} rows`
        : t.row_count === 1
          ? "1 row"
          : `${t.row_count} rows`}
    </Chip>
  );
}

/**
 * A bar or line chart from the series the model asked for.
 *
 * `line` needs at least two points and ordered labels; anything else falls back to bars,
 * which are honest about being unordered. The bars are hand-rolled for the web's reason —
 * `BarRows` formats every value as paise, and here the number can be rupees, a count or a
 * percentage — and for one more: this app's `BarChart` is *vertical*, which turns a category
 * name into three legible characters.
 *
 * `renderChart` has already dropped a chart whose columns the query did not return, whose
 * values would not convert, or that came down to fewer than two points, so this takes what
 * it is given. The one guard left is the same length check, because a stored turn is only as
 * trustworthy as the version of the app that wrote it.
 */
function AnswerChart({ chart }: { chart: AskChart }) {
  const t = useTheme();
  const s = useStyles(styles);

  const { labels, values } = chart;
  if (values.length < 2) return null;

  const money = isMoney(chart.value);
  // The web's `format` multiplied every money value by 100, which is right for a `*_rupees`
  // column and wrong for a `*_minor` one — a distinction `queries/ask.ts`'s `cell()` makes
  // too. Made here as well, so a chart and the table under it agree.
  const alreadyMinor = /_minor$/.test(chart.value);
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
 *
 * Both halves come straight out of the turn: `cols[i].num` is the alignment the row was
 * rendered with, and a cell is already the string `queries/ask.ts` made of it. The heading is
 * the one thing still computed, from the column name, because a name is all a heading has.
 */
function Table({ cols, rows }: { cols: AskColumn[]; rows: string[][] }) {
  const s = useStyles(styles);

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.tableScroll}>
      <View style={{ width: cols.length * COL_W }}>
        <View style={s.theadRow}>
          {cols.map((c, i) => (
            // Keyed on name *and* index: expo-sqlite reports columns by name, so two
            // same-named columns would collide on the name alone. `ai/sql.ts`'s prompt asks
            // for an alias on every expression, which is what normally prevents it.
            <Text
              key={`${c.name}-${i}`}
              style={[s.th, c.num ? s.alignRight : null]}
              numberOfLines={2}
            >
              {pretty(c.name)}
            </Text>
          ))}
        </View>
        {rows.map((r, ri) => (
          // There is no id to key on — the shape of the result is whatever was asked for —
          // and the rows are a frozen snapshot that nothing reorders, so the index is stable
          // for as long as the turn exists.
          <View key={ri} style={s.tbodyRow}>
            {r.map((v, ci) => (
              <Text key={ci} style={[s.td, cols[ci]?.num ? s.tdNum : null]} numberOfLines={2}>
                {v}
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
 *
 * The web's version ended "…and the LIMIT was added by the app" when it had been. That clause
 * is gone rather than guessed at: `ask_turns.sql_text` is documented as the SELECT *before*
 * the row cap was wrapped around it, so whether the cap was the model's or the app's is not
 * something a stored turn knows. The sentence says the more useful thing instead — that this
 * is the model's working, not the statement that ran — and `Footer` states the cap once.
 */
function Sql({ sql, ran }: { sql: string; ran: boolean }) {
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
        <Text style={s.summaryText}>
          {ran ? "The query that produced this" : "The query that was rejected"}
        </Text>
      </Pressable>

      {open ? (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.sqlScroll}>
            <Text style={s.sql}>{sql}</Text>
          </ScrollView>
          <Text style={s.sqlNote}>
            {ran
              ? "This is the query as the model wrote it, before the app wrapped its own row cap around it. It ran on a second connection opened with PRAGMA query_only = ON, which can read the analytics_ views and nothing else — no write of any kind is possible on it."
              : "This is what came back from the model. It was never run: it failed one of the checks named above, which is why it is here to read."}
          </Text>
        </>
      ) : null}
    </View>
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
  /** Bold inside a `Banner`, which has already wrapped its children in one `<Text>`. */
  strong: { fontWeight: weight.medium } as TextStyle,
  proseActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 16,
  } as ViewStyle,

  // ---------------------------------------------------------------- the thread
  /** `.row-between`, which is a per-screen style in this codebase rather than a shared one. */
  rowBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  } as ViewStyle,
  threadCount: { ...font.small, color: t.c.text3, flex: 1 } as TextStyle,
  turnActions: { flexDirection: "row", alignItems: "center", gap: 8 } as ViewStyle,

  // -------------------------------------------------------------- the results
  assumptions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 14,
    marginBottom: 4,
  } as ViewStyle,

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
