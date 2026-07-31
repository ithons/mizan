import test from 'node:test';
import assert from 'node:assert/strict';
import { readState } from '../client/src/components/balance/Figure';
import { signedBarScale } from '../client/src/components/balance/ProgressBar';
import {
  FREE_STATES,
  INSTRUMENT_WINDOWS,
  describeWeekChange,
  describeWindow,
  formatPointsFigure,
  isWindowId,
  readComparison,
  readStanding,
  readWeekChange,
  splitSpending,
  windowRange,
  type SheetPoint,
  type SpendingCategory,
  type WindowId,
} from '../client/src/views/instrumentReadings';
import type {
  NullableMetricSummary,
  ReportMetricSummary,
  ReportSummary,
  SafeToSpend,
} from '../shared/types';

/**
 * What `/` claims, checked without a DOM.
 *
 * Every fixture below is the shape the live ledger actually produces, measured against a private
 * copy of `.mizan/mizan.db` whose newest `schema_migrations` row is `053_drop_budget_groups.sql`.
 * The queries that produced each figure are named beside it, because a number in a test that
 * nothing can reproduce is worth no more than a number in a comment.
 */

/* ── Hazard 4: `free` is signed, and the two directions are two states ───────── */

function safeToSpend(overrides: Partial<SafeToSpend> = {}): SafeToSpend {
  // The live breakdown on 2026-07-31, from
  //   computeSafeToSpend(db, { budgets: getMonthlyBudgetsWithProjection(db, 2026, 7) })
  // which is exactly what GET /api/insights/safe-to-spend serves. Cents there, dollars here.
  return {
    liquid: 6035.67,
    card_balances: 4278.7,
    upcoming_bills: 64.04,
    allocated_budgets: 500,
    allocated_goals: 1001.7,
    free: 191.23,
    forecast_days: 30,
    ...overrides,
  };
}

test('having room and being short are two states, not one figure in a different colour', () => {
  const room = readStanding(safeToSpend());
  assert.equal(room.kind, 'free');
  assert.equal(room.kind === 'free' && room.magnitude, 191.23);

  const shortfall = readStanding(safeToSpend({ free: -1427.96 }));
  assert.equal(shortfall.kind, 'short');
  // The magnitude, never the signed value: the direction is spent on the word beside it.
  assert.equal(shortfall.kind === 'short' && shortfall.magnitude, 1427.96);
  assert.ok(
    shortfall.kind === 'short' && shortfall.value < 0,
    'the signed value is still carried, so Figure can pick the state'
  );

  // The two readings must not share a sentence. This is the whole hazard: rendering a negative
  // `free` in the slot a positive one used to sit in says nothing about which state it is.
  assert.notEqual(room.detail, shortfall.detail);
  assert.match(room.detail, /Left in the liquid pool/);
  assert.match(shortfall.detail, /claim more than the liquid pool holds/);

  // And the word under the numeral differs, through the primitive that owns that rule.
  assert.notEqual(readState(room.kind === 'free' ? room.value : 0, FREE_STATES), readState(-1, FREE_STATES));
  assert.equal(readState(191.23, FREE_STATES), 'free to spend');
  assert.equal(readState(-1427.96, FREE_STATES), 'short this month');
  assert.equal(readState(0, FREE_STATES), 'exactly level');
});

test('being short names the largest claim, and having room does not', () => {
  const shortfall = readStanding(safeToSpend({ free: -1427.96 }));
  assert.equal(shortfall.kind, 'short');
  // Cards are the largest of the four claims on this breakdown: 4278.70 > 1001.70 > 500 > 64.04.
  assert.equal(shortfall.kind === 'short' && shortfall.largestClaim, 'The largest single claim is $4,278.70 of card balances.');

  // There is nothing to do about the composition of a surplus, so nothing is said about it.
  const room = readStanding(safeToSpend());
  assert.ok(!('largestClaim' in room));
});

test('a card total in credit is not a claim, so it can never be the largest one', () => {
  // Hazard 5 reaching hazard 4: with every card in credit the total is negative and ADDS to the
  // pool. Naming it as the biggest claim on the pool would be the exact inversion the sign fix
  // removed everywhere else.
  const shortfall = readStanding(
    safeToSpend({ card_balances: -625.2, allocated_goals: 1001.7, free: -100 })
  );
  assert.equal(shortfall.kind, 'short');
  assert.equal(shortfall.kind === 'short' && shortfall.largestClaim, 'The largest single claim is $1,001.70 of goal earmarks.');

  // And when nothing at all is claiming, there is no largest claim to name.
  const nothingClaimed = readStanding(
    safeToSpend({ card_balances: -10, upcoming_bills: 0, allocated_budgets: 0, allocated_goals: 0, free: -5 })
  );
  assert.equal(nothingClaimed.kind === 'short' && nothingClaimed.largestClaim, null);
});

test('exactly level is its own reading, and an unread breakdown claims nothing', () => {
  const level = readStanding(safeToSpend({ free: 0 }));
  assert.equal(level.kind, 'level');
  assert.match(level.detail, /already claimed/);

  // Not "you have $0 free": that asserts a measurement where the code only knows it has none.
  const unread = readStanding(undefined);
  assert.equal(unread.kind, 'unread');
  assert.doesNotMatch(unread.detail, /\$/);
  assert.deepEqual(readStanding(null), unread);
});

/* ── Hazard 1: a spending category can be negative ───────────────────────────── */

function category(id: string, name: string, amount: number, percentage: number): SpendingCategory {
  return { category_id: id, category_name: name, amount, percentage };
}

/**
 * July 2026, exactly as `GET /api/reports/spending?startDate=2026-07-01&endDate=2026-07-31` serves
 * it, from `getSpendingReport(db, { startDate: '2026-07-01', endDate: '2026-07-31' })`:
 *
 *   total 111299c   Food & Drink 73160  Travel 49625  Transport 41614  Subscriptions 16271
 *                   Pets 14029  Entertainment 9622  Health 8257  Home 1584  Shopping -102863
 *
 * Shopping is negative because that month's Amazon and REI credits outweigh its purchases:
 *
 *   SELECT t.date, t.merchant_name, t.amount FROM transactions t JOIN categories c ON c.id = t.category_id
 *   WHERE (c.name = 'Shopping' OR c.parent_id IN (SELECT id FROM categories WHERE name = 'Shopping'))
 *     AND t.date BETWEEN '2026-07-01' AND '2026-07-31';
 *   -- eight purchases summing -102459c against four credits summing +205322c
 */
const JULY_TOTAL = 1112.99;
const JULY: SpendingCategory[] = [
  category('c_food', 'Food & Drink', 731.6, 65.73),
  category('c_travel', 'Travel', 496.25, 44.59),
  category('c_transport', 'Transport', 416.14, 37.39),
  category('c_subs', 'Subscriptions', 162.71, 14.62),
  category('c_pets', 'Pets', 140.29, 12.6),
  category('c_ent', 'Entertainment', 96.22, 8.65),
  category('c_health', 'Health', 82.57, 7.42),
  category('c_home', 'Home', 15.84, 1.42),
  category('c_shop', 'Shopping', -1028.63, -92.42),
];

const cents = (dollars: number) => Math.round(dollars * 100);

test('the report`s own percentage field is not a share of anything, which is why none is printed', () => {
  // The reason the surface prints no percentage: these are shares of a SIGNED total. The eight
  // categories that cost money account for 192.42% of the month between them, and the one that
  // gave money back is at -92.42%. Both come straight off the API response above.
  const spendShare = JULY.filter((c) => c.amount > 0).reduce((sum, c) => sum + c.percentage, 0);
  assert.equal(Math.round(spendShare * 100) / 100, 192.42);
  assert.equal(JULY.find((c) => c.category_name === 'Shopping')?.percentage, -92.42);
  // They do sum to 100, which is exactly what makes each one individually unreadable.
  assert.equal(Math.round(JULY.reduce((sum, c) => sum + c.percentage, 0)), 100);
});

test('a category that came back is its own group, and it leads', () => {
  const split = splitSpending(JULY);

  assert.deepEqual(split.returned.map((c) => c.category_name), ['Shopping']);
  assert.equal(cents(split.returnedTotal), 102863, 'the group total is a magnitude, not a negative');
  assert.deepEqual(
    split.spent.map((c) => c.category_name),
    ['Food & Drink', 'Travel', 'Transport', 'Subscriptions', 'Pets', 'Entertainment', 'Health', 'Home']
  );

  // The defect this replaces: ranking the whole list by amount descending puts the single largest
  // movement of money in the month LAST, under a heading that says top spending. Both shipped
  // screens did that, and both capped the list at six or eight rows above it.
  const byAmount = [...JULY].sort((a, b) => b.amount - a.amount);
  assert.equal(byAmount[byAmount.length - 1].category_name, 'Shopping');
  assert.equal(Math.abs(byAmount[byAmount.length - 1].amount) > byAmount[0].amount, true);
});

test('the two groups reproduce the report total exactly, on every window', () => {
  // The identity the section rests on: what it says went out, minus what it says came back, is the
  // figure printed at the top of it. Settled in cents, because these are API dollars.
  const july = splitSpending(JULY);
  assert.equal(cents(july.spentTotal), 214162);
  assert.equal(cents(july.spentTotal) - cents(july.returnedTotal), cents(JULY_TOTAL));

  // June 2026 has no returns at all (measured: `getSpendingReport` over 2026-06 returns nine
  // categories, none negative), so the section must read exactly like an ordinary ranking.
  const june = splitSpending(JULY.filter((c) => c.amount > 0));
  assert.equal(june.returned.length, 0);
  assert.equal(june.returnedTotal, 0);
  assert.equal(cents(june.spentTotal), 214162);

  // A category settled at exactly zero moved no money and is not a return.
  const withZero = splitSpending([...JULY, category('c_zero', 'Gifts', 0, 0)]);
  assert.equal(withZero.returned.length, 1);
  assert.equal(withZero.spent.length, 9);
  assert.equal(cents(withZero.spentTotal) - cents(withZero.returnedTotal), cents(JULY_TOTAL));

  assert.deepEqual(splitSpending([]), { spent: [], returned: [], spentTotal: 0, returnedTotal: 0 });
});

test('one scale spans both groups, so a return is comparable to the spend it offsets', () => {
  const split = splitSpending(JULY);
  const scale = signedBarScale([...split.spent, ...split.returned].map((c) => c.amount));

  // The extent is Shopping's return, not the largest expense: it is the biggest thing on the list.
  assert.equal(cents(scale.extent), 102863);
  assert.equal(scale.diverging, true, 'a zero rule has to appear the moment one bar points left');

  // With no returns the rule goes back to the left edge and the bars fill the whole track, which is
  // what every window before July looked like.
  const noReturns = signedBarScale(split.spent.map((c) => c.amount));
  assert.equal(noReturns.diverging, false);
  assert.equal(cents(noReturns.extent), 73160);
});

test('a merchant total and a category total are different quantities, so no share is printed', () => {
  // `getTopMerchantsReport` sums ABS(amount) per merchant while its own `total` is SUM(-amount)
  // over the same predicate, so the two are not commensurable. Measured on July 2026: Amazon
  // 179586c gross across 5 rows, against a report total of 111299c. Reports.tsx divided one by the
  // other and rendered the result as "161%", with the bar clipped at the end of its track.
  const amazonGross = 1795.86;
  const share = (amazonGross / JULY_TOTAL) * 100;
  assert.equal(Math.round(share), 161);
  assert.ok(share > 100, 'a share above 100% is the proof that these are two different quantities');
});

/* ── Hazard 3: a week is only a week against a sheet that measured the same thing ── */

function sheetPoint(
  date: string,
  assets: number,
  liabilities: number,
  netWorth: number,
  coverage: number,
  isEstimated = false
): SheetPoint {
  return { date, assets, liabilities, netWorth, isEstimated, coveredAccounts: coverage, totalAccounts: coverage };
}

/**
 * The measured tail of the live series, cents in the table and dollars here:
 *
 *   SELECT date, total_assets, total_liabilities, net_worth, is_estimated, covered_accounts,
 *          total_accounts
 *   FROM net_worth_snapshots WHERE date >= '2026-07-13' ORDER BY date;
 *
 * Coverage steps 11 to 14 on 2026-07-24, and three accounts arriving in mizān is not money moving.
 */
const SHEETS: SheetPoint[] = [
  sheetPoint('2026-07-13', 10294.39, 4725.27, 5569.12, 11),
  sheetPoint('2026-07-14', 6871.53, 3852.93, 3018.6, 11),
  sheetPoint('2026-07-15', 6967.64, 3899.68, 3067.96, 11),
  sheetPoint('2026-07-16', 7503.38, 3903.5, 3599.88, 11),
  sheetPoint('2026-07-23', 8039.32, 4943.38, 3095.94, 11),
  sheetPoint('2026-07-24', 8032.4, 5283.01, 2749.39, 14),
  sheetPoint('2026-07-27', 8008.38, 5229.91, 2778.47, 14),
  sheetPoint('2026-07-28', 8012.58, 5229.91, 2782.67, 14),
  sheetPoint('2026-07-29', 7735.16, 5653.71, 2081.45, 14),
  sheetPoint('2026-07-30', 8481.56, 4278.7, 4202.86, 14),
  sheetPoint('2026-07-31', 8471.88, 4278.7, 4193.18, 14),
];

const before = (date: string) => SHEETS.filter((s) => s.date < date);
const at = (date: string) => SHEETS.find((s) => s.date === date)!;

test('the figure the old rule drew on 2026-07-30 was three accounts arriving, and is refused', () => {
  // What the old rule computed: `latest.net_worth - weekAgo.net_worth` with nothing but a
  // seven-day filter. 2026-07-30 minus 2026-07-23 is the pair, and it crosses the coverage step.
  const naive = cents(at('2026-07-30').netWorth) - cents(at('2026-07-23').netWorth);
  assert.equal(naive, 110692, 'the $1,107 the screen used to render in the positive tone');
  assert.equal(at('2026-07-30').coveredAccounts, 14);
  assert.equal(at('2026-07-23').coveredAccounts, 11);

  const change = readWeekChange(before('2026-07-30'), at('2026-07-30'));
  assert.equal(change.kind, 'incomparable');
  // Five sheets are at least seven days back and not one of them read the same accounts.
  assert.equal(change.kind === 'incomparable' && change.refused, 5);

  const caption = describeWeekChange(change);
  assert.equal(
    caption.reading,
    'No sheet at least seven days back reached the same 14 of 14 accounts, so there is no week to compare.'
  );
  assert.equal(caption.note, '5 earlier sheets reached a different set of accounts and are not comparable to this one.');
  assert.doesNotMatch(caption.reading, /1,107|1,106/, 'the flattened figure is not printed anywhere');
});

test('the coverage step took a full week of readings with it, not one', () => {
  // Every sheet recorded from the step to the day before a comparable baseline exists is refused,
  // which is the claim the source comment makes and the reason this is not a one-day curiosity.
  for (const date of ['2026-07-24', '2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30']) {
    const change = readWeekChange(before(date), at(date));
    assert.equal(change.kind, 'incomparable', `${date} should have no comparable week`);
  }
});

test('a week the coverage rule can vouch for is stated, with what it refused beside it', () => {
  const change = readWeekChange(before('2026-07-31'), at('2026-07-31'));
  assert.equal(change.kind, 'change');
  assert.equal(change.kind === 'change' && change.since, '2026-07-24', 'the nearest COMPARABLE sheet, not the nearest');
  // Settled in cents: 419318 - 274939. In float these dollars give 1443.7900000000004.
  assert.equal(change.kind === 'change' && cents(change.delta), 144379);
  assert.equal(change.kind === 'change' && change.refused, 5);

  const caption = describeWeekChange(change);
  assert.equal(
    caption.reading,
    '+$1,444 since 24 July, the nearest sheet at least seven days back that reached the same 14 of 14 accounts.'
  );
  assert.equal(caption.note, '5 earlier sheets reached a different set of accounts and are not comparable to this one.');
});

test('an estimated sheet is never a baseline, even when its coverage matches exactly', () => {
  //   SELECT date, total_assets, total_liabilities, net_worth, is_estimated, covered_accounts,
  //          total_accounts FROM net_worth_snapshots WHERE date IN ('2026-03-01', '2026-04-01');
  //   -- 2026-03-01  613238c  554131c  59107c   est  14/14
  //   -- 2026-04-01 1144870c  530809c 614061c   est  14/14
  // The old rule read +554954c off this pair; both sheets are replayed from the ledger, not
  // measured, so neither can vouch for the other.
  const march = sheetPoint('2026-03-01', 6132.38, 5541.31, 591.07, 14, true);
  const april = sheetPoint('2026-04-01', 11448.7, 5308.09, 6140.61, 14, true);
  assert.equal(cents(april.netWorth) - cents(march.netWorth), 554954);

  const change = readWeekChange([march], april);
  assert.equal(change.kind, 'incomparable');
  assert.equal(change.kind === 'incomparable' && change.refused, 1);
  assert.equal(
    describeWeekChange(change).note,
    'One earlier sheet reached a different set of accounts and is not comparable to this one.'
  );
});

test('no sheet far enough back, and no sheet at all, are their own readings', () => {
  // Six days is not a week, and the rule does not stretch to find something to say.
  const sixDays = readWeekChange([at('2026-07-24')], at('2026-07-30'));
  assert.equal(sixDays.kind, 'none');
  assert.equal(describeWeekChange(sixDays).reading, 'No earlier sheet recorded to compare against.');
  assert.equal(describeWeekChange(sixDays).note, null);

  assert.deepEqual(readWeekChange(SHEETS, null), { kind: 'none' });
  assert.deepEqual(readWeekChange([], at('2026-07-31')), { kind: 'none' });
});

test('a sheet written before migration 044 records no coverage, and says so instead of comparing', () => {
  // `covered_accounts` is NULL on those rows, so there is nothing to match. Claiming a week
  // against them would be exactly the inference this whole reading exists to refuse.
  const uncounted: SheetPoint = { ...at('2026-07-31'), coveredAccounts: null, totalAccounts: null };
  const change = readWeekChange(before('2026-07-31'), uncounted);
  assert.equal(change.kind, 'uncounted');
  assert.match(describeWeekChange(change).reading, /does not record how many accounts it reached/);
  assert.doesNotMatch(describeWeekChange(change).reading, /\$/);
});

test('a change in a rate is in points, and a rate that moved never prints as zero', () => {
  // The live `this month` summary carries savings_rate.delta = 195.61378142653112, a difference of
  // two percentages (59.01193194372837 against -136.60184948280275). Percent would be a lie.
  assert.equal(formatPointsFigure(195.61378142653112), '196 points');
  assert.equal(formatPointsFigure(1), '1 point');
  assert.equal(formatPointsFigure(0.4), '0.4 points');
  // A rate that moved must never print as a rate that did not, which is why the floor is a phrase
  // rather than another rounding step.
  assert.equal(formatPointsFigure(0.04), 'under 0.1 points');
});

/* ── The window ──────────────────────────────────────────────────────────────── */

const NOW = new Date(2026, 6, 31); // 31 July 2026, local, the day this was measured

test('four windows, each a different question rather than a different length', () => {
  assert.deepEqual(INSTRUMENT_WINDOWS.map((w) => w.id), ['this-month', 'last-month', 'six-months', 'all']);

  assert.deepEqual(windowRange('this-month', NOW), { startDate: '2026-07-01', endDate: '2026-07-31' });
  // Closed, and it does not reach today: that is the whole reason it is a separate window from the
  // month in progress, and the only window whose answer will not change tomorrow.
  assert.deepEqual(windowRange('last-month', NOW), { startDate: '2026-06-01', endDate: '2026-06-30' });
  assert.deepEqual(windowRange('six-months', NOW), { startDate: '2026-02-01', endDate: '2026-07-31' });

  // `all` is bounded by the ledger, not by this constant: the live ledger's first transaction is
  // 2023-09-16 (SELECT MIN(date) FROM transactions), and 50 years of runway clears it.
  const all = windowRange('all', NOW);
  assert.equal(all.startDate, '1976-07-01');
  assert.equal(all.endDate, '2026-07-31');
  assert.ok(all.startDate < '2023-09-16');
});

test('an unknown window in the URL falls back rather than rendering an empty range', () => {
  assert.equal(isWindowId('six-months'), true);
  assert.equal(isWindowId('this-year'), false, 'a window Reports used to offer and this surface does not');
  assert.equal(isWindowId(null), false);
  assert.equal(isWindowId(''), false);
});

test('the window is described from the months that carry activity, not from the dates asked for', () => {
  // `all` asks for fifty years; the ledger holds 35 months, 2023-09 to 2026-07
  // (SELECT COUNT(*) over getCashflowReport's months on the live database).
  const allMonths = ['2023-09', '2023-10', '2026-06', '2026-07'];
  assert.equal(
    describeWindow(allMonths, windowRange('all', NOW), NOW),
    'September 2023 to July 2026 · 4 months, the last still running'
  );

  // A month in progress and a month with a final answer read differently.
  assert.equal(describeWindow(['2026-07'], windowRange('this-month', NOW), NOW), 'July 2026 · still running');
  assert.equal(describeWindow(['2026-06'], windowRange('last-month', NOW), NOW), 'June 2026 · closed');

  // A closed multi-month window says so too.
  assert.equal(
    describeWindow(['2026-05', '2026-06'], windowRange('last-month', NOW), NOW),
    'May 2026 to June 2026 · 2 months'
  );

  // Nothing recorded is not "zero spent": it falls back to the dates and says what it found.
  assert.equal(
    describeWindow([], { startDate: '2026-01-01', endDate: '2026-01-31' }, NOW),
    '1 Jan 2026 to 31 Jan 2026 · nothing recorded'
  );
});

function metric(current: number, previous: number): ReportMetricSummary {
  return { current, previous, delta: current - previous, delta_percent: previous === 0 ? null : ((current - previous) / previous) * 100 };
}

function nullableMetric(current: number | null, previous: number | null): NullableMetricSummary {
  return { current, previous, delta: null, delta_percent: null };
}

function summary(overrides: Partial<ReportSummary> = {}): ReportSummary {
  return {
    comparison: 'prior_period',
    comparison_label: 'Prior period',
    comparison_start_date: '2026-05-31',
    comparison_end_date: '2026-06-30',
    income: metric(2715.4, 2735.9),
    expenses: metric(1112.99, 6473.19),
    net: metric(1602.41, -3737.29),
    savings_rate: nullableMetric(59.01, -136.6),
    top_spending: [],
    top_income: [],
    spending_movers: [],
    excluded_flows: [],
    ...overrides,
  };
}

test('a delta against a window that recorded nothing is not a change, and does not render as one', () => {
  // The live `this month` summary, prior_period: June is a real month and the deltas mean something.
  const live = readComparison(summary());
  assert.equal(live.comparable, true);
  assert.match(live.note, /^Compared with prior period \(2026-05-31 to 2026-06-30\)\.$/);

  // The live `all` summary, re-measured rather than restated. `ALL_WINDOW_MONTHS = 600` puts the
  // window at 1976-07-01 to 2026-07-31, and the prior period is the same length again immediately
  // before it, so it lands half a century before the ledger and holds no rows:
  //
  //   getReportSummary(db, { ...windowRange('all', new Date(2026, 6, 31)), comparison: 'prior_period' })
  //   -- comparison_start_date 1926-06-01, comparison_end_date 1976-06-30
  //   -- income 1146127c vs 0c, expenses 7485650c vs 0c, net -6339523c vs 0c
  //   -- savings_rate -553.1257007295003 vs null
  //
  // Both `previous` terms at zero is the check; a window with any income or any expenses in it
  // cannot produce that pair.
  const allTime = readComparison(
    summary({
      comparison_start_date: '1926-06-01',
      comparison_end_date: '1976-06-30',
      income: metric(11461.27, 0),
      expenses: metric(74856.5, 0),
      net: metric(-63395.23, 0),
      savings_rate: nullableMetric(-553.1257007295003, null),
    })
  );
  assert.equal(allTime.comparable, false);
  assert.match(allTime.note, /Nothing is recorded in prior period \(1926-06-01 to 1976-06-30\), so there is no change/);

  // A window with expenses but no income is still comparable: it recorded something.
  const spendOnly = readComparison(summary({ income: metric(0, 0), expenses: metric(50, 120) }));
  assert.equal(spendOnly.comparable, true);
});

test('every window id the selector offers resolves to a range', () => {
  for (const w of INSTRUMENT_WINDOWS) {
    const range = windowRange(w.id satisfies WindowId, NOW);
    assert.match(range.startDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(range.endDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(range.startDate <= range.endDate, `${w.id} resolves to an inverted range`);
  }
});
