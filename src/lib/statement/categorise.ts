/**
 * Choosing a category, in three tiers, and admitting which one answered.
 *
 * A statement does not contain your categories. It contains a narration and a
 * number, and the category is a judgement you make — so the honest question is not
 * "how do we know?" but "whose judgement do we reuse?".
 *
 *   1. **Learned.** Yours. Group every bill you have already filed by its
 *      normalised merchant and take the category you chose most often. This is the
 *      tier that matters: it is built from your own 260 decisions, it needs no
 *      maintenance, and it gets better every time you correct a row on the review
 *      screen. "Netflix" is whatever you have always said Netflix is.
 *   2. **Rules.** A table of common Indian merchants (`rules.ts`), for merchants
 *      you have never filed. A reasonable default, nothing more.
 *   3. **Nothing.** The row arrives with no category and `category_source: "none"`,
 *      and the review screen shows it as needing a decision.
 *
 * Tier three is the one worth defending. The tempting alternative is to drop
 * unknowns into "Other", which would make the importer look cleverer — every row
 * filed! — while quietly poisoning the analytics the rest of the app is built on. A
 * blank is a question; "Other" is a wrong answer that nobody will ever revisit.
 *
 * Every row carries its tier into the review table, so "learned from your bills"
 * and "guessed from a pattern" are never confused for each other on screen.
 *
 * Byte-for-byte the web app's `src/lib/statement/categorise.ts`. All three imports
 * resolve under the same relative paths here — `normaliseMerchant` at
 * `src/lib/analytics/subscriptions.ts:43`, `Category`/`Kind` at `src/lib/types.ts`.
 */

import { normaliseMerchant } from "../analytics/subscriptions";
import type { Category, Kind } from "../types";
import { RULES } from "./rules";
import type { CategorySource } from "./types";

export type Decision = {
  category_id: number | null;
  category_source: CategorySource;
};

/** `kind:normalised-merchant` → the category you have picked most often for it. */
export type LearnedMap = Map<string, number>;

export function learnedKey(kind: Kind, merchant: string): string {
  return `${kind}:${normaliseMerchant(merchant)}`;
}

/**
 * Builds the categoriser for one parse. Takes the live category list so rules can
 * be resolved by name — and so a renamed or archived category simply stops
 * matching instead of filing bills under an id that no longer means anything.
 */
export function makeCategoriser(categories: Category[], learned: LearnedMap) {
  const byName = new Map<string, Category>();
  for (const c of categories) byName.set(c.name.toLowerCase(), c);

  // Resolve the rule table once, and keep each rule's kind so an expense can never
  // be filed under Salary on the strength of the word "salary" appearing in a
  // narration about a loan repayment.
  const resolved = RULES.flatMap((rule) => {
    const cat = byName.get(rule.category.toLowerCase());
    return cat ? [{ re: rule.re, id: cat.id, kind: cat.kind }] : [];
  });

  return function categorise(merchant: string, narration: string, kind: Kind): Decision {
    const key = normaliseMerchant(merchant);
    if (key) {
      const id = learned.get(`${kind}:${key}`);
      if (id !== undefined) return { category_id: id, category_source: "learned" };
    }

    // The merchant is the cleaner signal, so it gets the first pass on its own;
    // the narration is tried second because the useful word is often in a part of
    // the line the merchant extractor dropped.
    for (const hay of [merchant, narration]) {
      for (const rule of resolved) {
        if (rule.kind === kind && rule.re.test(hay)) {
          return { category_id: rule.id, category_source: "rule" };
        }
      }
    }

    return { category_id: null, category_source: "none" };
  };
}
