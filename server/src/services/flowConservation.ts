import type Database from 'better-sqlite3';

/**
 * Money that left two owned accounts at once and arrived in neither.
 *
 * A transfer between two accounts the owner holds is equal and OPPOSITE. The existing transfer
 * pairing searches for exactly that shape, so an equal and SAME-SIGNED near-pair is invisible to
 * it: two outbound legs mean the amount left the household twice and landed nowhere.
 *
 * OUTBOUND ONLY. Two accounts receiving the same amount days apart is ordinary external income:
 * a paycheck, a refund, a deposit whose funding side is at an institution this ledger has never
 * seen. Money arriving has no counterparty here by construction, so demanding one would alarm on
 * the most routine event the ledger contains. Money leaving is different: an owned account is the
 * only place a transfer between owned accounts can land.
 *
 * UNPAIRED ONLY, and this is what keeps the check quiet. Two round-number transfers of the same
 * size within a week is an ordinary month, not a defect: a payday split, two card payments from two
 * funding accounts, a transfer and its reversal. What separates those from a real violation is that
 * each of their legs already has its own equal-and-opposite counterpart somewhere in the ledger. A
 * leg that is already accounted for is not evidence of anything, however many other legs it
 * resembles.
 *
 * This is a fact about the ledger rather than a guess about intent, which is the whole reason it is
 * safe to report. It compares stored rows to each other and never to a balance, so a price move
 * cannot manufacture it. Nothing here rewrites an amount: the provider owns those, and a repair
 * would revert on the next pass anyway.
 *
 * GROUPED by account pair, because one systematic defect in one feed is one finding. Reporting the
 * twelve Chase Checking / Fidelity Individual legs as twelve alarms is how a panel stops being read.
 *
 * REPEATED ONLY. Two equal transfers out of the household in the same week, on two owned accounts,
 * to institutions this ledger is not connected to, is an ordinary week: neither leg has a landing
 * here because neither landing exists here. A single coincidence between two accounts is a
 * coincidence; a repeated pattern between the same two accounts is a systematic sign defect, which
 * is the only thing worth reporting. So the same unordered account pair must carry at least two
 * distinct matched pairs before any of it becomes a finding.
 */

export interface FlowConservationFinding {
  account_a_id: string;
  account_a_name: string | null;
  account_b_id: string;
  account_b_name: string | null;
  /** Distinct transactions involved across both accounts, not the number of matched pairs. */
  leg_count: number;
  first_date: string;
  last_date: string;
  /**
   * The money at issue, counted ONCE, in cents.
   *
   * Both accounts record the same movement leaving, so summing every leg reports $1,400.00 for
   * $700.00 of money. This is one side's outflow: the larger side where the two disagree, since a
   * leg can match several on the other side. It is what at least this much movement is worth, not
   * a total across the pair and not a loss.
   */
  movement_cents: number;
}

/** Under this, two same-signed rows on two accounts are likelier a coincidence than a defect. */
export const MIN_LEG_CENTS = 1000;

/** Institutions post the two sides of one movement days apart; beyond this they are not one. */
export const MAX_PAIR_DAY_GAP = 5;

/**
 * Matched pairs the same account pair must carry before it is reported.
 *
 * A single coincidence between two accounts is a coincidence: two equal transfers out to
 * institutions this ledger never sees is what an ordinary week looks like. A repeated pattern
 * between the same two accounts is a systematic sign defect.
 */
export const MIN_MATCHED_PAIRS = 2;

// BOTH legs must be transfer-class. An equal-magnitude coincidence between a transfer and an
// ordinary merchant charge (the ledger has Chipotle, Uber Eats and Blue Bottle pairs across two
// cards) is a coincidence, and one transfer-class leg does not make it a broken transfer.
//
// The counterpart search deliberately admits pending rows and hidden accounts. It is asking whether
// the money plausibly landed anywhere at all, and the more evidence that question accepts, the
// fewer healthy movements this reports.
const PAIR_SQL = `
  WITH RECURSIVE transfer_categories(id) AS (
    SELECT id FROM categories WHERE id IN ('cat_xfer', 'cat_inv_transfer')
    UNION ALL
    SELECT c.id FROM categories c JOIN transfer_categories tc ON c.parent_id = tc.id
  ),
  unpaired_outbound AS (
    SELECT t.id, t.account_id, t.date, t.amount
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    WHERE t.pending = 0
      AND a.is_hidden = 0
      AND t.amount < 0
      AND ABS(t.amount) >= @minCents
      AND t.category_id IN (SELECT id FROM transfer_categories)
      AND NOT EXISTS (
        SELECT 1 FROM transactions counterpart
        WHERE counterpart.account_id <> t.account_id
          AND counterpart.amount = -t.amount
          AND ABS(julianday(counterpart.date) - julianday(t.date)) <= @maxGap
      )
  )
  SELECT
    l.id AS id_a, l.account_id AS account_a, l.date AS date_a,
    r.id AS id_b, r.account_id AS account_b, r.date AS date_b,
    l.amount AS amount
  FROM unpaired_outbound l
  JOIN unpaired_outbound r ON r.id > l.id
  WHERE l.account_id <> r.account_id
    AND l.amount = r.amount
    AND ABS(julianday(l.date) - julianday(r.date)) <= @maxGap
`;

interface PairRow {
  id_a: string;
  account_a: string;
  date_a: string;
  id_b: string;
  account_b: string;
  date_b: string;
  amount: number;
}

interface Leg {
  accountId: string;
  amount: number;
  date: string;
}

interface PairGroup {
  accountA: string;
  accountB: string;
  legs: Map<string, Leg>;
  matchedPairs: number;
}

function outflowOf(legs: Leg[], accountId: string): number {
  return legs
    .filter((leg) => leg.accountId === accountId)
    .reduce((sum, leg) => sum + Math.abs(leg.amount), 0);
}

function toFinding(group: PairGroup, names: Map<string, string | null>): FlowConservationFinding {
  const legs = [...group.legs.values()];
  const dates = legs.map((leg) => leg.date).sort();
  return {
    account_a_id: group.accountA,
    account_a_name: names.get(group.accountA) ?? null,
    account_b_id: group.accountB,
    account_b_name: names.get(group.accountB) ?? null,
    leg_count: legs.length,
    first_date: dates[0],
    last_date: dates[dates.length - 1],
    movement_cents: Math.max(outflowOf(legs, group.accountA), outflowOf(legs, group.accountB)),
  };
}

export function findFlowConservationViolations(db: Database.Database): FlowConservationFinding[] {
  const rows = db.prepare(PAIR_SQL).all({
    minCents: MIN_LEG_CENTS,
    maxGap: MAX_PAIR_DAY_GAP,
  }) as PairRow[];
  if (rows.length === 0) return [];

  const names = new Map(
    (db.prepare('SELECT id, account_name FROM accounts').all() as Array<{
      id: string;
      account_name: string | null;
    }>).map((account) => [account.id, account.account_name])
  );

  const groups = new Map<string, PairGroup>();
  for (const row of rows) {
    // Unordered pair: which leg the join happened to put first is not a property of the defect.
    const [accountA, accountB] = row.account_a < row.account_b
      ? [row.account_a, row.account_b]
      : [row.account_b, row.account_a];
    const key = `${accountA}|${accountB}`;

    let group = groups.get(key);
    if (!group) {
      group = { accountA, accountB, legs: new Map(), matchedPairs: 0 };
      groups.set(key, group);
    }
    // The join emits each unordered transaction pair once (r.id > l.id), so a row is one match.
    group.matchedPairs += 1;
    // Keyed by transaction id: one leg can pair with several on the other side, and it is still
    // one row of money.
    group.legs.set(row.id_a, { accountId: row.account_a, amount: row.amount, date: row.date_a });
    group.legs.set(row.id_b, { accountId: row.account_b, amount: row.amount, date: row.date_b });
  }

  return [...groups.values()]
    .filter((group) => group.matchedPairs >= MIN_MATCHED_PAIRS)
    .map((group) => toFinding(group, names))
    .sort((a, b) => b.movement_cents - a.movement_cents);
}
