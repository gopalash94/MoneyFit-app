/**
 * Asking a question.
 *
 * The one action in MoneyFit that touches the network, and the shape of it is the
 * argument for why that is acceptable: **the question goes out, the answer does not
 * come back.** What comes back is a SELECT, which is checked here and then run here,
 * on the connection `db.ts` opened with `PRAGMA query_only = ON`. Your figures are
 * computed on this phone exactly as they are on every other screen.
 *
 * Four things can happen, and all four are written to `ask_turns` before this returns:
 *
 *  - the model writes a query, it passes `validateSql`, SQLite answers → `answered`
 *  - the model says it cannot be answered from these views → `refused`
 *  - the model writes something that is not a plain SELECT, or names something that is
 *    not an analytics view → `refused`
 *  - the network, the key or the query itself fails → `failed`
 *
 * Recording the failures is not tidiness. This file is the only route out of the app,
 * so a thread that showed only successes would be an incomplete record of what has
 * been sent — and on a phone where the request is blocked, a silent failure is
 * indistinguishable from a broken screen.
 *
 * **This module is the sequence now.** It used to call one `answerQuestion` in
 * `ai/sql.ts` that did describe → generate → validate → run and returned a single
 * answer. Three of the four outcomes above are not an answer, and what a single-value
 * function throws has nowhere to carry the thing the thread most wants to keep — the
 * SQL the model wrote. So the steps are called in order here, one `try` apiece, and
 * `ai/sql.ts` keeps the four barriers and nothing else. See the note at the foot of
 * that file.
 *
 * Nothing here returns the API key, or anything derived from it. That rule came from
 * the web, where every export of a `"use server"` module is an endpoint the browser
 * can call by name; it holds here too, because `src/lib/ai/gemini.ts` is the only
 * module that reads the key and it exports no way to read it back.
 */

import { AI_MODEL, aiConfigured } from "@/lib/ai/gemini";
import { describeSchema, generateSql, runQuery, validateSql } from "@/lib/ai/sql";
// Shadows the global `FormData` for this module, which is the rule `lib/form-data.ts`
// states: without it `fd` resolves to the DOM declaration, whose entry values are
// `string | File`, and `str()` below wants ours. `import type` is enough — nothing here
// constructs one — and it erases at compile time.
import type { FormData } from "@/lib/form-data";
import {
  clearTurns,
  deleteTurn,
  recordTurn,
  renderChart,
  renderResult,
} from "@/lib/queries/ask";

import { fail, refreshAll, str, type FormState } from "./shared";

/** Long enough for a real question, short enough that nobody pastes a document. */
const MAX_QUESTION = 400;

/**
 * How much of the model's SQL is kept when the validator rejected it.
 *
 * A rejected query is still worth reading — it is the evidence for *why* it was
 * rejected — but it is also the one string in this table that nothing has vetted for
 * length. Truncating it keeps a pathological reply from writing a novel into the
 * thread. An accepted query needs no cap: it has already passed a shape check that
 * rejects anything but a single statement.
 */
const MAX_REJECTED_SQL = 4000;

export async function askQuestion(_prev: FormState, fd: FormData): Promise<FormState> {
  const question = str(fd, "question", MAX_QUESTION);

  // The two failures that are about the form rather than the answer, so they come
  // back as a banner over a preserved input instead of a row in the thread.
  if (!question) {
    return fail("Type a question first.", { question: "Nothing to ask yet." });
  }
  if (!aiConfigured()) {
    // The web said "set GEMINI_API_KEY in .env and restart", which is not a thing you
    // can do to a phone. Same sentence as the camera scan's, for the same reason.
    return fail("Answering questions needs a Gemini API key. Add one in Settings, then try again.");
  }

  // From here on, every outcome is a turn, and `refreshAll()` is called in each branch
  // rather than once at the bottom. Tidier to read the other way, but this way a
  // thrown error cannot leave a recorded turn invisible until the next navigation.

  // Step 1 and 2 share a branch, because both are the model's side of the exchange and
  // both fail the same way — `describeSchema` reads the views over the read-only
  // connection and throws an `AiError` if they are missing, which is as much a reason
  // the question could not be sent as a blocked network is.
  let gen;
  try {
    gen = await generateSql(question, await describeSchema());
  } catch (e) {
    await recordTurn({
      question,
      status: "failed",
      model: AI_MODEL,
      note: describe(e),
    });
    refreshAll();
    return null;
  }

  const sql = gen.sql.trim();

  // The model's own refusal. `answerable` and an empty `sql` are checked together
  // because either one alone means the same thing, and a reply that sets `answerable`
  // while writing nothing is not a reply worth second-guessing.
  if (!gen.answerable || !sql) {
    await recordTurn({
      question,
      status: "refused",
      model: AI_MODEL,
      note: gen.explanation || "The model did not write a query for that.",
      // Kept even on a refusal: the explanation says what is missing, and an
      // assumption often says what it would have guessed if it had tried.
      assumptions: gen.assumptions,
    });
    refreshAll();
    return null;
  }

  // Step 3. `validateSql` throws where the web's `checkSelect` returned
  // `{ ok, reason }` — the messages it throws are already written for a person and end
  // in "so it was not run", so the branch keeps its own `try` rather than the contract
  // being changed to suit this one call site.
  let checked;
  try {
    checked = validateSql(sql);
  } catch (e) {
    await recordTurn({
      question,
      status: "refused",
      model: AI_MODEL,
      sql_text: sql.slice(0, MAX_REJECTED_SQL),
      note: describe(e),
    });
    refreshAll();
    return null;
  }

  // Step 4.
  try {
    const result = await runQuery(checked.sql);
    const { cols, rows } = renderResult(result);
    await recordTurn({
      question,
      status: "answered",
      model: AI_MODEL,
      // `sql` and not `checked.sql`: the column is documented in `schema.ts` as the
      // SELECT "exactly as the model wrote it, before the row cap was wrapped around
      // it", and `validateSql` returns the already-capped text. The cap is the app's
      // doing, so showing it as the model's working would be a small lie — and
      // `truncated` is how the screen says the result was cut short anyway.
      sql_text: sql,
      note: gen.explanation,
      assumptions: gen.assumptions,
      chart: renderChart(gen.chart, result),
      result_cols: cols,
      result_rows: rows,
      // `result.rows` is already sliced to the cap, so this counts what is stored
      // rather than what matched. `truncated` is what says there was more.
      row_count: result.rows.length,
      truncated: result.truncated,
      ms: result.ms,
    });
  } catch (e) {
    // A query that passed every barrier and still would not run: a column that does
    // not exist, a type mismatch, or the five-second timer. SQLite says why better
    // than any wrapper could, and the SQL is kept next to it.
    await recordTurn({
      question,
      status: "failed",
      model: AI_MODEL,
      sql_text: sql,
      note: describe(e),
    });
  }

  refreshAll();
  return null;
}

/**
 * A failure the user can act on, rather than the class name of an exception.
 *
 * On the web this was a `switch` over `AskFailure.kind` — `no-key`, `network`, `api`,
 * `empty` — that appended a sentence of advice to each. There is no `kind` to switch
 * on here, deliberately: `gemini.ts` explains that the advice is already in the
 * sentences it throws, which is where the web's version put it in the end anyway. So
 * this is down to one line, and the one line is the point — an `AiError` message is
 * finished prose, and wrapping it in "an error occurred:" would make it worse.
 *
 * The same function covers all three failing branches, so the web's second helper —
 * `dbReason`, which rewrote three Postgres messages — has no counterpart. Each of its
 * three cases is already answered further up:
 *
 *   - `DATABASE_URL_RO` has no equivalent. `poolRo()` is a second connection to the
 *     same file rather than a second set of credentials, so there is no configuration
 *     for it to be missing.
 *   - `statement timeout` never reaches here. The raced timer in `runQuery` throws its
 *     own sentence, which already suggests narrowing the period.
 *   - `permission denied` cannot happen. A name outside the eleven views is rejected
 *     by the allowlist before the query runs, with a message naming the table.
 *
 * What is left is SQLite's own complaint — a missing column, a type mismatch — which
 * `runQuery` has already prefixed with "SQLite rejected the query:". It names a column
 * or a keyword, never a credential.
 */
function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * One question out of the thread. The answer it holds is not recoverable, which is why
 * the screen puts this behind a confirm rather than a plain row tap.
 *
 * The id comes off a turn this module wrote, so it is not user input — but the check
 * is here anyway, because it is the same check every other id-taking action in this
 * app does and a `DELETE WHERE id = NaN` deletes nothing silently.
 */
export async function removeTurn(id: number): Promise<void> {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return;
  await deleteTurn(n);
  refreshAll();
}

export async function clearThread(): Promise<void> {
  await clearTurns();
  refreshAll();
}
