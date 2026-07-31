import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ClaimSheet, Plan } from '../../client/src/views/Plan';
import type {
  Budget,
  BudgetRolloverLedgerEntry,
  Goal,
  RecurringForecast,
  SafeToSpend,
} from '../../shared/types';

/**
 * `/plan`, rendered.
 *
 * Every fixture below is the owner's live ledger, read from a PRIVATE copy of `.mizan/mizan.db`
 * taken at migration `053_drop_budget_groups.sql` (52 rows in `schema_migrations`, `001_initial.sql`
 * through `053`, `038` deliberately absent). The query that produced each figure is written beside
 * it; nothing here is a number somebody remembered.
 *
 * The point of rendering rather than unit-testing the readings is that the two blocking defects on
 * this screen are both about WHICH query a value came from, and a unit test on a pure function
 * cannot see that. A cold load is modelled by simply not seeding a key: `renderToString` runs no
 * effects, so an unseeded `useQuery` is `pending` with `data === undefined` and fires no request.
 */

// SELECT SUM(current_balance) FROM accounts
//   WHERE is_hidden = 0 AND type != 'closed' AND is_liability = 0
//     AND type IN ('checking','savings','cash');            -> 603567 cents
// SELECT SUM(current_balance) FROM accounts
//   WHERE is_hidden = 0 AND type != 'closed' AND is_liability = 1;   -> 427870 cents
// SELECT current_amount FROM goals WHERE is_archived = 0 AND type = 'savings';  -> 100170 cents
// allocated_budgets is min(projected_remaining, amount + rollover_balance) per budget: Shopping's
// remaining is $1,703.63 against a $500.00 ceiling, so the sheet counts $500.00.
// free = 6035.67 - 4278.70 - 64.04 - 500.00 - 1001.70 = 191.23
export const SHEET: SafeToSpend = {
  liquid: 6035.67,
  card_balances: 4278.7,
  upcoming_bills: 64.04,
  allocated_budgets: 500,
  allocated_goals: 1001.7,
  free: 191.23,
  forecast_days: 30,
};

// SELECT b.id, c.name, b.amount, b.rollover, b.created_at FROM budgets b
//   JOIN categories c ON c.id = b.category_id;
//   -> 68d53019-04d6-45c2-899e-097985358382 | Shopping | 50000 | 0 | 2026-07-09T22:50:37.383Z
// SELECT actual_spend FROM budget_rollover_ledger WHERE month = '2026-07';  -> -120363 cents
export const SHOPPING_BUDGET_ID = '68d53019-04d6-45c2-899e-097985358382';

export function shoppingBudget(overrides: Partial<Budget> = {}): Budget {
  const spent = overrides.spent ?? -1203.63;
  const amount = overrides.amount ?? 500;
  return {
    id: SHOPPING_BUDGET_ID,
    category_id: 'c_shop',
    amount,
    period: 'monthly',
    rollover: false,
    rollover_balance: 0,
    created_at: '2026-07-09T22:50:37.383Z',
    updated_at: '2026-07-09T22:50:37.383Z',
    category_name: 'Shopping',
    spent,
    expected_recurring: 0,
    projected_spend: spent,
    projected_remaining: amount - spent,
    projected_percent: (spent / amount) * 100,
    forecast_confidence: 'none',
    ...overrides,
  };
}

// SELECT id, name, type, target_amount, current_amount, is_archived FROM goals;
//   -> 7174e1b2-... | Emergency Fund | savings | 500000 | 100170 | 0
export const EMERGENCY_FUND: Goal = {
  id: '7174e1b2-8097-4edf-b235-88c0055eaca7',
  name: 'Emergency Fund',
  type: 'savings',
  target_amount: 5000,
  current_amount: 1001.7,
  account_id: '5d729a65-974f-4b55-bfa0-bb91c645a74b',
  target_date: null,
  is_archived: false,
  created_at: '2026-07-09T22:50:37.383Z',
  updated_at: '2026-07-30T12:00:00.000Z',
  progress_amount: 1001.7,
  remaining_amount: 3998.3,
  progress_percent: 20.034,
} as Goal;

// SELECT budget_id, month, starting_rollover, budget_amount, actual_spend, ending_rollover
//   FROM budget_rollover_ledger ORDER BY month;
//   -> 68d53019-... | 2026-07 | 0 | 50000 | -120363 | 170363
export const JULY_LEDGER_ROW: BudgetRolloverLedgerEntry = {
  id: `${SHOPPING_BUDGET_ID}:2026-07`,
  budget_id: SHOPPING_BUDGET_ID,
  category_id: 'c_shop',
  category_name: 'Shopping',
  month: '2026-07',
  starting_rollover: 0,
  budget_amount: 500,
  actual_spend: -1203.63,
  ending_rollover: 1703.63,
  calculated_at: '2026-07-30T12:00:00.000Z',
};

const FORECAST: RecurringForecast = {
  days: 30,
  income: 0,
  bills: 64.04,
  net: -64.04,
  confirmed_income: 0,
  confirmed_bills: 64.04,
  likely_income: 0,
  likely_bills: 0,
  uncertain_income: 0,
  uncertain_bills: 0,
  overdue_count: 0,
  review_count: 0,
  occurrences: [],
} as RecurringForecast;

export function openMonthKey(): string {
  return format(new Date(), 'yyyy-MM');
}

export interface Seed {
  /** Omit a field to model the cold-load state where that query has not resolved yet. */
  sheet?: SafeToSpend;
  goals?: Goal[];
  /** Keyed by `yyyy-MM`, so a test can give the open month and the stepped month different lists. */
  budgetsByMonth?: Record<string, Budget[]>;
  ledger?: BudgetRolloverLedgerEntry[];
}

export function render(seed: Seed = {}): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });

  if (seed.sheet) client.setQueryData(['insights', 'safe-to-spend'], seed.sheet);
  if (seed.goals) client.setQueryData(['goals', 'all'], seed.goals);
  for (const [month, budgets] of Object.entries(seed.budgetsByMonth ?? {})) {
    client.setQueryData(['budgets', month], budgets);
  }
  if (seed.ledger) {
    client.setQueryData(['budgets', 'rollover-ledger', SHOPPING_BUDGET_ID], seed.ledger);
  }
  client.setQueryData(['categories'], []);
  client.setQueryData(['accounts'], []);
  client.setQueryData(['recurring', 'forecast', 30], FORECAST);

  // `useLayoutEffect` warns on every server render and says nothing about this screen; anything
  // else React has to say still reaches the runner, because a swallowed warning is how a real
  // render defect would get through a test that only asserts on strings.
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('useLayoutEffect does nothing on the server')) return;
    realError(...args);
  };
  try {
    return renderToString(
      createElement(
        QueryClientProvider,
        { client },
        createElement(MemoryRouter, { initialEntries: ['/plan'] }, createElement(Plan))
      )
    );
  } finally {
    console.error = realError;
  }
}

/** The rendered text, with tags and HTML entities out of the way. */
export function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;|\s+/g, ' ');
}

/** Every `width:` percentage in render order, which is what a bar's magnitude actually is. */
export function barWidths(html: string): number[] {
  return [...html.matchAll(/width:\s*([\d.]+)%/g)].map((m) => Number(m[1]));
}

/**
 * The claim sheet on its own.
 *
 * It holds no state and calls no hook, so rendering it directly is the only way to hand the same
 * sheet two different budget lists and see which of the two the paragraph under it is reading.
 */
export function renderClaimSheet(
  sheet: SafeToSpend,
  budgets: Budget[] | undefined,
  goalCount: number | null
): string {
  return renderToString(createElement(ClaimSheet, { sheet, budgets, goalCount }));
}
