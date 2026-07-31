import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type Database from 'better-sqlite3';
import { _setDbForTesting } from '../server/src/db/index';
import aiRouter from '../server/src/routes/ai';
import { buildFinancialContext } from '../server/src/services/aiContext';
import {
  createMemory,
  deleteMemory,
  listMemories,
  supersedeMemory,
} from '../server/src/services/aiMemory';
import { migratedTestDb } from './helpers/schema';
import { AdvisorMemorySection } from '../client/src/views/settings/AdvisorMemorySection';

/**
 * ai_memory holds what the ledger cannot: how the owner runs their money.
 *
 * The store used to refuse any statement matching a set of figure patterns, and the patterns were
 * wrong in both directions at once: they refused `401(k)`, `529`, `1099`, `403(b)`, `the 1st of
 * each month` and `the 15th`, and admitted "four hundred dollars a month", "twelve thousand in the
 * checking buffer" and "90 in revolving balance". Both halves are pinned below, because the fix is
 * not a tighter pattern: there is no pattern, and staleness is neutralised by DATING every
 * statement in the prompt instead.
 */

const HOUSEHOLD = {
  scope: 'household' as const,
  kind: 'preference' as const,
  statement: 'Funds the taxable brokerage before the Roth',
  evidence: 'Said so in chat on 2026-07-14, and every transfer since has gone to the taxable account',
};

// Ordinary durable statements, the sentences the store exists to hold. The last seven are the ones
// the old figure rules refused; not one of them carries a figure that can go stale.
const HEALTHY_STATEMENTS = [
  'Funds the taxable brokerage before the Roth',
  'Treats the grocery budget as a floor rather than a ceiling',
  'Autopays every card in full, so a card balance is never debt being carried',
  'Keeps three months of expenses in cash and will not invest that buffer',
  'Has funded the Roth every January since 2024',
  'Counts a refund as money returning, never as income',
  'Will not sell a position to cover a shortfall',
  'Reads the emergency fund as untouchable even when a goal is behind',
  'Maxes out the 401(k) before adding anything to the taxable brokerage',
  'Keeps the 529 for the nephew untouched',
  'Treats 1099 consulting income as unpredictable and never budgets against it',
  'Rolls the old 403(b) over rather than leaving it with the previous employer',
  'Pays every card in full on the 1st of each month, never the minimum',
  'Moves the leftover to savings on the 15th of each month',
  'Rounds every paycheck up into savings and leaves the remainder in checking',
];

// Sentences that really are measurements. Three of these passed the old rules untouched, so the
// rules bought nothing they claimed; all four are now recorded, and dated where the model reads them.
const MEASUREMENT_STATEMENTS = [
  'Spends about four hundred dollars a month on groceries',
  'Keeps twelve thousand in the checking buffer at all times',
  'Carries 90 in revolving balance across the cards',
  'Spends $412 a month on groceries',
];

test('every ordinary durable statement is recorded, none refused', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  assert.equal(HEALTHY_STATEMENTS.length, 15);
  for (const statement of HEALTHY_STATEMENTS) {
    const result = createMemory(db, { ...HOUSEHOLD, statement });
    assert.equal(result.ok, true, `refused a healthy statement: ${statement}`);
  }
  assert.equal(listMemories(db).length, 15);
});

test('a statement carrying a figure is recorded too, and the prompt dates every one', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  for (const statement of MEASUREMENT_STATEMENTS) {
    const result = createMemory(db, { ...HOUSEHOLD, statement });
    assert.equal(result.ok, true, `refused a statement it no longer judges: ${statement}`);
  }

  // The mitigation is the date, not a refusal, so it has to be on the line the model reads.
  const context = contextWith(db);
  for (const statement of MEASUREMENT_STATEMENTS) {
    const line = context.split('\n').find((candidate) => candidate.includes(statement));
    assert.ok(line, `statement never reached the prompt: ${statement}`);
    assert.match(line, /\(recorded \d{4}-\d{2}-\d{2}, 1 observation\)$/);
  }
  assert.match(context, /READ EVERY STATEMENT AS OF THAT DATE/);
});

test('a memory cannot exist without the evidence that produced it', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const noEvidence = createMemory(db, { ...HOUSEHOLD, evidence: '' });
  assert.equal(noEvidence.ok, false);
  assert.match(noEvidence.ok ? '' : noEvidence.error, /what was observed/);

  // And the engine refuses it too, so no future write path can reach the table around the service.
  assert.throws(
    () =>
      db.prepare(`
        INSERT INTO ai_memory (id, scope, subject, statement, kind, evidence, created_at)
        VALUES ('m_direct', 'household', NULL, 'Funds the taxable brokerage first', 'preference', '', '2026-07-31T00:00:00.000Z')
      `).run(),
    /CHECK constraint failed/
  );
});

test('the engine refuses a non-dispositional kind, and does not judge the sentence', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const insert = (statement: string, kind: string): void => {
    db.prepare(`
      INSERT INTO ai_memory (id, scope, subject, statement, kind, evidence, created_at)
      VALUES (?, 'household', NULL, ?, ?, 'observed over several months of transfers', '2026-07-31T00:00:00.000Z')
    `).run(`m_${Math.random()}`, statement, kind);
  };

  // The four kinds say what the store is for. That is the only judgement the engine makes.
  assert.throws(() => insert('Groceries ran high over the winter', 'observation'), /CHECK constraint failed/);
  // A dollar sign used to be a CHECK here. It caught "$412" and missed "four hundred dollars", so
  // the guarantee it looked like it gave was never one.
  assert.doesNotThrow(() => insert('Spends $412 on groceries each pass', 'preference'));
});

test('a scoped statement must name its subject, and a household one must not', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const noSubject = createMemory(db, { ...HOUSEHOLD, scope: 'category' });
  assert.equal(noSubject.ok, false);
  assert.match(noSubject.ok ? '' : noSubject.error, /must name the category/);

  const straySubject = createMemory(db, { ...HOUSEHOLD, subject: 'Groceries' });
  assert.equal(straySubject.ok, false);

  const scoped = createMemory(db, {
    ...HOUSEHOLD,
    scope: 'category',
    subject: 'Groceries',
    kind: 'interpretation',
    statement: 'Treats the grocery budget as a floor rather than a ceiling',
  });
  assert.equal(scoped.ok, true);
  assert.equal(scoped.ok && scoped.memory.subject, 'Groceries');
});

test('the same statement cannot be recorded twice', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  assert.equal(createMemory(db, HOUSEHOLD).ok, true);
  const again = createMemory(db, { ...HOUSEHOLD, statement: '  funds the TAXABLE brokerage before the Roth ' });
  assert.equal(again.ok, false);
  assert.equal(listMemories(db).length, 1);
});

test('a revised belief keeps what it used to say, and only the new one is live', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const first = createMemory(db, HOUSEHOLD);
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const revised = supersedeMemory(db, first.memory.id, {
    statement: 'Funds the Roth to the limit first, then the taxable brokerage',
    evidence: 'Said on 2026-07-30 that the deduction changed the order',
  });
  assert.equal(revised.ok, true);
  if (!revised.ok) return;

  const live = listMemories(db);
  assert.equal(live.length, 1);
  assert.equal(live[0].statement, 'Funds the Roth to the limit first, then the taxable brokerage');
  assert.equal(live[0].prior_statements.length, 1);
  assert.equal(live[0].prior_statements[0].statement, HOUSEHOLD.statement);
  assert.equal(live[0].evidence_count, 1);

  // Both rows are still on disk: the history is the point of superseding.
  const total = db.prepare('SELECT COUNT(*) AS n FROM ai_memory').get() as { n: number };
  assert.equal(total.n, 2);

  // A second revision that restates the same wording is a legal write: the retired row leaves the
  // live-unique index before the new one enters it.
  const again = supersedeMemory(db, live[0].id, {
    statement: 'Funds the Roth to the limit first, then the taxable brokerage',
    evidence: 'Confirmed again after the January contribution went to the Roth',
  });
  assert.equal(again.ok, true);
  assert.equal(listMemories(db).length, 1);
  assert.equal(listMemories(db)[0].prior_statements.length, 2);
});

test('a revision that says nothing about what changed is refused and leaves the original live', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const first = createMemory(db, HOUSEHOLD);
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const refused = supersedeMemory(db, first.memory.id, {
    statement: 'Puts $400 a month into the taxable brokerage',
    evidence: '',
  });
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? '' : refused.error, /what was observed/);

  const live = listMemories(db);
  assert.equal(live.length, 1);
  assert.equal(live[0].statement, HOUSEHOLD.statement);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM ai_memory').get() as { n: number }).n, 1);

  // The same revision with its evidence stated goes through: the figure was never what stopped it.
  const accepted = supersedeMemory(db, first.memory.id, {
    statement: 'Puts $400 a month into the taxable brokerage',
    evidence: 'Four transfers of the same size in a row, and the owner confirmed the amount',
  });
  assert.equal(accepted.ok, true);
});

test('striking a belief takes its history with it', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const first = createMemory(db, HOUSEHOLD);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const revised = supersedeMemory(db, first.memory.id, {
    statement: 'Funds the Roth to the limit first, then the taxable brokerage',
    evidence: 'Said on 2026-07-30 that the deduction changed the order',
  });
  assert.equal(revised.ok, true);
  if (!revised.ok) return;

  assert.equal(deleteMemory(db, revised.memory.id).changed, 1);
  // Nothing is left for a model to read back: a rejected statement must not survive as a tombstone.
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM ai_memory').get() as { n: number }).n, 0);
  assert.equal(listMemories(db).length, 0);
});

function contextWith(db: Database.Database): string {
  _setDbForTesting(db);
  try {
    return buildFinancialContext();
  } finally {
    _setDbForTesting(null);
  }
}

test('an install with no memories says nothing about memory at all', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const context = contextWith(db);
  assert.doesNotMatch(context, /standing statement/i);
  assert.doesNotMatch(context, /belief/i);
  assert.doesNotMatch(context, /memor/i);
  assert.doesNotMatch(context, /\(0\)/);
});

test('a recorded statement reaches the prompt as a belief, and its evidence does not', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const created = createMemory(db, {
    ...HOUSEHOLD,
    evidence: 'Twelve of the fourteen transfers in the window went to the taxable account',
  });
  assert.equal(created.ok, true);
  createMemory(db, {
    scope: 'category',
    subject: 'Groceries',
    kind: 'interpretation',
    statement: 'Treats the grocery budget as a floor rather than a ceiling',
    evidence: 'Raised the budget after two months of overspend rather than cutting the spend',
  });

  const context = contextWith(db);
  assert.match(context, /### Standing Statements About How The Owner Runs Their Money \(2\)/);
  assert.match(
    context,
    /\[preference\] Funds the taxable brokerage before the Roth \(recorded \d{4}-\d{2}-\d{2}, 1 observation\)/
  );
  assert.match(context, /\[interpretation, Groceries\] Treats the grocery budget as a floor/);
  assert.match(context, /Beliefs, not measurements\./);
  // The section must not promise the model a guarantee the store does not keep.
  assert.doesNotMatch(context, /cannot be read back/);

  // The evidence is the owner's audit trail, not prompt material: it is where a figure legitimately
  // lives, and a figure in the prompt is a measurement with no query behind it.
  assert.doesNotMatch(context, /Twelve of the fourteen transfers/);
  assert.doesNotMatch(context, /Raised the budget after two months/);

  // Stated beside the owner's own personal context, ahead of every measured section, and marked as
  // a source the model must not weigh as a number.
  assert.ok(
    context.indexOf('### Standing Statements') < context.indexOf('### Net Worth'),
    'the belief section must come before the first measured section'
  );

  // Stable across calls: the prompt is the cached prefix, and anything that differs between two
  // reads of identical data bills the whole prefix again.
  assert.equal(context, contextWith(db));
});

test('the model is told which statements are its own conclusions, and nothing else is marked', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  createMemory(db, HOUSEHOLD, 'owner');
  const inferred = createMemory(
    db,
    {
      scope: 'merchant',
      subject: 'Amazon',
      kind: 'interpretation',
      statement: 'Returns most of what is bought from this merchant within the month',
      evidence: 'Most Amazon charges are followed by a credit in the same category',
      evidence_count: 6,
    },
    'ai'
  );
  assert.equal(inferred.ok, true);

  const context = contextWith(db);
  assert.match(context, /\[interpretation, Amazon\] Returns most of what is bought[^\n]*6 observations, your own conclusion/);
  // The owner's own statement carries no author tag: labelling it would invite the model to weigh
  // the owner's word as one of its own guesses.
  assert.doesNotMatch(context, /Funds the taxable brokerage before the Roth[^\n]*your own conclusion/);
});

async function withServer(db: Database.Database, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  _setDbForTesting(db);
  const app = express();
  app.use(express.json());
  app.use('/api/ai', aiRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no server address');
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    _setDbForTesting(null);
  }
}

/**
 * The owner meets this store through HTTP, so the refusals are asserted where they will be read.
 * A 400 whose body says "invalid input" would leave the owner rewriting a sentence in the dark.
 */
test('the routes carry the refusal reason, and a missing entry is a 404', async (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  await withServer(db, async (baseUrl) => {
    const post = (body: unknown): Promise<Response> =>
      fetch(`${baseUrl}/api/ai/memory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    const empty = await fetch(`${baseUrl}/api/ai/memory`);
    assert.equal(empty.status, 200);
    assert.deepEqual((await empty.json()).data, []);

    // Structural, and the only kind of refusal left: nothing here judges the sentence.
    const refused = await post({ ...HOUSEHOLD, evidence: '' });
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /what was observed/);

    const withFigure = await post({ ...HOUSEHOLD, statement: 'Spends $412 a month on groceries' });
    assert.equal(withFigure.status, 200);

    const created = await post(HOUSEHOLD);
    assert.equal(created.status, 200);
    const id = (await created.json()).data.id as string;

    const revised = await fetch(`${baseUrl}/api/ai/memory/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        statement: 'Funds the Roth to the limit first, then the taxable brokerage',
        evidence: 'Said on 2026-07-30 that the deduction changed the order',
      }),
    });
    assert.equal(revised.status, 200);
    const newId = (await revised.json()).data.id as string;

    const missing = await fetch(`${baseUrl}/api/ai/memory/does_not_exist`, { method: 'DELETE' });
    assert.equal(missing.status, 404);

    const struck = await fetch(`${baseUrl}/api/ai/memory/${newId}`, { method: 'DELETE' });
    assert.equal(struck.status, 200);
    const after = await fetch(`${baseUrl}/api/ai/memory`);
    const remaining = (await after.json()).data as Array<{ statement: string }>;
    assert.deepEqual(
      remaining.map((memory) => memory.statement),
      ['Spends $412 a month on groceries']
    );
  });
});

/**
 * The panel with nothing in it. A count of zero, an "empty" line or a "no statements yet" is the
 * shape this rule forbids: on an install that has recorded nothing, the panel has to read as a
 * description of what the store is, not as a hole waiting to be filled.
 */
test('the Settings panel with no statements reads as a fact, not an absence', () => {
  const markup = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(AdvisorMemorySection)
    )
  );

  assert.match(markup, /marked as belief rather than measurement/);
  assert.match(markup, /Nothing is refused for carrying a number/);
  assert.doesNotMatch(markup, /\bno\b[^<]{0,20}statement/i);
  assert.doesNotMatch(markup, /\bempty\b/i);
  assert.doesNotMatch(markup, /\b0 (?:statements|recorded|memories)\b/i);

  // The two guarantees this panel used to promise and the code never kept.
  assert.doesNotMatch(markup, /are refused in a statement/);
  assert.doesNotMatch(markup, /cannot be read back/);
  assert.doesNotMatch(markup, /keeps them honest/);
});
