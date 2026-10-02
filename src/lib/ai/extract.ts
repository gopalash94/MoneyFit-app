/**
 * Read a bill photo or PDF and fill in the form.
 *
 * The output is a *draft*, never a saved row. Extraction lands you on the normal
 * new-bill form with the fields already populated and the confidence stated, and
 * you press Add yourself. That is a deliberate product decision, not timidity:
 * an OCR mistake that becomes a silent ₹12,400 row is worse than no extraction
 * at all, because you will not find it until the month does not add up.
 *
 * `source = 'ai'` is stamped on the resulting bill so provenance survives — the
 * schema has had that CHECK constraint since the first migration for this, and it
 * is why `bills.source` is still here when the web app has dropped it.
 *
 * **This feature has no equivalent on the web any more, on purpose.** The desktop
 * app has a keyboard and a statement importer; a phone has a camera, and pointing it
 * at a restaurant bill is the one thing it can do that a laptop cannot. So it stayed
 * when Anthropic went, and it now runs on the same Gemini key Ask uses — one key to
 * configure, not two. The schema and the prompt below are byte-for-byte what the web
 * app used to send, because they were the whole value of the file and none of that
 * value was in whose endpoint received them.
 *
 * Two things changed with the provider, both in `fileBlock()` at the bottom:
 * Gemini has one inline part type for both a photo and a PDF, so the branch went;
 * and `image/gif` is not on Gemini's list, so it went from `ImageMediaType` and from
 * the picker's accept list.
 */

import { z } from "zod";
import { AI_MODEL, askStructured, type InlineMediaType, type Part } from "./gemini";

/**
 * Amounts come back in **rupees**, not paise. The model is far more reliable
 * transcribing the number it can actually see on the page than multiplying it by
 * a hundred first; the ×100 happens on our side where it cannot be got wrong.
 */
export const ExtractedBill = z.object({
  merchant: z
    .string()
    .describe("Who is being paid, or who paid you. The biller or shop name as printed, without a legal suffix like 'Pvt Ltd' unless that is all there is."),
  amount: z
    .number()
    .describe("The total actually payable, in rupees. Not the subtotal, not a line item, not an outstanding balance carried over from a previous bill. If a rounded 'amount payable' and an exact total disagree, take the amount payable."),
  txn_date: z
    .string()
    .nullable()
    .describe("The bill or invoice date as YYYY-MM-DD, or null if none is printed. Never guess from the due date."),
  due_date: z
    .string()
    .nullable()
    .describe("The payment due date as YYYY-MM-DD, or null if none is printed."),
  already_paid: z
    .boolean()
    .describe("True only if the document itself says it has been paid — a receipt, a 'PAID' stamp, a payment confirmation. A bill with a future due date is not paid."),
  kind: z
    .enum(["expense", "income"])
    .describe("'income' only for something you received money from, like a salary slip or a client invoice you raised. Almost everything is 'expense'."),
  category: z
    .string()
    .nullable()
    .describe("Exactly one name from the category list given, copied character for character, or null if none is a reasonable fit. Do not invent a name."),
  reference: z
    .string()
    .nullable()
    .describe("Invoice, bill or receipt number if printed — the thing you would search for later. Null if absent."),
  confidence: z
    .enum(["high", "medium", "low"])
    .describe("'high' when every field was read cleanly from clear text. 'medium' when something was inferred or the scan is imperfect. 'low' when the document is blurred, cropped, handwritten, or may not be a bill at all."),
  caveat: z
    .string()
    .nullable()
    .describe("One short sentence naming anything the person should check before saving — an ambiguous total, a cut-off date, a guessed currency. Null when there is genuinely nothing to flag."),
});

export type ExtractedBill = z.infer<typeof ExtractedBill>;

const SYSTEM = `You transcribe bills, invoices and receipts into structured fields for a personal finance app used in India.

You are transcribing, not interpreting. Every field must be something you can point at in the document. When a value is not printed, return null rather than a plausible guess — a null field costs the user one keystroke, and a wrong field costs them a wrong month.

Amounts are in Indian rupees unless the document clearly says otherwise. Indian bills are commonly printed with lakh grouping (1,23,456.78 is one hundred twenty-three thousand four hundred fifty-six rupees and seventy-eight paise) — read that grouping correctly and return a plain number. If the document is in another currency, still return the printed number, and say so in the caveat.

Documents arrive as phone photos as often as clean PDFs: skewed, shadowed, partially cropped. Read what is legible and lower your confidence for the rest. If the image is not a bill at all, set confidence to "low" and say so in the caveat rather than inventing a merchant.`;

export type ExtractInput = {
  /** Base64 of the stored upload — no data: prefix. */
  base64: string;
  mimeType: string;
  originalName: string;
  /** Existing category names, so the model picks rather than invents. */
  categories: string[];
  /** Today, on the device, so "due in 7 days" style text can be resolved. */
  today: string;
};

export async function extractBill(input: ExtractInput): Promise<{
  value: ExtractedBill;
  model: string;
}> {
  const instruction =
    `Today is ${input.today}. The file is named "${input.originalName}".\n\n` +
    `Transcribe this document into the required fields.\n\n` +
    `Available categories — pick exactly one of these names, or null:\n` +
    input.categories.map((c) => `- ${c}`).join("\n");

  // The file goes first. Both providers document that ordering for a document or
  // image followed by a question about it, and the reason is the same either way:
  // the instruction reads as being about the page when the page is already there.
  const content: Part[] = [
    fileBlock(input.base64, input.mimeType),
    { text: instruction },
  ];

  const value = await askStructured({
    schema: ExtractedBill,
    system: SYSTEM,
    content,
    // Transcription rewards care over cleverness, and a misread total is the one
    // failure that matters here, so this is the one feature worth paying `high`
    // for. It is also the only one a person is actively waiting on.
    effort: "high",
    maxTokens: 4000,
    timeoutMs: 180_000,
  });

  return { value, model: AI_MODEL };
}

/**
 * The file, as one inline part.
 *
 * Anthropic needed two different block types here — `document` for a PDF, `image`
 * for a photo, each with its own `source` wrapper. Gemini has one: `inlineData` with
 * a MIME type, and `application/pdf` is just another MIME type. So the branch that
 * used to be in this function is gone rather than preserved, which is the whole
 * change.
 */
function fileBlock(base64: string, mimeType: string): Part {
  return {
    inlineData: {
      // Narrowed by `isAiReadable` before we ever get here; the cast is only to
      // satisfy the literal union in gemini.ts, which does not include image/heic.
      mimeType: mimeType as InlineMediaType,
      data: base64,
    },
  };
}
