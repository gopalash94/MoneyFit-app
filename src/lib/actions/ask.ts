/**
 * The one action behind /ask.
 *
 * Nothing is written, so there is no `refreshAll()` and no navigation: the answer is
 * returned as form state and stays on the screen, which is what you want when the
 * next thing you do is squint at it and ask a better question.
 *
 * Verbatim from the web app apart from the `"use server"` directive, which has no
 * meaning here, and one word in the comment below.
 */

import { aiConfigured } from "@/lib/ai/client";
import { answerQuestion, type AskState } from "@/lib/ai/sql";
// Shadows the global `FormData` for this module, which is the rule `lib/form-data.ts`
// states: without it `fd` resolves to the DOM declaration, whose entry values are
// `string | File`, and `str()` below wants ours. `import type` is enough — nothing here
// constructs one — and it erases at compile time.
import type { FormData } from "@/lib/form-data";
import { str } from "./shared";

export async function ask(_prev: AskState, fd: FormData): Promise<AskState> {
  const question = str(fd, "question", 400);

  if (!question) return { question, error: "Type a question first." };
  if (!aiConfigured()) {
    return { question, error: "No Anthropic API key is configured, so questions cannot be answered." };
  }

  try {
    return { question, answer: await answerQuestion(question) };
  } catch (e) {
    // `AiError` messages are already written for a person; anything else is a
    // SQLite or connection failure, and its own message is the useful part.
    return { question, error: e instanceof Error ? e.message : String(e) };
  }
}
