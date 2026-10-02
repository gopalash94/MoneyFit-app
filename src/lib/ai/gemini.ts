/**
 * The single place this app talks to a model — `Finance/src/lib/ai/gemini.ts`.
 *
 * Replaces `client.ts`, which spoke to Anthropic. The web app made the same move:
 * it deleted its Anthropic plumbing entirely and rebuilt Ask on Google's Generative
 * Language API, because a free tier is the difference between a feature somebody
 * will actually switch on and a feature behind a credit card. This file is that
 * decision, ported.
 *
 * **The signature did not change.** `askStructured({schema, system, content, effort,
 * maxTokens, timeoutMs})` is what it was, `AiError` is still the error class, and
 * `aiConfigured()` is still synchronous. That is the whole reason this swap is one
 * file and two import lines rather than a rewrite: `ai/sql.ts` holds the prompt, the
 * validator, the view allowlist and the runner, `ai/extract.ts` holds the bill
 * schema, and neither of them has any opinion about whose HTTP endpoint is on the
 * other end.
 *
 * Two features call it, and they are the only two things in this app that open an
 * outbound connection: Ask (`ai/sql.ts`) and the camera bill scan (`ai/extract.ts`).
 * Insights and coaching used to be here too; they are local computation now, in
 * `lib/analytics/`, and do not know this file exists. Everything else — every chart,
 * forecast, XIRR and recurring-payment detector — never did.
 *
 * ## Still `fetch`, and now for a second reason
 *
 * `@anthropic-ai/sdk` was never an option (*"React Native is not supported at this
 * time"*). `@google/genai` does not say that, and was still not taken: the endpoint
 * is one documented POST, the SDK is a dependency tree in the lockfile of an app
 * whose pitch is that it holds your money data on your own phone, and the three
 * things an SDK would do for us are each a place a silent difference could hide:
 *
 *   1. **The schema.** `responseSchema` wants OpenAPI 3.0, not JSON Schema. That
 *      conversion is `json-schema.ts` next door, and it is the one piece of this
 *      swap with real work in it.
 *   2. **The validation.** The response is text. `JSON.parse`, then
 *      `schema.safeParse` — so every Zod schema in this folder is reused untouched
 *      and Zod is the thing doing the checking, exactly as before.
 *   3. **The retry.** Two attempts, never three, because someone is watching a
 *      spinner and a third attempt costs more waiting than the answer is worth.
 *      Retried on a rate limit, a 5xx or a dropped connection; never on a timeout,
 *      a bad request or a rejected key, because none of those get better by asking
 *      again.
 *
 * The key is read from `secrets.ts`, never from a constant and never from a build
 * variable — there is no `.env` on a phone, which is the one structural difference
 * from the web app's version of this file. `AiError.message` is rendered in a banner,
 * so nothing here may put a key, a prompt or a stack into one. The API's error
 * bodies name fields and quotas, not credentials, and they are truncated anyway in
 * case something between here and Google answers with an HTML page instead.
 */

import { z } from "zod";

import { apiKeyConfigured, getApiKey } from "../secrets";
import { toResponseSchema } from "./json-schema";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/** How long to wait before the second and final attempt. */
const RETRY_DELAY_MS = 1200;

/**
 * The model name is the one thing here with a shelf life. The web app reads
 * `GEMINI_MODEL` from the environment and falls back to this value; a phone has no
 * environment, so changing it means editing this line and rebuilding — which is the
 * same work as changing an env var and redeploying, so nothing is lost.
 *
 * Flash specifically, and `effortBudget()` below depends on it: only the Flash
 * models accept a zero thinking budget. If you point this at a Pro model, read that
 * function's comment first.
 */
export const AI_MODEL = "gemini-2.5-flash";

/**
 * Synchronous, because several screens call it during render to choose between a
 * feature and an `<AiNotConfigured/>` card. `secrets.ts` explains how a value out
 * of encrypted storage manages to answer synchronously.
 */
export function aiConfigured(): boolean {
  return apiKeyConfigured();
}

/**
 * Anything that went wrong talking to the model, already phrased for a banner.
 * Callers show `.message` to the user, so it must never carry a key, a prompt,
 * or a stack.
 *
 * The web app's equivalent is `AskFailure`, which carries a `kind` of
 * `"no-key" | "network" | "api" | "empty"` so that `actions/ask.ts:126` can turn it
 * into advice. The kind is not kept here, because the Android side never had it: the
 * advice is already baked into the sentences below, which is where the web's
 * `describe()` ends up putting it anyway. Keeping the class name means no call site
 * in `sql.ts`, `extract.ts`, `actions/ask.ts` or `actions/scan.ts` changes.
 */
export class AiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiError";
  }
}

/**
 * How much thinking to spend.
 *
 * On Anthropic this was `output_config.effort` and the five names were the API's
 * own. Gemini spells the same idea as a token budget, so the names are kept and
 * `effortBudget()` maps them — rather than deleting the parameter and silently
 * changing the behaviour of the two call sites that pass `"high"` on purpose.
 */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Thinking tokens per effort level, for a 2.5 Flash model.
 *
 * `0` genuinely switches thinking off, which is right for `"low"`; `-1` hands the
 * decision to the model, which is what `"max"` should mean when there is no ceiling
 * worth naming. The middle three are a spread across Flash's 0–24,576 range.
 *
 * Returns `null` — meaning "send no `thinkingConfig` at all" — for a model whose
 * name is not recognisably Flash. The Pro models reject a budget of 0, so a model
 * swap would otherwise turn `effort: "low"` into a 400 nobody could read. The
 * consequence is worth stating plainly: **on a non-Flash model `effort` stops having
 * any effect**, and this table is the line to change if that ever matters.
 */
function effortBudget(effort: Effort): number | null {
  if (!/flash/i.test(AI_MODEL)) return null;
  switch (effort) {
    case "low":
      return 0;
    case "medium":
      return 1024;
    case "high":
      return 4096;
    case "xhigh":
      return 12288;
    case "max":
      return -1;
  }
}

/**
 * The media types this app will send inline, standing in for an SDK's `Part` union.
 * Narrower than what the API accepts on purpose — a type that only describes what is
 * used is a type that cannot be used wrongly.
 *
 * `image/gif` was on this list for Anthropic and is **not** on Gemini's supported
 * list, so it is gone from here and from the picker's accept list in
 * `upload-meta.ts`. Dropping it is the honest translation: a GIF would have been
 * accepted by the picker, uploaded, base64'd and then rejected by the API, which is
 * the worst place to find out.
 */
export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp";

/** Images plus the one document type the scan path can hand over. */
export type InlineMediaType = ImageMediaType | "application/pdf";

/**
 * One piece of a user turn.
 *
 * This replaces `ContentBlock`, which was Anthropic's three-way shape
 * (`{type: "text"}` / `{type: "image", source}` / `{type: "document", source}`).
 * Gemini has no such split: a photo and a PDF are both `inlineData` with a different
 * `mimeType`, which is why `extract.ts`'s `fileBlock()` lost its branch. The name
 * changed with the shape rather than being kept over a type that no longer describes
 * what is sent.
 */
export type Part =
  | { text: string }
  | { inlineData: { mimeType: InlineMediaType; data: string } };

export type AskOptions<S extends z.ZodType> = {
  schema: S;
  /** Standing instructions. Kept identical between calls of a kind so it caches. */
  system: string;
  /** The user turn. A plain string, or parts when a PDF or photo is involved. */
  content: string | Part[];
  effort?: Effort;
  maxTokens?: number;
  /** Milliseconds. */
  timeoutMs?: number;
};

/** Only the parts of the response this file reads. */
type ApiResponse = {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
};

/**
 * One sentence, reused, for every way an answer can arrive malformed. Split in two
 * so the field-name variant below can be built by concatenation rather than by
 * slicing a magic number of characters off the end of a sentence.
 */
const SHAPE_STEM = "The model's answer did not come back in the expected shape";
const SHAPE = `${SHAPE_STEM}. Try again.`;

/**
 * One request, one validated object.
 *
 * `temperature: 0` because there is a right answer, in both of the features that
 * call this: the same question should produce the same SQL and the same bill photo
 * should produce the same total, or checking one against the other is pointless.
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
  if (!apiKey) throw new AiError("No Gemini API key is configured.");

  const generationConfig: Record<string, unknown> = {
    temperature: 0,
    responseMimeType: "application/json",
    responseSchema: toResponseSchema(schema),
    maxOutputTokens: maxTokens,
  };

  const budget = effortBudget(effort);
  if (budget !== null) generationConfig.thinkingConfig = { thinkingBudget: budget };

  const payload = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: typeof content === "string" ? [{ text: content }] : content }],
    generationConfig,
  });

  const body = await send(payload, apiKey, timeoutMs);

  let response: ApiResponse;
  try {
    response = JSON.parse(body) as ApiResponse;
  } catch {
    throw new AiError(SHAPE);
  }

  const text = answerText(response);

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
    throw new AiError(where ? `${SHAPE_STEM} (${where}). Try again.` : SHAPE);
  }
  return parsed.data as z.infer<S>;
}

/**
 * The JSON document out of a response, or a thrown `AiError` saying why there isn't
 * one.
 *
 * `responseMimeType: "application/json"` plus a `responseSchema` is supposed to make
 * the candidate's text a conforming JSON document, and usually does. Everything
 * below is the "usually" — a prompt refused before generation, a candidate that
 * stopped early, a model that wrapped its JSON in a fence anyway. Each of those
 * arrives with HTTP 200, so none of them can be left to the status check.
 */
function answerText(response: ApiResponse): string {
  // Refused before anything was generated. There is no candidate to look at.
  const blocked = response.promptFeedback?.blockReason;
  if (blocked) {
    throw new AiError(`The request was blocked by the model (${blocked}). Nothing was saved.`);
  }

  const candidate = response.candidates?.[0];
  const inner = candidate?.content?.parts?.map((p) => p.text ?? "").join("").trim();

  if (!inner) {
    // Saying *which* way it stopped is the difference between "try again" being
    // advice and being noise. MAX_TOKENS is the one a caller can act on by asking
    // for less; the rest are the model declining.
    const reason = candidate?.finishReason;
    if (reason === "MAX_TOKENS") {
      throw new AiError("The answer was cut off before it finished. Try again.");
    }
    if (reason && reason !== "STOP") {
      throw new AiError(`The model stopped before answering (${reason}). Nothing was saved.`);
    }
    throw new AiError(SHAPE);
  }

  // A fence around JSON that was asked for as JSON should not happen and does. One
  // strip costs nothing; the alternative is a parse failure the user reads as "try
  // again" when the answer was in fact sitting right there.
  return inner.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
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
  // whereas a boolean we set ourselves is. This is also why the web app's
  // `AbortSignal.timeout(TIMEOUT_MS)` one-liner is not what is used here —
  // `AbortSignal.timeout` is not reliable on Hermes.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    control.abort();
  }, timeoutMs);

  try {
    const res = await fetch(
      `${ENDPOINT}/${encodeURIComponent(AI_MODEL)}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Gemini takes the key in a header, not the query string. That matters on
          // a phone as much as on a server: a key in a URL is a key in every proxy
          // log and crash report between here and Google.
          "x-goog-api-key": apiKey,
        },
        body: payload,
        signal: control.signal,
      },
    );
    // Read as text, not `.json()`: an error status can carry an HTML page from a
    // captive portal or a proxy, and `.json()` would throw over the status code we
    // actually wanted to report.
    const text = await res.text();

    // A network that filters this category of site answers with its own block page
    // rather than the API's JSON. Worth naming precisely, because the key is fine
    // and the network is not — and worth not retrying, because a second request
    // down the same wire gets the same page.
    if (text.trimStart().startsWith("<")) {
      return {
        ok: false,
        retry: false,
        error: new AiError(
          `The network returned a web page instead of an answer (HTTP ${res.status}) — something between this phone and Google is intercepting the request.`,
        ),
      };
    }

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
        error: new AiError("The model did not answer in time. Try again, or lower the effort."),
      };
    }
    return {
      ok: false,
      retry: true,
      error: new AiError("Could not reach the Gemini API. Check the phone's connection and try again."),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * HTTP status → one sentence a person can act on.
 *
 * Gemini's status codes do not line up with Anthropic's, and the one that bites is
 * **400**: a key that is not valid comes back as `INVALID_ARGUMENT`, not 401. So the
 * message body is consulted before falling through to the generic wording, because
 * "the request was rejected: API key not valid" is a sentence that tells somebody to
 * go and check the wrong thing.
 */
function statusError(status: number, detail: string): AiError {
  if (status === 400 && /api[\s_-]?key/i.test(detail)) {
    return new AiError("The Gemini API key was rejected. Paste it again in Settings.");
  }
  if (status === 400) {
    // Usually a model or parameter mismatch — worth showing verbatim, because the
    // message names the offending field.
    return new AiError(`The API rejected the request: ${detail}`);
  }
  if (status === 401) {
    return new AiError("The Gemini API key was rejected. Paste it again in Settings.");
  }
  if (status === 403) {
    return new AiError("That API key is not allowed to use this model.");
  }
  if (status === 404) {
    // The model name is a constant in this file, so this is a stale build rather
    // than anything the person holding the phone did wrong.
    return new AiError(`The model “${AI_MODEL}” was not found. The app needs updating.`);
  }
  if (status === 429) {
    return new AiError("Rate limited by the API — the free tier has a per-minute cap. Wait a moment and try again.");
  }
  if (status >= 500) {
    return new AiError("The model is overloaded right now. Try again in a moment.");
  }
  return new AiError(`API error ${status}: ${detail}`);
}

/**
 * The `error.message` out of an API error body, or a short slice of whatever came
 * back instead. Truncated because the "instead" case is a proxy's page, and a banner
 * is one line high.
 */
function apiMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown; status?: unknown } };
    const message = parsed.error?.message;
    if (typeof message === "string" && message.trim()) return message.trim();
    // `status` is the enum name — PERMISSION_DENIED, RESOURCE_EXHAUSTED. Less
    // readable than `message`, better than nothing.
    const kind = parsed.error?.status;
    if (typeof kind === "string" && kind.trim()) return kind.trim();
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
