/**
 * Recognising a transaction you have already got.
 *
 * This matters more than it sounds, because statement ranges overlap. You download
 * January to March, then February to April, and the February rows are in both files.
 * Without a check, importing both doubles six weeks of spending and every chart in
 * the app is quietly wrong.
 *
 * Two different checks do two different jobs. The file's SHA-256 (held on
 * `statement_batches`) catches the same *file* uploaded twice, which is the common
 * accident and is caught before anything is parsed. This signature catches the same
 * *transaction* arriving inside a different file, which the hash cannot see.
 *
 * The three fields are the ones that survive the trip: the date, the amount in
 * paise, and the merchant reduced to a comparison key. Not the narration, which the
 * same bank prints differently in a PDF and in a CSV; not the balance, which differs
 * between statements covering different ranges.
 *
 * A match is never acted on automatically. It arrives at the review screen as a row
 * that is pre-unticked and labelled with the bill it matches, because two genuinely
 * separate ₹50 payments to the same shop on the same day are indistinguishable from
 * one payment imported twice — and only you know which it was.
 *
 * Byte-for-byte the web app's `src/lib/statement/dedupe.ts`.
 */

import { normaliseMerchant } from "../analytics/subscriptions";
import type { ISODate } from "../date";

export function signature(txn_date: ISODate, amount_minor: number, merchant: string): string {
  return `${txn_date}|${amount_minor}|${normaliseMerchant(merchant)}`;
}
