import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SYNC_HEALTH_PARTIAL, render, text } from './helpers/instrumentHarness';

/**
 * The feed behind the beam's `sync_incomplete` fault, and the one direction it must not fail in.
 *
 * `readCalibration` takes `syncIncomplete` as a boolean, and `Instrument.tsx` derives it from
 * `syncHealthQ.data?.last_run?.incomplete`. `retry: false` is right for a local endpoint, but with
 * no error branch a dead `GET /api/sync/health` leaves `data` undefined, which reads as `false`,
 * which is the sentence "the last sync finished every stage" asserted by a check that never ran.
 * That is the same shape as a clean bill of health covering accounts nothing judged.
 *
 * The fix is not a fault for a network error, because a failed request says nothing about the
 * sheet. It is that the request joins `failableQueries`, so the banner names it and the owner can
 * see that this particular reading was not taken. The screen's existing mechanism, used honestly.
 *
 * The degradation this feed exists to carry is measured in `beamDegradation.test.ts`; what is
 * asserted here is only the failure path and the silence around it.
 */

const SOURCE = readFileSync(join(import.meta.dirname, '..', 'client/src/views/Instrument.tsx'), 'utf8');

test('a dead sync-health request is named, not swallowed', () => {
  const body = text(render('this-month', { syncHealthFailed: true }));

  assert.match(body, /Couldn't load[^.]*sync health/, 'a failed health check renders as nothing at all');
});

test('the failed request does not invent a degradation it did not observe', () => {
  // It must not read as incomplete either. The check did not run; that is a third state, and the
  // banner is where it is said.
  const body = text(render('this-month', { syncHealthFailed: true }));

  assert.doesNotMatch(body, /The last sync did not finish every stage/);
});

test('HEALTHY: a sync-health request that succeeds says nothing at all', () => {
  const body = text(render('this-month'));

  assert.doesNotMatch(body, /Couldn't load/, 'the banner fired on a screen where every query answered');
  assert.doesNotMatch(body, /The last sync did not finish every stage/);
});

test('HEALTHY: a partial run still degrades the beam, and still fires no banner', () => {
  // The two paths are independent, and folding one into the other would be the easy wrong fix.
  const body = text(render('this-month', { syncHealth: SYNC_HEALTH_PARTIAL }));

  assert.match(body, /The last sync did not finish every stage\./);
  assert.doesNotMatch(body, /Couldn't load/);
});

test('the query is registered in failableQueries rather than only rendered from', () => {
  // A rendered assertion can be satisfied by a coincidence in the banner's label list, so the
  // registration itself is checked: one declaration, and it is in the list the banner reads.
  assert.match(SOURCE, /\{ query: syncHealthQ, label: 'sync health' \},/);
  assert.equal([...SOURCE.matchAll(/const syncHealthQ = useQuery\(/g)].length, 1);
  const list = SOURCE.slice(SOURCE.indexOf('const failableQueries = ['), SOURCE.indexOf('];', SOURCE.indexOf('const failableQueries = [')));
  assert.ok(list.includes('syncHealthQ'), 'the health query is fetched but not declared failable');
  // The declaration has to come before the list that references it, or this is a runtime error
  // rather than a missing banner.
  assert.ok(SOURCE.indexOf('const syncHealthQ = useQuery(') < SOURCE.indexOf('const failableQueries = ['));
});
