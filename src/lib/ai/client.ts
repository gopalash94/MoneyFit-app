/**
 * The single place this app talks to Claude.
 *
 * Every AI feature here is optional. Without a stored API key the app is not
 * degraded so much as simply smaller: every chart, forecast, XIRR and recurring-
 * payment detector is computed locally from SQLite and does not know this file
 * exists. So the contract is `aiConfigured()` first, `<AiNotConfigured/>` if not,
 * and no import of this module anywhere on a path that has to work without a key.
 *
 * All four features want a typed object back rather than prose, so they all go
 * through `askStructured` and a Zod schema. That is worth more than it looks:
 * a bill extractor that returns "The total appears to be around ₹1,240" cannot be
 * put into a form field, and one that returns `{amount: 1240}` can.
 *
 * ## Why this is `fetch` and not the SDK
 *
 * `@anthropic-ai/sdk`'s own requirements list is explicit — *"Note that React Native
 * is not supported at this time."* So the SDK is not a dependency of this project
 * and this file speaks HTTP directly. Three things it used to do for us are done
 * here instead, and each one is worth naming because each is a place a silent
 * difference could hide:
 *
 *   1. **The schema.** `zodOutputFormat()` became `toStrictJsonSchema()` next door.
 *   2. **The validation.** `messages.parse()` checked the response against the Zod
 *      schema and handed back `parsed_output`. Here the response is text, so it is
 *      `JSON.parse` then `schema.safeParse` — which means every Zod schema in this
 *      folder is reused untouched and Zod is now the thing doing the checking.
 *   3. **The retry.** The SDK was configured with `maxRetries: 1` and the reasoning
 *      is unchanged: two attempts, never three, because someone is watching a
 *      spinner and a third attempt costs more waiting than the answer is worth.
 *      Retried on a rate limit, a 5xx or a dropped connection; never on a timeout,
 *      a bad request or a rejected key, because none of those get better by asking
 *      again.
 *
 * Structured outputs guarantees the answer arrives as JSON inside a text block, so
 * the response walk below looks for the first `text` block rather than taking
 * `content[0]` — on Opus 5.5 thinking is always on, and a thinking block comes
 * first.
 *
 * The key is read from `secrets.ts`, never from a constant and never from a build
 * variable. `AiError.message` is rendered in a banner, so nothing here may put a
 * key, a prompt or a stack into one; the error bodies the API returns name fields
 * and limits, not credentials, and they are truncated anyway in case a proxy
 * answers with an HTML page instead.
 */

import { z } from "zod";

import { apiKeyConfigured, getApiKey } from "../secrets";
import { toStrictJsonSchema } from "./json-schema";

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/** How long to wait before the second and final attempt. */
const RETRY_DELAY_MS = 1200;

/**
 * The model name is the one thing here with a shelf life. On the web this could be
 * overridden by an environment variable; a phone has no environment, and changing
 * it means editing this line and rebuilding — which is the same work as changing an
 * env var and redeploying, so nothing is lost.
 *
 * Effort (below) is sent on every request, which older models reject. If you point
 * this at a pre-5 model, drop `effort` too.
 */
export const AI_MODEL = "claude-opus-5-5";

/**
 * Synchronous, because six screens call it during render to choose between a
 * feature and an `<AiNotConfigured/>` card. `secrets.ts` explains how a value out
 * of encrypted storage manages to answer synchronously.
 */
export function aiConfigured(): boolean {
  return apiKeyConfigured();
}

/**
 * Anything that went wrong talking to Claude, already phrased for a banner.
 * Callers show `.message` to the user, so it must never carry a key, a prompt,
 * or a stack.
 */
export class AiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiError";
  }
}

/** `output_config.effort` — how much thinking to spend. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * The content blocks this app actually sends, standing in for the SDK's
 * `Anthropic.ContentBlockParam`. Three of them: a question, a photo, a PDF.
 * Narrower than the real union on purpose — a type that only describes what is
 * used is a type that cannot be used wrongly.
 */
export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: ImageMediaType; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string } };

export type AskOptions<S extends z.ZodType> = {
  schema: S;
  /** Standing instructions. Kept identical between calls of a kind so it caches. */
  system: string;
  /** The user turn. A plain string, or blocks when a PDF or photo is involved. */
  content: string | ContentBlock[];
  effort?: Effort;
  maxTokens?: number;
  /** Milliseconds. */
  timeoutMs?: number;
};

/** Only the parts of the response this file reads. */
type ApiResponse = {
  content?: { type?: string; text?: string }[];
  stop_reason?: string | null;
};

/** One sentence, reused, for every way an answer can arrive malformed. */
const SHAPE = "Claude's answer did not come back in the expected shape. Try again.";

/**
 * One request, one validated object.
 *
 * `thinking` is deliberately absent: on Opus 5.5 thinking is always on and
 * sending a budget is a 400, while omitting the field is exactly equivalent to
 * `{type: "adaptive"}`. Depth is controlled by `effort` instead.
 */
export async function askStructured<S extends z.ZodType>({
  schema,
  system,
  content,
  effort = "medium",
  maxTokens = 8000,
  timeoutMs = 120_000,
}: AskOptions<S>): Promise<z.infer<S>> {
  const apiKey = await getApiKey();
  if (!apiKey) throw new AiError("No Anthropic API key is configured.");

  const payload = JSON.stringify({
    model: AI_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content }],
    output_config: {
      format: { type: "json_schema", schema: toStrictJsonSchema(schema) },
      effort,
    },
  });

  const body = await send(payload, apiKey, timeoutMs);

  let response: ApiResponse;
  try {
    response = JSON.parse(body) as ApiResponse;
  } catch {
    throw new AiError(SHAPE);
  }

  // Two stop reasons mean the schema was not honoured, and the API documents both
  // as arriving with a 200. Saying which one happened is the difference between
  // "try again" being advice and being noise.
  if (response.stop_reason === "refusal") {
    throw new AiError("Claude declined to answer this one. Nothing was saved.");
  }
  if (response.stop_reason === "max_tokens") {
    throw new AiError("Claude's answer was cut off before it finished. Try again.");
  }

  const text = firstText(response);
  if (text === null) throw new AiError(SHAPE);

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AiError(SHAPE);
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    // The field name comes from our own schema, never from the answer, so naming it
    // is safe and turns an unactionable sentence into a reportable one.
    const where = parsed.error.issues[0]?.path.join(".");
    throw new AiError(where ? `${SHAPE.slice(0, -12)} (${where}). Try again.` : SHAPE);
  }
  return parsed.data as z.infer<S>;
}

/** Structured outputs puts the JSON in a text block — but not necessarily the first. */
function firstText(response: ApiResponse): string | null {
  if (!Array.isArray(response.content)) return null;
  for (const block of response.content) {
    if (block?.type === "text" && typeof block.text === "string") return block.text;
  }
  return null;
}

type Attempt =
  | { ok: true; body: string }
  | { ok: false; retry: boolean; error: AiError };

/** Two attempts at most, and only for the failures a second attempt can fix. */
async function send(payload: string, apiKey: string, timeoutMs: number): Promise<string> {
  let result = await attempt(payload, apiKey, timeoutMs);
  if (!result.ok && result.retry) {
    await sleep(RETRY_DELAY_MS);
    result = await attempt(payload, apiKey, timeoutMs);
  }
  if (!result.ok) throw result.error;
  return result.body;
}

async function attempt(payload: string, apiKey: string, timeoutMs: number): Promise<Attempt> {
  const control = new AbortController();
  // A flag rather than sniffing the rejection: React Native's fetch is a polyfill
  // over XMLHttpRequest and what it throws on abort is not worth depending on,
  // whereas a boolean we set ourselves is.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    control.abort();
  }, timeoutMs);

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: payload,
      signal: control.signal,
    });
    // Read as text, not `.json()`: an error status can carry an HTML page from a
    // captive portal or a proxy, and `.json()` would throw over the status code we
    // actually wanted to report.
    const text = await res.text();
    if (res.ok) return { ok: true, body: text };
    return {
      ok: false,
      retry: res.status === 429 || res.status >= 500,
      error: statusError(res.status, apiMessage(text)),
    };
  } catch {
    if (timedOut) {
      return {
        ok: false,
        retry: false,
        error: new AiError("Claude did not answer in time. Try again, or lower the effort."),
      };
    }
    return {
      ok: false,
      retry: true,
      error: new AiError("Could not reach the Anthropic API. Check the phone's connection and try again."),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** HTTP status → one sentence a person can act on. The web's wording, phone advice. */
function statusError(status: number, detail: string): AiError {
  if (status === 401) {
    return new AiError("The Anthropic API key was rejected. Paste it again in Settings.");
  }
  if (status === 403) {
    return new AiError("That API key is not allowed to use this model.");
  }
  if (status === 429) {
    return new AiError("Rate limited by the API. Wait a moment and try again.");
  }
  if (status === 400) {
    // Usually a model or parameter mismatch — worth showing verbatim, because the
    // message names the offending field.
    return new AiError(`The API rejected the request: ${detail}`);
  }
  if (status >= 500) {
    return new AiError("Claude is overloaded right now. Try again in a moment.");
  }
  return new AiError(`API error ${status}: ${detail}`);
}

/**
 * The `error.message` out of an API error body, or a short slice of whatever came
 * back instead. Truncated because the "instead" case is a proxy's HTML page, and a
 * banner is one line high.
 */
function apiMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    const message = parsed.error?.message;
    if (typeof message === "string" && message.trim()) return message.trim();
  } catch {
    // Not JSON — fall through to the raw slice.
  }
  const flat = body.replace(/\s+/g, " ").trim();
  if (!flat) return "no details given";
  return flat.length > 180 ? `${flat.slice(0, 180)}…` : flat;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
