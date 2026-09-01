import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReconciliationReading } from '../shared/types';
import { LedgerIntegrityPanel } from '../client/src/components/LedgerIntegrityPanel';

const ROOT = join(__dirname, '..');

/**
 * The check that decides whether every other number is true, on a screen, silently.
 *
 * `GET /api/insights/reconciliation` was the only data route in the app with zero client callers.
 * Its own comment calls it "the one check that decides whether every other number in the app is
 * true", and it reached nothing but the advisor's prompt: the owner could be told the answer by
 * asking and could not see it. On the owner's live ledger it has been reporting the same
 * flow-conservation finding (Chase Checking against Fidelity Individual, 20 legs, $700) since
 * 2026-05-21, and `transaction_field_revisions` has 0 rows, because nothing routed anyone from the
 * finding to the rows it is made of.
 */
function render(data: Partial<ReconciliationReading>): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  client.setQueryData(['insights', 'reconciliation'], {
    accounts: [],
    unreconciled: [],
    unreconciled_residual: 0,
    residual_all_accounts: 0,
    measured_snapshot_count: 25,
    flow_conservation: [],
    ...data,
  } satisfies ReconciliationReading);
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(MemoryRouter, null, createElement(LedgerIntegrityPanel, {}))
    )
  );
}

const account = {
  account_id: 'acc_wallet',
  account_name: 'Wallet',
  is_liability: false,
  is_market_driven: false,
  window_count: 24,
  first_date: '2026-06-30',
  last_date: '2026-09-01',
  observed_delta: -80,
  explained_delta: 0,
  residual: -80,
  boundary_amount: 0,
  adjusted_residual: -80,
  direction_conflict: false,
  largest_window_residual: -80,
  residual_ratio: null,
};

const flow = {
  account_a_id: 'acc_chk',
  account_a_name: 'Chase Checking',
  account_b_id: 'acc_fid',
  account_b_name: 'Fidelity Individual',
  leg_count: 20,
  first_date: '2026-05-21',
  last_date: '2026-07-27',
  movement: 700,
};

test('HEALTHY: a ledger that explains itself renders nothing at all', () => {
  // Rule 3. Not "renders an empty section", not "renders a green tick": nothing. A reconciled
  // ledger has no news, and a panel that is always present is a panel that stops being read.
  assert.equal(render({}), '');
});

test('HEALTHY: a large raw residual across all accounts is still silence', () => {
  // `residual_all_accounts` sums the raw residual over EVERY account, including the market-driven
  // ones the filter exempts, so it is routinely large on a ledger that is entirely fine. Rendering
  // it would be a standing number the owner cannot act on, which is the other half of rule 3.
  assert.equal(render({ residual_all_accounts: 1004.71 }), '');
});

test('an unexplained account states both sides, not one "off by" figure', () => {
  const html = render({ unreconciled: [account] });

  assert.match(html, /What the ledger does not explain/);
  assert.match(html, /Wallet/);
  // Both halves: what the balance did, and what the rows account for.
  assert.match(html, /the balance moved −\$80/);
  assert.match(html, /the transactions account for \$0/);
  assert.match(html, /\$80/);
  assert.match(html, /unexplained/);
});

test('a direction conflict is said out loud, and is not claimed when absent', () => {
  assert.match(
    render({ unreconciled: [{ ...account, direction_conflict: true }] }),
    /in the opposite direction/
  );
  assert.doesNotMatch(render({ unreconciled: [account] }), /in the opposite direction/);
});

test('a flow-conservation finding carries a route to the rows it is made of', () => {
  const html = render({ flow_conservation: [flow] });

  assert.match(html, /Chase Checking and Fidelity Individual/);
  assert.match(html, /20 rows between 2026-05-21 and 2026-07-27/);
  assert.match(html, /\$700/);
  // The last mile: the finding used to name a pair and a movement and stop there.
  assert.match(html, /Open Chase Checking/);
  assert.match(html, /Open Fidelity Individual/);
});

test('the Ledger honours the accountId deep link the panel emits', () => {
  const ledger = readFileSync(join(ROOT, 'client/src/views/Ledger.tsx'), 'utf8');
  // Without this the button would navigate to an unfiltered ledger, which is the same dead end
  // the finding already was.
  assert.match(ledger, /searchParams\.get\('accountId'\)/);
  assert.match(ledger, /setAccountFilter\(account\)/);
});

test('the reconciliation route has a fetcher, and it is the one the panel uses', () => {
  const api = readFileSync(join(ROOT, 'client/src/lib/api.ts'), 'utf8');
  assert.match(api, /reconciliation: \(\) => apiFetch<ReconciliationReading>\('\/api\/insights\/reconciliation'\)/);
  const panel = readFileSync(join(ROOT, 'client/src/components/LedgerIntegrityPanel.tsx'), 'utf8');
  assert.match(panel, /insightsApi\.reconciliation/);
});
