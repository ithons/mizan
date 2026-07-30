import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DataQualityIssue } from '../shared/types';
import { DataQualityIssueList } from '../client/src/components/DataQualityPanel';

function render(issues: DataQualityIssue[]): string {
  return renderToStaticMarkup(
    createElement(DataQualityIssueList, { issues, onOpen: () => undefined })
  );
}

function clickTargets(issues: DataQualityIssue[]): string[] {
  const opened: string[] = [];
  const tree = DataQualityIssueList({ issues, onOpen: (route) => opened.push(route) });

  const walk = (node: ReactNode): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!isValidElement(node)) return;
    const props = (node as ReactElement).props as {
      onClick?: () => void;
      children?: ReactNode;
    };
    if (typeof props.onClick === 'function') props.onClick();
    if (props.children !== undefined) walk(props.children);
  };

  walk(tree);
  return opened;
}

// The live shape, taken from getDataQualitySummary run against a copy of the real database, in the
// order the service sorts it. The third row is the shape of a warning the real ledger does not
// currently carry, kept here so a second route is exercised.
const liveIssues: DataQualityIssue[] = [
  {
    id: 'cash-flow-review',
    label: 'Cash flow confidence',
    message: '1 recurring item needs review, including 1 overdue item.',
    route: '/bills',
    severity: 'warning',
  },
  {
    id: 'stale-pending-transactions',
    label: 'Old pending transactions',
    message: '2 pending transactions are older than 7 days and may never post. Pending rows stay out of reports until they post or are removed.',
    route: '/transactions?range=all',
    severity: 'warning',
  },
  {
    id: 'transaction-review',
    label: 'Transaction review backlog',
    message: '1 recurring candidate, 3 detected transfers need review before reports can be fully trusted.',
    route: '/review',
    severity: 'info',
  },
];

test('every issue is rendered with its own label, message and severity word', () => {
  const html = render(liveIssues);

  for (const issue of liveIssues) {
    assert.ok(html.includes(issue.label), `missing label: ${issue.label}`);
    assert.ok(html.includes(issue.message), `missing message: ${issue.message}`);
  }
  assert.ok(html.includes('Warning'));
  assert.ok(html.includes('Note'));
  assert.equal(html.match(/<button/g)?.length, liveIssues.length);
});

test('each row opens the route the issue carries, not a shared destination', () => {
  assert.deepEqual(clickTargets(liveIssues), ['/bills', '/transactions?range=all', '/review']);
});

/**
 * The rebuild's governing failure is a derived number presented as a fact. `score` is one, and so
 * is the status verdict computed from it, so neither reaches the panel at all.
 */
test('no score, no percentage and no verdict reaches the markup', () => {
  const html = render(liveIssues);

  assert.ok(!/\b\d{1,3}\s*\/\s*100\b/.test(html));
  assert.ok(!html.includes('%'));
  for (const verdict of ['Reliable enough', 'Review recommended', 'Needs attention', 'score']) {
    assert.ok(!html.toLowerCase().includes(verdict.toLowerCase()), `leaked verdict: ${verdict}`);
  }
});

// ─── The healthy case ─────────────────────────────────────────────────────────

test('a clean result states what was checked and reports nothing open', () => {
  const html = render([]);

  assert.equal(
    html,
    '<p class="text-note text-muted">Data quality: sync state, review queues, forecast confidence, and the ledger invariants report nothing open.</p>'
  );
});

test('a clean result claims nothing beyond what was checked', () => {
  const html = render([]).toLowerCase();

  // Praise, and any grade, are both readings the data does not support: the checks that ran
  // reported nothing, which is not the same as the ledger being right.
  for (const word of ['healthy', 'all good', 'great', 'excellent', 'perfect', 'clean bill', 'trust', 'reliable', '100']) {
    assert.ok(!html.includes(word), `praise or grade leaked into the clean state: ${word}`);
  }
});

test('a clean result carries none of the chrome a result with findings gets', () => {
  const clean = render([]);
  const withIssues = render(liveIssues);

  for (const chrome of ['rounded-xl', 'shadow-e1', 'border', '<button', '<svg', 'Data Quality']) {
    assert.ok(withIssues.includes(chrome), `expected chrome missing from the findings state: ${chrome}`);
    assert.ok(!clean.includes(chrome), `clean state should not carry: ${chrome}`);
  }

  assert.ok(
    clean.length * 4 < withIssues.length,
    `clean state is not visually lighter: ${clean.length} vs ${withIssues.length} chars`
  );
});

test('a single critical issue still renders as one row and nothing louder', () => {
  const html = render([
    {
      id: 'hidden-account-net-worth',
      label: 'Hidden account included in net worth',
      message: 'The latest net worth snapshot includes hidden account: Old Savings.',
      route: '/accounts',
      severity: 'critical',
    },
  ]);

  assert.equal(html.match(/<button/g)?.length, 1);
  assert.ok(html.includes('Critical'));
  assert.ok(html.includes('1 open condition.'));
});
