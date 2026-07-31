import type Database from 'better-sqlite3';
import type { AccountType } from '../../../shared/types';

// Best-effort guess only, run at first insert for a new SimpleFIN account. Institutions
// don't expose a structured type/subtype, so this is a name/org
// substring heuristic. It is not the ground truth. A user can always override the
// result via PATCH /api/accounts/:id, which marks the account 'manual' so neither this
// function nor the reclassification backfill below will ever touch it again.
const BROKERAGE_INSTITUTIONS = [
  'fidelity', 'vanguard', 'schwab', 'wealthfront', 'betterment', 'e*trade', 'etrade',
  'merrill', 'td ameritrade', 'robinhood', 'wealthsimple', 'ally invest', 'm1 finance',
];

// Well-known credit-card-only product lines whose names contain neither "credit" nor
// "card" (e.g. Bank of America's "Customized Cash Rewards", Capital One's "Savor"), so
// they'd otherwise fall through to the generic 'checking' default.
const KNOWN_CREDIT_CARD_PRODUCTS = [
  'cash rewards', 'savor', 'quicksilver', 'venture x', 'venture', 'spark cash', 'spark miles',
];

export function guessAccountTypeAndLiability(name: string, orgName: string): { type: AccountType; isLiability: boolean } {
  const combined = `${name} ${orgName}`.toLowerCase();

  if (combined.includes('credit') || combined.includes('card')) {
    return { type: 'credit', isLiability: true };
  }
  if (KNOWN_CREDIT_CARD_PRODUCTS.some((product) => combined.includes(product))) {
    return { type: 'credit', isLiability: true };
  }
  if (combined.includes('loan') || combined.includes('mortgage')) {
    return { type: 'other', isLiability: true };
  }
  if (combined.includes('roth')) {
    return { type: 'ira_roth', isLiability: false };
  }
  if (combined.includes('ira') || combined.includes('401k')) {
    return { type: 'ira_traditional', isLiability: false };
  }
  if (combined.includes('savings') || combined.includes('apy') || combined.includes('cash account')) {
    // Name-only signal, deliberately not combined with institution: fintechs like
    // Wealthfront offer both a real brokerage and a cash-management/HYSA product, often
    // both named e.g. "Individual". Institution alone can't distinguish them, but "APY"
    // or "cash account" in the name is a reliable sign this is the cash product, not a
    // taxable brokerage account.
    return { type: 'savings', isLiability: false };
  }
  if (combined.includes('brokerage') || combined.includes('investment')) {
    return { type: 'brokerage', isLiability: false };
  }
  if (BROKERAGE_INSTITUTIONS.some((institution) => combined.includes(institution))) {
    // A generically-named account ("Individual", "Cash") at a known brokerage is far
    // more likely to be a brokerage/cash-management account than a checking account.
    return { type: 'brokerage', isLiability: false };
  }

  return { type: 'checking', isLiability: false };
}

interface AutoAccountRow {
  id: string;
  account_name: string;
  institution_name: string;
  type: AccountType;
  is_liability: number;
}

// One-time (idempotent) pass to fix accounts whose `type` was frozen by an older,
// weaker version of the heuristic above and never re-derived since (sync only ever
// classifies at insert time). Only touches rows still marked 'auto': a manual
// override always wins and is never revisited here.
export function reclassifyAutoAccountTypes(db: Database.Database): { updated: number } {
  const rows = db.prepare(`
    SELECT id, account_name, institution_name, type, is_liability
    FROM accounts
    WHERE connection_type = 'simplefin' AND type_source = 'auto'
  `).all() as AutoAccountRow[];

  const now = new Date().toISOString();
  const update = db.prepare(`
    UPDATE accounts SET type = ?, is_liability = ?, updated_at = ? WHERE id = ?
  `);

  let updated = 0;
  for (const row of rows) {
    const wasLiability = Boolean(row.is_liability);
    const guessed = guessAccountTypeAndLiability(row.account_name, row.institution_name);

    // An existing liability flag is never cleared automatically: the name heuristic
    // missing a product name (e.g. "Chase Freedom Flex" containing neither "credit" nor
    // "card") is a false negative in the guess, not evidence the account stopped being a
    // liability. Only let the guess add a liability flag that wasn't set before.
    const nextIsLiability = wasLiability || guessed.isLiability;
    const nextType = !wasLiability || guessed.isLiability
      ? guessed.type
      : (row.type === 'credit' || row.type === 'other' ? row.type : 'credit');

    if (nextType === row.type && nextIsLiability === wasLiability) continue;
    update.run(nextType, nextIsLiability ? 1 : 0, now, row.id);
    updated++;
  }

  return { updated };
}
