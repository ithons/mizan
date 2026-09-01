import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildImportRunAdvisorPrompt,
  buildSyncRunAdvisorPrompt,
} from '../client/src/lib/advisorPrompts';
import type { DataImportRun, SyncRun, SyncRunDetail } from '../shared/types';

function importRun(): DataImportRun {
  return {
    id: 'import_csv',
    source: 'csv',
    status: 'partial',
    rows_seen: 10,
    rows_imported: 8,
    rows_invalid: 2,
    duplicate_candidates: 1,
    transfer_candidates: 1,
    warnings_count: 2,
    errors_count: 0,
    summary: 'Imported 8 transactions with review warnings.',
    created_at: '2026-06-30T12:00:00.000Z',
  };
}

function syncRun(overrides: Partial<SyncRun> = {}): SyncRun {
  return {
    id: overrides.id ?? 'sync_run_1',
    scope: overrides.scope ?? 'simplefin_all',
    status: overrides.status ?? 'partial',
    started_at: overrides.started_at ?? '2026-06-30T12:00:00.000Z',
    completed_at: overrides.completed_at ?? '2026-06-30T12:00:10.000Z',
    message: overrides.message ?? 'Completed with provider attention',
    error_code: overrides.error_code ?? null,
    error_message: overrides.error_message ?? null,
    recovery_action: overrides.recovery_action ?? null,
    accounts_seen: overrides.accounts_seen ?? 4,
    transactions_added: overrides.transactions_added ?? 12,
    transactions_modified: overrides.transactions_modified ?? 3,
    transactions_removed: overrides.transactions_removed ?? 1,
    transactions_skipped: overrides.transactions_skipped ?? 2,
    duplicate_candidates: overrides.duplicate_candidates ?? 1,
    transfer_candidates: overrides.transfer_candidates ?? 2,
  };
}

function syncRunDetail(overrides: Partial<SyncRunDetail> = {}): SyncRunDetail {
  const base = syncRun(overrides);
  return {
    ...base,
    items: overrides.items ?? [{
      id: 'sync_item_1',
      run_id: base.id,
      provider: 'simplefin',
      connection_id: 'item_1',
      institution_name: 'Test Bank',
      status: 'reauth_required',
      started_at: base.started_at,
      completed_at: base.completed_at,
      accounts_seen: 2,
      transactions_added: 8,
      transactions_modified: 1,
      transactions_removed: 0,
      transactions_skipped: 2,
      error_code: 'ITEM_LOGIN_REQUIRED',
      error_message: 'Bank login required',
      recovery_action: 'Reconnect Test Bank',
    }],
    changes: overrides.changes ?? [{
      id: 'sync_change_1',
      run_item_id: 'sync_item_1',
      entity_type: 'transaction',
      entity_id: 'tx_1',
      change_type: 'inserted',
      description: 'Imported City Market transaction',
      created_at: '2026-06-30T12:00:11.000Z',
    }],
  };
}

test('sync run advisor prompt captures provider status and detected changes', () => {
  const detail = syncRunDetail();
  const prompt = buildSyncRunAdvisorPrompt(detail, detail);

  assert.equal(prompt.source, 'sync');
  assert.equal(prompt.recordKind, 'sync_run');
  assert.equal(prompt.recordId, 'sync_run_1');
  assert.equal(prompt.params?.status, 'partial');
  assert.equal(prompt.params?.changedTransactions, 16);
  assert.equal(prompt.params?.providerCount, 1);
  assert.equal(prompt.params?.changeCount, 1);
  assert.match(prompt.prompt, /simplefin_all sync run/);
  assert.match(prompt.prompt, /12 added, 3 updated, 1 removed, 2 skipped/);
  assert.match(prompt.prompt, /Test Bank simplefin reauth_required/);
  assert.match(prompt.prompt, /Imported City Market transaction/);
});

test('import run advisor prompt captures audit summary', () => {
  const prompt = buildImportRunAdvisorPrompt(importRun());

  assert.equal(prompt.source, 'import');
  assert.equal(prompt.recordKind, 'import_run');
  assert.equal(prompt.recordId, 'import_csv');
  assert.equal(prompt.params?.rowsImported, 8);
  assert.match(prompt.prompt, /CSV import audit run/);
  assert.match(prompt.prompt, /imported 8\/10 rows/);
  assert.match(prompt.prompt, /duplicate candidate/);
});
