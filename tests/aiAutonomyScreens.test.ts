import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { _setDbForTesting } from '../server/src/db/index';
import aiRouter from '../server/src/routes/ai';
import { AUTONOMOUS_DRAFT_KINDS, DRAFT_KIND_AUTONOMY } from '../server/src/services/draftAutonomy';
import { AiActionRow, describeAutonomyForOwner, undoActionToast } from '../client/src/views/settings/Settings';
import { revertOffer, revertToast } from '../client/src/components/CommandPalette';
import type {
  AdvisorAutonomyEntry,
  AdvisorAutonomyResponse,
  AiDigest,
  AiDigestRevertResult,
} from '../shared/types';

/**
 * The three owner-facing surfaces that described the old autonomy boundary, and the one that
 * decided what the owner could take back.
 *
 * Settings kept a fourth hand-written list of kinds (`categorize_transaction`,
 * `create_merchant_rule`) to gate its Undo button. `retire_merchant_rule` became autonomous, the
 * list did not move, and a working, tested server-side undo became unreachable from every screen.
 * These tests hold the screens to the server's table rather than to a copy of it.
 */

async function withAiServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  // The autonomy handler reads no data, but the module-level singleton is pointed somewhere
  // harmless so nothing in this file can reach the real .mizan/mizan.db.
  _setDbForTesting(new Database(':memory:'));
  const app = express();
  app.use('/api/ai', aiRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no server address');
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function fetchAutonomy(): Promise<AdvisorAutonomyResponse> {
  let table: AdvisorAutonomyResponse | null = null;
  await withAiServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/ai/autonomy`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: AdvisorAutonomyResponse };
    table = body.data;
  });
  if (!table) throw new Error('the autonomy route returned nothing');
  return table;
}

function actionRowHtml(kind: string, undoable: boolean): string {
  return renderToStaticMarkup(
    createElement(AiActionRow, {
      action: {
        id: 'act_1',
        kind,
        label: 'Test action',
        summary: 'what it did',
        source: 'worker_auto' as const,
        created_at: '2026-07-30T12:00:00.000Z',
      },
      undoable,
      undoPending: false,
      onUndo: () => undefined,
    })
  );
}

/** The boundary as Settings hard-coded it, kept only to prove the screens no longer assume it. */
const BOUNDARY_BEFORE_THE_WIDENING: AdvisorAutonomyEntry[] = (
  Object.keys(DRAFT_KIND_AUTONOMY) as AdvisorAutonomyEntry['kind'][]
).map((kind) => ({
  kind,
  autonomy:
    kind === 'categorize_transaction' || kind === 'create_merchant_rule' ? 'autonomous' : 'proposal_only',
}));

test('the route serves DRAFT_KIND_AUTONOMY itself, not a second copy of it', async () => {
  const table = await fetchAutonomy();
  const declared = Object.keys(DRAFT_KIND_AUTONOMY);

  assert.equal(table.kinds.length, declared.length, 'every declared kind crosses the wire');
  assert.deepEqual(table.kinds.map((entry) => entry.kind), declared, 'in the order it declares them');

  for (const entry of table.kinds) {
    assert.equal(
      entry.autonomy,
      DRAFT_KIND_AUTONOMY[entry.kind].autonomy,
      `${entry.kind} must cross the wire with the autonomy the table argues for it`
    );
  }

  const served = table.kinds.filter((e) => e.autonomy === 'autonomous').map((e) => e.kind).sort();
  assert.deepEqual(served, [...AUTONOMOUS_DRAFT_KINDS].sort(), 'the autonomous half is the derived set');
  // The fact the hand-written list in Settings missed, stated on its own so a regression names it.
  assert.ok(served.includes('retire_merchant_rule'), 'rule retirement applies unattended today');
});

test('Undo is offered for every kind the server applies unattended, and for no other', async () => {
  const table = await fetchAutonomy();
  const undoable = new Set(
    table.kinds.filter((e) => e.autonomy === 'autonomous').map((e) => e.kind)
  );

  // Undo by action id replays what the revision logs recorded, and `exact_inverse` is one of the
  // four criteria a kind has to meet to be autonomous, so the autonomous set is exactly the set
  // undo can reach.
  assert.deepEqual([...undoable].sort(), [...AUTONOMOUS_DRAFT_KINDS].sort());

  assert.match(actionRowHtml('retire_merchant_rule', undoable.has('retire_merchant_rule')), /Undo/);
  assert.match(actionRowHtml('categorize_transaction', undoable.has('categorize_transaction')), /Undo/);
  assert.match(actionRowHtml('create_merchant_rule', undoable.has('create_merchant_rule')), /Undo/);
  assert.doesNotMatch(actionRowHtml('update_budget', undoable.has('update_budget')), /Undo/);
  assert.doesNotMatch(actionRowHtml('set_manual_cost_basis', undoable.has('set_manual_cost_basis')), /Undo/);
});

test('an install that has only ever categorized sees exactly what it saw before', async () => {
  const table = await fetchAutonomy();
  const undoable = new Set(
    table.kinds.filter((e) => e.autonomy === 'autonomous').map((e) => e.kind)
  );

  // The whole action list of such an install: one kind, one button per row, unchanged.
  const html = actionRowHtml('categorize_transaction', undoable.has('categorize_transaction'));
  assert.equal(html.match(/Undo/g)?.length, 1);
  assert.match(html, /auto-applied/);
  assert.doesNotMatch(html, /rule/i, 'the row chrome adds no rule wording of its own');

  // And its undo toast is the string it has always been, to the byte.
  assert.deepEqual(undoActionToast({ ok: true, reverted: 3 }), {
    type: 'success',
    message: 'Reverted 3 transactions',
  });
  assert.deepEqual(undoActionToast({ ok: true, reverted: 1, reverted_rules: 0, rule_failures: [] }), {
    type: 'success',
    message: 'Reverted 1 transaction',
  });
});

test('the boundary sentence is generated from the table, not typed beside it', async () => {
  const table = await fetchAutonomy();
  const sentence = describeAutonomyForOwner(table.kinds);
  assert.ok(sentence, 'a loaded table always produces a sentence');

  const [applies, queues] = sentence.split('Waits for you:');
  assert.ok(queues, 'both halves are stated');

  // Every autonomous kind is described on the autonomous side, and nothing else is.
  assert.match(applies, /categorizing transactions/);
  assert.match(applies, /writing merchant rules/);
  assert.match(applies, /retiring rules it wrote itself/);
  assert.doesNotMatch(applies, /budget/, 'a budget change has never applied unattended');
  assert.doesNotMatch(applies, /goal target/);
  assert.match(queues, /changing a budget/);
  assert.match(queues, /changing a goal target/);
  assert.match(queues, /confirming a bill/);

  // What the widening actually means for the owner: rows a machine already filed are in scope.
  // The worker's pool is `category_source IN ('rule','heuristic')`, which is 19 rows on the real
  // ledger at migration 052.
  assert.match(applies, /a rule or the heuristic already filed/);

  // Generated, not typed: move a kind across the boundary and the sentence moves with it, with no
  // edit to any copy.
  const widened = table.kinds.map((entry) =>
    entry.kind === 'update_budget' ? { ...entry, autonomy: 'autonomous' as const } : entry
  );
  const widenedSentence = describeAutonomyForOwner(widened);
  assert.ok(widenedSentence);
  const [widenedApplies, widenedQueues] = widenedSentence.split('Waits for you:');
  assert.match(widenedApplies, /changing a budget/);
  assert.doesNotMatch(widenedQueues, /changing a budget/);
});

test('the sentence the screens used to print is the sentence of an older table', () => {
  const sentence = describeAutonomyForOwner(BOUNDARY_BEFORE_THE_WIDENING);
  assert.ok(sentence);
  const [applies] = sentence.split('Waits for you:');
  assert.doesNotMatch(applies, /retiring rules/, 'the old table did not retire rules unattended');

  // An empty table states nothing rather than stating an empty boundary.
  assert.equal(describeAutonomyForOwner([]), null);
});

test('an undo reports the rules it put back and the rules it could not', () => {
  assert.deepEqual(undoActionToast({ ok: true, reverted: 0, reverted_rules: 1, rule_failures: [] }), {
    type: 'success',
    message: 'Put back 1 merchant rule',
  });
  assert.deepEqual(undoActionToast({ ok: true, reverted: 2, reverted_rules: 1, rule_failures: [] }), {
    type: 'success',
    message: 'Reverted 2 transactions and put back 1 merchant rule',
  });

  // A partial revert stops reading as a complete one, and says which rule stayed retired.
  const partial = undoActionToast({
    ok: true,
    reverted: 0,
    reverted_rules: 1,
    rule_failures: ['"AMZN" was not restored: another live rule now holds that pattern.'],
  });
  assert.equal(partial.type, 'info');
  assert.match(partial.message, /Put back 1 merchant rule\./);
  assert.match(partial.message, /another live rule now holds that pattern/);
});

function digest(overrides: Partial<AiDigest>): AiDigest {
  return {
    since: '2026-07-01T00:00:00.000Z',
    generated_at: '2026-07-30T12:00:00.000Z',
    action_limit: 50,
    truncated: false,
    action_count: 1,
    actions_that_changed_no_rows: 0,
    actions_unrecorded: 0,
    row_count: 0,
    standing_rows: 0,
    revertable_rows: 0,
    revertable_rules: 0,
    already_reverted_rows: 0,
    changed_since_rows: 0,
    replaced_within_action_rows: 0,
    actions: [],
    ...overrides,
  };
}

test('a window whose only AI activity is a retirement gets the button its own copy promises', () => {
  // The case the digest already described in words: "Changed no transactions. The rule above can
  // be put back." while the offer was gated on revertable_rows alone and rendered nothing.
  const offer = revertOffer(digest({ revertable_rows: 0, revertable_rules: 1, actions_that_changed_no_rows: 1 }));
  assert.equal(offer, 'Putting all of it back restores 1 merchant rule and changes no transaction.');

  const both = revertOffer(digest({ revertable_rows: 4, revertable_rules: 2 }));
  assert.equal(both, 'Putting all of it back restores 4 rows and 2 merchant rules.');

  // Nothing to put back is still no button.
  assert.equal(revertOffer(digest({ revertable_rows: 0, revertable_rules: 0 })), null);
});

test('a rows-only window reads exactly as it did before rules were counted', () => {
  assert.equal(
    revertOffer(digest({ revertable_rows: 1 })),
    'Putting all of it back restores 1 row.'
  );
  assert.equal(
    revertOffer(digest({ revertable_rows: 12, changed_since_rows: 2, replaced_within_action_rows: 1 })),
    'Putting all of it back restores 12 rows.'
      + ' 2 rows were changed after the AI touched them and are left alone.'
      + ' 1 earlier value the AI overwrote with its own later one stays as it is.'
  );
});

function revertResult(overrides: Partial<AiDigestRevertResult>): AiDigestRevertResult {
  return {
    since: '2026-07-01T00:00:00.000Z',
    action_limit: 50,
    planned_rows: 0,
    reverted_rows: 0,
    planned_rules: 0,
    reverted_rules: 0,
    already_reverted_rows: 0,
    changed_since_rows: 0,
    replaced_within_action_rows: 0,
    actions: [],
    discrepancies: [],
    ...overrides,
  };
}

test('the revert toast carries the rules, and names a shortfall instead of absorbing it', () => {
  // Rows only: the message this panel has always shown.
  assert.deepEqual(revertToast(revertResult({ planned_rows: 5, reverted_rows: 5 })), {
    type: 'success',
    message: 'Put back 5 row(s).',
  });
  assert.deepEqual(
    revertToast(revertResult({ planned_rows: 5, reverted_rows: 3, changed_since_rows: 2 })),
    {
      type: 'success',
      message: 'Put back 3 row(s), 2 left alone because something else changed them since.',
    }
  );

  assert.deepEqual(
    revertToast(revertResult({ reverted_rows: 0, planned_rules: 1, reverted_rules: 1 })),
    { type: 'success', message: 'Put back 0 row(s) and 1 merchant rule(s).' }
  );

  const short = revertToast(revertResult({ reverted_rows: 2, planned_rules: 3, reverted_rules: 1 }));
  assert.equal(short.type, 'info', 'a plan that fell short must not read as a success');
  assert.match(short.message, /2 rule\(s\) the plan counted could not be put back\./);
});
