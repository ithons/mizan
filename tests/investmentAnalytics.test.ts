import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOCATION_SLOTS,
  getAllocationQualityLabel,
  getAllocationDrift,
  getAllocationSlices,
  getPortfolioDelta,
  getConcentrationSummary,
  getCostBasisStats,
  holdingGain,
  getInvestmentDataQualitySummary,
  getInvestmentActivitySummary,
  isLivePosition,
} from '../client/src/lib/investmentAnalytics';
import type { Account, Holding, InvestmentTransaction } from '../shared/types';

function account(id: string, type: Account['type']): Account {
  return {
    id,
    coinbase_account_id: null,
    connection_id: null,
    connection_type: 'manual',
    institution_name: 'Mizan Test',
    account_name: id,
    type,
    subtype: null,
    mask: null,
    current_balance: 0,
    available_balance: null,
    credit_limit: null,
    currency: 'USD',
    native_currency: null,
    native_balance: null,
    is_manual: true,
    is_hidden: false,
    is_liability: false,
    color: null,
    sort_order: 0,
    created_at: '2026-06-30T00:00:00.000Z',
    updated_at: '2026-06-30T00:00:00.000Z',
  };
}

function holding(overrides: Partial<Holding>): Holding {
  return {
    id: overrides.id ?? 'holding',
    account_id: overrides.account_id ?? 'acct_taxable',
    security_id: overrides.security_id ?? 'sec',
    quantity: overrides.quantity ?? 1,
    institution_price: overrides.institution_price ?? overrides.institution_value ?? 0,
    institution_value: overrides.institution_value ?? 0,
    cost_basis: overrides.cost_basis,
    currency: 'USD',
    updated_at: '2026-06-30T00:00:00.000Z',
    ticker: overrides.ticker ?? null,
    security_name: overrides.security_name ?? null,
    security_type: overrides.security_type ?? null,
    cost_basis_quality: overrides.cost_basis_quality,
    provider_cost_basis: overrides.provider_cost_basis,
    manual_cost_basis: overrides.manual_cost_basis,
    sector: overrides.sector ?? null,
    sector_source: overrides.sector_source ?? null,
  };
}

function investmentTransaction(overrides: Partial<InvestmentTransaction>): InvestmentTransaction {
  return {
    id: overrides.id ?? 'tx',
    account_id: overrides.account_id ?? 'acct_taxable',
    date: overrides.date ?? '2026-06-30',
    type: overrides.type ?? 'buy',
    security_id: overrides.security_id ?? null,
    quantity: overrides.quantity ?? null,
    price: overrides.price ?? null,
    amount: overrides.amount ?? 0,
    fees: overrides.fees ?? null,
    name: overrides.name ?? 'Investment transaction',
    created_at: '2026-06-30T00:00:00.000Z',
    ticker: overrides.ticker ?? null,
    security_name: overrides.security_name ?? null,
  };
}

test('cost basis stats only calculate returns from holdings with known basis', () => {
  const stats = getCostBasisStats([
    holding({ id: 'known_a', institution_value: 1200, cost_basis: 1000 }),
    holding({ id: 'known_b', institution_value: 900, cost_basis: 800 }),
    holding({ id: 'missing', institution_value: 500, cost_basis: null }),
  ]);

  assert.equal(stats.label, 'Partial');
  assert.equal(stats.totalCount, 3);
  assert.equal(stats.knownCount, 2);
  assert.equal(stats.missingCount, 1);
  assert.equal(stats.manualCount, 0);
  assert.equal(stats.providerCount, 2);
  assert.equal(stats.knownCostBasis, 1800);
  assert.equal(stats.unrealized, 300);
  assert.equal(stats.returnPct, 300 / 1800 * 100);
  assert.equal(stats.coveragePct, 2 / 3 * 100);
});

test('cost basis stats count manual corrections separately', () => {
  const stats = getCostBasisStats([
    holding({ id: 'manual', institution_value: 1200, cost_basis: 1100, cost_basis_quality: 'manual', manual_cost_basis: 1100, provider_cost_basis: 1000 }),
    holding({ id: 'provider', institution_value: 900, cost_basis: 800, cost_basis_quality: 'provider', provider_cost_basis: 800 }),
    holding({ id: 'missing', institution_value: 500, cost_basis: null, cost_basis_quality: 'missing' }),
  ]);

  assert.equal(stats.knownCount, 2);
  assert.equal(stats.manualCount, 1);
  assert.equal(stats.providerCount, 1);
  assert.equal(stats.knownCostBasis, 1900);
});

test('allocation quality makes missing account links explicit', () => {
  const accounts = new Map([
    ['acct_taxable', account('acct_taxable', 'brokerage')],
    ['acct_ira', account('acct_ira', 'ira_roth')],
  ]);
  const holdings = [
    holding({ id: 'taxable', account_id: 'acct_taxable', institution_value: 1000 }),
    holding({ id: 'ira', account_id: 'acct_ira', institution_value: 500 }),
    holding({ id: 'missing', account_id: 'acct_missing', institution_value: 250 }),
  ];

  const slices = getAllocationSlices(holdings, 'tax_treatment', accounts);

  assert.deepEqual(
    slices.map((slice) => [slice.label, slice.value, Number(slice.pct.toFixed(1))]),
    [
      ['Taxable', 1000, 57.1],
      ['Tax-advantaged', 500, 28.6],
      ['Other', 250, 14.3],
    ]
  );
  assert.equal(
    getAllocationQualityLabel(holdings, 'tax_treatment', accounts),
    '1 holding missing account links'
  );
});

test('sector allocation uses metadata when available and marks gaps', () => {
  const slices = getAllocationSlices([
    holding({ id: 'tech_a', sector: 'Technology', institution_value: 1000 }),
    holding({ id: 'tech_b', sector: 'Technology', institution_value: 500 }),
    holding({ id: 'health', sector: 'Healthcare', institution_value: 300 }),
    holding({ id: 'missing', sector: null, institution_value: 200 }),
  ], 'sector', new Map());

  assert.deepEqual(
    slices.map((slice) => [slice.label, slice.value, Number(slice.pct.toFixed(1))]),
    [
      ['Technology', 1500, 75],
      ['Healthcare', 300, 15],
      ['Sector unavailable', 200, 10],
    ]
  );
  assert.equal(
    getAllocationQualityLabel([
      holding({ id: 'tech', sector: 'Technology' }),
      holding({ id: 'missing', sector: null }),
    ], 'sector', new Map()),
    '1 holding missing sector'
  );
});


test('allocation drift compares current slices against explicit targets', () => {
  const drift = getAllocationDrift(
    [
      {
        key: 'asset:etf',
        label: 'ETF',
        value: 800,
        count: 2,
        pct: 80,
        color: '#6487f0',
      },
      {
        key: 'asset:cash',
        label: 'Cash',
        value: 200,
        count: 1,
        pct: 20,
        color: '#32bfa3',
      },
    ],
    [
      { key: 'asset:etf', label: 'ETF', targetPct: 60 },
      { key: 'asset:cash', label: 'Cash', targetPct: 5 },
      { key: 'asset:equity', label: 'Equity', targetPct: 35 },
    ]
  );

  assert.equal(drift.label, 'Drifting');
  assert.equal(drift.maxDriftPct, 35);
  assert.deepEqual(
    drift.items.map((item) => [item.label, item.currentPct, item.targetPct, item.driftPct, item.severity]),
    [
      ['Equity', 0, 35, -35, 'drifting'],
      ['ETF', 80, 60, 20, 'drifting'],
      ['Cash', 20, 5, 15, 'drifting'],
    ]
  );
  assert.match(drift.detail, /Equity is 35\.0 points below target/);
});

test('allocation drift handles empty views without inventing targets', () => {
  const drift = getAllocationDrift([], [
    { key: 'asset:etf', label: 'ETF', targetPct: 60 },
  ]);

  assert.equal(drift.label, 'No target');
  assert.equal(drift.maxDriftPct, 0);
  assert.deepEqual(drift.items, []);
});

test('concentration summary groups positions before calculating top exposure', () => {
  const accounts = new Map([
    ['acct_taxable', account('acct_taxable', 'brokerage')],
    ['acct_ira', account('acct_ira', 'ira_traditional')],
  ]);
  const holdings = [
    holding({ id: 'aaa_a', account_id: 'acct_taxable', ticker: 'AAA', institution_value: 250 }),
    holding({ id: 'aaa_b', account_id: 'acct_ira', ticker: 'AAA', institution_value: 150 }),
    holding({ id: 'bbb', account_id: 'acct_taxable', ticker: 'BBB', institution_value: 250 }),
    holding({ id: 'ccc', account_id: 'acct_ira', ticker: 'CCC', institution_value: 150 }),
    holding({ id: 'ddd', account_id: 'acct_ira', ticker: 'DDD', institution_value: 100 }),
    holding({ id: 'eee', account_id: 'acct_taxable', ticker: 'EEE', institution_value: 50 }),
    holding({ id: 'fff', account_id: 'acct_taxable', ticker: 'FFF', institution_value: 50 }),
  ];

  const summary = getConcentrationSummary(holdings, accounts);

  assert.equal(summary.label, 'Concentrated');
  assert.equal(summary.totalValue, 1000);
  assert.equal(summary.largestPosition?.label, 'AAA');
  assert.equal(summary.largestPosition?.value, 400);
  assert.equal(summary.largestPosition?.pct, 40);
  assert.equal(summary.topFiveValue, 950);
  assert.equal(summary.topFivePct, 95);
  assert.equal(summary.largestAccount?.label, 'Brokerage');
  assert.equal(summary.largestAccount?.value, 600);
});

test('investment activity summarizes imported transaction flow without inventing realized gains', () => {
  const summary = getInvestmentActivitySummary([
    investmentTransaction({ id: 'buy', type: 'buy', amount: -1000, fees: 1 }),
    investmentTransaction({ id: 'sell', type: 'sell', amount: 700, fees: 2 }),
    investmentTransaction({ id: 'dividend', type: 'dividend', amount: 25 }),
    investmentTransaction({ id: 'fee', type: 'fee', amount: -4 }),
    investmentTransaction({ id: 'transfer', type: 'transfer', amount: 300 }),
    investmentTransaction({ id: 'other', type: 'other', amount: -10 }),
  ]);

  assert.equal(summary.transactionCount, 6);
  assert.equal(summary.buyAmount, 1000);
  assert.equal(summary.sellAmount, 700);
  assert.equal(summary.dividendAmount, 25);
  assert.equal(summary.feeAmount, 7);
  assert.equal(summary.transferAmount, 300);
  assert.equal(summary.otherAmount, 10);
  assert.equal(summary.netAmount, 11);
  assert.equal(summary.saleCount, 1);
  assert.equal(summary.realizedGain, null);
  assert.equal(summary.realizedGainLabel, 'Not available');
  assert.match(summary.realizedGainDetail, /lot-level sale cost basis/);
});

test('investment data quality starts empty without investment sources', () => {
  const summary = getInvestmentDataQualitySummary({
    holdings: [],
    transactions: [],
    investmentAccountCount: 0,
    accountById: new Map(),
    historyPointCount: 0,
  });

  assert.equal(summary.status, 'empty');
  assert.equal(summary.label, 'No Investment Data');
  assert.deepEqual(summary.issues.map((issue) => issue.id), ['no-investment-source']);
});

test('investment data quality marks provider limitations without requiring attention', () => {
  const accounts = new Map([
    ['acct_taxable', account('acct_taxable', 'brokerage')],
  ]);
  const summary = getInvestmentDataQualitySummary({
    holdings: [
      holding({ id: 'known', account_id: 'acct_taxable', security_type: 'equity', cost_basis: 900, institution_value: 1000 }),
      holding({ id: 'missing_type', account_id: 'acct_taxable', cost_basis: 100, institution_value: 110 }),
    ],
    transactions: [
      investmentTransaction({ id: 'sell', type: 'sell', amount: 250 }),
    ],
    investmentAccountCount: 1,
    accountById: accounts,
    historyPointCount: 1,
  });

  assert.equal(summary.status, 'limited');
  assert.deepEqual(summary.issues.map((issue) => issue.id), [
    'security-type-missing',
    'sector-missing',
    'realized-gain-unavailable',
    'history-limited',
  ]);
});

test('investment data quality escalates missing core holding data', () => {
  const accounts = new Map([
    ['acct_taxable', account('acct_taxable', 'brokerage')],
  ]);
  const summary = getInvestmentDataQualitySummary({
    holdings: [
      holding({ id: 'missing_basis', account_id: 'acct_taxable', security_type: 'equity', cost_basis: null, institution_value: 1000 }),
      holding({ id: 'missing_account', account_id: 'acct_missing', security_type: 'etf', cost_basis: null, institution_value: 500 }),
    ],
    transactions: [],
    investmentAccountCount: 1,
    accountById: accounts,
    historyPointCount: 2,
  });

  assert.equal(summary.status, 'attention');
  assert.deepEqual(summary.issues.map((issue) => issue.id), [
    'missing-account-links',
    'cost-basis-missing',
    'sector-missing',
    'no-investment-transactions',
  ]);
});

test('a ninth group folds into Other rather than wrapping onto slot one', () => {
  // `ALLOCATION_COLORS[index % length]` gave the ninth group the first group's colour, so one bar
  // carried two slices claiming the same identity and the legend named both of them.
  const holdings = Array.from({ length: 11 }, (_, i) =>
    holding({ id: `h${i}`, ticker: `SYM${i}`, institution_value: 1000 - i * 10 })
  );

  const slices = getAllocationSlices(holdings, 'symbol', new Map());
  const folded = slices.find((slice) => slice.label === 'Other');

  assert.equal(slices.length, ALLOCATION_SLOTS);
  assert.equal(new Set(slices.map((slice) => slice.color)).size, ALLOCATION_SLOTS);
  // Nothing is lost to the fold: the tail's value and count both survive in it.
  assert.equal(folded?.value, 930 + 920 + 910 + 900);
  assert.equal(folded?.count, 4);
  assert.equal(Math.round(slices.reduce((sum, slice) => sum + slice.pct, 0)), 100);
});

test('the fold merges with a group that already means Other under that lens', () => {
  // `security_type = 'other'` is a real asset class. Folding beside it would render two rows
  // labelled Other in different colours, and their percentages would not add up to the group.
  const holdings = [
    ...Array.from({ length: 9 }, (_, i) =>
      holding({ id: `h${i}`, security_type: `type_${i}`, institution_value: 1000 - i })
    ),
    holding({ id: 'genuinely_other', security_type: 'other', institution_value: 5000 }),
  ];

  const slices = getAllocationSlices(holdings, 'asset_type', new Map());

  assert.equal(slices.filter((slice) => slice.label === 'Other').length, 1);
  assert.equal(slices.length, ALLOCATION_SLOTS);
  // The genuine `other` holding plus the two groups that did not fit.
  assert.equal(slices.find((slice) => slice.label === 'Other')?.value, 5000 + 993 + 992);
});

test('a bar reads largest to smallest even when the fold is the largest group', () => {
  // The fold takes whatever already means "other" under the lens, whatever its size, so it is
  // NOT always the smallest groups. At 53% of this portfolio it was still drawn last, after
  // slices a twentieth its size, and the bar stopped meaning what its order says it means.
  const holdings = [
    holding({ id: 'other', security_type: 'other', institution_value: 5000 }),
    ...Array.from({ length: 9 }, (_, i) =>
      holding({ id: `h${i}`, security_type: `type_${i}`, institution_value: 1000 - i * 100 })
    ),
  ];

  const slices = getAllocationSlices(holdings, 'asset_type', new Map());

  assert.equal(slices[0].label, 'Other');
  assert.ok(slices[0].pct > 50, `fold is the majority of the bar: ${slices[0].pct}`);
  for (let i = 1; i < slices.length; i++) {
    assert.ok(
      slices[i - 1].value >= slices[i].value,
      `slice ${i} (${slices[i].value}) is larger than the one before it (${slices[i - 1].value})`
    );
  }
});

test('a sector typed Other is the fold, not a second slice with the same name', () => {
  // `sector` is free text the owner types on the holding modal. `sector:Other` and the fold's
  // `sector:other` were different keys, so one bar carried two slices labelled Other in two
  // different colours, with the larger one nowhere near the row that named it.
  const holdings = [
    holding({ id: 'big', sector: 'Other', institution_value: 5000 }),
    ...Array.from({ length: 9 }, (_, i) =>
      holding({ id: `h${i}`, sector: `Sector ${i}`, institution_value: 1000 - i * 100 })
    ),
  ];

  const slices = getAllocationSlices(holdings, 'sector', new Map());
  const labels = slices.map((slice) => slice.label);

  assert.deepEqual(labels.filter((label, i) => labels.indexOf(label) !== i), []);
  assert.equal(slices.filter((slice) => slice.label.toLowerCase() === 'other').length, 1);
  assert.equal(new Set(slices.map((slice) => slice.color)).size, slices.length);
});

test('two spellings of one sector are one group', () => {
  const slices = getAllocationSlices([
    holding({ id: 'a', sector: 'Technology', institution_value: 600 }),
    holding({ id: 'b', sector: 'technology', institution_value: 400 }),
  ], 'sector', new Map());

  assert.equal(slices.length, 1);
  assert.equal(slices[0].value, 1000);
  assert.equal(slices[0].count, 2);
});

test('a sector typed Unavailable is not relabelled as missing metadata', () => {
  // "The provider sent no sector" and "the owner typed the word unavailable" are different
  // claims, and normalizing free text is exactly how they would collide.
  const slices = getAllocationSlices([
    holding({ id: 'typed', sector: 'Unavailable', institution_value: 600 }),
    holding({ id: 'missing', sector: null, institution_value: 400 }),
  ], 'sector', new Map());

  assert.deepEqual(
    slices.map((slice) => [slice.label, slice.value]),
    [['Unavailable', 600], ['Sector unavailable', 400]]
  );
});

test('a position marked to zero does not take a slice of the bar', () => {
  // Sold positions are zeroed rather than deleted, so without this an exited sector keeps a 0%
  // row with its own colour on the bar forever, and there is nothing the owner can do about it.
  const slices = getAllocationSlices([
    holding({ id: 'held', sector: 'Technology', institution_value: 1000 }),
    holding({ id: 'sold', sector: 'Energy', institution_value: 0 }),
  ], 'sector', new Map());

  assert.deepEqual(slices.map((slice) => slice.label), ['Technology']);
});

test('eight groups or fewer keep their own slot', () => {
  const holdings = Array.from({ length: 8 }, (_, i) =>
    holding({ id: `h${i}`, ticker: `SYM${i}`, institution_value: 100 })
  );

  const slices = getAllocationSlices(holdings, 'symbol', new Map());

  assert.equal(slices.length, 8);
  assert.equal(slices.some((slice) => slice.label === 'Other'), false);
});

/** A history point covering the whole portfolio, which is what an ordinary snapshot does. */
function point(date: string, value: number, over = 3, estimated = false) {
  return { date, value, estimated, covered_accounts: over };
}

test('the portfolio delta measures the headline against a named snapshot', () => {
  const history = [point('2026-07-29', 2444.62), point('2026-07-30', 2445.89), point('2026-07-31', 2436.21)];

  // Straight after a sync the newest snapshot IS the headline, so it cannot be the baseline:
  // that is what printed "$0" while the headline moved.
  const settled = getPortfolioDelta(2436.21, history, 3);
  assert.equal(settled?.baseline.date, '2026-07-30');
  assert.equal(Number(settled?.change.toFixed(2)), -9.68);

  // Balances that moved since the last sync measure against that sync.
  const moved = getPortfolioDelta(2443.0, history, 3);
  assert.equal(moved?.baseline.date, '2026-07-31');
  assert.equal(Number(moved?.change.toFixed(2)), 6.79);
});

test('the portfolio delta reports nothing rather than a delta it cannot support', () => {
  assert.equal(getPortfolioDelta(null, [point('2026-07-31', 2436.21)], 3), null);
  assert.equal(getPortfolioDelta(2436.21, [], 3), null);
  // One snapshot, and it is the headline: there is no earlier value to measure from.
  assert.equal(getPortfolioDelta(2436.21, [point('2026-07-31', 2436.21)], 3), null);
  // No account set to check membership against is not the same as a set of none.
  assert.equal(getPortfolioDelta(2436.21, [point('2026-07-30', 2400), point('2026-07-31', 2436.21)], null), null);
});

test('a delta is refused when the newest point does not cover the whole headline', () => {
  // Disconnecting Coinbase sets is_hidden = 1 and leaves current_balance, and `takeSnapshot`
  // writes a breakdown entry only for visible accounts. A headline over three accounts against a
  // point over two is a comparison of two different quantities: it printed a standing
  // "+$391.17 since Jul 31" every day, on a portfolio that had not moved at all.
  const history = [point('2026-07-30', 2445.89, 3), point('2026-07-31', 2045.04, 2)];

  assert.equal(getPortfolioDelta(2436.21, history, 3), null);

  // The same series once the newest point covers the set again: the delta comes back.
  const covered = [point('2026-07-30', 2445.89, 3), point('2026-07-31', 2436.21, 3)];
  assert.equal(getPortfolioDelta(2436.21, covered, 3)?.baseline.date, '2026-07-30');
});

test('a delta is refused when the baseline it would name does not cover the headline', () => {
  // An account opened yesterday: the newest snapshot has it, the one before does not, and the
  // difference between them is an account appearing rather than money arriving.
  const history = [point('2026-07-30', 2045.04, 2), point('2026-07-31', 2436.21, 3)];

  assert.equal(getPortfolioDelta(2436.21, history, 3), null);
});

test('a delta is refused on a series that is not in date order', () => {
  // The route serves `ORDER BY date ASC` and `net_worth_snapshots.date` is UNIQUE, so this
  // should be unreachable. It is checked rather than assumed because the baseline's date is
  // printed to the owner: out of order, the copy names the wrong day.
  assert.equal(getPortfolioDelta(2436.21, [point('2026-07-31', 2436.21), point('2026-07-30', 2445.89)], 3), null);
  assert.equal(getPortfolioDelta(2436.21, [point('2026-07-30', 2445.89), point('2026-07-30', 2436.21)], 3), null);
});

test('the delta carries whether its baseline was measured or reconstructed', () => {
  const delta = getPortfolioDelta(2436.21, [
    point('2026-07-30', 2400, 3, true),
    point('2026-07-31', 2436.21, 3),
  ], 3);

  assert.equal(delta?.baseline.date, '2026-07-30');
  assert.equal(delta?.baseline.estimated, true);
});

/**
 * A position the owner sold out of is not a 100% unrealized loss.
 *
 * `services/simplefin.ts` and `services/coinbase.ts` zero a vanished position rather than deleting
 * it, and deliberately keep `cost_basis`, because that is what we knew and a repurchase should not
 * start blind. The write path is truthful; three readers were not. `effectiveCostBasis` refuses a
 * non-positive BASIS, which is a different question, so a sold row with a real provider basis
 * counted in `knownCount`, added its whole basis to `knownCostBasis` and its zero to market value,
 * and booked the entire basis as unrealized loss.
 */
function position(over: Partial<Holding> & { id: string }): Holding {
  return {
    account_id: 'acct',
    security_id: `sec_${over.id}`,
    quantity: 10,
    institution_price: 100,
    institution_value: 100000,
    cost_basis: 80000,
    cost_basis_quality: 'provider',
    ...over,
  } as Holding;
}

test('a sold-out position is excluded from the header, the return and the coverage', () => {
  const live = position({ id: 'live', institution_value: 100000, cost_basis: 80000 });
  const sold = position({ id: 'sold', quantity: 0, institution_value: 0, cost_basis: 119984 });

  const withSold = getCostBasisStats([live, sold]);
  const withoutSold = getCostBasisStats([live]);

  // The sale must move nothing about the position still held.
  assert.deepEqual(withSold, withoutSold);
  assert.equal(withSold.knownCount, 1);
  assert.equal(withSold.unrealized, 20000);
  assert.equal(withSold.coveragePct, 100, 'a sold row dragged coverage as if it were uncovered');
});

test('a sold-out position reports no gain rather than a total loss', () => {
  const sold = position({ id: 'sold', quantity: 0, institution_value: 0, cost_basis: 119984 });
  // It used to answer { gain: -119984, pct: -100 } and render as an unrealized loss forever.
  assert.equal(holdingGain(sold), null);
});

test('HEALTHY: an ordinary held position is untouched by the predicate', () => {
  const live = position({ id: 'live', institution_value: 100000, cost_basis: 80000 });
  assert.equal(isLivePosition(live), true);
  assert.deepEqual(holdingGain(live), { gain: 20000, pct: 25 });
});

test('a worthless but still-held token is a live position, because quantity decides too', () => {
  // Value alone is not the test: a token can be held and momentarily priced at nothing.
  const dust = position({ id: 'dust', quantity: 1000, institution_value: 0, cost_basis: 5000 });
  assert.equal(isLivePosition(dust), true);
  assert.deepEqual(holdingGain(dust), { gain: -5000, pct: -100 });
});
