/**
 * AI feature 1 of 4 — read a bill photo or PDF and fill in the form.
 *
 * The output is a *draft*, never a saved row. Extraction lands you on the normal
 * new-bill form with the fields already populated and the confidence stated, and
 * you press Add yourself. That is a deliberate product decision, not timidity:
 * an OCR mistake that becomes a silent ₹12,400 row is worse than no extraction
 * at all, because you will not find it until the month does not add up.
 *
 * `source = 'ai'` is stamped on the resulting bill so provenance survives — the
 * schema has had that CHECK constraint since the first migration for this.
 *
 * Unchanged from the web app apart from the content-block type, which now comes
 * from `client.ts` rather than the SDK. The schema and the prompt are the whole
 * value of this file and they are byte-for-byte what the web app sends, so a bill
 * photographed on the phone is read exactly as the same photo uploaded to the
 * desktop app would be.
 */

import { z } from "zod";
import { AI_MODEL, askStructured, type ContentBlock, type ImageMediaType } from "./client";
import { isPdf } from "../upload-meta";

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

  // The document block goes first. Claude reads a PDF or image better when the
  // page precedes the question about it, and the API documents that ordering for
  // documents specifically.
  const content: ContentBlock[] = [
    fileBlock(input.base64, input.mimeType),
    { type: "text", text: instruction },
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

function fileBlock(base64: string, mimeType: string): ContentBlock {
  if (isPdf(mimeType)) {
    return {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: base64 },
    };
  }
  return {
    type: "image",
    source: {
      type: "base64",
      // Narrowed by `isAiReadable` before we ever get here; the cast is only to
      // satisfy the literal union in client.ts, which does not include image/heic.
      media_type: mimeType as ImageMediaType,
      data: base64,
    },
  };
}
