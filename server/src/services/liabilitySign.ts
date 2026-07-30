import type Database from 'better-sqlite3';
import { readSnapshots } from './netWorthHistory';

/**
 * Settle the DIRECTION of a liability balance against the ledger.
 *
 * `accounts.current_balance` under the convention "positive = owed" is our transform of the
 * provider's number, not the provider's number: `liabilityAdjustedCents` negates whatever
 * SimpleFIN sends on the documented assumption that a credit balance arrives negative. When a card
 * goes into credit the institution sends a negative too, so the negation produces debt. Three cards
 * were storing the exact magnitude of their credit as the amount owed on 2026-07-29, and net worth
 * was understated by twice the total.
 *
 * So this corrects our own transform, which is allowed, rather than a reported transaction amount,
 * which is not. Nothing here touches `transactions`.
 */

export interface LiabilitySignCorrection {
  account_id: string;
  account_name: string | null;
  /** Measured snapshot the chain starts from, and the figure it recorded: owed if positive. */
  anchor_date: string;
  anchor_value: number;
  stored_balance: number;
  corrected_balance: number;
}

export interface LiabilitySignUnverifiable {
  account_id: string;
  account_name: string | null;
  reason: string;
}

export interface LiabilitySignReport {
  corrections: LiabilitySignCorrection[];
  /**
   * Liabilities whose direction the ledger contradicts without being able to settle: an anchor that
   * disagrees with the provider about direction AND magnitude, with no pending row to explain the
   * gap. Silence about those would read as a pass.
   *
   * An account no measured snapshot has reached yet is NOT here. It is new, and a not-yet is not a
   * doubt: a card connected today carries whatever it carries, and the first snapshot settles it.
   */
  unverifiable: LiabilitySignUnverifiable[];
}

interface LiabilityRow {
  id: string;
  account_name: string | null;
  current_balance: number;
}

/**
 * Correct any liability whose stored balance has the magnitude the ledger implies and the opposite
 * sign, and report any liability whose direction the ledger contradicts without being able to fix.
 */
export function correctLiabilitySigns(db: Database.Database, now: string): LiabilitySignReport {
  const accounts = db.prepare(`
    SELECT id, account_name, current_balance
    FROM accounts
    WHERE is_liability = 1 AND is_hidden = 0
  `).all() as LiabilityRow[];

  // Newest first: the shortest chain of transactions is the one that has to be trusted least far.
  const snapshots = readSnapshots(db, { measuredOnly: true, order: 'desc' }).map((snapshot) => {
    let breakdown: Record<string, unknown>;
    try {
      breakdown = JSON.parse(snapshot.breakdown) as Record<string, unknown>;
    } catch {
      breakdown = {};
    }
    return { date: snapshot.date, breakdown };
  });

  const sumAfter = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM transactions
    WHERE account_id = ? AND pending = 0 AND date > ?
  `);
  const pendingAfter = db.prepare(`
    SELECT COUNT(*) AS count
    FROM transactions
    WHERE account_id = ? AND pending = 1 AND date > ?
  `);
  const updateBalance = db.prepare(
    'UPDATE accounts SET current_balance = ?, updated_at = ? WHERE id = ?'
  );

  const report: LiabilitySignReport = { corrections: [], unverifiable: [] };

  for (const account of accounts) {
    let corrected = false;
    let doubt: { date: string; anchorValue: number; expectedOwed: number } | null = null;

    for (const snapshot of snapshots) {
      const anchorValue = snapshot.breakdown[account.id];
      // A negative anchor is accepted. A snapshot is our own settled record, written after this
      // correction has already run, not the provider's number, so a card sitting in credit records
      // a negative here and refusing it would leave that card unanchored forever. What makes an
      // adoption safe is the exactness triple below, and that holds against an anchor of any sign.
      // Walking newest to oldest already keeps an anchor from before the correction out of reach.
      if (typeof anchorValue !== 'number' || !Number.isFinite(anchorValue)) continue;

      const { total } = sumAfter.get(account.id, snapshot.date) as { total: number };
      const expectedOwed = anchorValue - total;

      // Exactness is the safety property, and it is why this is a correction rather than a guess.
      // The rule can only fire when the provider's own transactions agree with the provider's own
      // magnitude to the cent and disagree only about direction. An incomplete feed cannot trigger
      // it (Discover's backfill_floor_date is 2026-06-16, Coinbase's is 2025-09-04): a chain
      // missing even one row lands on a different magnitude and no correction is made.
      if (expectedOwed >= 0) continue;
      if (account.current_balance <= 0) continue;
      if (Math.abs(expectedOwed) !== Math.abs(account.current_balance)) {
        // The two sides disagree about direction and about magnitude, so the magnitude cannot be
        // adopted. Moving on in silence would report the direction as settled, and this is the case
        // where the owner most needs to be told it is not. Newest anchor wins: shortest chain.
        //
        // Unless a pending row is in flight. The chain counts settled rows only while the provider's
        // balance counts everything it has authorized, so one pending charge on a card makes the two
        // sides disagree by exactly that charge. That disagreement is the feed working.
        const { count } = pendingAfter.get(account.id, snapshot.date) as { count: number };
        if (count === 0) doubt ??= { date: snapshot.date, anchorValue, expectedOwed };
        continue;
      }

      updateBalance.run(expectedOwed, now, account.id);
      report.corrections.push({
        account_id: account.id,
        account_name: account.account_name,
        anchor_date: snapshot.date,
        anchor_value: anchorValue,
        stored_balance: account.current_balance,
        corrected_balance: expectedOwed,
      });
      corrected = true;
      break;
    }

    if (corrected || !doubt) continue;

    report.unverifiable.push({
      account_id: account.id,
      account_name: account.account_name,
      reason:
        `Provider reports $${dollars(account.current_balance)} owed; the ledger since ${doubt.date} ` +
        `(anchored at ${describePosition(doubt.anchorValue)}) gives a credit balance of ` +
        `$${dollars(Math.abs(doubt.expectedOwed))}. The magnitudes disagree, so nothing was adopted ` +
        'and the direction of this balance is in doubt.',
    });
  }

  return report;
}

function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Anchors can now be credits, and "$-5.82 owed" is not a sentence. */
function describePosition(cents: number): string {
  return cents < 0 ? `a $${dollars(-cents)} credit` : `$${dollars(cents)} owed`;
}

/** The sync_changes description for an adoption, naming both values so neither is lost. */
export function describeLiabilitySignCorrection(correction: LiabilitySignCorrection): string {
  const stored = dollars(correction.stored_balance);
  const adopted = dollars(Math.abs(correction.corrected_balance));
  return `Provider reported $${stored} owed; the ledger since ${correction.anchor_date} gives a credit balance of $${adopted}. Stored as a credit.`;
}
