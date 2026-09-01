/**
 * Questions a screen can hand to the Cmd+K sheet about the thing it is showing.
 *
 * Two builders, for the two surfaces that still ask: the sync activity panel and the CSV import
 * record. There were sixteen. The other fourteen wrote questions about Reports, the Dashboard
 * cards, and per-row asks on budgets, goals, holdings, transactions and accounts, all of which the
 * 12-to-6 consolidation deleted; the builders outlived their screens by a month with 700 lines of
 * passing tests, because a builder with no caller does not fail anything. They are gone rather
 * than re-homed, with the argument: Cmd+K is the one conversational surface, it builds its own
 * context server-side (`buildFinancialContext`), and a client-side builder that pre-writes a
 * question about a screen is worth keeping exactly as long as that screen exists.
 * `tests/advisorPromptCallers.test.ts` fails on any builder added here without a caller.
 */
import type { AdvisorRoutePrompt } from './askAdvisor';
import type {
  DataImportRun,
  SyncRun,
  SyncRunDetail,
} from '@shared/types';

function summarizeSyncItems(detail?: SyncRunDetail): string {
  if (!detail || detail.items.length === 0) return 'detail not loaded';
  return detail.items
    .slice(0, 5)
    .map((item) => {
      const issue = item.error_message ? `, issue ${item.error_message}` : '';
      const recovery = item.recovery_action ? `, recovery ${item.recovery_action}` : '';
      return `${item.institution_name} ${item.provider} ${item.status}: ${item.accounts_seen} accounts, ${item.transactions_added} added, ${item.transactions_modified} updated, ${item.transactions_removed} removed, ${item.transactions_skipped} skipped${issue}${recovery}`;
    })
    .join('; ');
}

function summarizeSyncChanges(detail?: SyncRunDetail): string {
  if (!detail || detail.changes.length === 0) return detail ? 'none' : 'detail not loaded';
  return detail.changes
    .slice(0, 5)
    .map((change) => `${change.entity_type} ${change.change_type}: ${change.description}`)
    .join('; ');
}

export function buildSyncRunAdvisorPrompt(
  run: SyncRun,
  detail?: SyncRunDetail
): AdvisorRoutePrompt {
  const providerSummary = summarizeSyncItems(detail);
  const changeSummary = summarizeSyncChanges(detail);
  const changedTransactions = run.transactions_added + run.transactions_modified + run.transactions_removed;

  return {
    source: 'sync',
    recordKind: 'sync_run',
    recordId: run.id,
    params: {
      runId: run.id,
      scope: run.scope,
      status: run.status,
      startedAt: run.started_at,
      completedAt: run.completed_at ?? null,
      accountsSeen: run.accounts_seen,
      transactionsAdded: run.transactions_added,
      transactionsModified: run.transactions_modified,
      transactionsRemoved: run.transactions_removed,
      transactionsSkipped: run.transactions_skipped,
      changedTransactions,
      duplicateCandidates: run.duplicate_candidates,
      transferCandidates: run.transfer_candidates,
      errorCode: run.error_code ?? null,
      errorMessage: run.error_message ?? null,
      recoveryAction: run.recovery_action ?? null,
      providerCount: detail?.items.length ?? null,
      changeCount: detail?.changes.length ?? null,
      providerSummary,
      changeSummary,
    },
    prompt: [
      `Explain this ${run.scope} sync run from ${run.started_at}.`,
      `Status is ${run.status}${run.completed_at ? `, completed at ${run.completed_at}` : ''}.`,
      `It saw ${run.accounts_seen} account${run.accounts_seen === 1 ? '' : 's'} and changed ${changedTransactions} transaction${changedTransactions === 1 ? '' : 's'}: ${run.transactions_added} added, ${run.transactions_modified} updated, ${run.transactions_removed} removed, ${run.transactions_skipped} skipped.`,
      `${run.duplicate_candidates} duplicate candidate group${run.duplicate_candidates === 1 ? '' : 's'} and ${run.transfer_candidates} transfer candidate pair${run.transfer_candidates === 1 ? '' : 's'} were detected.`,
      run.error_message ? `Run issue: ${run.error_message}.` : 'No run-level issue is recorded.',
      run.recovery_action ? `Suggested recovery: ${run.recovery_action}.` : 'No run-level recovery action is recorded.',
      `Provider detail: ${providerSummary}.`,
      `Detected changes: ${changeSummary}.`,
      'Explain what changed, whether this sync result should affect account balances or reports, and what I should do next if anything needs recovery or review.',
    ].join(' '),
  };
}

export function buildImportRunAdvisorPrompt(run: DataImportRun): AdvisorRoutePrompt {
  return {
    source: 'import',
    recordKind: 'import_run',
    recordId: run.id,
    params: {
      runId: run.id,
      source: run.source,
      status: run.status,
      rowsSeen: run.rows_seen,
      rowsImported: run.rows_imported,
      rowsInvalid: run.rows_invalid,
      duplicateCandidates: run.duplicate_candidates,
      transferCandidates: run.transfer_candidates,
      warnings: run.warnings_count,
      errors: run.errors_count,
      createdAt: run.created_at,
    },
    prompt: [
      `Explain this ${run.source === 'csv' ? 'CSV import' : 'backup restore'} audit run from ${run.created_at}.`,
      `Status is ${run.status}. It imported ${run.rows_imported}/${run.rows_seen} rows, with ${run.rows_invalid} invalid rows.`,
      `It found ${run.duplicate_candidates} duplicate candidate${run.duplicate_candidates === 1 ? '' : 's'}, ${run.transfer_candidates} transfer candidate${run.transfer_candidates === 1 ? '' : 's'}, ${run.warnings_count} warning${run.warnings_count === 1 ? '' : 's'}, and ${run.errors_count} error${run.errors_count === 1 ? '' : 's'}.`,
      `Summary: ${run.summary}.`,
      'Explain whether this import changed trustworthy financial data, what review queues I should inspect, and whether duplicates or transfers need cleanup.',
    ].join(' '),
  };
}
