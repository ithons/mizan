import test from 'node:test';
import assert from 'node:assert/strict';
import { format } from 'date-fns';
import { migratedTestDb, insertAccount, insertCategory, insertTransaction } from './helpers/schema';
import {
  ENUM_MEANINGS,
  TABLE_MEANINGS,
  buildSchemaDoc,
  describeTables,
  getCategoryProvenance,
  transactionReportInclusion,
} from '../server/src/services/schemaDoc';
import {
  excludedFromTotalsSql,
  expenseSideSql,
  incomeSideSql,
  spendAmountSql,
} from '../server/src/services/transactionFilters';
import { getCashflowReport, getSpendingReport } from '../server/src/services/reporting';

// Every test that reads a date-derived field pins `now`, so the suite says the same thing in
// August as it does today. The doc derives its worked example from this date.
const NOW = new Date(2026, 6, 15, 9, 0, 0);

function docFor(db: ReturnType<typeof migratedTestDb>) {
  return buildSchemaDoc(db, NOW);
}

/**
 * A documented column, from whichever level of detail carries it.
 *
 * Tables outside ALWAYS_DETAILED_TABLES come back as names only, so the meanings for those are
 * fetched with describeTables, which is the same path the tool uses for a second call.
 */
function column(db: ReturnType<typeof migratedTestDb>, table: string, name: string) {
  const doc = docFor(db);
  const listed = doc.tables.find((entry) => entry.table === table);
  assert.ok(listed, `expected table ${table}`);
  const detailed = listed.detail === 'full' ? listed : describeTables(db, [table]).tables[0];
  assert.ok(detailed && detailed.detail === 'full', `expected full detail for ${table}`);
  const c = detailed.columns.find((entry) => entry.name === name);
  assert.ok(c, `expected column ${table}.${name}`);
  return c;
}

// ─── The dictionary must describe the schema that exists, in both directions ───

test('every documented table and column exists in the migrated schema', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const live = new Map<string, Set<string>>();
  for (const { name } of db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>) {
    live.set(
      name,
      new Set((db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>).map((c) => c.name))
    );
  }

  for (const [table, meaning] of Object.entries(TABLE_MEANINGS)) {
    const columns = live.get(table);
    assert.ok(columns, `schemaDoc documents a table that no longer exists: ${table}`);
    for (const name of Object.keys(meaning.columns)) {
      assert.ok(columns.has(name), `schemaDoc documents a column that no longer exists: ${table}.${name}`);
    }
  }

  for (const meaning of Object.values(ENUM_MEANINGS)) {
    const columns = live.get(meaning.table);
    assert.ok(columns, `enum documented on a missing table: ${meaning.table}`);
    assert.ok(columns.has(meaning.column), `enum documented on a missing column: ${meaning.table}.${meaning.column}`);
  }
});

test('describes only columns the database actually has, at either level of detail', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());
  const doc = docFor(db);

  for (const table of doc.tables) {
    const live = new Set(
      (db.prepare(`PRAGMA table_info("${table.table}")`).all() as Array<{ name: string }>).map((c) => c.name)
    );
    const named =
      table.detail === 'full' ? table.columns.map((c) => c.name) : table.column_names.split(', ');
    assert.ok(named.length > 0, `${table.table} listed no columns at all`);
    for (const name of named) {
      assert.ok(live.has(name), `${table.table}.${name} is described but not present`);
    }
    // The index must name EVERY column, so "not in the list" is safe to read as "not a column".
    assert.equal(named.length, live.size, `${table.table} listed ${named.length} of ${live.size} columns`);
  }
});

// ─── Weight: the dictionary is read inside a tool loop, so its size is a correctness concern ───

test('the default doc lists every table, and expands the three every spend query reads', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());
  const doc = docFor(db);

  const liveNames = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);

  assert.equal(doc.tables.length, liveNames.length, 'every table is listed, whatever its detail level');
  assert.deepEqual(doc.detail.expanded, ['accounts', 'categories', 'transactions']);
  for (const name of doc.detail.expanded) {
    assert.equal(doc.tables.find((entry) => entry.table === name)?.detail, 'full');
  }
  // A withheld note must never read as an absent note.
  const holdings = doc.tables.find((entry) => entry.table === 'holdings');
  assert.equal(holdings?.detail, 'names_only');
  assert.match(doc.detail.note, /NOT a statement that none are documented/);
});

test('expanding a table returns that table and says what it left out', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const detail = describeTables(db, ['holdings', 'no_such_table']);
  assert.equal(detail.tables.length, 1);
  const holdings = detail.tables[0];
  assert.equal(holdings.table, 'holdings');
  assert.equal(holdings.detail, 'full');
  assert.ok(holdings.detail === 'full');
  assert.match(
    holdings.columns.find((c) => c.name === 'institution_price')?.unit ?? '',
    /REAL DOLLARS PER UNIT/
  );

  // An unknown name is reported, not silently dropped into an empty answer.
  assert.deepEqual(detail.requested_but_unknown, ['no_such_table']);
  // And the omission of the predicates is stated, because a model that never saw them would
  // otherwise write a spend query without them.
  assert.match(detail.note, /NOT repeated here/);

  const full = Buffer.byteLength(JSON.stringify(docFor(db)), 'utf8');
  const expansion = Buffer.byteLength(JSON.stringify(detail), 'utf8');
  assert.ok(expansion * 4 < full, `an expansion (${expansion} b) must be far cheaper than the doc (${full} b)`);
});

// ─── The predicates are generated, not transcribed ───

test('predicates are the literal output of transactionFilters, character for character', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());
  const doc = docFor(db);

  assert.equal(doc.predicates.excluded_from_totals, excludedFromTotalsSql('t'));
  assert.equal(doc.predicates.income_side, incomeSideSql('t', 'c'));
  assert.equal(doc.predicates.expense_side, expenseSideSql('t', 'c'));
  assert.equal(doc.predicates.spend_amount, spendAmountSql('t'));
});

test('the worked example covers the month it is generated in, not a month someone typed', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const july = buildSchemaDoc(db, new Date(2026, 6, 15));
  assert.ok(july.predicates.example.includes("'2026-07-01' AND '2026-07-31'"), july.predicates.example);
  assert.match(july.predicates.example_range, /2026-07-01 to 2026-07-31/);

  // The bug this replaces: hardcoded July literals sitting next to a live today_local, so from
  // August the doc offered a stale month and called it ready to paste.
  const august = buildSchemaDoc(db, new Date(2026, 7, 3));
  assert.ok(august.predicates.example.includes("'2026-08-01' AND '2026-08-31'"), august.predicates.example);
  assert.equal(august.time.today_local, '2026-08-03');

  // February, because a month length that is not 31 is where a hand-written literal goes wrong.
  const february = buildSchemaDoc(db, new Date(2028, 1, 10));
  assert.ok(february.predicates.example.includes("'2028-02-01' AND '2028-02-29'"), february.predicates.example);
});

test('the worked example the model is invited to paste actually runs', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());
  const doc = docFor(db);

  const food = insertCategory(db, { name: 'Food' });
  const account = insertAccount(db);
  insertTransaction(db, { account_id: account, date: '2026-07-05', amount: -5000, category_id: food });
  // A refund: positive, inside an expense category. It must net the total down, not vanish and not
  // read as income.
  insertTransaction(db, { account_id: account, date: '2026-07-06', amount: 2000, category_id: food });
  // A transfer between the owner's own accounts must not reach the total at all.
  db.prepare("UPDATE transactions SET transfer_status = 'confirmed' WHERE id = ?").run(
    insertTransaction(db, { account_id: account, date: '2026-07-07', amount: -9900, category_id: food })
  );

  const row = db.prepare(doc.predicates.example).get() as { spend_cents: number };
  assert.equal(row.spend_cents, 3000, 'purchase minus refund, transfer excluded');
});

// ─── Units ───

test('money units name the cents rule and the REAL exceptions as exceptions', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());
  const doc = docFor(db);

  assert.match(doc.money.rule, /INTEGER number of CENTS/);
  assert.ok(
    doc.money.real_dollar_exceptions.some((line) => line.includes('holdings.institution_price')),
    'institution_price must be named as a REAL-dollars exception'
  );
  assert.ok(
    doc.money.not_money.some((line) => line.includes('transactions.quantity')),
    'transactions.quantity must be named as not money'
  );

  assert.match(column(db, 'transactions', 'amount').unit ?? '', /integer cents/);
  assert.match(column(db, 'holdings', 'institution_price').unit ?? '', /REAL DOLLARS PER UNIT/);
  assert.match(column(db, 'holdings', 'institution_value').unit ?? '', /integer cents/);
  assert.match(column(db, 'transactions', 'quantity').unit ?? '', /NOT money/);
  assert.match(column(db, 'accounts', 'native_balance').unit ?? '', /NOT money/);
});

// ─── Sign conventions ───

test('sign conventions cover the three readings that have already gone wrong here', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());
  const doc = docFor(db);
  const text = doc.sign_conventions.join('\n');

  assert.match(text, /negative means money LEFT the account/i);
  // A liability in credit: stored negative, raises net worth, must never be Math.abs'd.
  assert.match(text, /NEGATIVE, which means the card is in credit/);
  assert.match(text, /Never Math\.abs it/);
  assert.match(text, /refund is a POSITIVE amount inside an EXPENSE category. It is not income/i);

  assert.match(column(db, 'accounts', 'current_balance').note ?? '', /may legitimately be NEGATIVE/);
});

// ─── Enums ───

test('category_source NULL is documented as pre-provenance and counted, never asserted', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const account = insertAccount(db);
  const cat = insertCategory(db);
  insertTransaction(db, { account_id: account, category_id: cat, category_source: null });
  insertTransaction(db, { account_id: account, category_id: cat, category_source: null });
  insertTransaction(db, { account_id: account, category_id: cat, category_source: 'human' });

  const doc = docFor(db);
  const meaning = doc.enums.category_source;
  assert.match(meaning.note ?? '', /NULL is not zero/i);
  assert.equal(meaning.observed.NULL, 2);
  assert.equal(meaning.observed.human, 1);
  assert.deepEqual(meaning.undocumented_values, []);
});

test('a healthy ledger reports no undocumented enum values anywhere', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const cat = insertCategory(db);
  for (const type of ['checking', 'credit', 'brokerage', 'crypto_wallet']) {
    const account = insertAccount(db, { type, connection_type: 'simplefin' });
    insertTransaction(db, { account_id: account, category_id: cat, category_source: 'rule' });
  }
  db.prepare("UPDATE transactions SET transfer_status = 'candidate' WHERE rowid = 1").run();
  db.prepare("UPDATE transactions SET duplicate_status = 'dismissed' WHERE rowid = 2").run();
  db.prepare("UPDATE transactions SET review_status = 'reviewed' WHERE rowid = 3").run();

  const doc = docFor(db);
  for (const [key, meaning] of Object.entries(doc.enums)) {
    assert.deepEqual(meaning.undocumented_values, [], `${key} reported an undocumented value on healthy data`);
  }
});

test('an empty database produces no enum noise at all', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());
  const doc = docFor(db);

  for (const [key, meaning] of Object.entries(doc.enums)) {
    assert.deepEqual(meaning.undocumented_values, [], `${key} fired on an empty database`);
  }
  assert.deepEqual(doc.enums.transfer_status.observed, {});
});

// ─── Time ───

test('today_local is the LOCAL date, which is the thing date(now) gets wrong', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  // 23:30 local on the 30th is already the 31st in UTC for any timezone west of Greenwich. The
  // literal must follow the owner's calendar, because every month boundary in this app does.
  const evening = new Date(2026, 6, 30, 23, 30, 0);
  const doc = buildSchemaDoc(db, evening);
  assert.equal(doc.time.today_local, format(evening, 'yyyy-MM-dd'));
  assert.equal(doc.time.today_local, '2026-07-30');
  assert.match(doc.time.warning, /date\('now'\) is UTC/);
});

// ─── Reconstructions ───

test('reconstructions are named as reconstructions', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());
  const doc = docFor(db);
  const text = doc.reconstructions.join('\n');

  assert.match(text, /is_estimated = 1 are RECONSTRUCTED/);
  assert.match(text, /balanceHistory/);
  assert.match(column(db, 'net_worth_snapshots', 'is_estimated').note ?? '', /RECONSTRUCTION, not a measurement/);
});

// ─── Provenance summary ───

test('getCategoryProvenance counts what is there and separates NULL from zero', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const account = insertAccount(db);
  const cat = insertCategory(db);
  insertTransaction(db, { account_id: account, category_id: cat });                                    // NULL source
  insertTransaction(db, { account_id: account, category_id: cat, category_source: 'human' });
  insertTransaction(db, { account_id: account, category_id: cat, manually_categorized: 1 });           // owner, other marker
  insertTransaction(db, { account_id: account, category_id: null });                                   // uncategorized

  const summary = getCategoryProvenance(db);
  assert.equal(summary.total_transactions, 4);
  assert.equal(summary.categorized, 3);
  assert.equal(summary.uncategorized, 1);
  assert.equal(summary.owner_chosen, 2, 'both markers count as the owner choosing');
  assert.equal(summary.ai_rows_with_a_live_action, 0);

  const nullEntry = summary.by_source.find((entry) => entry.source === 'NULL');
  assert.ok(nullEntry);
  // Three rows carry a NULL source: the pre-provenance one, the one marked only by the older
  // manually_categorized flag, and the uncategorized one. NULL is a state, not an absence.
  assert.equal(nullEntry.transactions, 3);
  assert.match(nullEntry.meaning, /NOT zero, and NOT the machine/);
});

test('an AI row keeps its live action only while the action still owns it', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const account = insertAccount(db);
  const cat = insertCategory(db);
  insertTransaction(db, { account_id: account, category_id: cat, category_source: 'ai', category_action_id: 'act_1' });
  insertTransaction(db, { account_id: account, category_id: cat, category_source: 'ai', category_action_id: null });

  const summary = getCategoryProvenance(db);
  assert.equal(summary.ai_rows_with_a_live_action, 1, 'a cleared action id is not a live action');
});

// ─── The worked example must agree with the page it claims to agree with ───

test('the example returns the same total as getSpendingReport, on data built to break it', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const account = insertAccount(db);
  // The seeded tree already carries the three roots Reports drops wholesale. cat_xfer_out is a
  // CHILD of one of them, and it is the point: the exclusion is a tree, and a flat NOT IN on the
  // roots would let every child through.
  insertTransaction(db, { account_id: account, date: '2026-07-02', amount: -8000, category_id: 'cat_food' });
  insertTransaction(db, { account_id: account, date: '2026-07-03', amount: 2500, category_id: 'cat_food' });   // refund
  insertTransaction(db, { account_id: account, date: '2026-07-04', amount: -50000, category_id: 'cat_xfer_out' });
  insertTransaction(db, { account_id: account, date: '2026-07-05', amount: -25000, category_id: 'cat_inv' });
  insertTransaction(db, { account_id: account, date: '2026-07-06', amount: -1000, category_id: 'cat_crypto' });
  insertTransaction(db, { account_id: account, date: '2026-07-07', amount: -1500, category_id: null });        // uncategorized
  insertTransaction(db, { account_id: account, date: '2026-07-08', amount: -9900, category_id: 'cat_food', pending: 1 });
  db.prepare("UPDATE transactions SET duplicate_status = 'confirmed' WHERE id = ?").run(
    insertTransaction(db, { account_id: account, date: '2026-07-09', amount: -4200, category_id: 'cat_food' })
  );

  const doc = docFor(db);
  const example = (db.prepare(doc.predicates.example).get() as { spend_cents: number }).spend_cents;
  const report = getSpendingReport(db, { startDate: '2026-07-01', endDate: '2026-07-31' });

  assert.equal(example, report.total, 'the pasted example must not disagree with the Reports page');
  assert.equal(example, 7000, '$80 purchase, less a $25 refund, plus $15 uncategorized');
});

// ─── "Does this row count?" must be answered by the report's own predicates ───

test('per-row inclusion agrees with getSpendingReport and getCashflowReport, row for row', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const account = insertAccount(db);
  const income = insertCategory(db, { name: 'Salary', is_income: 1 });
  const ids: string[] = [
    insertTransaction(db, { account_id: account, date: '2026-07-02', amount: -8000, category_id: 'cat_food' }),
    insertTransaction(db, { account_id: account, date: '2026-07-03', amount: 2500, category_id: 'cat_food' }),
    insertTransaction(db, { account_id: account, date: '2026-07-04', amount: -20000, category_id: 'cat_xfer_out' }),
    insertTransaction(db, { account_id: account, date: '2026-07-05', amount: -50000, category_id: 'cat_inv_transfer' }),
    insertTransaction(db, { account_id: account, date: '2026-07-06', amount: -1000, category_id: 'cat_crypto' }),
    insertTransaction(db, { account_id: account, date: '2026-07-07', amount: -1500, category_id: null }),
    insertTransaction(db, { account_id: account, date: '2026-07-08', amount: -9900, category_id: 'cat_food', pending: 1 }),
    insertTransaction(db, { account_id: account, date: '2026-07-09', amount: 400000, category_id: income }),
  ];
  const duplicate = insertTransaction(db, { account_id: account, date: '2026-07-10', amount: -4200, category_id: 'cat_food' });
  db.prepare("UPDATE transactions SET duplicate_status = 'confirmed' WHERE id = ?").run(duplicate);
  const candidate = insertTransaction(db, { account_id: account, date: '2026-07-11', amount: -7700, category_id: 'cat_food' });
  db.prepare("UPDATE transactions SET transfer_status = 'candidate' WHERE id = ?").run(candidate);
  ids.push(duplicate, candidate);

  const amountOf = db.prepare('SELECT amount FROM transactions WHERE id = ?');
  let spend = 0;
  let earned = 0;
  for (const id of ids) {
    const inclusion = transactionReportInclusion(db, id);
    assert.ok(inclusion, `no inclusion for ${id}`);
    const amount = (amountOf.get(id) as { amount: number }).amount;
    if (!inclusion.counts) {
      assert.ok(inclusion.excluded_because.length > 0, `${id} does not count but gives no reason`);
      continue;
    }
    assert.deepEqual(inclusion.excluded_because, [], `${id} counts but carries a reason it does not`);
    if (inclusion.side === 'expense') spend += -amount;
    else earned += amount;
  }

  const report = getSpendingReport(db, { startDate: '2026-07-01', endDate: '2026-07-31' });
  const cashflow = getCashflowReport(db, { startDate: '2026-07-01', endDate: '2026-07-31' });
  assert.equal(spend, report.total, 'the per-row answer must add up to the page it claims to describe');
  assert.equal(spend, 7000, '$80 purchase, less a $25 refund, plus $15 uncategorized');
  assert.equal(earned, cashflow.months[0].income);
  assert.equal(earned, 400000);
});

test('an ordinary categorized purchase is included, with nothing said against it', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const account = insertAccount(db);
  const id = insertTransaction(db, { account_id: account, date: '2026-07-12', amount: -4250, category_id: 'cat_food' });

  assert.deepEqual(transactionReportInclusion(db, id), {
    counts: true,
    side: 'expense',
    excluded_because: [],
  });
});

test('each exclusion names the predicate that dropped the row', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const account = insertAccount(db);
  const investment = insertTransaction(db, { account_id: account, date: '2026-07-05', amount: -50000, category_id: 'cat_inv_transfer' });
  const pending = insertTransaction(db, { account_id: account, date: '2026-07-06', amount: -2000, category_id: 'cat_food', pending: 1 });
  const transfer = insertTransaction(db, { account_id: account, date: '2026-07-07', amount: -2000, category_id: 'cat_food' });
  db.prepare("UPDATE transactions SET transfer_status = 'confirmed' WHERE id = ?").run(transfer);

  const investmentReading = transactionReportInclusion(db, investment);
  assert.equal(investmentReading?.counts, false);
  assert.match(investmentReading?.excluded_because.join(' ') ?? '', /cat_xfer, cat_inv, cat_crypto/);

  const pendingReading = transactionReportInclusion(db, pending);
  assert.equal(pendingReading?.counts, false);
  assert.match(pendingReading?.excluded_because.join(' ') ?? '', /pending = 1/);

  const transferReading = transactionReportInclusion(db, transfer);
  assert.equal(transferReading?.counts, false);
  assert.match(transferReading?.excluded_because.join(' ') ?? '', /transfer_status = 'confirmed'/);
});

test('inclusion on an id that is not there is null, not a default answer', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());
  assert.equal(transactionReportInclusion(db, 'nope'), null);
});

test('the report scope predicate is exposed separately, so it cannot be left off by accident', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());
  const doc = docFor(db);

  assert.match(doc.predicates.report_scope_cte, /excluded_report_categories/);
  assert.match(doc.predicates.report_scope_condition, /excluded_report_categories/);
  assert.ok(doc.predicates.example.includes(doc.predicates.report_scope_cte));
  assert.ok(doc.predicates.example.includes(doc.predicates.report_scope_condition));
  assert.match(doc.predicates.usage, /report_scope_cte/);
});

/**
 * The three frozen split columns carry their caveat to the model.
 *
 * `liquid_assets`, `investment_assets` and `crypto_assets` are frozen from the ACCOUNT TYPES in
 * force when the snapshot was written. An account retyped later does not move in them, so a row
 * can be a genuine measurement (`is_estimated = 0`) and still split the same money differently
 * from `breakdown`. `routes/reports.ts` already refuses to read `investment_assets` for exactly
 * this reason, naming two measured days on this ledger where it says $0.00 against a portfolio
 * holding $1,661.66. The schema doc published all three as bare `CENTS`, with the caveats sitting
 * on `is_estimated` and `covered_accounts` instead, so the one warning the model needed to not
 * quote a wrong split was the one it did not get.
 */
test('the frozen asset-split columns are published with their caveat, not as bare cents', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  for (const name of ['liquid_assets', 'investment_assets', 'crypto_assets']) {
    const c = column(db, 'net_worth_snapshots', name);
    assert.ok(c.note, `${name} is published with no note at all`);
    assert.match(c.note, /frozen from the ACCOUNT TYPES/i, `${name} is published with no caveat`);
    assert.match(c.note, /breakdown/i, `${name}'s caveat does not name what to use instead`);
  }

  // The contrast: a column that IS what it says stays uncluttered.
  assert.equal(column(db, 'net_worth_snapshots', 'total_assets').note, undefined);
});
