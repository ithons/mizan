import test from 'node:test';
import assert from 'node:assert/strict';
import { RECENT_SHEETS, SAFE_TO_SPEND, SHEET_0731, SPENDING, render, text } from './helpers/instrumentHarness';

/**
 * The surface itself, rendered.
 *
 * `instrumentSurface.test.ts` checks what the readings say; this checks that the screen says it.
 * The two states of hazard 1 and hazard 4 are the ones that have never rendered before, so they
 * are the ones asserted here: a screen that throws in the short state, or that quietly prints a
 * percentage of a signed total, would pass every unit test in the file next door.
 *
 * Fixtures and the render harness live in `helpers/instrumentHarness.ts`, measured from a private
 * copy of `.mizan/mizan.db`.
 */

test('the surface renders with room to spend, and the subject figure is what is free', () => {
  const body = text(render('this-month'));

  // Hazard 4, the positive state. The magnitude and the word, never a signed figure in a slot.
  assert.match(body, /\$191\.23/);
  assert.match(body, /free to spend/);
  assert.doesNotMatch(body, /short this month/);
  assert.doesNotMatch(body, /−\$191\.23/, 'the direction is carried by the word, not by a sign');

  // Net worth is present and is not the subject.
  assert.match(body, /Net worth/);
  assert.match(body, /\$4,202\.86/);

  // Hazard 5: three of five cards are in credit and the beam says so.
  assert.match(body, /3 of 5 cards in credit/);
});

test('the surface renders when the owner is short, and reads differently', () => {
  const body = text(render('this-month', { safeToSpend: { ...SAFE_TO_SPEND, free: -1427.96 } }));

  assert.match(body, /short this month/);
  assert.doesNotMatch(body, /free to spend/);
  assert.match(body, /\$1,427\.96/);
  assert.doesNotMatch(body, /−\$1,427\.96/, 'the magnitude is printed; the state is a word');
  assert.match(body, /claim more than the liquid pool holds/);
  // Being short is actionable, so the largest claim is named. Having room is not, so it is not.
  assert.match(body, /The largest single claim is \$4,278\.70 of card balances\./);
});

test('a category that came back leads the section and never becomes a percentage', () => {
  const body = text(render('this-month'));

  assert.match(body, /Came back · \$1,028\.63 from one category/);
  assert.match(body, /Went out · \$2,141\.62 across 8 categories/);
  // The returned group is rendered before the spend ranking, which is the whole fix: ranking the
  // combined list by amount put the single largest movement of money last.
  assert.ok(body.indexOf('Came back') < body.indexOf('Went out'));
  assert.ok(body.indexOf('Shopping') < body.indexOf('Food & Drink'));

  // The report's own percentages are on the wire and none of them reaches the screen.
  for (const share of ['65.73', '44.59', '92.42', '37.39', '14.62']) {
    assert.doesNotMatch(body, new RegExp(share.replace('.', '\\.')), `${share}% is a share of a signed total`);
  }
  // Nor does the merchant share, which divided a gross total by a net one and printed 161%.
  assert.doesNotMatch(body, /161%/);
  assert.match(body, /No share of the total is shown/);
});

test('a window with no returns renders as an ordinary ranking, with no returned group at all', () => {
  const body = text(
    render('last-month', {
      spending: {
        total: 6473.19,
        categories: SPENDING.categories.filter((c) => c.amount > 0),
      },
    })
  );

  assert.doesNotMatch(body, /Came back/);
  assert.match(body, /Went out · \$2,141\.62 across 8 categories/);
  assert.match(body, /Food & Drink/);
});

test('a surface with no balance sheet states that, rather than drawing a zeroed one', () => {
  const body = text(render('this-month', { snapshot: null }));

  assert.match(body, /No balance sheet has been recorded yet\./);
  // The flow half does not depend on a sheet and still renders.
  assert.match(body, /Where it went/);
  assert.match(body, /Busiest merchants/);
});

test('the screen never prints a week that crossed a coverage step', () => {
  // The default series ends at the 2026-07-30 sheet, whose only neighbours seven days back reached
  // 11 of 11 accounts against its own 14 of 14. That pair is what produced "+$1,107".
  const body = text(render('this-month'));

  assert.doesNotMatch(body, /\$1,107/, 'three accounts arriving in mizān is not a week of net worth');
  assert.doesNotMatch(body, /since the nearest sheet at least seven days back/, 'the uncaveated copy is gone');
  assert.match(body, /No sheet at least seven days back reached the same 14 of 14 accounts/);
  assert.match(body, /5 earlier sheets reached a different set of accounts and are not comparable to this one\./);
});

test('the week that is comparable renders as one, and names the sheet it is against', () => {
  const body = text(render('this-month', { snapshot: SHEET_0731, recent: [...RECENT_SHEETS, SHEET_0731] }));

  assert.match(body, /\+\$1,444 since 24 July, the nearest sheet at least seven days back that reached the same 14 of 14 accounts\./);
  assert.match(body, /5 earlier sheets reached a different set of accounts/);
});

test('all four summary metrics show the change they arrived with', () => {
  const body = text(render('this-month'));

  // From the live `this month` summary, prior_period: net 533970c and savings_rate 195.61 points,
  // both fetched over the wire and both previously discarded.
  assert.match(body, /↑ \$5,340/, 'net moved and the card says so');
  assert.match(body, /↑ 196 points/, 'a change in a rate is in points, never in dollars');
  assert.doesNotMatch(body, /↑ \$196/, 'the rate delta must not be run through the currency formatter');
  // The two that were already drawn are unchanged.
  assert.match(body, /↓ \$21/);
  assert.match(body, /↓ \$5,360/);
});

test('the register rule is stated once, so the reader learns which half the selector governs', () => {
  const body = text(render('six-months'));
  assert.match(body, /Everything below answers to this selector\. The balance sheet above it is now, and has no window\./);
  assert.match(body, /Over this window/);
  // The four windows are all offered, and the chosen one is marked for assistive tech too.
  assert.match(render('six-months'), /aria-pressed="true"/);
  for (const label of ['This month', 'Last month', '6 months', 'All']) {
    assert.match(body, new RegExp(label));
  }
});

/**
 * The two readings the consolidation dropped, back on the surface that replaced the screens they
 * came from.
 *
 * `reportsApi.trends` and `reportsApi.networthAttribution` were called by the retired Today and
 * Reports views and by nothing afterwards: both fetchers stayed defined, both routes stayed
 * mounted, and neither answer could reach the owner. Fixtures are the live shapes; see the harness.
 */

test('each category is drawn over the window months, on one stated scale', () => {
  const body = text(render('six-months'));

  assert.match(body, /Each category, month by month/);
  assert.match(body, /3 months/);
  // The window's own end months are named, so a column has a date rather than a position.
  assert.match(body, /One column for each month this window has entries in, May 2026 to Jul 2026/);
  // The scale every column in the grid is drawn against is stated, because a bar without one is a
  // shape. $2,160.83 is Amazon's June, the largest single month in the fixture.
  assert.match(body, /largest single month here at \$2,161/);
  // Ranked by what the window TOTALS, the same order "Where it went" ranks by. Amazon's June is
  // the tallest column in the grid and Amazon still sits fifth, because May+June+July nets to
  // $470.17 against Restaurants' $914.24. Ranking by the tallest column would have put a category
  // the owner barely spent in above one they spent in every month.
  assert.ok(body.indexOf('Restaurants') < body.indexOf('Amazon'));
  // Six rows are drawn, and the two below the cut are counted rather than dropped in silence.
  assert.match(body, /Household & Everyday/);
  assert.doesNotMatch(body, /Software & AI Tools/);
  assert.match(body, /2 smaller categories are not shown/);
  // The stated scale is a column that is actually on screen: $2,160.83 is Amazon's June, and
  // Amazon is the fifth of the six drawn rows.
  assert.ok(body.indexOf('Amazon') < body.indexOf('largest single month here'));
});

test('a window holding one month draws no grid at all, rather than one column', () => {
  const body = text(
    render('six-months', {
      trends: { months: ['2026-07'], series: [{ category_id: 'c', category_name: 'Pets', color: null, values: [140.29] }] },
    })
  );
  assert.doesNotMatch(body, /Each category, month by month/);
});

test('what moved net worth is attributed to accounts, with the liability sign explained', () => {
  const body = text(render('six-months'));

  assert.match(body, /What moved it/);
  assert.match(body, /\+\$3,114 over the window/);
  // Both cards moved net worth UP while their balances fell. Rendering the raw balance change here
  // would print these as losses.
  assert.match(body, /Discover/);
  assert.match(body, /\+\$1,619/);
  assert.match(body, /Chase Freedom Flex/);
  assert.match(body, /\+\$1,512/);
  assert.match(body, /Chase Checking/);
  assert.match(body, /−\$1,324/);
  assert.match(body, /a card whose balance grew reads negative/);
  // The endpoints are the two measured sheets the service used, not the window's own edges.
  assert.match(body, /Jul 1 to Jul 31/);
  assert.match(body, /only\s+measured sheets are used as endpoints/);
});

test('a window with nothing to attribute says nothing rather than printing a zero move', () => {
  const body = text(render('six-months', { attribution: null }));
  assert.doesNotMatch(body, /What moved it/);
});
