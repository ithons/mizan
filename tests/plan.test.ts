import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claimLines, carryoverBudgetPhrase, uncountedHeadroom } from '../client/src/views/plan/readings';
import {
  EMERGENCY_FUND,
  JULY_LEDGER_ROW,
  SHEET,
  barWidths,
  openMonthKey,
  render,
  renderClaimSheet,
  shoppingBudget,
  text,
} from './helpers/planHarness';
import type { Budget } from '../shared/types';

/**
 * `/plan`: the claim sheet, the budget bars, and the grounds this screen puts money on.
 *
 * Fixtures are the owner's live ledger from a private copy of `.mizan/mizan.db` at migration
 * `053_drop_budget_groups.sql`; the SQL behind each one is in `helpers/planHarness.ts`.
 */

const PLAN = readFileSync(
  join(import.meta.dirname, '..', 'client', 'src', 'views', 'Plan.tsx'),
  'utf8'
);

describe('the claim sheet says nothing it does not yet know', () => {
  // The reproduction: only the sheet's own query has resolved. This is not fault injection, it is
  // the ordinary handful of milliseconds before the budget and goal lists land.
  const cold = text(render({ sheet: SHEET }));

  test('the sheet renders on its own query alone', () => {
    assert.match(cold, /Free to spend/);
    assert.match(cold, /\$191\.23/);
  });

  test('it prints the budget and goal claims', () => {
    assert.match(cold, /\$500\.00/);
    assert.match(cold, /\$1,001\.70/);
  });

  test('and denies neither of them', () => {
    assert.doesNotMatch(cold, /No monthly budgets set/);
    assert.doesNotMatch(cold, /No goals yet/);
  });

  test('the denial comes back once the lists resolve empty AND the sheet agrees', () => {
    const empty = { ...SHEET, allocated_budgets: 0, allocated_goals: 0, free: 1692.93 };
    const warm = text(render({ sheet: empty, goals: [], budgetsByMonth: { [openMonthKey()]: [] } }));
    assert.match(warm, /No monthly budgets set/);
    assert.match(warm, /No goals yet/);
  });

  test('a count of zero never appears beside a figure that is not zero', () => {
    // The invariant, independent of which query was slow: the sentence is about the figure on its
    // own line, so it is sayable only when that figure is zero too.
    for (const [budgetCount, goalCount] of [[0, 0], [0, null], [null, 0], [null, null], [1, 1]] as const) {
      for (const line of claimLines(SHEET, budgetCount, goalCount)) {
        if (line.note && /nothing is claimed here/.test(line.note)) {
          assert.equal(line.delta, 0, `"${line.note}" printed beside ${line.delta}`);
        }
      }
    }
  });

  test('the running total is the server\'s own subtraction, to the cent', () => {
    const running = claimLines(SHEET, 1, 1).reduce((sum, line) => sum + line.delta, 0);
    assert.equal(Number(running.toFixed(2)), SHEET.free);
  });
});

describe('the claim sheet reads the month it was computed for', () => {
  // `GET /api/insights/safe-to-spend` builds its budgets from `new Date()` and no request parameter
  // can move that (server/src/routes/insights.ts). So the headroom paragraph, which re-derives the
  // clamp that endpoint applied, has to be fed the same month.
  const july = shoppingBudget({ spent: -1203.63 });
  const junePlaceholder = shoppingBudget({ amount: 400, spent: 400, projected_remaining: 0 });

  test('the paragraph is a reading of the list it is handed, and of nothing else', () => {
    const withHeadroom = text(renderClaimSheet(SHEET, [july], 1));
    const withNone = text(renderClaimSheet(SHEET, [junePlaceholder], 1));
    assert.match(withHeadroom, /of headroom is left out/);
    assert.doesNotMatch(withNone, /of headroom is left out/);
  });

  test('the headroom is the excess over the ceiling the sheet counted', () => {
    // projected_remaining 1703.63 against a 500.00 ceiling, so 1203.63 was declined.
    assert.equal(Number(uncountedHeadroom([july]).toFixed(2)), 1203.63);
    assert.equal(uncountedHeadroom([]), 0);
  });

  test('an unresolved list produces no paragraph rather than a zero one', () => {
    assert.doesNotMatch(text(renderClaimSheet(SHEET, undefined, null)), /of headroom is left out/);
  });

  test('the single call site feeds it the open month, not the stepper', () => {
    // The stepper's list is `budgetsQ`, keyed on `month`. The sheet's is `openMonthBudgetsQ`, keyed
    // on `openMonth`. This is a source assertion because the wiring is the defect: the component
    // cannot be handed a stepped month without a click, and both queries collapse to one key while
    // the stepper sits where it starts.
    assert.match(PLAN, /queryKey: \['budgets', openMonth\]/);
    assert.match(PLAN, /<ClaimSheet\s+sheet=\{sheetQ\.data\}\s+budgets=\{openMonthBudgetsQ\.data\}/);
    assert.doesNotMatch(PLAN, /<ClaimSheet[^>]*budgets=\{budgets\}/);
  });
});

describe('the diverging bar stays a measurement when the refunds get large', () => {
  const returned = (id: string, spent: number): Budget =>
    shoppingBudget({ id, spent, projected_remaining: 500 - spent });

  test('two returned months of different size draw different bars', () => {
    const html = render({
      sheet: SHEET,
      goals: [EMERGENCY_FUND],
      budgetsByMonth: { [openMonthKey()]: [returned('b1', -600), returned('b2', -5000)] },
    });
    const widths = barWidths(html);
    const bars = widths.filter((w) => w > 0);
    assert.equal(bars.length >= 2, true, `expected two drawn bars, got ${JSON.stringify(widths)}`);
    assert.notEqual(bars[0], bars[1]);
  });

  test('the extent is the list\'s largest movement, so the biggest row fills its half', () => {
    const html = render({
      sheet: SHEET,
      goals: [EMERGENCY_FUND],
      budgetsByMonth: { [openMonthKey()]: [returned('b1', -600), returned('b2', -5000)] },
    });
    // signedBarScale extent = max(|spent|) = 5000; a diverging bar gets half the runway.
    // 600/5000 * 50 = 6, 5000/5000 * 50 = 50.
    const bars = barWidths(html).filter((w) => w > 0);
    assert.deepEqual(bars.slice(0, 2), [6, 50]);
  });

  test('the row no longer supplies its own extent', () => {
    assert.doesNotMatch(PLAN, /extent=\{Math\.max/);
    assert.match(PLAN, /signedBarScale\(budgets\.map\(budgetActualSpend\)\)/);
  });
});

describe('the copy claims only what the code checks', () => {
  const warm = text(
    render({
      sheet: SHEET,
      goals: [EMERGENCY_FUND],
      budgetsByMonth: { [openMonthKey()]: [shoppingBudget({ rollover: true })] },
      ledger: [{ ...JULY_LEDGER_ROW, month: '2026-06' }, JULY_LEDGER_ROW],
    })
  );

  test('the cards line does not assert how the owner pays them', () => {
    // Nothing in this codebase reads a per-account or per-sync payment behaviour, so the sheet
    // cannot say the cards are autopaid in full. What it can say is the arithmetic it performs.
    assert.doesNotMatch(warm, /[Aa]utopaid/);
    assert.doesNotMatch(warm, /statement period/);
    assert.match(warm, /The whole balance is taken out here, not a minimum payment/);
  });

  test('a card in credit still reads as money coming back', () => {
    const credit = claimLines({ ...SHEET, card_balances: -120 }, 1, 1).find((l) => l.key === 'cards');
    assert.equal(credit?.label, 'Cards in credit');
    assert.equal(credit?.delta, 120);
    assert.match(credit?.note ?? '', /money coming back to the pool/);
  });

  test('the carryover strip does not call a closed month frozen', () => {
    // `walkRolloverLedger` freezes a closed month only when `budget_rollover_ledger` holds a row
    // for it, and otherwise falls back to the live `budgets.amount`:
    //   const budgetAmount = monthKey < openMonth ? recorded.get(id) ?? budget.amount : budget.amount;
    // `BudgetRolloverLedgerEntry` carries no field separating those two cases.
    assert.match(warm, /Carryover/);
    assert.doesNotMatch(warm, /frozen/);
    assert.doesNotMatch(PLAN, /frozen/);
  });

  test('it still separates a closed month from the one in progress', () => {
    const open = openMonthKey();
    assert.equal(carryoverBudgetPhrase('2026-06', open, '$500'), 'budget $500');
    assert.equal(carryoverBudgetPhrase(open, open, '$500'), 'budget $500, still open');
  });
});

/* ── Contrast ───────────────────────────────────────────────────────────────────────────────── */

type Rgb = readonly [number, number, number];

const CSS = readFileSync(
  join(import.meta.dirname, '..', 'client', 'src', 'index.css'),
  'utf8'
);

function relativeLuminance([r, g, b]: Rgb): number {
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [x, y] = [relativeLuminance(a), relativeLuminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The light block is first in index.css and the `[data-theme='dark']` block is last. */
function triplet(name: string, theme: 'light' | 'dark'): Rgb {
  const matches = [...CSS.matchAll(new RegExp(`--mz-${name}-c:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s*;`, 'g'))];
  assert.ok(matches.length > 0, `--mz-${name}-c is not declared in index.css`);
  const m = theme === 'light' ? matches[0] : matches[matches.length - 1];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function isColorToken(name: string): boolean {
  return CSS.includes(`--mz-${name}-c:`);
}

/** One top-level `function Name(` block of Plan.tsx, up to the next one. */
function componentSource(name: string): string {
  const start = PLAN.search(new RegExp(`^(export )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `Plan.tsx has no component ${name}`);
  const rest = PLAN.slice(start + 1);
  const end = rest.search(/^(export )?function /m);
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * Every `text-*` class in a slice that names a palette token rather than a size step.
 *
 * Enumerated from the source instead of listed by hand, because the finding this replaces was a
 * hand-written list: the contrast pass measured paper, card and card-alt and never noticed that
 * `CarryoverStrip` sets money on `well`. A class that names no `--mz-*-c` token is a type step
 * (`text-note`), an alignment (`text-right`) or an arbitrary value, and is not a colour.
 */
function inkTokens(source: string): string[] {
  const found = new Set<string>();
  for (const [, name] of source.matchAll(/(?:^|[\s"'`:!])text-([a-z0-9-]+)/g)) {
    if (isColorToken(name)) found.add(name);
  }
  return [...found].sort();
}

describe('every ground /plan puts money on, in both themes', () => {
  const AA = 4.5;

  /**
   * The grounds, enumerated from what each component actually sits in rather than assumed.
   *
   *   Screen           no background of its own, so the body's `bg-paper` shows through
   *   Card elevation 2 `bg-card-alt` (components/balance/Card.tsx)
   *   Modal panel      `bg-card-alt` (components/Modal.tsx)
   *   CarryoverStrip   `bg-well`, declared on the strip itself
   *
   * `card` is deliberately absent: nothing on this screen renders a default-elevation Card.
   */
  const GROUNDS: Array<[component: string, ground: string]> = [
    ['ClaimSheet', 'card-alt'],
    ['CarryoverStrip', 'well'],
    ['BudgetLine', 'paper'],
    ['GoalLine', 'paper'],
    ['BudgetModal', 'card-alt'],
    ['GoalModal', 'card-alt'],
    ['Plan', 'paper'],
  ];

  test('the grounds list still matches what the source declares', () => {
    assert.match(componentSource('CarryoverStrip'), /bg-well/);
    assert.match(componentSource('ClaimSheet'), /elevation=\{2\}/);
    // A Card that took the default elevation would land on `bg-card`, which is not in the list.
    assert.equal(/<Card(?![^>]*elevation=)/.test(PLAN), false);
  });

  test('every component that prints a money numeral inline was actually scanned', () => {
    // GoalModal is deliberately absent: it sets no colour class of its own, its numerals live in
    // `<input class="mz-field">`, and that pairing is measured on its own below.
    for (const component of ['ClaimSheet', 'CarryoverStrip', 'BudgetLine', 'GoalLine', 'Plan']) {
      assert.ok(
        inkTokens(componentSource(component)).length > 0,
        `no colour tokens found in ${component}; the scan is matching nothing`
      );
    }
  });

  test('a money input is ink on card-alt, which is the modal ground', () => {
    // `.mz-field` is where BudgetModal and GoalModal put their amounts.
    assert.match(CSS, /\.mz-field \{[\s\S]*?bg-card-alt[\s\S]*?text-ink\b/);
    for (const theme of ['light', 'dark'] as const) {
      const ratio = contrast(triplet('ink', theme), triplet('card-alt', theme));
      assert.ok(ratio >= AA, `ink on card-alt ${theme} is ${ratio.toFixed(2)}:1`);
    }
  });

  for (const [component, ground] of GROUNDS) {
    for (const tokenName of inkTokens(componentSource(component))) {
      for (const theme of ['light', 'dark'] as const) {
        test(`${component}: ${tokenName} on ${ground}, ${theme}`, () => {
          const ratio = contrast(triplet(tokenName, theme), triplet(ground, theme));
          assert.ok(ratio >= AA, `${ratio.toFixed(2)}:1 is below AA ${AA}:1`);
        });
      }
    }
  }

  test('the ground that was missed is the one that failed, and the failure was real', () => {
    // Kept as the regression record: `muted-2` at 12.5px on `well` is what the strip shipped with.
    assert.ok(contrast(triplet('muted-2', 'light'), triplet('well', 'light')) < AA);
    assert.ok(contrast(triplet('muted-2', 'dark'), triplet('well', 'dark')) < AA);
    assert.doesNotMatch(componentSource('CarryoverStrip'), /text-muted-2/);
  });
});

describe('bar fills are visible against their own track', () => {
  // WCAG 1.4.11: a graphical object that conveys information needs 3:1 against what is adjacent
  // to it, which for a fill is the track it sits in.
  const UI = 3;
  const BAR = readFileSync(
    join(import.meta.dirname, '..', 'client', 'src', 'components', 'balance', 'ProgressBar.tsx'),
    'utf8'
  );

  // Comments stripped first: this file explains its own colour choices by naming the tokens it
  // rejected, and a scan that reads those would measure the losers instead of the shipped fills.
  const code = BAR.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const fills = [...new Set([...code.matchAll(/bg-([a-z0-9-]+)/g)].map((m) => m[1]))]
    .filter((name) => isColorToken(name) && name !== 'track');

  test('the fills were found in the source, not listed here', () => {
    assert.ok(fills.length >= 4, `only found ${JSON.stringify(fills)}`);
  });

  for (const fill of fills) {
    for (const theme of ['light', 'dark'] as const) {
      test(`${fill} on track, ${theme}`, () => {
        const ratio = contrast(triplet(fill, theme), triplet('track', theme));
        assert.ok(ratio >= UI, `${ratio.toFixed(2)}:1 is below ${UI}:1`);
      });
    }
  }

  test('the tones this shipped with are still the ones that failed', () => {
    // Why the map moved rather than the tokens: `sage` and `clay-scale` are correct everywhere else
    // they are used, they were simply never measured against `track`.
    assert.ok(contrast(triplet('sage', 'light'), triplet('track', 'light')) < UI);
    assert.ok(contrast(triplet('clay-scale', 'light'), triplet('track', 'light')) < UI);
    assert.doesNotMatch(BAR, /sage: 'bg-sage'/);
    assert.doesNotMatch(BAR, /clay: 'bg-clay-scale'/);
  });
});
