/**
 * The fallback category table: merchant pattern → category name.
 *
 * This is tier two of three. Tier one is what you have already categorised
 * yourself — 260 bills' worth of decisions, which beat any table written by a
 * stranger — and tier three is leaving the row blank. This table only speaks for
 * merchants you have never filed before.
 *
 * It lives in TypeScript rather than in a database table on purpose. A table would
 * need a migration, a Settings screen to edit it, and a seed that drifts from the
 * code; a `const` here is reviewable in a diff, ships with the build, and costs
 * nothing to extend — add a line. The real editing surface is the review screen,
 * and anything you correct there is learned by tier one for next time, which is the
 * mechanism that is actually supposed to improve over months.
 *
 * Patterns are matched against the cleaned merchant first and the full narration
 * second, both lowercased, in the order written: put the specific before the
 * general. Categories are named, not numbered, and resolved against the live
 * `categories` table at parse time — a name that no longer exists simply stops
 * matching rather than filing a bill under a stale id.
 *
 * Byte-for-byte the web app's `src/lib/statement/rules.ts`. The category names must
 * match this project's seeded `categories` rows, and they do: `src/db/seed.ts` is
 * the same list the web's `db/020_seed.sql` inserts.
 */

export type Rule = {
  re: RegExp;
  /** Must match `categories.name` exactly, or the rule is skipped. */
  category: string;
};

export const RULES: Rule[] = [
  // ------------------------------------------------------------------ Dining
  { re: /\b(swiggy|zomato|eatclub|eatsure|faasos|box8|freshmenu|dominos|pizza ?hut|mcdonald|burger king|kfc|subway|starbucks|chaayos|chai ?point|barbeque nation|haldiram|bikanervala|cafe|restaurant|dhaba|bakery|biryani|dunkin|baskin|naturals ice)\b/i, category: "Dining" },

  // --------------------------------------------------------------- Groceries
  { re: /\b(dmart|d ?mart|avenue supermart|big ?basket|bbdaily|blinkit|grofers|zepto|instamart|jiomart|licious|country delight|more retail|reliance fresh|reliance smart|spencer|nature'?s basket|star bazaar|milk|kirana|provision|supermarket|vegetable|fruit)\b/i, category: "Groceries" },

  // -------------------------------------------------------------------- Fuel
  { re: /\b(iocl|indian ?oil|hpcl|hindustan petroleum|bpcl|bharat petroleum|reliance petro|nayara|shell|petrol|fuel|filling station|hp pump)\b/i, category: "Fuel" },

  // --------------------------------------------------------------- Transport
  { re: /\b(uber|ola|rapido|namma yatri|blusmart|irctc|redbus|abhibus|metro rail|bmrcl|dmrc|bmtc|msrtc|ksrtc|tsrtc|fastag|nhai|parking|toll|auto fare)\b/i, category: "Transport" },

  // ------------------------------------------------------------------ Travel
  { re: /\b(makemytrip|mmt|goibibo|cleartrip|yatra|ixigo|easemytrip|indigo|air ?india|spicejet|akasa air|vistara|emirates|qatar airways|oyo|airbnb|booking\.com|agoda|treebo|fabhotel|taj hotel|marriott|hyatt|hotel)\b/i, category: "Travel" },

  // ------------------------------------------------------------------ Mobile
  { re: /\b(airtel ?(prepaid|postpaid|recharge)?|bharti airtel|jio|reliance jio|vi |vodafone|idea cellular|bsnl|mtnl|recharge)\b/i, category: "Mobile" },

  // ---------------------------------------------------------------- Internet
  { re: /\b(act fibernet|act broadband|hathway|excitel|tikona|you broadband|airtel xstream|jiofiber|jio fiber|broadband|fibernet)\b/i, category: "Internet" },

  // ----------------------------------------------------------- Subscriptions
  { re: /\b(netflix|spotify|prime video|amazon prime|hotstar|disney|sonyliv|zee5|jiocinema|jiohotstar|voot|youtube ?(premium|music)?|apple\.?com\/bill|apple music|icloud|google one|google storage|microsoft 365|office 365|adobe|canva|chatgpt|openai|dropbox|notion|audible|kindle unlimited|gaana|wynk|cred ?pay)\b/i, category: "Subscriptions" },

  // ----------------------------------------------------------- Entertainment
  { re: /\b(bookmyshow|pvr|inox|cinepolis|carnival cinema|miraj cinema|district by zomato|ticketnew|dreamsports|gaming|steam games|playstation|xbox|nintendo)\b/i, category: "Entertainment" },

  // ------------------------------------------------------------- Electricity
  { re: /\b(bescom|mseb|mahadiscom|msedcl|tneb|tangedco|kseb|apspdcl|tssouthern|tsspdcl|bses|tata power|adani electricity|torrent power|cesc|pspcl|uppcl|jvvnl|dhbvn|uhbvn|wbsedcl|electricity|power bill)\b/i, category: "Electricity" },

  // ------------------------------------------------------------------- Water
  { re: /\b(bwssb|kwa|djb|delhi jal|mcgm water|water board|water bill|water tanker)\b/i, category: "Water" },

  // --------------------------------------------------------------------- Gas
  { re: /\b(indane|hp ?gas|bharat ?gas|ebharatgas|gail|igl |indraprastha gas|mahanagar gas|gujarat gas|adani total gas|lpg|cylinder|piped gas)\b/i, category: "Gas" },

  // ------------------------------------------------------------------ Health
  { re: /\b(apollo|pharmeasy|1mg|tata 1mg|netmeds|medplus|wellness forever|practo|cult\.?fit|cultfit|healthifyme|thyrocare|dr lal|lal path|metropolis|srl diagnostic|redcliffe|fortis|manipal hospital|narayana|max healthcare|aster|kims|clinic|hospital|pharmacy|chemist|diagnostic|dental|optical|lenskart)\b/i, category: "Health" },

  // --------------------------------------------------------------- Insurance
  { re: /\b(lic of india|lic premium|licindia|hdfc life|icici pru|sbi life|max life|bajaj allianz|tata aia|kotak life|star health|niva bupa|care health|hdfc ergo|icici lombard|acko|digit insurance|go ?digit|new india assurance|oriental insurance|united india|insurance|policy premium|renewal premium)\b/i, category: "Insurance" },

  // --------------------------------------------------------------- Education
  { re: /\b(byju|unacademy|vedantu|physics ?wallah|coursera|udemy|upgrad|great learning|simplilearn|scaler|school fee|college fee|tuition|university|academy|coaching class|exam fee)\b/i, category: "Education" },

  // ---------------------------------------------------------------- Shopping
  { re: /\b(amazon|flipkart|myntra|ajio|meesho|nykaa|tatacliq|tata cliq|snapdeal|shopsy|firstcry|decathlon|ikea|croma|reliance digital|vijay sales|lifestyle stores|pantaloon|westside|max fashion|zudio|h ?& ?m|zara|uniqlo|puma|adidas|nike|bata|titan|tanishq|caratlane)\b/i, category: "Shopping" },

  // --------------------------------------------------------------- Household
  { re: /\b(urban ?(clap|company)|nobroker|housejoy|pest control|plumber|electrician|carpenter|maid|house ?keeping|society maintenance|apartment maintenance|rwa |laundry|dry clean)\b/i, category: "Household" },

  // -------------------------------------------------------------------- Rent
  { re: /\b(house rent|flat rent|monthly rent|rent payment|rent for|landlord|nobroker ?pay|cred ?rent|redgirraffe)\b/i, category: "Rent" },

  // ------------------------------------------------------------------- Gifts
  { re: /\b(ferns ?n ?petals|fnp |igp\.com|archies|gift ?card|donation|charity|temple|ngo |give ?india|cry india|akshaya patra)\b/i, category: "Gifts" },

  // ------------------------------------------------------------------- Taxes
  { re: /\b(income ?tax|itns|tin ?nsdl|advance tax|self assessment tax|tds payment|gst payment|gstin|property tax|professional tax|municipal tax|bbmp tax|challan)\b/i, category: "Taxes" },

  // -------------------------------------------------------- Fees and charges
  // Last of the expense rules: these words appear inside other narrations, so
  // anything more specific has already had its turn by the time we get here.
  { re: /\b(atm ?(withdrawal|charge|fee|decline)|atw|cash ?wdl|service charge|bank charge|annual fee|joining fee|late (payment )?fee|penal|penalty|bounce charge|ecs return|cheque return|chq rtn|sms (charge|alert)|debit card (fee|charge|amc)|amc charge|processing fee|convenience fee|gst on|cgst|sgst|igst|interest charge|finance charge|forex markup|markup fee|minimum balance)\b/i, category: "Fees & Charges" },

  // --------------------------------------------------------------------- Income
  // Only reached for credits; `categorise` filters rules by kind so a debit
  // narrating "SALARY ADVANCE RECOVERY" can never land in Salary.
  { re: /\b(salary|sal cr|sal for|payroll|stipend|wages|arrears|bonus|incentive|reimbursement|ge aerospace|monthly sal)\b/i, category: "Salary" },
  { re: /\b(interest|int\.? ?(pd|cr|paid|credited)|saving ?int|fd ?interest|td ?interest|recurring deposit int|rd interest)\b/i, category: "Interest" },
  { re: /\b(dividend|div ?warrant|div ?payout|mf dividend|idcw)\b/i, category: "Dividends" },
  { re: /\b(refund|reversal|rev ?of|chargeback|cashback|returned|failed txn|imps return|neft return|claim settle)\b/i, category: "Refunds" },
];
