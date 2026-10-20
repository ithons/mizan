/**
 * An is_estimated net-worth point has one name on screen: the chart legend and tooltip say
 * "reconstructed", so the panel that rebuilds those points and the beam that qualifies a sheet
 * must say the same, not "replayed".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { calibrationNote } from '../client/src/components/balance/BalanceScale';

const ROOT = join(__dirname, '..');

test('the reconstructed-history panel never calls its points replayed', () => {
  const src = readFileSync(join(ROOT, 'client/src/views/settings/DataSection.tsx'), 'utf8');
  assert.doesNotMatch(src, /replay/i);
});

test('the chart legend and the beam use the same word', () => {
  const chart = readFileSync(join(ROOT, 'client/src/components/balance/TrendChart.tsx'), 'utf8');
  assert.match(chart, /key: 'reconstructed'/);
  assert.match(calibrationNote({ kind: 'estimated' }), /reconstructed/);
});
