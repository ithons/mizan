import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AdvisorDraftAction,
  TransactionReviewQueueId,
  TransactionReviewQueueSummary,
  TransactionReviewSummary,
} from '../shared/types';
import { readWaiting } from '../client/src/views/Instrument';
import { REVIEW, render, text } from './helpers/instrumentHarness';

/**
 * "What needs you", the rail on `/`.
 *
 * The defect: the rail rendered ONE row for the whole of review. It was labelled "Uncategorized",
 * its number was `total_open` (every queue summed), and it linked to `/ledger?uncategorized=1`.
 * Measured against a private copy of `.mizan/mizan.db` at migration `054_drop_dead_preferences.sql`
 * on 2026-07-31, through `GET /api/transactions/review` on the running dev server:
 *
 *   total_open 7
 *   ai_insights 7 · uncategorized 0 · rule_suggestions 0 · pending 0 · recurring_candidates 0 ·
 *   duplicate_candidates 0 · transfer_candidates 0
 *   SELECT COUNT(*) FROM transactions WHERE category_id IS NULL   ->  0
 *   SELECT status, COUNT(*) FROM advisor_drafts GROUP BY 1  ->  confirmed 235, dismissed 3, open 15
 *   (seven of the fifteen open drafts survive `isDraftStillActionable`, which is the 7 above)
 *
 * So the most prominent call to action on the primary screen named an empty queue, printed a
 * different queue's count, and sent the owner to a filter holding none of it.
 */

/* ── Fixtures ────────────────────────────────────────────────────────────────
 * The counts are the measured ones. The seven draft objects are synthesized from the shape of a
 * real row (`kind: 'categorize_transaction'`, all seven of the live ones are) because what these
 * tests assert is the rail, not the drafts' contents; only the LENGTH has to agree with the count
 * the server would have derived from the same array. */

function draft(n: number): AdvisorDraftAction {
  return {
    id: `draft_${n}`,
    kind: 'categorize_transaction',
    label: `Categorize row ${n}`,
    summary: `Row ${n} looks like a category the ledger already uses.`,
    route: '/ledger',
    payload: { kind: 'categorize_transaction', transaction_id: `tx_${n}`, category_id: 'cat_food' },
    changes: [{ field: 'category', before: 'Uncategorized', after: 'Food & Drink' }],
    citations: [],
    confirmation_required: true,
    status: 'open',
  };
}

/** The queue list in the order and with the labels `getTransactionReviewSummary` builds it. */
function queues(counts: Partial<Record<TransactionReviewQueueId, number>>): TransactionReviewQueueSummary[] {
  const spec: Array<[TransactionReviewQueueId, string, TransactionReviewQueueSummary['severity']]> = [
    ['ai_insights', 'AI Insights', 'info'],
    ['uncategorized', 'Needs category', 'attention'],
    ['rule_suggestions', 'Rule suggestions', 'info'],
    ['pending', 'Pending', 'warning'],
    ['recurring_candidates', 'Recurring candidates', 'info'],
    ['duplicate_candidates', 'Possible duplicates', 'warning'],
    ['transfer_candidates', 'Detected transfers', 'info'],
  ];
  return spec.map(([id, label, severity]) => ({
    id,
    label,
    count: counts[id] ?? 0,
    action_label: 'Review',
    severity,
  }));
}

function summary(counts: Partial<Record<TransactionReviewQueueId, number>>): TransactionReviewSummary {
  const list = queues(counts);
  return {
    ...REVIEW,
    // The server's own rule: every queue except `pending` counts toward the headline.
    total_open: list.filter((q) => q.id !== 'pending').reduce((sum, q) => sum + q.count, 0),
    queues: list,
    ai_drafts: Array.from({ length: counts.ai_insights ?? 0 }, (_, i) => draft(i)),
  };
}

/** The live ledger on 2026-07-31: seven surfaced AI drafts and nothing else outstanding. */
const LIVE = summary({ ai_insights: 7 });

/* ── The reading ─────────────────────────────────────────────────────────── */

test('the live queues produce one row, and it is not the one the rail used to print', () => {
  const rows = readWaiting(LIVE);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'ai_insights');
  assert.equal(rows[0].label, 'AI Insights');
  assert.equal(rows[0].count, 7);
  assert.notEqual(rows[0].label, 'Uncategorized');
  assert.notEqual(rows[0].to, '/ledger?uncategorized=1');
});

test('a row carries its own queue\'s count, never the sum of the others', () => {
  const rows = readWaiting(summary({ ai_insights: 7, uncategorized: 3, duplicate_candidates: 2 }));

  assert.deepEqual(
    rows.map((r) => [r.id, r.count]),
    [
      ['ai_insights', 7],
      ['uncategorized', 3],
      ['duplicate_candidates', 2],
    ]
  );
  // 12 is `total_open`. It is the number the old single row printed, and no row prints it.
  assert.equal(rows.reduce((sum, r) => sum + r.count, 0), 12);
  assert.ok(!rows.some((r) => r.count === 12));
});

test('an empty queue produces no row, so a clean ledger produces no rail at all', () => {
  assert.deepEqual(readWaiting(summary({})), []);
  assert.deepEqual(readWaiting(REVIEW), []);
  assert.deepEqual(readWaiting(undefined), []);
});

test('pending is offered nowhere, matching its exclusion from the headline total', () => {
  const rows = readWaiting(summary({ pending: 4 }));

  assert.deepEqual(rows, [], 'a pending authorization posts on its own; there is nothing to decide');
  assert.equal(summary({ pending: 4 }).total_open, 0);
});

test('every queue that can be waiting has somewhere to go, and it is a route the app mounts', () => {
  const all: TransactionReviewQueueId[] = [
    'ai_insights',
    'uncategorized',
    'rule_suggestions',
    'pending',
    'recurring_candidates',
    'duplicate_candidates',
    'transfer_candidates',
  ];
  // Every id the union declares is covered: either it routes somewhere, or it is deliberately
  // not offered. A silent gap would render a row with no destination.
  const routed = readWaiting(summary(Object.fromEntries(all.map((id) => [id, 1]))));
  assert.deepEqual(routed.map((r) => r.id), all.filter((id) => id !== 'pending'));

  const mounted = ['/ledger', '/settings'];
  for (const row of routed) {
    const path = row.to.split('?')[0];
    assert.ok(mounted.includes(path), `${row.id} points at ${path}, which is not one of the six screens`);
  }
});

test('the one deep link offered is the one the ledger actually answers', () => {
  const uncategorized = readWaiting(summary({ uncategorized: 5 }))[0];
  assert.equal(uncategorized.to, '/ledger?uncategorized=1');
  // `Ledger.tsx` reads exactly this parameter; anything else would be a link to a filter that
  // never gets set, which is the defect being fixed rather than a different spelling of it.
  const ledger = readWaiting(summary({ uncategorized: 5, ai_insights: 1 }));
  assert.equal(ledger.filter((r) => r.to.includes('?')).length, 1);
});

test('an AI suggestion is not rendered as an alarm', () => {
  assert.equal(readWaiting(summary({ ai_insights: 7 }))[0].tone, undefined);
  assert.equal(readWaiting(summary({ uncategorized: 7 }))[0].tone, 'text-clay');
  assert.equal(readWaiting(summary({ duplicate_candidates: 7 }))[0].tone, 'text-gold');
});

test('every tone a rail row can take clears AA on the ground the rail sits on', () => {
  // The rail is directly on `paper`; `RailRow` falls back to `muted` for the label and `ink` for
  // the numeral when a queue carries no tone of its own. `gold` is measured rather than assumed:
  // it is 4.64:1 on paper light and 6.22:1 dark, and it is the tightest of the four in both
  // themes, which is asserted below rather than stated.
  const CSS = readFileSync(join(import.meta.dirname, '..', 'client/src/index.css'), 'utf8');
  const triplet = (name: string, theme: 'light' | 'dark'): [number, number, number] => {
    const all = [...CSS.matchAll(new RegExp(`--mz-${name}-c:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s*;`, 'g'))];
    const m = theme === 'light' ? all[0] : all[all.length - 1];
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const ratio = (fg: string, theme: 'light' | 'dark'): number => {
    const lum = ([r, g, b]: [number, number, number]) => {
      const ch = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
      return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
    };
    const [a, b] = [lum(triplet(fg, theme)), lum(triplet('paper', theme))];
    return Number(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2));
  };
  const tones = ['clay', 'gold', 'muted', 'ink'];
  for (const tone of tones) {
    for (const theme of ['light', 'dark'] as const) {
      assert.ok(ratio(tone, theme) >= 4.5, `${tone} on paper is ${ratio(tone, theme)}:1 in ${theme}`);
    }
  }
  assert.equal(ratio('gold', 'light'), 4.64);
  assert.equal(ratio('gold', 'dark'), 6.22);
  for (const theme of ['light', 'dark'] as const) {
    const worst = tones.reduce((a, b) => (ratio(a, theme) <= ratio(b, theme) ? a : b));
    assert.equal(worst, 'gold', `${worst} is tighter than gold on ${theme}; the comment above is stale`);
  }
});

/* ── The surface ─────────────────────────────────────────────────────────── */

test('the screen prints the queue that is waiting and links it where it is decided', () => {
  const html = render('this-month', { review: LIVE });
  const body = text(html);

  assert.match(body, /What needs you/);
  assert.match(body, /AI Insights/);
  assert.ok(html.includes('href="/ledger"'), 'the AI queue does not link to the ledger');
  // The two halves of the defect, neither of which may reappear on this data.
  assert.doesNotMatch(body, /Uncategorized/, 'the rail still names a queue that holds nothing');
  assert.ok(!html.includes('uncategorized=1'), 'the rail still links to a filter holding none of it');
});

test('the screen is silent about review when every queue is empty', () => {
  const body = text(render('this-month', { review: REVIEW }));

  // Nothing else is waiting in this fixture either (no goals, no bills, no insights), so the whole
  // section is absent rather than rendering an empty strip or a zero.
  assert.doesNotMatch(body, /What needs you/);
  assert.doesNotMatch(body, /AI Insights/);
  assert.doesNotMatch(body, /Uncategorized/);
});

test('the screen prints one row per waiting queue, each with its own number', () => {
  const html = render('this-month', { review: summary({ ai_insights: 7, uncategorized: 3 }) });
  const body = text(html);
  const rail = body.slice(body.indexOf('What needs you'), body.indexOf('Over this window'));

  assert.match(rail, /AI Insights 7/);
  assert.match(rail, /Needs category 3/);
  assert.ok(html.includes('href="/ledger?uncategorized=1"'));
  // 10 is `total_open`, the number the single row used to print. It is nowhere in the rail.
  assert.doesNotMatch(rail, /\b10\b/);
});
