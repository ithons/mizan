// One-off rules reset from the full-data audit: repoint wrong rules, delete broad/redundant
// ones, add missing ones (incl. rules that populate the new taxonomy leaves), then
// re-categorize the whole ledger (preserving manual categorizations).
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../../server/src/db/index';
import { recategorizeAll } from '../../server/src/services/rules';

const db = getDb();
const now = new Date().toISOString();

// Repoint an existing rule's category (matched case-insensitively by exact pattern).
const FIX: Array<[string, string]> = [
  ['Automatic Payment', 'cat_xfer_cc'],
  ['Electronic Funds Transfer Received', 'cat_inv_transfer'],
  ['Cash Deposit', 'cat_xfer_in'],
  ['NON-CHASE ATM FEE-WITH', 'cat_fees'],
  ['Chewy', 'cat_pets'],
  ['PetSmart', 'cat_pets'],
  ['Poison Control Aspca', 'cat_pets'],
  // Taxonomy-split repoints (populate the new leaves).
  ['Enterprise', 'cat_travel_rental'],
  ['Budget Rent-A-Car', 'cat_travel_rental'],
  ['Zipcar', 'cat_transport_share'],
  ['Bluebik Ride', 'cat_transport_share'],
  ['Anthropic', 'cat_sub_software'],
  ['backblaze', 'cat_sub_software'],
  ['Porkbun.com', 'cat_sub_software'],
  ['Walter Ai', 'cat_sub_software'],
];

// Delete broad/wrong/redundant rules.
const DELETE = [
  'Apple',                              // too broad — swallows Apple Pay tokens + hardware
  'VENMO CASHOUT PPD ID: 5264681992',   // wrong direction + hard-coded id
  'Caffe Nero Central',                 // subset of 'Caffe Nero'
  'Bluebik Rides',                      // subset of 'Bluebik Ride'
  'Facebook',                           // mislabels the opaque FACEBK charges
];

// Add missing rules (narrow replacements + new-leaf coverage).
const ADD: Array<[string, string]> = [
  ['APPLE.COM/BILL', 'cat_subscriptions'],
  ['Mint Mobile', 'cat_home_phone'],
  ['AMC', 'cat_ent_movies'],
  ['Wanderu', 'cat_travel_intercity'],
  ['Amtrak', 'cat_travel_intercity'],
  ['Peter Pan Bus', 'cat_travel_intercity'],
  ['OpenAI', 'cat_sub_software'],
  ['ChatGPT', 'cat_sub_software'],
  ['Cursor', 'cat_sub_software'],
  ['Colab', 'cat_sub_software'],
];

const run = db.transaction(() => {
  const catExists = db.prepare('SELECT 1 FROM categories WHERE id = ?');
  for (const [, cat] of [...FIX, ...ADD]) {
    if (!catExists.get(cat)) throw new Error(`Target category missing (run migrations first): ${cat}`);
  }

  const upd = db.prepare('UPDATE merchant_rules SET category_id = ? WHERE lower(pattern) = lower(?)');
  for (const [pattern, cat] of FIX) {
    const r = upd.run(cat, pattern);
    console.log(`  fix  ${r.changes ? '✓' : '✗ (not found)'}  ${pattern} -> ${cat}`);
  }

  const del = db.prepare('DELETE FROM merchant_rules WHERE lower(pattern) = lower(?)');
  for (const pattern of DELETE) {
    const r = del.run(pattern);
    console.log(`  del  ${r.changes ? '✓' : '✗ (not found)'}  ${pattern}`);
  }

  const has = db.prepare('SELECT 1 FROM merchant_rules WHERE lower(pattern) = lower(?)');
  const ins = db.prepare('INSERT INTO merchant_rules (id, pattern, category_id, created_at) VALUES (?, ?, ?, ?)');
  for (const [pattern, cat] of ADD) {
    if (has.get(pattern)) { console.log(`  add  ⃝ (exists)  ${pattern}`); continue; }
    ins.run(uuidv4(), pattern, cat, now);
    console.log(`  add  ✓  ${pattern} -> ${cat}`);
  }
});

console.log('Applying rules reset...');
run();

console.log('\nRe-categorizing the whole ledger (preserving manual categorizations)...');
const result = recategorizeAll(db);
console.log(`  recategorized ${result.updated} transaction(s)`);
console.log(`  uncategorized now: ${(db.prepare("SELECT COUNT(*) c FROM transactions WHERE category_id IS NULL").get() as { c: number }).c}`);

closeDb();
