// Second categorization pass (post rules-reset): the text heuristic in textCategorization.ts
// gained keywords for the "clear win" merchants that were still uncategorized (Costco, TJ Maxx,
// Warby Parker, Wawa, CSC laundry, MIT Outing Club, Cafe Vanak, bakeries, SEPTA, card-payment
// "online payment from/to" strings). This deletes the one dead rule and re-runs the idempotent
// auto-categorizer over the NULL-category rows. Genuinely ambiguous merchants (Klarna, CollegeBoard,
// person-to-person, foreign one-offs) are intentionally left uncategorized.
import { getDb, closeDb } from '../../server/src/db/index';
import { autoCategorizeTransactions } from '../../server/src/services/rules';

const db = getDb();

function nullCount(): number {
  return (db.prepare("SELECT COUNT(*) n FROM transactions WHERE category_id IS NULL AND pending = 0").get() as { n: number }).n;
}

const before = nullCount();

// The 'AMC' merchant_rule matches nothing (AMC theatres are covered by the cat_ent_movies
// heuristic 'amc theat'/'amc '); a bare 3-char 'amc' pattern is a fuzzy-match liability.
const deleted = db.prepare("DELETE FROM merchant_rules WHERE lower(pattern) = 'amc'").run().changes;

const result = autoCategorizeTransactions(db);

const after = nullCount();
console.log(`[categorize] deleted ${deleted} dead rule(s); auto-categorizer updated ${result.updated}`);
console.log(`[categorize] uncategorized (null, non-pending): ${before} -> ${after}`);

closeDb();
