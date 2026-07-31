import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  buildLocalBackup,
  buildLocalBackupRestorePreview,
  LOCAL_BACKUP_TABLES,
  LOCAL_RESTORE_TABLES,
  restoreLocalBackup,
  LocalBackupValidationError,
  type LocalBackup,
} from '../server/src/services/localBackup';
import { confirmAdvisorDraft, undoAdvisorAction } from '../server/src/services/advisorDrafts';
import {
  migratedTestDb,
  insertAccount,
  insertCategory,
  insertTransaction,
  insertAdvisorAction,
  TEST_NOW,
} from './helpers/schema';
import type { AdvisorDraftAction, AdvisorDraftPayload } from '../shared/types';

function setupBackupDb(): Database.Database {
  const db = new Database(':memory:');

  for (const table of LOCAL_BACKUP_TABLES) {
    db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, value TEXT)`);
  }

  db.prepare('INSERT INTO accounts (id, value) VALUES (?, ?)').run('acct_1', 'Checking');
  db.prepare('INSERT INTO transactions (id, value) VALUES (?, ?)').run('txn_1', 'Coffee');
  db.prepare('INSERT INTO sync_runs (id, value) VALUES (?, ?)').run('sync_1', 'Succeeded');
  db.prepare('INSERT INTO schema_migrations (id, value) VALUES (?, ?)').run('migration_1', 'Initial');

  return db;
}

/** A backup as it actually arrives: JSON off disk, not the live object graph. */
function overTheWire(backup: LocalBackup): unknown {
  return JSON.parse(JSON.stringify(backup)) as unknown;
}

function tableCounts(db: Database.Database): Record<string, number> {
  return Object.fromEntries(
    LOCAL_BACKUP_TABLES.map((table) => [
      table,
      (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n,
    ])
  );
}

function foreignKeyViolations(db: Database.Database): unknown[] {
  return db.prepare('PRAGMA foreign_key_check').all() as unknown[];
}

interface SeededIds {
  accountId: string;
  categoryId: string;
  transactionId: string;
  securityId: string;
  actionId: string;
}

/**
 * Put at least one row in every restorable table.
 *
 * A round-trip test only proves what it populates. The nine tables this backup used to drop
 * (holdings_history, advisor_actions, advisor_drafts, conversations, messages, budget_groups,
 * budget_group_members, budget_rollover_ledger, recurring_occurrence_adjustments) were all empty
 * in the old fixtures, which is why nothing failed while the owner's price history was being
 * deleted on every restore.
 */
function seedEveryTable(db: Database.Database, tag: string): SeededIds {
  const accountId = insertAccount(db, { id: `acct_${tag}`, account_name: `Checking ${tag}` });
  const categoryId = insertCategory(db, { id: `cat_${tag}`, name: `Category ${tag}` });
  const transactionId = insertTransaction(db, {
    id: `txn_${tag}`,
    account_id: accountId,
    category_id: categoryId,
    merchant_name: `Blue Bottle ${tag}`,
    amount: -450,
  });

  const securityId = `sec_${tag}`;
  db.prepare(
    `INSERT INTO securities (id, ticker, name, type, currency) VALUES (?, ?, ?, 'etf', 'USD')`
  ).run(securityId, `TK${tag}`, `Security ${tag}`);

  db.prepare(`
    INSERT INTO holdings (id, account_id, security_id, quantity, institution_price,
                          institution_value, currency, updated_at)
    VALUES (?, ?, ?, 3.5, 241.13, 84395, 'USD', ?)
  `).run(`hold_${tag}`, accountId, securityId, TEST_NOW);

  ['2026-07-01', '2026-07-02', '2026-07-03'].forEach((date, index) => {
    db.prepare(`
      INSERT INTO holdings_history (id, account_id, security_id, date, quantity,
                                    institution_price, institution_value, created_at)
      VALUES (?, ?, ?, ?, 3.5, ?, ?, ?)
    `).run(`hist_${tag}_${index}`, accountId, securityId, date, 240 + index, 84000 + index, TEST_NOW);
  });

  const budgetId = `bud_${tag}`;
  db.prepare(`
    INSERT INTO budgets (id, category_id, amount, period, created_at, updated_at)
    VALUES (?, ?, 50000, 'monthly', ?, ?)
  `).run(budgetId, categoryId, TEST_NOW, TEST_NOW);

  db.prepare(`
    INSERT INTO budget_rollover_ledger (id, budget_id, month, starting_rollover, budget_amount,
                                        actual_spend, ending_rollover, calculated_at)
    VALUES (?, ?, '2026-07', 0, 50000, 450, 49550, ?)
  `).run(`roll_${tag}`, budgetId, TEST_NOW);

  const groupId = `grp_${tag}`;
  db.prepare(`
    INSERT INTO budget_groups (id, name, sort_order, created_at, updated_at)
    VALUES (?, ?, 0, ?, ?)
  `).run(groupId, `Group ${tag}`, TEST_NOW, TEST_NOW);
  db.prepare(`
    INSERT INTO budget_group_members (group_id, category_id, sort_order, created_at)
    VALUES (?, ?, 0, ?)
  `).run(groupId, categoryId, TEST_NOW);

  const recurringId = `rec_${tag}`;
  db.prepare(`
    INSERT INTO recurring_patterns (id, merchant_name, category_id, average_amount, frequency,
                                    last_seen, next_expected, created_at, updated_at)
    VALUES (?, ?, ?, -1200, 'monthly', '2026-07-01', '2026-08-01', ?, ?)
  `).run(recurringId, `Subscription ${tag}`, categoryId, TEST_NOW, TEST_NOW);
  db.prepare(`
    INSERT INTO recurring_occurrence_adjustments (id, recurring_id, original_date, action,
                                                  created_at, updated_at)
    VALUES (?, ?, '2026-08-01', 'skip', ?, ?)
  `).run(`adj_${tag}`, recurringId, TEST_NOW, TEST_NOW);

  const ruleId = `rule_${tag}`;
  db.prepare(`
    INSERT INTO merchant_rules (id, pattern, category_id, created_at) VALUES (?, ?, ?, ?)
  `).run(ruleId, `pattern ${tag}`, categoryId, TEST_NOW);
  db.prepare(`
    INSERT INTO merchant_rule_revisions (id, rule_id, pattern, to_category_id, source, operation,
                                         created_at)
    VALUES (?, ?, ?, ?, 'human', 'create', ?)
  `).run(`rulerev_${tag}`, ruleId, `pattern ${tag}`, categoryId, TEST_NOW);

  db.prepare(`
    INSERT INTO transaction_category_revisions (id, transaction_id, to_category_id, to_source,
                                                created_at)
    VALUES (?, ?, ?, 'human', ?)
  `).run(`txnrev_${tag}`, transactionId, categoryId, TEST_NOW);

  db.prepare(`
    INSERT INTO transaction_field_revisions (id, transaction_id, field, from_value, to_value,
                                             from_source, to_source, origin, created_at)
    VALUES (?, ?, 'merchant_name', 'BLUE BOTTLE 0042', ?, 'provider', 'human', 'owner_edit', ?)
  `).run(`fieldrev_${tag}`, transactionId, `Blue Bottle ${tag}`, TEST_NOW);

  db.prepare(`
    INSERT INTO goals (id, name, type, target_amount, account_id, created_at, updated_at)
    VALUES (?, ?, 'savings', 500000, ?, ?, ?)
  `).run(`goal_${tag}`, `Goal ${tag}`, accountId, TEST_NOW, TEST_NOW);

  db.prepare(`
    INSERT INTO coinbase_connections (id, coinbase_user_id, created_at) VALUES (?, ?, ?)
  `).run(`cb_${tag}`, `user_${tag}`, TEST_NOW);
  db.prepare('INSERT INTO simplefin_connections (id, created_at) VALUES (?, ?)')
    .run(`sf_${tag}`, TEST_NOW);

  db.prepare(`
    INSERT INTO net_worth_snapshots (id, date, total_assets, total_liabilities, net_worth,
                                     breakdown, created_at)
    VALUES (?, ?, 100000, 2000, 98000, '{}', ?)
  `).run(`snap_${tag}`, `2026-07-0${tag.length}`, TEST_NOW);

  const runId = `run_${tag}`;
  db.prepare(`
    INSERT INTO sync_runs (id, scope, status, started_at) VALUES (?, 'full', 'succeeded', ?)
  `).run(runId, TEST_NOW);
  const runItemId = `item_${tag}`;
  db.prepare(`
    INSERT INTO sync_run_items (id, run_id, provider, status, started_at)
    VALUES (?, ?, 'simplefin', 'succeeded', ?)
  `).run(runItemId, runId, TEST_NOW);
  db.prepare(`
    INSERT INTO sync_changes (id, run_item_id, entity_type, change_type, description, created_at)
    VALUES (?, ?, 'transaction', 'inserted', 'seeded', ?)
  `).run(`chg_${tag}`, runItemId, TEST_NOW);

  db.prepare(`
    INSERT OR REPLACE INTO app_preferences (key, value, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(`pref_${tag}`, 'on', TEST_NOW, TEST_NOW);

  db.prepare(`
    INSERT INTO data_import_runs (id, source, status, summary, created_at)
    VALUES (?, 'csv', 'succeeded', 'seeded', ?)
  `).run(`imp_${tag}`, TEST_NOW);

  const actionId = insertAdvisorAction(db, { id: `action_${tag}` });
  db.prepare(`
    INSERT INTO advisor_drafts (id, kind, label, summary, route, payload, changes, citations,
                                created_at, updated_at)
    VALUES (?, 'categorize_transaction', 'draft', 'draft', '/transactions', '{}', '[]', '[]', ?, ?)
  `).run(`draft_${tag}`, TEST_NOW, TEST_NOW);

  db.prepare(`
    INSERT INTO ai_feedback (id, signal, proposal_kind, action_id, transaction_id, merchant_name,
                             proposed_category_id, owner_choice, owner_category_id,
                             affected_transactions, created_at)
    VALUES (?, 'undo', 'categorize_transaction', ?, ?, ?, ?, 'uncategorized', NULL, 1, ?)
  `).run(`fb_${tag}`, actionId, transactionId, `Blue Bottle ${tag}`, categoryId, TEST_NOW);

  db.prepare(`
    INSERT INTO ai_memory (id, scope, subject, statement, kind, evidence, created_at)
    VALUES (?, 'merchant', ?, ?, 'preference', ?, ?)
  `).run(
    `mem_${tag}`,
    `Blue Bottle ${tag}`,
    `Coffee at Blue Bottle belongs in dining out for ${tag}`,
    `Categorised by hand three times in a row for ${tag}`,
    TEST_NOW
  );

  db.prepare(`
    INSERT INTO ai_incidents (id, batch_name, detected_at, month, start_date, end_date, breaches,
                              before_headlines, after_headlines, action_ids, revert_status,
                              reverted_action_ids, reverted_rows, headlines_restored, resolved_at)
    VALUES (?, 'worker_autonomous_pass', ?, '2026-07', '2026-07-01', '2026-07-31', '[]',
            '{}', '{}', ?, 'reverted', ?, 1, 1, ?)
  `).run(`inc_${tag}`, TEST_NOW, JSON.stringify([actionId]), JSON.stringify([actionId]), TEST_NOW);

  db.prepare(`
    INSERT INTO ai_runs (id, job, trigger_source, sync_run_id, model, effort, digest_section,
                         status, started_at, completed_at, proposed, applied, queued,
                         input_tokens, output_tokens, created_at)
    VALUES (?, 'background_review', 'after_sync', NULL, 'claude-sonnet-5', 'medium', 'review',
            'completed', ?, ?, 2, 1, 1, 4211, 318, ?)
  `).run(`airun_${tag}`, TEST_NOW, TEST_NOW, TEST_NOW);

  const conversationId = `conv_${tag}`;
  db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(conversationId, `Chat ${tag}`, TEST_NOW, TEST_NOW);
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, created_at)
    VALUES (?, ?, 'user', 'hello', ?)
  `).run(`msg_${tag}`, conversationId, TEST_NOW);

  return { accountId, categoryId, transactionId, securityId, actionId };
}

function draft(payload: AdvisorDraftPayload): AdvisorDraftAction {
  return {
    id: `draft_${payload.kind}`,
    kind: payload.kind,
    label: 'test draft',
    summary: 'test draft',
    route: '/transactions',
    payload,
    changes: [],
    citations: [],
    confirmation_required: true,
  } as AdvisorDraftAction;
}

test('the backup set covers every table the real migrations create', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const live = (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .all() as Array<{ name: string }>
  )
    .map((row) => row.name)
    .sort();

  // Anything in the schema and not in this list is data a "Full Local Backup" throws away.
  assert.deepEqual(live, [...LOCAL_BACKUP_TABLES].sort());
});

test('the backup set lists every parent before its children', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const position = new Map<string, number>(
    LOCAL_BACKUP_TABLES.map((table, index) => [table as string, index])
  );

  for (const table of LOCAL_BACKUP_TABLES) {
    const parents = db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as Array<{ table: string }>;
    for (const parent of parents) {
      // A self-reference (categories.parent_id) is a within-table ordering question, and the
      // restore answers it by writing with foreign_keys OFF.
      if (parent.table === table) continue;
      const parentIndex = position.get(parent.table);
      assert.notEqual(parentIndex, undefined, `${parent.table} is missing from the backup set`);
      assert.ok(
        (parentIndex as number) < (position.get(table) as number),
        `${table} must be listed after its parent ${parent.table}`
      );
    }
  }
});

test('a backup round-trips every table in the closure', (t) => {
  const source = migratedTestDb();
  const target = migratedTestDb();
  t.after(() => source.close());
  t.after(() => target.close());

  seedEveryTable(source, 'src');
  // The target starts full of unrelated data, which is the case that used to break: rows in an
  // uncovered table outlived the restore and pointed at accounts the restore had just deleted.
  seedEveryTable(target, 'tgt');

  const before = tableCounts(source);
  const result = restoreLocalBackup(target, overTheWire(buildLocalBackup(source)));
  const after = tableCounts(target);

  for (const table of LOCAL_RESTORE_TABLES) {
    assert.equal(after[table], before[table], `${table} row count survived the round trip`);
    assert.ok(before[table] > 0, `${table} was actually populated by the fixture`);
  }

  assert.equal(result.restored_tables, LOCAL_RESTORE_TABLES.length);
  assert.deepEqual(result.skipped_tables, ['schema_migrations']);
  assert.deepEqual(result.warnings, []);

  for (const table of ['holdings_history', 'advisor_actions', 'messages', 'budget_rollover_ledger']) {
    assert.deepEqual(
      target.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all(),
      source.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all(),
      `${table} restored row for row`
    );
  }

  assert.deepEqual(foreignKeyViolations(target), [], 'restore left no dangling references');
});

test('an AI action is still undoable after a restore', (t) => {
  const source = migratedTestDb();
  const target = migratedTestDb();
  t.after(() => source.close());
  t.after(() => target.close());

  const accountId = insertAccount(source);
  const categoryId = insertCategory(source, { name: 'Coffee' });
  const transactionId = insertTransaction(source, {
    account_id: accountId,
    merchant_name: 'Blue Bottle Coffee',
  });

  confirmAdvisorDraft(
    source,
    draft({ kind: 'categorize_transaction', transaction_id: transactionId, category_id: categoryId }),
    true,
    'worker_auto'
  );
  const action = source.prepare('SELECT id FROM advisor_actions').get() as { id: string };

  restoreLocalBackup(target, overTheWire(buildLocalBackup(source)));

  // advisor_actions and transaction_category_revisions were both outside the old backup set, so
  // the restored row kept a category_action_id pointing at an action that no longer existed and
  // POST /api/ai/actions/:id/undo answered 404 forever.
  const restored = target
    .prepare('SELECT category_id, category_action_id FROM transactions WHERE id = ?')
    .get(transactionId) as { category_id: string | null; category_action_id: string | null };
  assert.equal(restored.category_id, categoryId);
  assert.equal(restored.category_action_id, action.id);

  const undone = undoAdvisorAction(target, action.id);
  assert.equal(undone.ok, true);
  assert.equal(undone.reverted, 1);

  const reverted = target
    .prepare('SELECT category_id FROM transactions WHERE id = ?')
    .get(transactionId) as { category_id: string | null };
  assert.equal(reverted.category_id, null);
});

test('a backup that predates a table restores with a warning instead of a 400', (t) => {
  const source = migratedTestDb();
  const target = migratedTestDb();
  t.after(() => source.close());
  t.after(() => target.close());

  seedEveryTable(source, 'src');
  seedEveryTable(target, 'tgt');

  const wire = overTheWire(buildLocalBackup(source)) as {
    tables: Record<string, unknown>;
  };
  delete wire.tables.holdings_history;
  delete wire.tables.advisor_drafts;

  const preview = buildLocalBackupRestorePreview(target, wire);
  assert.equal(preview.valid, true, 'an absent table is not a reason to reject intact data');
  assert.deepEqual(preview.errors, []);
  assert.ok(preview.warnings.some((warning) => warning.includes('predates table holdings_history')));
  assert.ok(preview.warnings.some((warning) => warning.includes('predates table advisor_drafts')));

  // The N/M the owner sees: two of the covered tables are not supplied by this backup.
  assert.equal(preview.table_count, LOCAL_RESTORE_TABLES.length);
  assert.equal(preview.restorable_table_count, LOCAL_RESTORE_TABLES.length - 2);
  assert.equal(
    preview.tables.find((table) => table.table === 'holdings_history')?.present_in_backup,
    false
  );

  const result = restoreLocalBackup(target, wire);
  assert.equal(result.warnings.length, 2);

  const counts = tableCounts(target);
  assert.equal(counts.holdings_history, 0, 'an absent table restores empty');
  assert.equal(counts.advisor_drafts, 0);
  assert.equal(counts.transactions, 1, 'everything the backup did carry landed');
  assert.equal(counts.advisor_actions, 1);
  assert.deepEqual(foreignKeyViolations(target), []);
});

test('a present-but-malformed table key is still a hard error', (t) => {
  const target = migratedTestDb();
  t.after(() => target.close());

  seedEveryTable(target, 'tgt');
  const wire = overTheWire(buildLocalBackup(target)) as { tables: Record<string, unknown> };
  wire.tables.holdings_history = null;

  const preview = buildLocalBackupRestorePreview(target, wire);
  assert.equal(preview.valid, false);
  assert.ok(preview.errors.some((error) => error.includes('holdings_history must be an array')));
  assert.throws(() => restoreLocalBackup(target, wire), LocalBackupValidationError);
});

test('a backup with dangling references previews as blocked, not ready', (t) => {
  const source = migratedTestDb();
  const target = migratedTestDb();
  t.after(() => source.close());
  t.after(() => target.close());

  seedEveryTable(source, 'src');

  const wire = overTheWire(buildLocalBackup(source)) as {
    tables: Record<string, Array<Record<string, unknown>>>;
  };
  wire.tables.accounts = wire.tables.accounts.filter((row) => row.id !== 'acct_src');

  // The restore's own foreign_key_check would catch this, but only after the preview had told
  // the owner "Ready" and the restore had already deleted everything it was replacing.
  const preview = buildLocalBackupRestorePreview(target, wire);
  assert.equal(preview.valid, false);
  assert.ok(
    preview.errors.some((error) => error.includes('transactions') && error.includes('accounts')),
    `expected an orphan report, got: ${preview.errors.join(' | ')}`
  );

  assert.throws(() => restoreLocalBackup(target, wire), LocalBackupValidationError);
  assert.equal(tableCounts(target).transactions, 0, 'nothing was written');
});

test('local backup exports all configured tables with metadata', (t) => {
  const db = setupBackupDb();
  t.after(() => db.close());

  const backup = buildLocalBackup(db, new Date('2026-06-30T12:00:00.000Z'));

  assert.equal(backup.app, 'mizan');
  assert.equal(backup.version, 1);
  assert.equal(backup.exported_at, '2026-06-30T12:00:00.000Z');
  assert.deepEqual(Object.keys(backup.tables), [...LOCAL_BACKUP_TABLES]);
  assert.deepEqual(backup.tables.accounts, [{ id: 'acct_1', value: 'Checking' }]);
  assert.deepEqual(backup.tables.transactions, [{ id: 'txn_1', value: 'Coffee' }]);
  assert.deepEqual(backup.tables.sync_runs, [{ id: 'sync_1', value: 'Succeeded' }]);
  assert.ok(!('credentials' in backup.tables));
});

test('local backup restore preview validates row counts and skips migration state', (t) => {
  const db = setupBackupDb();
  t.after(() => db.close());

  const backup = buildLocalBackup(db, new Date('2026-06-30T12:00:00.000Z'));
  const preview = buildLocalBackupRestorePreview(db, backup);
  const migrationTable = preview.tables.find((table) => table.table === 'schema_migrations');

  assert.equal(preview.valid, true);
  assert.equal(preview.app, 'mizan');
  assert.equal(preview.version, 1);
  assert.equal(preview.table_count, LOCAL_RESTORE_TABLES.length);
  assert.equal(preview.restorable_table_count, LOCAL_RESTORE_TABLES.length);
  assert.equal(preview.restorable_rows, 3);
  assert.equal(migrationTable?.restorable, false);
  assert.equal(migrationTable?.backup_rows, 1);
});

test('local backup restore replaces data tables without rewriting schema migrations', (t) => {
  const source = setupBackupDb();
  const target = setupBackupDb();
  t.after(() => source.close());
  t.after(() => target.close());

  source.prepare('INSERT INTO accounts (id, value) VALUES (?, ?)').run('acct_2', 'Savings');
  target.prepare('INSERT INTO accounts (id, value) VALUES (?, ?)').run('acct_old', 'Old Checking');
  target.prepare('INSERT INTO schema_migrations (id, value) VALUES (?, ?)').run('migration_current', 'Current');

  const backup = buildLocalBackup(source, new Date('2026-06-30T12:00:00.000Z'));
  const result = restoreLocalBackup(target, backup);

  assert.equal(result.restored_tables, LOCAL_RESTORE_TABLES.length);
  assert.equal(result.restored_rows, 4);
  assert.deepEqual(result.skipped_tables, ['schema_migrations']);
  assert.deepEqual(
    target.prepare('SELECT * FROM accounts ORDER BY id').all(),
    [
      { id: 'acct_1', value: 'Checking' },
      { id: 'acct_2', value: 'Savings' },
    ]
  );
  assert.deepEqual(
    target.prepare('SELECT * FROM schema_migrations ORDER BY id').all(),
    [
      { id: 'migration_1', value: 'Initial' },
      { id: 'migration_current', value: 'Current' },
    ]
  );
});

test('local backup restore rejects unsupported columns before mutation', (t) => {
  const db = setupBackupDb();
  t.after(() => db.close());

  const backup = buildLocalBackup(db, new Date('2026-06-30T12:00:00.000Z'));
  backup.tables.accounts = [
    { id: 'acct_2', value: 'Savings', unsupported_column: true },
  ];

  const preview = buildLocalBackupRestorePreview(db, backup);
  assert.equal(preview.valid, false);
  assert.ok(preview.errors.some((error) => error.includes('unsupported_column')));

  assert.throws(
    () => restoreLocalBackup(db, backup),
    LocalBackupValidationError
  );
  assert.deepEqual(
    db.prepare('SELECT * FROM accounts ORDER BY id').all(),
    [{ id: 'acct_1', value: 'Checking' }]
  );
});
