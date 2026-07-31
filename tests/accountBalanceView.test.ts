import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creditNote, isInCredit, signedAccountBalance } from '../client/src/lib/accountBalance';
import {
  beamPositionFraction,
  beamTiltDegrees,
  calibrationNote,
  captionText,
  comparableHistory,
  describeReading,
  readCalibration,
  scalePans,
  type BeamHistory,
  type BeamHistoryPoint,
} from '../client/src/components/balance/BalanceScale';

/**
 * How the screens read a liability that is in CREDIT.
 *
 * The server was fixed first and the screens still contradicted it: `-Math.abs(current_balance)`
 * turned each of the three cards that owed the owner money on 2026-07-29 (Discover $563.26, Chase
 * Freedom Flex $283.81, BofA Cash Rewards $5.82) into debt of the same size, so the Accounts list
 * printed a net worth $1,705.78 below the one the AI context computed from the same rows.
 *
 * Balances are dollars here, the unit the API hands the client.
 */

const discover = { type: 'credit' as const, is_liability: true, current_balance: -563.26 };
const sapphire = { type: 'credit' as const, is_liability: true, current_balance: 4791.94 };
const checking = { type: 'checking' as const, is_liability: false, current_balance: 7735.16 };
const loan = { type: 'other' as const, is_liability: true, current_balance: -20 };

test('a card in credit contributes to net worth instead of subtracting from it', () => {
  assert.equal(signedAccountBalance(discover), 563.26);
  assert.equal(signedAccountBalance(sapphire), -4791.94);
  assert.equal(signedAccountBalance(checking), 7735.16);
});

test('a credit position is a different state from debt, and says so', () => {
  assert.equal(isInCredit(discover), true);
  assert.equal(isInCredit(sapphire), false);
  assert.equal(isInCredit(checking), false, 'an asset is never "in credit"');

  // Matches the advisor context's wording, which renders these as "credit balance (the card owes
  // you)". Two surfaces describing the same row must not describe it two different ways.
  assert.match(creditNote(discover), /owes you/);
  assert.match(creditNote(discover), /card/);
  // Not every liability is a card: an overpaid loan is in credit too, and is not called one.
  assert.match(creditNote(loan), /account/);
});

test('the accounts screen totals agree with the server on all three figures', () => {
  const live = [checking, discover, sapphire];
  const assets = live.filter((a) => !a.is_liability).reduce((s, a) => s + a.current_balance, 0);
  const owed = live.filter((a) => a.is_liability).reduce((s, a) => s + a.current_balance, 0);

  // snapshot.ts splits by role and subtracts. The screen used to split by SIGN, which put a card in
  // credit on the assets side and then counted it against itself through Math.abs().
  assert.equal(round(assets), 7735.16);
  assert.equal(round(owed), 4228.68);
  assert.equal(round(assets - owed), 3506.48);

  const flattened = live.reduce((s, a) => s + (a.is_liability ? -Math.abs(a.current_balance) : a.current_balance), 0);
  assert.equal(round(assets - owed - flattened), 1126.52, 'the old expression was low by twice the credit');
});

test('a net credit position sits on the held side, not on the owed side', () => {
  const pans = scalePans(7735.16, -852.89);
  assert.equal(pans.owed, 0, 'nothing is owed when every card is in credit');
  assert.equal(round(pans.held), 8588.05);
  assert.equal(pans.credit, 852.89);
  // The property that keeps the instrument honest against the figures printed beside it.
  assert.equal(round(pans.held - pans.owed), round(7735.16 + 852.89));

  // Math.abs() drew this sheet as one carrying $852.89 of debt: the beam sat the wrong side of even.
  assert.ok(beamTiltDegrees(pans.held, pans.owed) > beamTiltDegrees(7735.16, 852.89));
  assert.ok(beamPositionFraction(pans.held, pans.owed) > beamPositionFraction(7735.16, 852.89));
});

test('an ordinary sheet of debt is unchanged by the credit handling', () => {
  const pans = scalePans(7735.16, 4228.68);
  assert.equal(pans.owed, 4228.68);
  assert.equal(pans.held, 7735.16);
  assert.equal(pans.credit, 0);
  assert.equal(beamTiltDegrees(pans.held, pans.owed), beamTiltDegrees(7735.16, 4228.68));
});

// ─── The reading the beam takes ───────────────────────────────────────────────

test('the position and the tilt are the same reading, so they cannot drift apart', () => {
  for (const [held, owed] of [
    [7735.16, 5653.71],
    [7735.16, 3947.93],
    [5942.97, 7004.46],
    [1, 0],
    [0, 1],
    [46490, 46490],
    [0, 0],
  ]) {
    const fromTilt = beamTiltDegrees(held, owed) / 18 + 0.5;
    assert.ok(
      Math.abs(beamPositionFraction(held, owed) - fromTilt) < 1e-12,
      `${held}/${owed} disagrees with the tilt it is derived from`
    );
    // And the closed form the axis label promises: the fraction of the whole sheet that is held.
    const share = held + owed > 0 ? held / (held + owed) : 0.5;
    assert.ok(Math.abs(beamPositionFraction(held, owed) - share) < 1e-12);
  }
});

test('the owner’s own sheet lands where the axis says it does', () => {
  // Latest recorded balance sheet, 2026-07-29: assets $7,735.16, liabilities $5,653.71.
  const now = beamPositionFraction(...panArgs(7735.16, 5653.71));
  assert.equal((now * 100).toFixed(1), '57.8');
  assert.equal((now * 100 - 50).toFixed(1), '7.8', 'points clear of even');

  // 2026-03-01, the far side of even: assets $5,942.97, liabilities $7,004.46.
  const march = beamPositionFraction(...panArgs(5942.97, 7004.46));
  assert.equal((march * 100).toFixed(1), '45.9');
  assert.equal((50 - march * 100).toFixed(1), '4.1', 'points short of even');
});

/**
 * Why the drawn scale was replaced, re-derived rather than asserted in a comment.
 *
 * The old figure mapped the whole 18-degree domain onto the vertical travel of a beam end:
 * 2 x HALF_BEAM x sin(MAX_TILT), in viewBox units, at the 332/320 scale it rendered at. The beam
 * maps the same domain onto the width of its container. Every figure below is that arithmetic.
 */
const HALF_BEAM = 104;
const MAX_TILT_DEG = 9;
const UNIT_PX = 332 / 320;

/** Vertical travel of a beam end, in the px the drawn figure rendered at. */
function panPx(tiltDegrees: number): number {
  return HALF_BEAM * Math.sin((tiltDegrees * Math.PI) / 180) * UNIT_PX;
}

test('the beam is worth the change by a factor this test computes', () => {
  const panTravelPx = 2 * panPx(MAX_TILT_DEG);
  assert.ok(panTravelPx > 33.7 && panTravelPx < 33.8, `expected ~33.76px, got ${panTravelPx}`);

  // A sheet recorded 2026-07-29, on the figure it replaces: a pan end 2.6px off level.
  const offEven = beamPositionFraction(...panArgs(7735.16, 5653.71)) - 0.5;
  const panOffsetPx = panPx(beamTiltDegrees(7735.16, 5653.71));
  assert.equal(panOffsetPx.toFixed(1), '2.6');

  // The same sheet on the beam, at the widths this screen actually renders at.
  for (const [width, floor] of [[900, 25], [1060, 29], [1240, 34]]) {
    assert.ok(
      (offEven * width) / panOffsetPx > floor,
      `at ${width}px the beam is only ${((offEven * width) / panOffsetPx).toFixed(1)}x the pan`
    );
  }
});

/**
 * The two windows the comments in BalanceScale.tsx and Today.tsx quote, kept apart on purpose.
 *
 * A note in `beamPositionFraction` claimed "seven months of it spanned 5px", and no window pairs
 * those. Six months of the whole series spans 8.66px of pan travel; 5.13px is one month of the
 * measured segment. Endpoints are the extreme-tilt rows of each window, read on 2026-07-31 from a
 * copy of .mizan/mizan.db at migration 046:
 *
 *   SELECT date, total_assets, total_liabilities, is_estimated FROM net_worth_snapshots
 *   ORDER BY date;
 *
 * Today reads the newest sheet (2026-07-30) and hands the other 19 to the axis as history.
 */
const SERIES_FLOOR = { date: '2026-02-01', assets: 3029.29, liabilities: 4018.38 };   // replayed
const MEASURED_FLOOR = { date: '2026-06-30', assets: 8377.52, liabilities: 7309.23 };
const SERIES_PEAK = { date: '2026-07-13', assets: 10294.39, liabilities: 4725.27 };

test('the drawn scale collapsed both history windows, at different sizes', () => {
  const tiltOf = (p: typeof SERIES_PEAK) => beamTiltDegrees(...panArgs(p.assets, p.liabilities));

  // All 19 sheets on the axis, 2026-02-01 to 2026-07-29: six months.
  const wholeSeries = tiltOf(SERIES_PEAK) - tiltOf(SERIES_FLOOR);
  assert.equal(wholeSeries.toFixed(3), '4.600');
  assert.equal((panPx(tiltOf(SERIES_PEAK)) - panPx(tiltOf(SERIES_FLOOR))).toFixed(2), '8.66');

  // The 14 measured ones among them, 2026-06-30 to 2026-07-29: one month.
  const measured = tiltOf(SERIES_PEAK) - tiltOf(MEASURED_FLOOR);
  assert.equal(measured.toFixed(3), '2.724');
  assert.equal((panPx(tiltOf(SERIES_PEAK)) - panPx(tiltOf(MEASURED_FLOOR))).toFixed(2), '5.13');

  // The same month on the beam. Screen `wide` is max-w-[1240px] with xl:px-12 beside NavRail's
  // xl:w-[148px], so a 1440px window gives the beam 1440 - 148 - 96 = 1196px, and the 1240px cap
  // needs a window above 1484px. 1196px is the width Today's note now quotes.
  assert.equal(1440 - 148 - 2 * 48, 1196);
  assert.equal(Math.min(1240, 1280 - 148 - 2 * 48), 1036);
  assert.equal(Math.min(1240, 1024 - 56 - 2 * 36), 896);
  assert.equal(((measured / (2 * MAX_TILT_DEG)) * 1196).toFixed(0), '181');
});

test('the settle overshoots by 9%, which is what the clamp is sized for', () => {
  // `useSettledValue` eases with 1 - e^(-7t)cos(8t). Both this file's clamp note and that hook
  // claimed ~6%.
  let peak = 0;
  for (let i = 0; i <= 200_000; i++) {
    const t = i / 200_000;
    peak = Math.max(peak, 1 - Math.exp(-7 * t) * Math.cos(8 * t));
  }
  assert.equal(peak.toFixed(4), '1.0903');
  assert.ok(peak > 1.09, 'a clamp sized for 6% would let a reading above 94% off the end of the track');
});

// ─── What the instrument will and will not vouch for ──────────────────────────

const HEALTHY = {
  sheetDate: '2026-07-31',
  today: '2026-07-31',
  isEstimated: false,
  coveredAccounts: 14,
  totalAccounts: 14,
  syncIncomplete: false,
};

test('a sheet measured today against every account is calibrated, and says nothing', () => {
  const reading = readCalibration(HEALTHY);
  assert.equal(reading.calibrated, true);
  assert.deepEqual(reading.faults, [], 'a healthy sheet must not produce a single caveat');

  // Coverage that was never recorded (rows written before migration 044) is not a coverage
  // failure. Claiming one would be asserting a check that did not run.
  const preMigration = readCalibration({ ...HEALTHY, coveredAccounts: null, totalAccounts: null });
  assert.deepEqual(preMigration.faults, []);
});

test('every condition that takes the reading out of calibration says which one it was', () => {
  const estimated = readCalibration({ ...HEALTHY, isEstimated: true });
  assert.equal(estimated.calibrated, false);
  assert.deepEqual(estimated.faults, [{ kind: 'estimated' }]);
  assert.match(calibrationNote(estimated.faults[0]), /replayed from the ledger/);

  const partial = readCalibration({ ...HEALTHY, coveredAccounts: 11, totalAccounts: 14 });
  assert.deepEqual(partial.faults, [{ kind: 'coverage', covered: 11, total: 14 }]);
  assert.equal(calibrationNote(partial.faults[0]), 'This sheet reached 11 of 14 accounts.');

  // The live state on 2026-07-31: the newest recorded sheet is dated 2026-07-29.
  const stale = readCalibration({ ...HEALTHY, sheetDate: '2026-07-29' });
  assert.deepEqual(stale.faults, [{ kind: 'stale', asOf: '2026-07-29', days: 2 }]);
  assert.equal(calibrationNote(stale.faults[0]), 'Recorded 2 days ago, on 29 July.');
  assert.match(
    calibrationNote(readCalibration({ ...HEALTHY, sheetDate: '2026-07-30' }).faults[0]),
    /Recorded a day ago/
  );

  const failed = readCalibration({ ...HEALTHY, syncIncomplete: true });
  assert.deepEqual(failed.faults, [{ kind: 'sync_incomplete' }]);

  // The state the 7px sage dot rendered as healthy: nothing recorded at all.
  const nothing = readCalibration({ ...HEALTHY, sheetDate: null });
  assert.deepEqual(nothing.faults, [{ kind: 'no_sheet' }]);
  // And with no sheet, the sheet's own properties are not judged: they do not exist.
  const nothingYet = readCalibration({
    ...HEALTHY,
    sheetDate: null,
    isEstimated: true,
    coveredAccounts: 6,
    totalAccounts: 14,
  });
  assert.deepEqual(nothingYet.faults, [{ kind: 'no_sheet' }]);
});

test('faults accumulate rather than the worst one winning', () => {
  const reading = readCalibration({
    ...HEALTHY,
    sheetDate: '2026-06-01',
    isEstimated: true,
    coveredAccounts: 6,
    totalAccounts: 14,
    syncIncomplete: true,
  });
  assert.equal(reading.calibrated, false);
  assert.deepEqual(
    reading.faults.map((f) => f.kind),
    ['estimated', 'coverage', 'stale', 'sync_incomplete']
  );
});

// ─── History that may honestly share the axis ─────────────────────────────────
//
// The live series: 06-30 to 07-23 reached 11 accounts, 07-24 onward reached 14. Three accounts
// arrived in mizān on 07-24, so part of the distance between an 11-account point and a
// 14-account point is not money moving. The instrument refuses that comparison.

const LIVE_HISTORY: BeamHistoryPoint[] = [
  { date: '2026-06-01', assets: 8037.59, liabilities: 4168.67, isEstimated: true, coveredAccounts: null, totalAccounts: null },
  { date: '2026-06-30', assets: 8377.52, liabilities: 7309.23, isEstimated: false, coveredAccounts: 11, totalAccounts: 11 },
  { date: '2026-07-16', assets: 7503.38, liabilities: 3903.5, isEstimated: false, coveredAccounts: 11, totalAccounts: 11 },
  { date: '2026-07-24', assets: 8032.4, liabilities: 5283.01, isEstimated: false, coveredAccounts: 14, totalAccounts: 14 },
  { date: '2026-07-28', assets: 8012.58, liabilities: 5229.91, isEstimated: false, coveredAccounts: 14, totalAccounts: 14 },
];

test('only sheets that reached the same accounts are drawn on the same axis', () => {
  const history = comparableHistory(LIVE_HISTORY, { coveredAccounts: 14, totalAccounts: 14 });
  assert.deepEqual(history.marks.map((m) => m.date), ['2026-07-24', '2026-07-28']);
  assert.equal(history.excluded, 3, 'two 11-account sheets and one replayed month');

  // The positions are the same reading as the needle's, so a mark and the needle are comparable.
  assert.equal((history.marks[0].fraction * 100).toFixed(1), '60.3');
  assert.equal((history.marks[1].fraction * 100).toFixed(1), '60.5');
});

test('a reading with no coverage of its own compares against nothing', () => {
  // A current sheet whose coverage was never recorded cannot establish that any earlier sheet
  // reached the same accounts, so it draws no history rather than assuming it did.
  const history = comparableHistory(LIVE_HISTORY, { coveredAccounts: null, totalAccounts: null });
  assert.deepEqual(history.marks, []);
  assert.equal(history.excluded, LIVE_HISTORY.length);
});

test('a series recorded at one coverage throughout keeps all of it', () => {
  const steady = LIVE_HISTORY.filter((p) => p.coveredAccounts === 11);
  const history = comparableHistory(steady, { coveredAccounts: 11, totalAccounts: 11 });
  assert.equal(history.marks.length, 2);
  assert.equal(history.excluded, 0, 'nothing is refused on a series that never changed shape');
});

// ─── What the caption is allowed to say ───────────────────────────────────────

const NO_HISTORY: BeamHistory = { marks: [], excluded: 0 };

function caption(assets: number, liabilities: number, over: Partial<Parameters<typeof readCalibration>[0]> = {}, history = NO_HISTORY) {
  const pans = scalePans(assets, liabilities);
  return describeReading({
    held: pans.held,
    owed: pans.owed,
    credit: pans.credit,
    calibration: readCalibration({ ...HEALTHY, ...over }),
    history,
  });
}

test('no sheet on record states that, instead of a claim about the balance sheet', () => {
  // The route returns null when nothing has been recorded, so Today has nothing to pass and passes
  // zeros. The caption read those zeros as a sheet and printed "Nothing on either side of the sheet
  // yet", which asserts something about the owner's finances that no check established, and hid the
  // one fault built for this state.
  const nothing = caption(0, 0, { sheetDate: null });
  assert.deepEqual(nothing.faults, ['No balance sheet has been recorded yet.']);
  assert.equal(nothing.reading, null, 'there is no reading to state');
  assert.deepEqual(nothing.notes, []);

  // A sync that failed while no sheet existed still says so; a fault is not withheld by the
  // absence of the thing it qualifies.
  const alsoFailed = caption(0, 0, { sheetDate: null, syncIncomplete: true });
  assert.deepEqual(alsoFailed.faults, [
    'No balance sheet has been recorded yet.',
    'The last sync did not finish every stage.',
  ]);
});

test('a recorded sheet that is genuinely zero keeps every fault it has', () => {
  // Zero on both sides, recorded 60 days ago by a sync that did not finish. The old caption
  // short-circuited on the zeros and printed none of this.
  const stale = caption(0, 0, { sheetDate: '2026-06-01', syncIncomplete: true });
  assert.deepEqual(stale.faults, [
    'Recorded 60 days ago, on 1 June.',
    'The last sync did not finish every stage.',
  ]);
  assert.equal(captionText(stale.reading ?? []), 'Nothing is recorded on either side of this sheet.');
});

test('the credit note claims only what scalePans established', () => {
  // The figure derives credit from the signed liabilities TOTAL. It has established that the owed
  // side is in credit, and nothing at all about cards: Today's readCardCredit is the only thing
  // that filters `type === 'credit'`, and it reports separately.
  const credited = caption(7735.16, -852.89);
  const note = captionText(credited.notes[0]);
  assert.equal(note, '$852.89 of what is held is credit on the liabilities side rather than an asset.');
  assert.doesNotMatch(note, /card/i, 'nothing here checked that the liabilities in credit are cards');
});

test('the reading, the faults and the notes are three separate statements', () => {
  const reading = caption(
    8481.56,
    4278.70,
    { sheetDate: '2026-07-30', coveredAccounts: 11 },
    { marks: [{ date: '2026-07-28', fraction: 0.6 }], excluded: 15 }
  );

  // The latest sheet on record: 2026-07-30, assets $8,481.56, liabilities $4,278.70.
  assert.equal(captionText(reading.reading ?? []), '66.5% of the sheet is held, 16.5 points clear of even.');
  assert.deepEqual(reading.faults, [
    'This sheet reached 11 of 14 accounts.',
    'Recorded a day ago, on 30 July.',
  ]);
  assert.deepEqual(reading.notes.map(captionText), [
    '1 earlier sheet is drawn above.',
    '15 are left off: recorded against a different number of accounts, or replayed rather than measured.',
  ]);
});

test('a debt-free sheet states a magnitude, because the ratio stops distinguishing them', () => {
  const clear = caption(8481.56, 0);
  assert.equal(captionText(clear.reading ?? []), 'Nothing is owed against $8,481.56 held.');
  assert.deepEqual(clear.faults, [], 'a calibrated sheet carries no qualification at all');

  // Every numeral in a reading is set in tabular mono, so a figure never reflows mid-glance.
  assert.deepEqual(
    clear.reading?.filter((s) => s.numeral).map((s) => s.text),
    ['$8,481.56']
  );
});

function panArgs(assets: number, liabilities: number): [number, number] {
  const pans = scalePans(assets, liabilities);
  return [pans.held, pans.owed];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
