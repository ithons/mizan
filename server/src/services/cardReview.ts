import type Database from 'better-sqlite3';
import { addDays, addYears, format, parseISO, subMonths } from 'date-fns';
import type {
  CardFeeKind,
  CardFeeRow,
  CardReview,
  CardReviewCard,
  CardReviewRow,
  CardReviewWindow,
  UnattributedRedemption,
} from '../../../shared/types';
import { excludedFromTotalsSql } from './transactionFilters';
import { getSpendByAccount } from './reporting';
import { dollarizeFields } from './money';

const CARD_REDEMPTION = /STATEMENT CREDIT|STMT CRDT|CASH ?BACK|CASH ?REWARDS?|REDEMPTION/i;

const BANK_REDEMPTION = /CASH ?REWARDS?|CASH ?BACK|CASH REDEMPTION|REWARDS? REDEMPTION/i;

const FEE_KINDS: ReadonlyArray<[CardFeeKind, RegExp]> = [
  ['annual', /ANNUAL (MEMBERSHIP )?FEE/i],
  ['foreign_transaction', /FOREIGN TRANSACTION FEE/i],
  ['late', /\bLATE (PAYMENT )?FEE\b/i],
  ['interest', /INTEREST CHARGE|PURCHASE INTEREST|FINANCE CHARGE/i],
  ['returned_payment', /RETURNED (CHECK|PAYMENT) (CHARGE|FEE)/i],
  ['cash_advance_or_transfer', /CASH ADVANCE FEE|BALANCE TRANSFER FEE/i],
];

interface BankProgram {
  descriptor: RegExp;
  institution: RegExp;
}

const BANK_PROGRAMS: readonly BankProgram[] = [
  { descriptor: /BANK OF AMERICA.*CASH ?REWARDS?/i, institution: /bank of america/i },
];

const NOT_BANK_TYPES = ['credit', 'brokerage', 'ira_traditional', 'ira_roth', 'crypto_wallet'];

interface CardAccount {
  id: string;
  account_name: string;
  institution_name: string;
}

interface LedgerRow {
  id: string;
  account_id: string;
  account_name: string;
  institution_name: string;
  date: string;
  amount: number;
  descriptor: string;
}

const ROW_SELECT = `
  SELECT t.id, t.account_id, a.account_name, a.institution_name, t.date, t.amount,
         TRIM(COALESCE(NULLIF(TRIM(t.original_name), ''), t.merchant_name, '')) AS descriptor
  FROM transactions t JOIN accounts a ON a.id = t.account_id
  WHERE t.pending = 0 AND ${excludedFromTotalsSql('t')}`;

function toRow(row: LedgerRow): CardReviewRow {
  return {
    transaction_id: row.id,
    date: row.date,
    amount: row.amount,
    descriptor: row.descriptor,
    account_id: row.account_id,
    account_name: row.account_name,
  };
}

function feeKind(descriptor: string): CardFeeKind | null {
  return FEE_KINDS.find(([, pattern]) => pattern.test(descriptor))?.[0] ?? null;
}

function attributedCard(row: LedgerRow, cards: readonly CardAccount[]): CardAccount | null {
  const program = BANK_PROGRAMS.find((p) => p.descriptor.test(row.descriptor));
  if (!program) return null;
  const matches = cards.filter((card) => program.institution.test(card.institution_name));
  return matches.length === 1 ? matches[0] : null;
}

function sumWindow(rows: readonly CardReviewRow[], from: string | null, to: string, sign: 1 | -1): number {
  return rows
    .filter((row) => row.date <= to && (from === null || row.date >= from))
    .reduce((sum, row) => sum + sign * row.amount, 0);
}

function windowFor(
  redemptions: readonly CardReviewRow[],
  fees: readonly CardFeeRow[],
  spend: number,
  from: string | null,
  to: string
): CardReviewWindow {
  const redeemed = sumWindow(redemptions, from, to, 1);
  const charged = sumWindow(fees, from, to, -1);
  return { redeemed, fees: charged, net: redeemed - charged, spend };
}

function lastAnnualFee(fees: readonly CardFeeRow[]): string | null {
  const charges = fees.filter((fee) => fee.kind === 'annual' && fee.amount < 0).map((fee) => fee.date).sort();
  return charges.length > 0 ? charges[charges.length - 1] : null;
}

/**
 * Per credit card, what it returned (redemptions on the card, and bank deposits whose descriptor
 * names exactly one card's program) and what it charged (issuer fees by descriptor; a merchant's
 * or processor's fee filed under Fees is not one). Spend is what Reports counts on the card,
 * less the fee rows. A bank deposit that names no single card is returned unattributed.
 */
export function cardReview(db: Database.Database, asOf: string): CardReview {
  const trailingFrom = format(addDays(subMonths(parseISO(asOf), 12), 1), 'yyyy-MM-dd');
  const cards = db.prepare(`
    SELECT id, account_name, institution_name FROM accounts WHERE type = 'credit' ORDER BY account_name, id
  `).all() as CardAccount[];
  const cardRows = db.prepare(`${ROW_SELECT} AND a.type = 'credit' ORDER BY t.date, t.id`).all() as LedgerRow[];
  const bankRows = (db.prepare(`
    ${ROW_SELECT} AND t.amount > 0 AND a.type NOT IN (${NOT_BANK_TYPES.map(() => '?').join(',')})
    ORDER BY t.date, t.id
  `).all(...NOT_BANK_TYPES) as LedgerRow[]).filter((row) => BANK_REDEMPTION.test(row.descriptor));

  const redemptions = new Map<string, CardReviewRow[]>(cards.map((card) => [card.id, []]));
  const fees = new Map<string, CardFeeRow[]>(cards.map((card) => [card.id, []]));
  const ledgerFrom = new Map<string, string>();
  for (const row of cardRows) {
    if (!ledgerFrom.has(row.account_id)) ledgerFrom.set(row.account_id, row.date);
    const kind = feeKind(row.descriptor);
    if (kind) fees.get(row.account_id)?.push({ ...toRow(row), kind });
    else if (row.amount > 0 && CARD_REDEMPTION.test(row.descriptor)) redemptions.get(row.account_id)?.push(toRow(row));
  }

  const unattributed: UnattributedRedemption[] = [];
  for (const row of bankRows) {
    const card = attributedCard(row, cards);
    if (card) {
      redemptions.get(card.id)?.push(toRow(row));
      continue;
    }
    unattributed.push({
      ...toRow(row),
      same_institution_card_ids: cards.filter((c) => c.institution_name === row.institution_name).map((c) => c.id),
    });
  }

  const cardIds = cards.map((card) => card.id);
  const feeIds = [...fees.values()].flat().map((fee) => fee.transaction_id);
  const lifeSpend = getSpendByAccount(db, { endDate: asOf }, cardIds, feeIds);
  const trailingSpend = getSpendByAccount(db, { startDate: trailingFrom, endDate: asOf }, cardIds, feeIds);

  return {
    as_of: asOf,
    trailing_12_from: trailingFrom,
    cards: cards.map((card): CardReviewCard => {
      const cardRedemptions = (redemptions.get(card.id) ?? []).sort((a, b) => a.date.localeCompare(b.date));
      const cardFees = fees.get(card.id) ?? [];
      const lastFee = lastAnnualFee(cardFees);
      return {
        account_id: card.id,
        account_name: card.account_name,
        institution_name: card.institution_name,
        ledger_from: ledgerFrom.get(card.id) ?? null,
        life: windowFor(cardRedemptions, cardFees, lifeSpend.get(card.id) ?? 0, null, asOf),
        trailing_12: windowFor(cardRedemptions, cardFees, trailingSpend.get(card.id) ?? 0, trailingFrom, asOf),
        redemptions: cardRedemptions,
        fees: cardFees,
        last_annual_fee_date: lastFee,
        next_annual_fee_date: lastFee ? format(addYears(parseISO(lastFee), 1), 'yyyy-MM-dd') : null,
      };
    }),
    unattributed,
  };
}

const WINDOW_FIELDS = ['redeemed', 'fees', 'net', 'spend'] as const;
const ROW_FIELDS = ['amount'] as const;

export function cardReviewToDollars(review: CardReview): CardReview {
  return {
    ...review,
    cards: review.cards.map((card) => ({
      ...card,
      life: dollarizeFields({ ...card.life }, WINDOW_FIELDS),
      trailing_12: dollarizeFields({ ...card.trailing_12 }, WINDOW_FIELDS),
      redemptions: card.redemptions.map((row) => dollarizeFields({ ...row }, ROW_FIELDS)),
      fees: card.fees.map((row) => dollarizeFields({ ...row }, ROW_FIELDS)),
    })),
    unattributed: review.unattributed.map((row) => dollarizeFields({ ...row }, ROW_FIELDS)),
  };
}
