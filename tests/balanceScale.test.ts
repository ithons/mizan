import test from 'node:test';
import assert from 'node:assert/strict';
import { beamTiltDegrees } from '../client/src/components/balance/BalanceScale';

const MAX = 9;

test('a sheet with no debt tips fully to assets, and owing everything tips fully the other way', () => {
  assert.equal(beamTiltDegrees(46490, 0), MAX);
  assert.equal(beamTiltDegrees(0, 46490), -MAX);
});

test('owing as much as you hold sits level', () => {
  assert.equal(beamTiltDegrees(46490, 46490), 0);
});

test('nothing on either pan sits level rather than dividing by zero', () => {
  assert.equal(beamTiltDegrees(0, 0), 0);
});

/**
 * The regression this replaced: the old formula multiplied debt share by 12 and clamped to 7
 * degrees, so every sheet below ~21% debt drew an identical picture. That is the range most
 * people actually live in, so the instrument was blank exactly where it was read.
 */
test('states inside the low-debt range stay distinguishable', () => {
  const none = beamTiltDegrees(46490, 0);
  const five = beamTiltDegrees(46490, 2447); // ~5% of the sheet
  const ten = beamTiltDegrees(46490, 5166); // ~10%
  const twenty = beamTiltDegrees(46490, 11623); // ~20%

  for (const [a, b] of [[none, five], [five, ten], [ten, twenty]]) {
    assert.ok(a - b > 0.5, `expected a visible step between ${a} and ${b}`);
  }
});

test('tilt is monotonic in what is owed', () => {
  let previous = Infinity;
  for (let owed = 0; owed <= 60000; owed += 2500) {
    const tilt = beamTiltDegrees(46490, owed);
    assert.ok(tilt < previous, `tilt should keep falling as debt rises, saw ${tilt} after ${previous}`);
    previous = tilt;
  }
});

test('tilt never exceeds the mechanical limit in either direction', () => {
  for (const [assets, owed] of [[1, 0], [0, 1], [1e9, 1], [1, 1e9], [46490, 5281]]) {
    const tilt = beamTiltDegrees(assets, owed);
    assert.ok(Math.abs(tilt) <= MAX, `${tilt} exceeds ${MAX}`);
  }
});
