import type Database from 'better-sqlite3';
import { format, subDays } from 'date-fns';
import { excludedFromTotalsSql } from './transactionFilters';
import { toDollars } from './money';

const PEER_PAYMENT = ['%zelle%from%', '%venmo%', '%cash app%', '%paypal%'];
const LOOKBACK_DAYS = 14;
const CANDIDATES_PER_INFLOW = 3;

interface Inflow { id: string; date: string; amount: number; label: string; category: string | null }
interface Purchase { id: string; date: string; amount: number; label: string; category: string | null; paid_back: number }

/**
 * Money in from a person-to-person payment that nothing pairs or links yet, each with the spending
 * of the fortnight before it that is large enough to be the purchase it pays back. Only candidates:
 * whether any of them is a reimbursement is the owner's to say.
 */
export function findReimbursements(db: Database.Database, days = 120, today = new Date()) {
  const since = format(subDays(today, days), 'yyyy-MM-dd');
  const inflows = db.prepare(`
    SELECT t.id, t.date, t.amount, COALESCE(t.merchant_name, t.original_name) AS label, c.name AS category
    FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.amount > 0 AND t.pending = 0 AND t.date >= ? AND t.transfer_pair_id IS NULL AND t.refund_of_id IS NULL
      AND COALESCE(t.refund_link_source, '') <> 'rejected'
      AND (${PEER_PAYMENT.map(() => 'lower(t.original_name) LIKE ?').join(' OR ')})
    ORDER BY t.date DESC
  `).all(since, ...PEER_PAYMENT) as Inflow[];
  const purchasesFor = db.prepare(`
    SELECT t.id, t.date, t.amount, COALESCE(t.merchant_name, t.original_name) AS label, c.name AS category,
           COALESCE((SELECT SUM(r.amount) FROM transactions r WHERE r.refund_of_id = t.id), 0) AS paid_back
    FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.amount < 0 AND t.pending = 0 AND ${excludedFromTotalsSql('t')}
      AND t.date BETWEEN ? AND ? AND -t.amount - COALESCE((SELECT SUM(r.amount) FROM transactions r WHERE r.refund_of_id = t.id), 0) >= ?
    ORDER BY t.date DESC, -t.amount ASC
    LIMIT ${CANDIDATES_PER_INFLOW}
  `);
  return {
    inflows: inflows.map((inflow) => ({
      id: inflow.id,
      date: inflow.date,
      amount: toDollars(inflow.amount),
      label: inflow.label,
      category: inflow.category,
      could_pay_back: (purchasesFor.all(format(subDays(new Date(`${inflow.date}T00:00:00`), LOOKBACK_DAYS), 'yyyy-MM-dd'), inflow.date, inflow.amount) as Purchase[])
        .map((purchase) => ({
          id: purchase.id,
          date: purchase.date,
          amount: toDollars(-purchase.amount),
          already_paid_back: toDollars(purchase.paid_back),
          label: purchase.label,
          category: purchase.category,
        })),
    })),
    method: `Person-to-person money in (Zelle from, Venmo, Cash App, PayPal) in the last ${days} days that no transfer pairs and no link claims, unless the owner already said it pays nothing back. For each, up to ${CANDIDATES_PER_INFLOW} purchases from the ${LOOKBACK_DAYS} days before it, newest first, that still have at least that much not yet paid back. A Venmo cashout can bundle several payments, and money from the owner's own other account is not a reimbursement; ask before proposing a link.`,
  };
}
