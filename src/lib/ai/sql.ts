/**
 * AI feature 3 of 4 — ask a question in English, get an answer from your own data.
 *
 * Gemini writes a read-only query against the analytics views; SQLite runs it; the
 * rows go straight to the screen. The model never sees the results. That is the
 * design guarantee and it survived the port intact: it writes the query and a
 * sentence about what the query does, so there is no step at which a *figure* can
 * be hallucinated. A wrong answer here is a visibly wrong *question*, with the SQL
 * on screen to show why.
 *
 * ## The four barriers, and the one that changed
 *
 * `lib/db.ts` points here for this list, so here it is.
 *
 *   1. **The prompt is built from the database, not hardcoded.** `describeSchema()`
 *      reads the real column list at request time. This is a prompting choice and
 *      therefore worth nothing on its own — hence the three below.
 *   2. **Shape.** `validateSql` rejects anything that is not a single SELECT or
 *      WITH…SELECT, and rejects a list of statement keywords outright. This is a
 *      whitelist of shapes, not a blacklist of attacks.
 *   3. **Scope.** Every `FROM`/`JOIN` target must be one of the eleven view names in
 *      `ANALYTICS_VIEWS`, plus whatever CTEs the query itself defines. On the web
 *      this step was a Postgres role (`moneyfit_ro`, SELECT on `analytics` and no
 *      privilege of any kind anywhere else) and the header said it was *"the one
 *      that actually matters"*. SQLite has no roles and no GRANT, so it is replaced
 *      by two things: this name allowlist, and a separate connection running
 *      `PRAGMA query_only = ON` for its whole lifetime (`poolRo()` in lib/db.ts).
 *      The allowlist is strictly stronger than the cross-schema regex it replaces —
 *      a pattern can be satisfied by a name nobody wrote, an allowlist cannot — and
 *      `query_only` is a real write barrier rather than a hopeful one. What is
 *      genuinely weaker is that `query_only` is a property of a connection this
 *      process opened, not of a role a server enforces: code in this app could open
 *      another connection. Nothing does, and that is the honest strength of it.
 *   4. **Size and time.** `LIMIT 201` is appended when the query has no limit of its
 *      own, so 200 rows are shown and truncation is detectable. Postgres also gave
 *      us `statement_timeout = '5s'`; SQLite has no equivalent and expo-sqlite
 *      exposes no interrupt, so `runQuery` races a 5s timer instead. **Residual
 *      difference, stated plainly:** a pathological query keeps running on the native
 *      thread after the error appears. Against eleven small views over one person's
 *      own data this is a non-issue, but it is not the hard cap Postgres gave us.
 *
 * Steps 2, 3 and 4 also cover each other in a way worth knowing about, because it is
 * the reason neither is written more defensively than it is: `pragma_table_info` is a
 * table-valued function, so `FROM pragma_table_info('x')` slips past the word check
 * in step 2 (the boundary after `pragma` is an underscore) and is stopped dead by the
 * allowlist in step 3. A quoted identifier goes the other way: `FROM [sqlite_master]`
 * has no bare name for step 3 to test, and `stripLiterals` turns it into `FROM qi`,
 * which fails the allowlist. Both barriers fail closed.
 */

import { z } from "zod";

import { ANALYTICS_VIEWS, VIEW_NOTES } from "../../db/views";
import { poolRo } from "../db";
import { thisMonth, today } from "../date";
import { AiError, askStructured } from "./gemini";

/** Rows shown. The appended LIMIT asks for one more, so truncation is detectable. */
export const MAX_ROWS = 200;

/** How long `runQuery` waits before giving up on a query. See barrier 4 above. */
const QUERY_TIMEOUT_MS = 5_000;

/**
 * The views, their columns and what each one holds, as a block for the prompt.
 *
 * Hardcoding a schema description is the standard way this feature rots: a view
 * gains a column, the prompt does not, and the model keeps writing SQL against last
 * month's shape. So the columns are read from the database every time.
 *
 * On the web this was `information_schema.columns` joined to `obj_description()` for
 * the `COMMENT ON VIEW` text. SQLite has neither, so it is `PRAGMA table_info` per
 * view, paired with `VIEW_NOTES` — which is where those same comment strings now
 * live, next to the SQL that creates the views.
 *
 * Two honest limitations:
 *
 *   - `table_info` reports a declared type only for a column that is a plain
 *     reference to a base-table column. A computed column — every `*_rupees`, every
 *     `sum(...)` — comes back with an empty string, so those are listed by name
 *     alone. The names carry the meaning (`_rupees`, `_minor`, `_count`, `_pct`) and
 *     the alternative was a hardcoded type map, which is the rot this function
 *     exists to avoid.
 *   - A view that is missing is omitted rather than described as empty, so the model
 *     is never told about a view it cannot select from.
 */
export async function describeSchema(): Promise<string> {
  const db = poolRo();
  const lines: string[] = [];

  for (const view of ANALYTICS_VIEWS) {
    // Interpolated because PRAGMA accepts no bind values. `view` comes from
    // ANALYTICS_VIEWS — a module-private `as const` array of literals in
    // src/db/views.ts — and from nowhere else. Never pass a name from any other
    // source into this call.
    const info = await db.query<{ name: string; type: string }>(`PRAGMA table_info(${view})`);
    if (!info.rows.length) continue;

    const cols = info.rows.map((c) => {
      const t = shortType(c.type);
      return t ? `${c.name} ${t}` : c.name;
    });
    lines.push(`${view}(${cols.join(", ")})`);
    lines.push(`  -- ${VIEW_NOTES[view]}`);
  }

  if (!lines.length) {
    // Not reachable in a healthy install: the views are dropped and recreated on
    // every schema upgrade, so the only way to be here is to have deleted them by
    // hand. Say what recreates them rather than guess at a cause.
    throw new AiError(
      "The analytics views are missing, so questions cannot be answered. They are rebuilt by the migration in src/db/migrations.ts.",
    );
  }

  return lines.join("\n");
}

/** SQLite's declared type names, shortened for the prompt. Empty stays empty. */
function shortType(t: string): string {
  const v = t.trim().toLowerCase();
  if (!v) return "";
  if (v === "text" || v.startsWith("varchar") || v.startsWith("char")) return "text";
  if (v === "integer" || v === "int" || v === "bigint" || v === "smallint") return "int";
  if (v === "real" || v === "numeric" || v === "num" || v === "double" || v === "float") return "number";
  return v;
}

export const GeneratedQuery = z.object({
  answerable: z
    .boolean()
    .describe("True when the question can be answered from the listed views. False when it needs data this app does not hold, or is not a question about the person's money at all."),
  sql: z
    .string()
    .describe("A single SELECT (or WITH … SELECT) against the analytics views. Empty string when answerable is false. No semicolon, no comments, no trailing text."),
  explanation: z
    .string()
    .describe("One or two sentences, in plain English, saying what the query counts or sums and over what period. When answerable is false, say instead what is missing and — if there is one — which screen of the app does hold the answer."),
  assumptions: z
    .array(z.string())
    .describe("Up to three short notes about choices you had to make — a date range you picked, a category you guessed at, 'paid bills only'. Empty array when the question was unambiguous."),
  chart: z
    .object({
      kind: z
        .enum(["bar", "line"])
        .describe("'line' only when the label column is a month or a date in order; 'bar' otherwise."),
      label_column: z
        .string()
        .describe("Column name from your own SELECT list to use for the axis labels."),
      value_column: z.string().describe("Numeric column name from your own SELECT list to plot."),
    })
    .nullable()
    .describe("A chart, when the result is a small series worth seeing as one. Null for a single number, a long list, or anything with more than one interesting numeric column."),
});

export type GeneratedQuery = z.infer<typeof GeneratedQuery>;

const SYSTEM = `You translate one person's questions about their own finances into a single read-only SQLite query.

You are given the complete list of views you may use. There is nothing else: no base tables, no other names. A query naming anything not on that list will be rejected before it runs, so do not guess at a table.

Rules:

1. One statement. A SELECT, or a WITH … SELECT when a common table expression makes it clearer. No semicolon, no second statement, no trailing text.
2. Read only. INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, ATTACH and PRAGMA are rejected by the app and by the connection, which is opened read-only. Note that WITH … INSERT is still a write, and is rejected too.
3. Prefer the *_rupees columns over the *_minor ones. The minor columns are integer paise and will confuse the answer by a factor of a hundred. Never divide by 100 yourself — a rupees column already did it.
4. Give every computed column a snake_case alias. The column names are what the answer is labelled with on screen.
5. Order the result meaningfully and add a LIMIT when the question implies one ("top 5", "biggest"). The app caps the result at ${MAX_ROWS} rows regardless.
6. Months are text in 'YYYY-MM' form, so they sort and compare as strings — month >= '2026-01' is correct and needs no casting. Dates are text in 'YYYY-MM-DD' form and behave the same way.
7. Expenses and income share one table. Almost every spending question wants kind = 'expense' AND status = 'paid'; a question about what is still due wants status = 'upcoming'. Choose deliberately and say which you chose in the explanation.
8. Category names are the person's own and may not match their wording. Match case-insensitively and loosely — category LIKE '%food%' — rather than on equality, and note the guess in assumptions.

When the question cannot be answered from these views — it asks about a bank balance you do not have, or about the weather — set answerable to false, leave sql empty, and use the explanation to say what is missing rather than writing a query that answers a different question.

Write the plainest SQL that is correct. This is somebody's own small database: there is no performance problem to solve, and a readable query is one they can check.`;

export async function generateSql(question: string, schema: string): Promise<GeneratedQuery> {
  const value = await askStructured({
    schema: GeneratedQuery,
    system: SYSTEM,
    content: [
      `Today is ${today()}. The current month is ${thisMonth()}. "This month" means ${thisMonth()}; "last month" is the one before it.`,
      ``,
      `Views available, with column types:`,
      ``,
      schema,
      ``,
      `Question: ${question}`,
    ].join("\n"),
    // High, not medium: getting the join and the filter right is the whole job, and
    // a subtly wrong query is the one failure mode that looks like success.
    effort: "high",
    maxTokens: 4000,
    timeoutMs: 120_000,
  });

  // The prompt asks for at most three and the schema does not enforce a maximum, so
  // the cap is applied here rather than trusted. Returned bare: this used to be
  // `{ value, model }` because `cached()` needed a producer that reported which model
  // had written the answer it was storing, and with the cache gone the model name is
  // simply `AI_MODEL`, read once by the action that records the turn.
  return { ...value, assumptions: value.assumptions.slice(0, 3) };
}

/**
 * Matched as whole words against SQL that has already had its comments and string
 * literals removed. Both removals are load-bearing: a merchant genuinely called
 * 'Update Cafe' would otherwise trip the check, and a block comment placed
 * mid-keyword hides it from this regex while SQLite reads it perfectly well.
 *
 * Two differences from the web app's list, both deliberate:
 *
 *   - **Added for SQLite:** `pragma`, `attach`, `detach`. `pragma` so `query_only`
 *     cannot be turned back off, `attach` and `detach` so no other database file can
 *     be reached. (`vacuum` and `reindex` were already on the list.)
 *   - **Dropped:** the Postgres-only escape hatches — `pg_read_file`, `dblink`,
 *     `lo_import`, `current_setting` and the rest. They cannot exist here, and a
 *     list of names that could never match is a list nobody trusts. SQLite's own
 *     equivalents take their place below.
 *
 * Cursor verbs (DECLARE, FETCH, MOVE, CLOSE) are deliberately incomplete here —
 * DECLARE is listed, and without it the other three have nothing to operate on.
 * FETCH in particular is left out because `FETCH FIRST n ROWS ONLY` is ordinary
 * standard SQL and rejecting it would be a false alarm.
 */
const FORBIDDEN = [
  "insert",
  "update",
  "delete",
  "merge",
  "truncate",
  "drop",
  "alter",
  "create",
  "grant",
  "revoke",
  "comment",
  "copy",
  "vacuum",
  "reindex",
  "analyze",
  "cluster",
  "refresh",
  "lock",
  "set",
  "reset",
  "begin",
  "commit",
  "rollback",
  "savepoint",
  "release",
  "discard",
  "call",
  "do",
  "execute",
  "prepare",
  "deallocate",
  "declare",
  "move",
  "close",
  "listen",
  "notify",
  "unlisten",
  "security",
  "into",
  "pragma",
  "attach",
  "detach",
  // SQLite's own ways out of the database file.
  "load_extension",
  "readfile",
  "writefile",
  "fts3_tokenizer",
  "sqlite_dbpage",
] as const;

/** The eleven views, as a set, so the allowlist below is a lookup and not a scan. */
const ALLOWED_TABLES = new Set<string>(ANALYTICS_VIEWS);

export type Validated = { sql: string; limitAdded: boolean };

/**
 * Shape and scope, before anything reaches the database. Throws on a rejection so
 * the screen can say which rule was broken.
 */
export function validateSql(raw: string): Validated {
  const sql = raw.trim().replace(/;+\s*$/, "").trim();
  if (!sql) throw new AiError("No query came back.");

  const bare = stripLiterals(sql).toLowerCase();

  if (bare.includes(";")) {
    throw new AiError("The generated query contained more than one statement, so it was not run.");
  }
  if (!/^\s*(select|with)\b/.test(bare)) {
    throw new AiError("The generated query was not a SELECT, so it was not run.");
  }

  for (const word of FORBIDDEN) {
    // `\b` does not fire before an opening paren for names ending in a letter, so
    // the boundary is spelled out.
    if (new RegExp(`(^|[^a-z0-9_])${word}([^a-z0-9_]|$)`).test(bare)) {
      throw new AiError(
        `The generated query used "${word.toUpperCase()}", which is not allowed here, so it was not run.`,
      );
    }
  }

  for (const table of tableTargets(bare)) {
    if (!ALLOWED_TABLES.has(table)) {
      throw new AiError(
        `The generated query selected from "${table}", which is not one of the analytics views, so it was not run.`,
      );
    }
  }

  const limitAdded = !/\blimit\b/.test(bare);
  return { sql: limitAdded ? `${sql}\nLIMIT ${MAX_ROWS + 1}` : sql, limitAdded };
}

/**
 * Every name the query selects from, minus the ones it defines itself.
 *
 * A CTE name is not a view, so the allowlist has to learn the names the query
 * declares or every `WITH` would be rejected — and `WITH RECURSIVE days(d) AS (…)`
 * is exactly how the month-spine queries elsewhere in this app are written, so it is
 * the shape the model will reach for.
 *
 * The two patterns are deliberately conservative. A form they do not recognise means
 * a name is *not* removed from the list of targets, so an unrecognised CTE becomes a
 * clear rejection rather than a silent pass — which is the only direction a check
 * like this is allowed to be wrong in. A subquery (`FROM (SELECT …)`) has no name to
 * capture and is skipped, which is correct: whatever it selects from is matched on
 * its own.
 */
function tableTargets(bare: string): string[] {
  const defined = new Set<string>();
  const cte = /(?:^|[^a-z0-9_])(?:with(?:\s+recursive)?|,)\s+([a-z_][a-z0-9_]*)\s*(?:\([^)]*\))?\s+as\s*\(/g;
  for (const m of bare.matchAll(cte)) defined.add(m[1]);

  const out: string[] = [];
  // The dot is inside the character class so a qualified name arrives whole and is
  // rejected as a whole: `main.analytics_bills` must not read as `main`.
  for (const m of bare.matchAll(/(?:^|[^a-z0-9_])(?:from|join)\s+([a-z_][a-z0-9_.]*)/g)) {
    const name = m[1];
    if (!defined.has(name)) out.push(name);
  }
  return out;
}

/**
 * Comments and literals out, so the keyword and name checks look at SQL rather than
 * at somebody's merchant names. The output is deliberately not runnable — it is a
 * sieve, not a rewrite, and the original string is what gets executed.
 *
 * The web app's five lanes, plus two SQLite accepts and Postgres does not: backtick
 * and bracket quoting. Both had to be added. `FROM [sqlite_master]` has no bare name
 * for the allowlist to test, so without this lane it would pass scope entirely;
 * turning it into `FROM qi` makes it fail closed, exactly as the double-quote lane
 * already did for `FROM "sqlite_master"`.
 *
 * The `$$…$$` lane is inert here — SQLite has no dollar quoting — and is kept
 * anyway. Removing a lane from a sieve is the kind of change that looks safe and is
 * not, and an inert lane costs one line.
 */
function stripLiterals(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\$\$[\s\S]*?\$\$/g, " ''")
    .replace(/'(?:[^']|'')*'/g, " '' ")
    .replace(/"(?:[^"]|"")*"/g, " qi ")
    .replace(/`(?:[^`]|``)*`/g, " qi ")
    .replace(/\[[^\]]*\]/g, " qi ");
}

export type QueryResult = {
  /**
   * The SELECT list, in order.
   *
   * Read from the keys of the first row, because expo-sqlite has no column-metadata
   * side-channel — `pg` handed us `res.fields` and there is no equivalent. Two
   * consequences, both acceptable: a query returning no rows reports no columns (the
   * screen says "nothing matched" rather than drawing an empty table), and two
   * columns sharing a name collapse into one, which is what rule 4 in the prompt
   * asks for aliases to prevent.
   */
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
  ms: number;
};

/**
 * Runs the validated statement on the read-only connection.
 *
 * The statement is passed whole rather than parameterised, which is normally the
 * cardinal sin. It is safe here for a reason that has nothing to do with the string:
 * this is not user input spliced into a template, it *is* the statement, it has been
 * shape-checked and scope-checked, and the connection it runs on has been read-only
 * since it was opened. Parameterisation has no meaning for a query whose text is the
 * payload — the privilege boundary is what does the work.
 */
export async function runQuery(sql: string): Promise<QueryResult> {
  const started = Date.now();

  let rows: Record<string, unknown>[];
  try {
    const res = await withTimeout(
      poolRo().query<Record<string, unknown>>(sql),
      QUERY_TIMEOUT_MS,
      "The query took too long and was given up on. Try asking for a narrower period.",
    );
    rows = res.rows;
  } catch (e) {
    // Already phrased for a banner if it came from the timer; otherwise it is
    // SQLite's own message, which names a column or a keyword, never a credential.
    if (e instanceof AiError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw new AiError(`SQLite rejected the query: ${msg}`);
  }

  return {
    columns: rows.length ? Object.keys(rows[0]) : [],
    rows: rows.slice(0, MAX_ROWS),
    truncated: rows.length > MAX_ROWS,
    ms: Date.now() - started,
  };
}

/**
 * `statement_timeout` stood in for this on the web. Here the work carries on in the
 * background after the race is lost — see barrier 4 in the header.
 *
 * `Promise.race` attaches a handler to `work`, so a rejection arriving after the
 * timer won is absorbed rather than surfacing as an unhandled rejection.
 */
function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new AiError(message)), ms);
  });
  return Promise.race([work, limit]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/*
 * There is no `answerQuestion` here any more, and no `Answer` or `AskState` either.
 *
 * This module used to own the whole sequence — describe, generate, validate, run —
 * and hand back one object the screen rendered directly. That made sense while the
 * answer lived in component state and died with it. It stopped making sense when
 * `ask_turns` arrived, for a reason that is worth writing down because it is the
 * shape of the web app and this is the point the two converged:
 *
 *   **Three of the four outcomes are not an answer.** A sequence that returns a
 *   single value can only describe one of them and must throw for the rest, and what
 *   is thrown has no room for the thing the thread most wants to keep — the SQL the
 *   model wrote. A query rejected by `validateSql` and a query SQLite would not run
 *   are both worth recording *with their SQL next to them*, which is exactly what
 *   `ask_turns.sql_text` is for.
 *
 * So `src/lib/actions/ask.ts` is the sequence now, one `try` per step, a turn written
 * for every outcome — the same four branches as the web's `actions/ask.ts`. What is
 * left here is what it orchestrates: `describeSchema`, `generateSql`, `validateSql`,
 * `runQuery`. The four barriers are untouched; only who calls them in order moved.
 */
