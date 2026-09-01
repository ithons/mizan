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
  // A snapshot is taken at an INSTANT and dated a DAY, so a row dated the same day may have posted
  // either side of it and the chain has two legitimate readings. Requiring the strict one alone made
  // the guard blind at a boundary it meets constantly: on 2026-08-01 three Chase charges dated
  // 2026-07-30 posted after that day's 21:50 snapshot, summing to exactly the $62.36 between the
  // chain's answer and the provider's magnitude, so a correction that was right to the cent could
  // not fire. Exactness is preserved because a match is still an exact match; what widens is only
  // which of two defensible chains it may match against.
  const sumOnAndAfter = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM transactions
    WHERE account_id = ? AND pending = 0 AND date >= ?
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

      const strict = (sumAfter.get(account.id, snapshot.date) as { total: number }).total;
      const inclusive = (sumOnAndAfter.get(account.id, snapshot.date) as { total: number }).total;
      const candidates = strict === inclusive
        ? [anchorValue - strict]
        : [anchorValue - strict, anchorValue - inclusive];
      // Take the reading that settles the direction, if either does. Both are the same chain over a
      // one-day difference in where its horizon is cut.
      const expectedOwed =
        candidates.find((c) => c !== 0 && Math.sign(c) !== Math.sign(account.current_balance)
          && Math.abs(c) === Math.abs(account.current_balance))
        ?? candidates[0];

      // Exactness is the safety property, and it is why this is a correction rather than a guess.
      // The rule can only fire when the provider's own transactions agree with the provider's own
      // magnitude to the cent and disagree only about direction. An incomplete feed cannot trigger
      // it: a chain missing even one row lands on a different magnitude and no correction is made.
      // (This used to cite Discover's floor as 2026-06-16. Re-derived 2026-09-01 it reads
      // 2026-07-31, along with every other SimpleFIN account; see the note in balanceHistory.ts
      // about floors being rewritten out of band. The argument does not depend on the value, so
      // the value is no longer stated here.)
      // The disagreement is about DIRECTION, and it runs both ways.
      //
      // This used to fire only when the ledger implied a credit and the provider had been negated
      // into debt. That is one half of the same defect. `liabilityAdjustedCents` negates whatever
      // the provider sends, so an institution that reports a positive balance for money OWED comes
      // out stored as a credit, and nothing corrected it because the guard required
      // `current_balance > 0`. On 2026-08-01 that left Chase Sapphire recorded as $5,433.49 in
      // credit when the ledger said $5,433.49 owed, to the cent, and net worth was overstated by
      // twice that. Chase and Capital One disagree about the sign convention on the same feed, so
      // this is not a one-institution quirk to special-case.
      //
      // What makes the correction safe is unchanged and is the exactness below, not the direction:
      // the provider's own transactions must agree with the provider's own magnitude to the cent and
      // disagree only about which way it points.
      if (expectedOwed === 0) continue;
      if (account.current_balance === 0) continue;
      if (Math.sign(expectedOwed) === Math.sign(account.current_balance)) continue;
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
        `Provider reports ${describePosition(account.current_balance)}; the ledger since ${doubt.date} ` +
        `(anchored at ${describePosition(doubt.anchorValue)}) gives ${describePosition(doubt.expectedOwed)}. ` +
        'The magnitudes disagree, so nothing was adopted and the direction of this balance is in doubt.',
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
/**
 * Names both values and both directions. It used to hardcode "reported owed ... stored as a credit",
 * which was only ever true of one of the two corrections this makes.
 */
export function describeLiabilitySignCorrection(correction: LiabilitySignCorrection): string {
  const stored = describePosition(correction.stored_balance);
  const adopted = describePosition(correction.corrected_balance);
  return `Provider reported ${stored}; the ledger since ${correction.anchor_date} gives ${adopted}. Stored as ${correction.corrected_balance < 0 ? 'a credit' : 'owed'}.`;
}
