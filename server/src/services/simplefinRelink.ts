import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import { safeJsonParse } from './jsonSafe';
import { toCents, toDollarsOrNull, toDollars } from './money';
import type {
  SimplefinRelinkProposalView,
  SimplefinRelinkPairView,
  SimplefinRelinkUnpairedStoredView,
  SimplefinRelinkUnpairedProviderView,
  SimplefinRelinkProviderAccountView,
  SimplefinRelinkStoredAccountView,
} from '../../../shared/types';

/**
 * Did the provider re-mint its account ids, and if so, which existing account is which?
 *
 * `upsertSimplefinAccount` finds a row by `simplefin_account_id` and by nothing else. That is
 * correct as long as the id is stable, and on 2026-08-01 it was not: a lapsed SimpleFIN Bridge
 * subscription (402) was renewed, every institution was re-added at the provider, and every account
 * arrived under a new ACT- id. Nine lookups missed, nine INSERTs ran, and the nine originals were
 * then absent from a clean response, so `zeroAccountsMissingFromResponse` read them as closed and
 * zeroed them. See migration 055 for the measured damage.
 *
 * This module is the missing step: look at the ids BEFORE anything writes, and decide what kind of
 * event this is rather than assuming the ordinary one.
 *
 * Three things it deliberately does not do.
 *
 * It does not pair silently. Every pair carries the comparison that produced it, and adoption is a
 * separate explicit call. The defect being fixed here was a silent decision; replacing it with a
 * cleverer silent decision fixes nothing.
 *
 * It does not create. Adoption writes the new provider id onto the EXISTING row and moves nothing
 * else: not the name, not the type, not `type_source`, not `name_source`, and above all not
 * `backfill_floor_date`, which is the line below which imported manual history owns the ledger. A
 * row that loses it re-imports years of duplicates on the next deep resync.
 *
 * And it does not leave a finding the owner cannot clear. Dismissal records the provider ids it
 * settles, so the same proposal cannot be raised again on the next sync; and if the condition
 * clears on its own, a pending proposal is resolved rather than left blocking the sync forever.
 */

/** Where the owner resolves a pending proposal. One copy, so the copy and the UI cannot drift. */
export const RELINK_SCREEN = 'Settings';
export const RELINK_SCREEN_PATH = '/settings';

// ---------------------------------------------------------------------------
// 1. Detection
// ---------------------------------------------------------------------------

export type RelinkOutcome = 'none' | 'relink' | 'partial';

export interface RelinkOutcomePolicy {
  outcome: RelinkOutcome;
  /** Whether syncSimplefin may write anything at all: accounts, transactions, holdings, zeroing. */
  blocksSync: boolean;
  /** Whether a `simplefin_relink_proposals` row is persisted for the owner to act on. */
  opensProposal: boolean;
  /** Null exactly on the silent outcome. A detector that speaks on a healthy sync is a broken one. */
  headline: string | null;
  /** Goes onto `sync_run_items.recovery_action`. Null exactly on the silent outcome. */
  recoveryAction: string | null;
}

/**
 * Total over the union, so a fourth outcome that declares nothing is a compile error rather than
 * something that quietly inherits "proceed" -- which is the behaviour that caused the incident.
 */
export const RELINK_OUTCOMES: Readonly<Record<RelinkOutcome, RelinkOutcomePolicy>> = {
  none: {
    outcome: 'none',
    blocksSync: false,
    opensProposal: false,
    headline: null,
    recoveryAction: null,
  },
  relink: {
    outcome: 'relink',
    blocksSync: true,
    opensProposal: true,
    headline: 'Every SimpleFIN account arrived under a new provider id.',
    recoveryAction:
      `SimpleFIN served a full set of accounts and not one of their ids matches an account already stored, which is what re-adding every institution at the provider looks like. Syncing was stopped before it wrote anything, because proceeding would duplicate every account and zero the originals. Confirm the pairing in ${RELINK_SCREEN} to move the new ids onto the existing accounts.`,
  },
  partial: {
    outcome: 'partial',
    blocksSync: true,
    opensProposal: true,
    headline: 'Some SimpleFIN accounts arrived under ids this ledger has never seen.',
    recoveryAction:
      `SimpleFIN sent accounts under ids that do not match anything stored, while stored accounts went unmentioned. That is neither a clean re-link nor an ordinary new account, so it is not being guessed at. Syncing was stopped before it wrote anything. Review the pairing in ${RELINK_SCREEN}: adopt the pairs that are real, and dismiss the rest if these genuinely are new accounts.`,
  },
};

/** One provider account as the response carried it. `balanceCents` is null when it did not parse. */
export interface ProviderAccountSnapshot {
  id: string;
  name: string;
  institutionName: string;
  currency: string;
  /**
   * Integer cents, the MAGNITUDE the provider sent, with no liability negation applied. Comparing
   * it against a stored balance therefore has to undo that negation; see `providerFacingCents`.
   */
  balanceCents: number | null;
}

/** One stored SimpleFIN-linked account, in the cents domain the DB holds it in. */
export interface StoredAccountSnapshot {
  id: string;
  simplefinAccountId: string;
  accountName: string;
  institutionName: string;
  currency: string;
  type: string;
  /** Integer cents. Positive-as-owed for a liability, and legitimately negative in credit. */
  balanceCents: number;
  isLiability: boolean;
}

export interface RelinkDetection {
  outcome: RelinkOutcome;
  /** Provider ids that already name a stored account. */
  matchedProviderIds: string[];
  /** Provider ids naming nothing stored, minus any a resolved proposal already settled. */
  unmatchedProviderIds: string[];
  /** Provider ids naming nothing stored that a resolved proposal already settled. */
  acknowledgedProviderIds: string[];
  /** Stored accounts the response did not mention. */
  unmatchedStoredAccountIds: string[];
  storedAccountCount: number;
  providerAccountCount: number;
  /** Why this outcome and not another, in the terms actually compared. */
  reason: string;
}

/**
 * The stored SimpleFIN population, which is deliberately the same one
 * `zeroAccountsMissingFromResponse` walks.
 *
 * Hidden accounts are included. A hidden account still carries a provider id, still syncs, and is
 * still zeroed by absence, so excluding it here would let a re-link slip past detection on exactly
 * the accounts whose damage is least visible.
 */
export function readStoredSimplefinAccounts(db: Database.Database): StoredAccountSnapshot[] {
  const rows = db.prepare(`
    SELECT id, simplefin_account_id, account_name, institution_name, currency, type,
           current_balance, is_liability
    FROM accounts
    WHERE connection_type = 'simplefin' AND simplefin_account_id IS NOT NULL
    ORDER BY id
  `).all() as Array<{
    id: string;
    simplefin_account_id: string;
    account_name: string;
    institution_name: string;
    currency: string;
    type: string;
    current_balance: number;
    is_liability: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    simplefinAccountId: r.simplefin_account_id,
    accountName: r.account_name,
    institutionName: r.institution_name,
    currency: r.currency ?? 'USD',
    type: r.type,
    balanceCents: r.current_balance,
    isLiability: r.is_liability === 1,
  }));
}

/**
 * Build a snapshot entry from a raw SimpleFIN account payload.
 *
 * A balance that does not parse becomes null rather than NaN or 0. `parseFinancialAmount` in
 * simplefin.ts refuses to persist such a value for exactly the reason it must not be compared here
 * either: NaN silently loses every comparison and 0 silently wins some. The balance is only ever a
 * tiebreak, so a proposal is still worth raising without it.
 */
export function toProviderSnapshot(raw: {
  id: string;
  name: string;
  currency?: string | null;
  balance: unknown;
  org?: { name?: string | null } | null;
}): ProviderAccountSnapshot {
  const parsed = parseFloat(String(raw.balance));
  return {
    id: raw.id,
    name: raw.name,
    institutionName: raw.org?.name || 'SimpleFIN',
    currency: raw.currency || 'USD',
    balanceCents: Number.isFinite(parsed) ? toCents(parsed) : null,
  };
}

/**
 * Which of the three events this response is.
 *
 *   none     every provider id names a stored account, OR nothing SimpleFIN-linked is stored yet (a
 *            first connection is not a re-link), OR the response carries no accounts (the empty-200
 *            case `zeroAccountsMissingFromResponse` already guards), OR the only unmatched provider
 *            ids are ones a resolved proposal already settled.
 *   relink   stored accounts exist, the response carries accounts, and NOT ONE provider id matches.
 *   partial  some match and some do not, AND stored accounts went unmatched.
 *
 * The two healthy asymmetries are `none` on purpose and this is the load-bearing part. An account
 * closed at the bank stops appearing, so stored goes unmatched while every provider id still
 * matches: ordinary, already handled, silent here. A new account opened at the bank appears under
 * an id nothing stored has, while every stored account is still mentioned: also ordinary, also
 * silent. `partial` needs BOTH sides to have leftovers, which is the shape neither of those makes.
 */
export function detectSimplefinRelink(
  db: Database.Database,
  providerAccounts: ProviderAccountSnapshot[],
  storedAccounts: StoredAccountSnapshot[] = readStoredSimplefinAccounts(db)
): RelinkDetection {
  const storedIds = new Set(storedAccounts.map((a) => a.simplefinAccountId));
  const providerIds = new Set(providerAccounts.map((a) => a.id));
  const settled = settledProviderIds(db);

  const matchedProviderIds = providerAccounts.filter((a) => storedIds.has(a.id)).map((a) => a.id);
  const unmatchedProviderIds: string[] = [];
  const acknowledgedProviderIds: string[] = [];
  for (const account of providerAccounts) {
    if (storedIds.has(account.id)) continue;
    (settled.has(account.id) ? acknowledgedProviderIds : unmatchedProviderIds).push(account.id);
  }
  const unmatchedStored = storedAccounts.filter((a) => !providerIds.has(a.simplefinAccountId));
  const unmatchedStoredAccountIds = unmatchedStored.map((a) => a.id);

  const base = {
    matchedProviderIds,
    unmatchedProviderIds,
    acknowledgedProviderIds,
    unmatchedStoredAccountIds,
    storedAccountCount: storedAccounts.length,
    providerAccountCount: providerAccounts.length,
  };

  if (storedAccounts.length === 0) {
    return { ...base, outcome: 'none', reason: 'No SimpleFIN accounts are stored yet, so this is a first connection and not a re-link.' };
  }
  if (providerAccounts.length === 0) {
    return { ...base, outcome: 'none', reason: 'The response carried no accounts at all, which says nothing about the stored ones.' };
  }
  if (unmatchedProviderIds.length === 0) {
    return {
      ...base,
      outcome: 'none',
      reason: `All ${matchedProviderIds.length} provider account id(s) that could name a stored account do.`,
    };
  }
  if (matchedProviderIds.length === 0) {
    return {
      ...base,
      outcome: 'relink',
      reason: `${providerAccounts.length} provider account(s) arrived and not one of their ids matches any of the ${storedAccounts.length} stored SimpleFIN account(s).`,
    };
  }
  if (unmatchedStoredAccountIds.length === 0) {
    return {
      ...base,
      outcome: 'none',
      reason: `${unmatchedProviderIds.length} provider account id(s) are new, but every stored account was mentioned, so these are additions rather than replacements.`,
    };
  }
  return {
    ...base,
    outcome: 'partial',
    reason: `${unmatchedProviderIds.length} provider account id(s) match nothing stored while ${unmatchedStoredAccountIds.length} stored account(s) went unmentioned, and ${matchedProviderIds.length} id(s) did match.`,
  };
}

/** Provider ids a resolved proposal already ruled on. Detection must stay silent about these. */
function settledProviderIds(db: Database.Database): Set<string> {
  const rows = db.prepare(`
    SELECT acknowledged_provider_ids FROM simplefin_relink_proposals
    WHERE status <> 'pending' AND acknowledged_provider_ids IS NOT NULL
  `).all() as Array<{ acknowledged_provider_ids: string }>;
  const ids = new Set<string>();
  for (const row of rows) {
    for (const id of safeJsonParse<string[]>(row.acknowledged_provider_ids, [], 'simplefin_relink_proposals.acknowledged_provider_ids')) {
      if (typeof id === 'string') ids.add(id);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// 2. Pairing (a proposal, never an application)
// ---------------------------------------------------------------------------

export type PairEvidence =
  | 'institution_name_match'
  | 'institution_name_differs'
  | 'account_name_match'
  | 'account_number_mask_match'
  | 'account_name_similar'
  | 'currency_match'
  | 'currency_differs'
  | 'balance_match'
  | 'sole_unmatched_at_institution';

/**
 * How much the evidence carries, and nothing more. Three words, not a number: a confidence score
 * would be a figure nothing measured, and the owner would be confirming the score instead of the
 * comparison.
 */
export type PairStrength = 'exact' | 'strong' | 'inferred';

export interface RelinkPairProposal {
  storedAccountId: string;
  storedAccountName: string;
  storedInstitutionName: string;
  /** The dead provider id the stored row still holds. */
  storedSimplefinAccountId: string;
  providerAccountId: string;
  providerAccountName: string;
  providerInstitutionName: string;
  strength: PairStrength;
  evidence: PairEvidence[];
  /** The sentence the owner confirms against. It names what was compared, not how sure we are. */
  reason: string;
}

export type UnpairedReasonCode = 'no_candidate' | 'ambiguous';

export interface UnpairedStoredAccount {
  accountId: string;
  accountName: string;
  institutionName: string;
  simplefinAccountId: string;
  balanceCents: number;
  isLiability: boolean;
  reasonCode: UnpairedReasonCode;
  reason: string;
}

export interface UnpairedProviderAccount {
  providerAccountId: string;
  name: string;
  institutionName: string;
  currency: string;
  balanceCents: number | null;
  reasonCode: UnpairedReasonCode;
  reason: string;
}

export interface RelinkPairing {
  pairs: RelinkPairProposal[];
  unpairedStored: UnpairedStoredAccount[];
  unpairedProvider: UnpairedProviderAccount[];
}

/** Strip case, punctuation and repeated spaces so two renderings of one name compare equal. */
function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** The trailing account-number fragment institutions append, e.g. "Checking ...4021" -> "4021". */
function maskOf(value: string): string | null {
  const matches = value.match(/\d{3,}/g);
  return matches ? matches[matches.length - 1] : null;
}

/** A normalized name with its mask digits removed, so "Checking 4021" and "Checking" compare. */
function nameWithoutMask(value: string): string {
  return normalizeName(value.replace(/\d{3,}/g, ' '));
}

/**
 * The stored balance restated in the provider's own sign convention.
 *
 * A liability is stored positive-as-owed because `liabilityAdjustedCents` negates what SimpleFIN
 * sends. Comparing a stored $1,204.11 owed against a provider -1204.11 without undoing that would
 * make every card fail the tiebreak, and a card in credit (legitimately negative when stored) would
 * fail it in the other direction.
 */
function providerFacingCents(stored: StoredAccountSnapshot): number {
  return stored.isLiability ? -stored.balanceCents : stored.balanceCents;
}

interface CandidateEdge {
  stored: StoredAccountSnapshot;
  provider: ProviderAccountSnapshot;
  rank: number;
  strength: PairStrength;
  evidence: PairEvidence[];
  balanceMatches: boolean;
}

// Lower is stronger. The ladder is explicit rather than a weighted sum so that a pair's rank is
// readable off the evidence it lists, and so two pairs can never tie for a reason nobody can name.
const RANK_NAME = 0;              // institution + name + currency
const RANK_MASK = 1;              // institution + account-number mask + currency
const RANK_SIMILAR = 2;           // institution + one name contains the other + currency
const RANK_NAME_CCY_DIFFERS = 3;  // institution + name, but the currency changed
const RANK_SOLE = 4;              // institution + currency, and one unmatched account on each side
const RANK_RENAMED_INSTITUTION = 5; // name + currency + exact balance, institution string changed

function edgeFor(
  stored: StoredAccountSnapshot,
  provider: ProviderAccountSnapshot,
  soleAtInstitution: boolean
): CandidateEdge | null {
  const institutionMatch = normalizeName(stored.institutionName) === normalizeName(provider.institutionName);
  const nameMatch = normalizeName(stored.accountName) === normalizeName(provider.name);
  const storedMask = maskOf(stored.accountName);
  const providerMask = maskOf(provider.name);
  const maskMatch = storedMask !== null && storedMask === providerMask;
  const storedBare = nameWithoutMask(stored.accountName);
  const providerBare = nameWithoutMask(provider.name);
  const similar =
    storedBare.length >= 3 && providerBare.length >= 3 &&
    (storedBare.includes(providerBare) || providerBare.includes(storedBare));
  const currencyMatch = stored.currency === provider.currency;
  const balanceMatches =
    provider.balanceCents !== null && provider.balanceCents === providerFacingCents(stored);

  const evidence: PairEvidence[] = [];
  evidence.push(institutionMatch ? 'institution_name_match' : 'institution_name_differs');
  if (nameMatch) evidence.push('account_name_match');
  if (maskMatch) evidence.push('account_number_mask_match');
  if (!nameMatch && similar) evidence.push('account_name_similar');
  evidence.push(currencyMatch ? 'currency_match' : 'currency_differs');
  if (balanceMatches) evidence.push('balance_match');

  let rank: number | null = null;
  if (institutionMatch && nameMatch && currencyMatch) rank = RANK_NAME;
  else if (institutionMatch && maskMatch && currencyMatch) rank = RANK_MASK;
  else if (institutionMatch && similar && currencyMatch) rank = RANK_SIMILAR;
  else if (institutionMatch && nameMatch && !currencyMatch) rank = RANK_NAME_CCY_DIFFERS;
  else if (institutionMatch && currencyMatch && soleAtInstitution) {
    rank = RANK_SOLE;
    evidence.push('sole_unmatched_at_institution');
  } else if (!institutionMatch && nameMatch && currencyMatch && balanceMatches) {
    rank = RANK_RENAMED_INSTITUTION;
  }
  if (rank === null) return null;

  const strength: PairStrength = rank === RANK_NAME ? 'exact' : rank <= RANK_SIMILAR ? 'strong' : 'inferred';
  return { stored, provider, rank, strength, evidence, balanceMatches };
}

function quoted(value: string): string {
  return `"${value}"`;
}

/** The owner-facing sentence. It restates the comparison; it never asserts a likelihood. */
function describeEdge(edge: CandidateEdge, resolvedByBalance: boolean): string {
  const { stored, provider, rank } = edge;
  const parts: string[] = [];

  switch (rank) {
    case RANK_NAME:
      parts.push(
        `${provider.institutionName} sent ${quoted(provider.name)} in ${provider.currency}, and the stored account has the same institution, the same name and the same currency.`
      );
      break;
    case RANK_MASK:
      parts.push(
        `${provider.institutionName} sent ${quoted(provider.name)}, whose account number ends ${maskOf(provider.name)}, matching the stored ${quoted(stored.accountName)}. Same institution, same currency, different wording.`
      );
      break;
    case RANK_SIMILAR:
      parts.push(
        `${provider.institutionName} sent ${quoted(provider.name)}, and the stored ${quoted(stored.accountName)} is the same name with more or less of it. Same institution, same currency.`
      );
      break;
    case RANK_NAME_CCY_DIFFERS:
      parts.push(
        `${provider.institutionName} sent ${quoted(provider.name)}, the same institution and the same name as the stored account, but in ${provider.currency} where the stored account is in ${stored.currency}. The currency changing is unexplained; check it before confirming.`
      );
      break;
    case RANK_SOLE:
      parts.push(
        `${provider.institutionName} has exactly one account on each side that nothing else accounts for, both in ${provider.currency}. The names differ (${quoted(provider.name)} at the provider, ${quoted(stored.accountName)} stored), so this pairing rests on the institution alone.`
      );
      break;
    case RANK_RENAMED_INSTITUTION:
      parts.push(
        `The account name ${quoted(provider.name)}, the currency ${provider.currency} and the balance all match the stored account exactly, but the institution is now ${quoted(provider.institutionName)} where it was ${quoted(stored.institutionName)}.`
      );
      break;
  }

  if (resolvedByBalance) {
    parts.push('More than one provider account matched that well, and this is the only one whose balance matches the stored balance to the cent.');
  } else if (edge.balanceMatches && rank !== RANK_RENAMED_INSTITUTION) {
    parts.push('The balance also matches to the cent.');
  } else if (edge.provider.balanceCents === null) {
    parts.push('The provider sent a balance that did not parse as a number, so the balance was not compared.');
  } else if (!edge.balanceMatches) {
    parts.push('The balances differ, which is ordinary: the provider is reporting today and the stored figure is from the last sync that ran.');
  }

  return parts.join(' ');
}

/**
 * Propose which stored account each unmatched provider account is, and say what did not pair.
 *
 * The evidence used is the evidence the provider actually gives: institution, then account name,
 * then currency, with balance as a tiebreak ONLY. A balance is the weakest signal here by
 * construction, because the response that raises a re-link is the first one in a while and the
 * balances have moved since.
 *
 * Ambiguity is refused, not resolved. If a stored account's best candidates are two provider
 * accounts and the balance does not separate them, it pairs with neither and is reported ambiguous.
 * The same in reverse: if two stored accounts land on one provider account, both are released. An
 * account genuinely closed at the bank has no partner at all, and that outcome is available and
 * does not block the pairs that are real.
 */
export function proposeSimplefinPairing(
  providerAccounts: ProviderAccountSnapshot[],
  storedAccounts: StoredAccountSnapshot[]
): RelinkPairing {
  // Institutions where exactly one account on each side is unaccounted for. Computed over the
  // candidate population, not the whole ledger, because "the only one left" is the claim being made.
  const storedByInstitution = new Map<string, number>();
  const providerByInstitution = new Map<string, number>();
  for (const s of storedAccounts) {
    const key = normalizeName(s.institutionName);
    storedByInstitution.set(key, (storedByInstitution.get(key) ?? 0) + 1);
  }
  for (const p of providerAccounts) {
    const key = normalizeName(p.institutionName);
    providerByInstitution.set(key, (providerByInstitution.get(key) ?? 0) + 1);
  }

  const edges: CandidateEdge[] = [];
  for (const stored of storedAccounts) {
    for (const provider of providerAccounts) {
      const key = normalizeName(stored.institutionName);
      const sole =
        key === normalizeName(provider.institutionName) &&
        storedByInstitution.get(key) === 1 &&
        providerByInstitution.get(key) === 1;
      const edge = edgeFor(stored, provider, sole);
      if (edge) edges.push(edge);
    }
  }

  const ambiguousStored = new Set<string>();
  const ambiguousProvider = new Set<string>();
  const chosen = new Map<string, { edge: CandidateEdge; resolvedByBalance: boolean }>();

  // Step 1: each stored account keeps at most one candidate. Ties at the best rank are broken by an
  // exact balance match and by nothing else; if that does not leave exactly one, the account is
  // ambiguous and pairs with nobody.
  for (const stored of storedAccounts) {
    const mine = edges.filter((e) => e.stored.id === stored.id);
    if (mine.length === 0) continue;
    const bestRank = Math.min(...mine.map((e) => e.rank));
    const best = mine.filter((e) => e.rank === bestRank);
    if (best.length === 1) {
      chosen.set(stored.id, { edge: best[0], resolvedByBalance: false });
      continue;
    }
    const byBalance = best.filter((e) => e.balanceMatches);
    if (byBalance.length === 1) {
      chosen.set(stored.id, { edge: byBalance[0], resolvedByBalance: true });
      continue;
    }
    ambiguousStored.add(stored.id);
    for (const e of best) ambiguousProvider.add(e.provider.id);
  }

  // Step 2: a provider account claimed by two stored accounts releases both. Picking one would be
  // the silent decision this module exists to remove.
  const claims = new Map<string, string[]>();
  for (const [storedId, { edge }] of chosen) {
    const list = claims.get(edge.provider.id) ?? [];
    list.push(storedId);
    claims.set(edge.provider.id, list);
  }
  for (const [providerId, storedIds] of claims) {
    if (storedIds.length < 2) continue;
    ambiguousProvider.add(providerId);
    for (const storedId of storedIds) {
      ambiguousStored.add(storedId);
      chosen.delete(storedId);
    }
  }

  const pairs: RelinkPairProposal[] = [];
  for (const stored of storedAccounts) {
    const hit = chosen.get(stored.id);
    if (!hit) continue;
    pairs.push({
      storedAccountId: stored.id,
      storedAccountName: stored.accountName,
      storedInstitutionName: stored.institutionName,
      storedSimplefinAccountId: stored.simplefinAccountId,
      providerAccountId: hit.edge.provider.id,
      providerAccountName: hit.edge.provider.name,
      providerInstitutionName: hit.edge.provider.institutionName,
      strength: hit.edge.strength,
      evidence: hit.edge.evidence,
      reason: describeEdge(hit.edge, hit.resolvedByBalance),
    });
  }

  const pairedStored = new Set(pairs.map((p) => p.storedAccountId));
  const pairedProvider = new Set(pairs.map((p) => p.providerAccountId));

  const unpairedStored: UnpairedStoredAccount[] = storedAccounts
    .filter((s) => !pairedStored.has(s.id))
    .map((s) => {
      const ambiguous = ambiguousStored.has(s.id);
      return {
        accountId: s.id,
        accountName: s.accountName,
        institutionName: s.institutionName,
        simplefinAccountId: s.simplefinAccountId,
        balanceCents: s.balanceCents,
        isLiability: s.isLiability,
        reasonCode: ambiguous ? ('ambiguous' as const) : ('no_candidate' as const),
        reason: ambiguous
          ? `More than one incoming account matched ${quoted(s.accountName)} equally well and the balances did not separate them, so no pairing is being proposed. Pick one, or leave it unpaired.`
          : `No incoming account matched ${quoted(s.accountName)} at ${quoted(s.institutionName)}. If this account was closed at the bank, leaving it unpaired is the right answer.`,
      };
    });

  const unpairedProvider: UnpairedProviderAccount[] = providerAccounts
    .filter((p) => !pairedProvider.has(p.id))
    .map((p) => {
      const ambiguous = ambiguousProvider.has(p.id);
      return {
        providerAccountId: p.id,
        name: p.name,
        institutionName: p.institutionName,
        currency: p.currency,
        balanceCents: p.balanceCents,
        reasonCode: ambiguous ? ('ambiguous' as const) : ('no_candidate' as const),
        reason: ambiguous
          ? `${quoted(p.name)} matched more than one stored account equally well, so no pairing is being proposed for it.`
          : `${quoted(p.name)} at ${quoted(p.institutionName)} did not match any stored account. If this is a genuinely new account, dismissing lets the next sync add it.`,
      };
    });

  return { pairs, unpairedStored, unpairedProvider };
}

// ---------------------------------------------------------------------------
// 3. Persistence
// ---------------------------------------------------------------------------

export type RelinkProposalStatus = 'pending' | 'applied' | 'dismissed';

export interface SimplefinRelinkProposal {
  id: string;
  detectedAt: string;
  outcome: 'relink' | 'partial';
  status: RelinkProposalStatus;
  providerSnapshot: ProviderAccountSnapshot[];
  storedSnapshot: StoredAccountSnapshot[];
  pairs: RelinkPairProposal[];
  unpairedStored: UnpairedStoredAccount[];
  unpairedProvider: UnpairedProviderAccount[];
  resolvedAt: string | null;
  appliedPairs: RelinkAdoptionRecord[] | null;
  acknowledgedProviderIds: string[] | null;
  dismissedReason: string | null;
}

interface ProposalRow {
  id: string;
  detected_at: string;
  outcome: 'relink' | 'partial';
  status: RelinkProposalStatus;
  provider_snapshot: string;
  stored_snapshot: string;
  pairs: string;
  unpaired_stored: string;
  unpaired_provider: string;
  resolved_at: string | null;
  applied_pairs: string | null;
  acknowledged_provider_ids: string | null;
  dismissed_reason: string | null;
}

function hydrate(row: ProposalRow): SimplefinRelinkProposal {
  const ctx = 'simplefin_relink_proposals';
  return {
    id: row.id,
    detectedAt: row.detected_at,
    outcome: row.outcome,
    status: row.status,
    providerSnapshot: safeJsonParse<ProviderAccountSnapshot[]>(row.provider_snapshot, [], `${ctx}.provider_snapshot`),
    storedSnapshot: safeJsonParse<StoredAccountSnapshot[]>(row.stored_snapshot, [], `${ctx}.stored_snapshot`),
    pairs: safeJsonParse<RelinkPairProposal[]>(row.pairs, [], `${ctx}.pairs`),
    unpairedStored: safeJsonParse<UnpairedStoredAccount[]>(row.unpaired_stored, [], `${ctx}.unpaired_stored`),
    unpairedProvider: safeJsonParse<UnpairedProviderAccount[]>(row.unpaired_provider, [], `${ctx}.unpaired_provider`),
    resolvedAt: row.resolved_at,
    appliedPairs: row.applied_pairs === null ? null : safeJsonParse<RelinkAdoptionRecord[]>(row.applied_pairs, [], `${ctx}.applied_pairs`),
    acknowledgedProviderIds: row.acknowledged_provider_ids === null
      ? null
      : safeJsonParse<string[]>(row.acknowledged_provider_ids, [], `${ctx}.acknowledged_provider_ids`),
    dismissedReason: row.dismissed_reason,
  };
}

/**
 * The provider ids this proposal is actually asking about: the ones it proposed a home for, plus
 * the ones it could not place.
 *
 * NOT every id in `provider_snapshot`. On a `partial` outcome the snapshot also carries the ids
 * that matched a stored account perfectly and were never in question, and acknowledging those
 * would record a decision the owner was never asked to make.
 */
function providerIdsInQuestion(proposal: SimplefinRelinkProposal): Set<string> {
  return new Set([
    ...proposal.pairs.map((p) => p.providerAccountId),
    ...proposal.unpairedProvider.map((u) => u.providerAccountId),
  ]);
}

/** The stored accounts this proposal is asking about, by the same rule. */
function storedIdsInQuestion(proposal: SimplefinRelinkProposal): Set<string> {
  return new Set([
    ...proposal.pairs.map((p) => p.storedAccountId),
    ...proposal.unpairedStored.map((u) => u.accountId),
  ]);
}

const SELECT_PROPOSAL = `
  SELECT id, detected_at, outcome, status, provider_snapshot, stored_snapshot, pairs,
         unpaired_stored, unpaired_provider, resolved_at, applied_pairs,
         acknowledged_provider_ids, dismissed_reason
  FROM simplefin_relink_proposals
`;

export function getPendingRelinkProposal(db: Database.Database): SimplefinRelinkProposal | null {
  const row = db.prepare(`${SELECT_PROPOSAL} WHERE status = 'pending'`).get() as ProposalRow | undefined;
  return row ? hydrate(row) : null;
}

export function getRelinkProposal(db: Database.Database, id: string): SimplefinRelinkProposal | null {
  const row = db.prepare(`${SELECT_PROPOSAL} WHERE id = ?`).get(id) as ProposalRow | undefined;
  return row ? hydrate(row) : null;
}

export function listRelinkProposals(db: Database.Database, limit = 20): SimplefinRelinkProposal[] {
  const rows = db.prepare(`${SELECT_PROPOSAL} ORDER BY detected_at DESC, id DESC LIMIT ?`).all(limit) as ProposalRow[];
  return rows.map(hydrate);
}

// ---------------------------------------------------------------------------
// 4. The sync guard
// ---------------------------------------------------------------------------

export interface RelinkSyncBlock {
  proposalId: string;
  outcome: 'relink' | 'partial';
  detectedAt: string;
  headline: string;
  /** Goes onto `sync_run_items.recovery_action`. */
  recoveryAction: string;
  /**
   * What the stage should be recorded as. NOT 'failed': the provider answered, the response parsed,
   * and nothing went wrong at SimpleFIN, so claiming a failure would be a claim nothing checked.
   * NOT 'reauth_required' either: no login has expired. The run wrote nothing and needs the owner,
   * which is 'skipped' carrying a recovery action that names where to go.
   */
  syncRunItemStatus: 'skipped';
  errorCode: 'simplefin_relink_pending';
  pairCount: number;
  unpairedStoredCount: number;
  unpairedProviderCount: number;
}

export type RelinkGuardResult =
  | { proceed: true; clearedProposalId: string | null }
  | { proceed: false; block: RelinkSyncBlock };

function blockFor(proposal: SimplefinRelinkProposal): RelinkSyncBlock {
  const policy = RELINK_OUTCOMES[proposal.outcome];
  return {
    proposalId: proposal.id,
    outcome: proposal.outcome,
    detectedAt: proposal.detectedAt,
    // Non-null by construction: `relink` and `partial` both declare copy in RELINK_OUTCOMES, and
    // `none` is the only entry that declares null and is never persisted.
    headline: policy.headline as string,
    recoveryAction: policy.recoveryAction as string,
    syncRunItemStatus: 'skipped',
    errorCode: 'simplefin_relink_pending',
    pairCount: proposal.pairs.length,
    unpairedStoredCount: proposal.unpairedStored.length,
    unpairedProviderCount: proposal.unpairedProvider.length,
  };
}

/**
 * The one call the sync makes, after the response is parsed and BEFORE anything writes.
 *
 * `proceed: false` means syncSimplefin must write nothing at all: no account insert, no account
 * update, no transaction, no holding, and above all no zeroing. Zeroing is the half that turned a
 * duplicate-accounts bug into a wrong balance sheet on 2026-08-01: it runs off absence from the
 * response, which is exactly what a re-link manufactures, so the nine rows holding the history read
 * zero while nine new rows held the money. No figure is quoted for the size of that, because the one
 * this comment used to carry did not reproduce from any query.
 *
 * Three states, and the third is the one detectors usually get wrong:
 *
 *   - a proposal is already pending and the response still shows the condition: keep blocking, and
 *     refresh the pending row against the response actually in hand, so the owner is never asked to
 *     confirm a pairing computed against a response that has since changed.
 *   - a proposal is already pending and the condition has CLEARED: resolve it and proceed. A finding
 *     that outlives its cause is a standing finding the owner cannot act on. It is recorded as
 *     dismissed with the reason, not deleted, so the audit trail keeps it.
 *   - no proposal and the condition is present: open one and block.
 */
export function guardSimplefinRelink(
  db: Database.Database,
  providerAccounts: ProviderAccountSnapshot[],
  now: string
): RelinkGuardResult {
  const storedAccounts = readStoredSimplefinAccounts(db);
  const detection = detectSimplefinRelink(db, providerAccounts, storedAccounts);
  const pending = getPendingRelinkProposal(db);

  if (!RELINK_OUTCOMES[detection.outcome].blocksSync) {
    if (!pending) return { proceed: true, clearedProposalId: null };
    db.prepare(`
      UPDATE simplefin_relink_proposals
      SET status = 'dismissed', resolved_at = ?, acknowledged_provider_ids = '[]', dismissed_reason = ?
      WHERE id = ?
    `).run(now, `Resolved automatically: the condition cleared. ${detection.reason}`, pending.id);
    return { proceed: true, clearedProposalId: pending.id };
  }

  const pairing = proposeSimplefinPairing(
    providerAccounts.filter((p) => detection.unmatchedProviderIds.includes(p.id)),
    storedAccounts.filter((s) => detection.unmatchedStoredAccountIds.includes(s.id))
  );

  const id = pending?.id ?? uuidv4();
  const values = [
    detection.outcome,
    JSON.stringify(providerAccounts),
    JSON.stringify(storedAccounts),
    JSON.stringify(pairing.pairs),
    JSON.stringify(pairing.unpairedStored),
    JSON.stringify(pairing.unpairedProvider),
  ];

  if (pending) {
    db.prepare(`
      UPDATE simplefin_relink_proposals
      SET detected_at = ?, outcome = ?, provider_snapshot = ?, stored_snapshot = ?, pairs = ?,
          unpaired_stored = ?, unpaired_provider = ?
      WHERE id = ?
    `).run(now, ...values, id);
  } else {
    db.prepare(`
      INSERT INTO simplefin_relink_proposals
        (id, detected_at, outcome, status, provider_snapshot, stored_snapshot, pairs,
         unpaired_stored, unpaired_provider)
      VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)
    `).run(id, now, ...values);
  }

  const proposal = getRelinkProposal(db, id);
  if (!proposal) throw new Error(`Wrote relink proposal ${id} and could not read it back.`);
  return { proceed: false, block: blockFor(proposal) };
}

// ---------------------------------------------------------------------------
// 5. Adoption
// ---------------------------------------------------------------------------

export interface RelinkAdoptionRequest {
  storedAccountId: string;
  providerAccountId: string;
}

export type RelinkAdoptionOutcome = 'adopted' | 'already_adopted';

export interface RelinkAdoptionRecord {
  storedAccountId: string;
  providerAccountId: string;
  /** The dead id the row was carrying. Null only if the row somehow had none. */
  previousSimplefinAccountId: string | null;
  outcome: RelinkAdoptionOutcome;
}

export type AdoptRelinkRefusal =
  | 'proposal_not_found'
  | 'proposal_not_pending'
  | 'unknown_stored_account'
  | 'stored_account_not_simplefin'
  | 'provider_account_not_in_snapshot'
  | 'duplicate_stored_account'
  | 'duplicate_provider_account'
  | 'contested_provider_id';

export type AdoptRelinkResult =
  | {
      ok: true;
      proposalId: string;
      adoptions: RelinkAdoptionRecord[];
      /** Stored accounts the proposal listed that this call deliberately did not pair. */
      leftUnpairedStoredAccountIds: string[];
      /** Provider ids from the snapshot no account adopted. The next sync may add these as new. */
      leftUnpairedProviderAccountIds: string[];
    }
  | { ok: false; reason: AdoptRelinkRefusal; message: string; details: string[] };

/**
 * Move confirmed provider ids onto the existing account rows, and resolve the proposal.
 *
 * WHAT MOVES: `accounts.simplefin_account_id`, and `updated_at` because the row did change. Nothing
 * else. Not `account_name`, not `type`, not `type_source`, not `name_source`, and not
 * `backfill_floor_date`. Those five are the whole reason adoption exists rather than a merge: on
 * 2026-08-01 nine freshly created rows carried none of them, FIVE accounts were re-guessed by
 * `guessAccountTypeAndLiability` (nine less the four carrying `type_source = 'manual'`), two credit
 * cards came back as checking, and the transactions stayed on the rows that got zeroed.
 *
 * ALL OR NOTHING. Every request is validated before anything is written, and the writes run in one
 * transaction. A batch that is half applied would leave the ledger in a state neither the proposal
 * nor the response describes, and the proposal would be gone.
 *
 * RELEASE BEFORE CLAIMING. `simplefin_account_id` is UNIQUE and SQLite has no deferred constraints,
 * which `mergeAccounts` had to learn the hard way. Every row in the batch drops its old id first,
 * so a batch that rotates ids among the accounts already in it cannot collide with itself.
 *
 * A CONTESTED ID IS REFUSED, NEVER TAKEN. If a row OUTSIDE the batch already holds the requested
 * id, that row is the one the provider is currently talking to, and quietly releasing it to hand
 * the id elsewhere is a silent decision about which of two accounts is real.
 *
 * IDEMPOTENT. Re-confirming a pairing already applied is not an error and writes nothing: the row
 * already holds the id, and the adoption is recorded as `already_adopted`.
 */
export function adoptRelinkPairs(
  db: Database.Database,
  proposalId: string,
  requests: RelinkAdoptionRequest[],
  now: string
): AdoptRelinkResult {
  const proposal = getRelinkProposal(db, proposalId);
  if (!proposal) {
    return { ok: false, reason: 'proposal_not_found', message: `No re-link proposal with id ${proposalId}.`, details: [] };
  }
  if (proposal.status !== 'pending') {
    return {
      ok: false,
      reason: 'proposal_not_pending',
      message: `Re-link proposal ${proposalId} was already ${proposal.status} at ${proposal.resolvedAt}.`,
      details: [],
    };
  }

  const seenStored = new Set<string>();
  const seenProvider = new Set<string>();
  for (const req of requests) {
    if (seenStored.has(req.storedAccountId)) {
      return {
        ok: false,
        reason: 'duplicate_stored_account',
        message: 'One account cannot adopt two provider ids in the same confirmation.',
        details: [req.storedAccountId],
      };
    }
    if (seenProvider.has(req.providerAccountId)) {
      return {
        ok: false,
        reason: 'duplicate_provider_account',
        message: 'One provider id cannot be adopted by two accounts in the same confirmation.',
        details: [req.providerAccountId],
      };
    }
    seenStored.add(req.storedAccountId);
    seenProvider.add(req.providerAccountId);
  }

  const snapshotIds = new Set(proposal.providerSnapshot.map((p) => p.id));
  const accountRow = db.prepare(
    'SELECT id, connection_type, simplefin_account_id FROM accounts WHERE id = ?'
  );
  const holderOf = db.prepare(
    'SELECT id FROM accounts WHERE simplefin_account_id = ?'
  );

  const planned: RelinkAdoptionRecord[] = [];
  for (const req of requests) {
    if (!snapshotIds.has(req.providerAccountId)) {
      return {
        ok: false,
        reason: 'provider_account_not_in_snapshot',
        message: `Provider account ${req.providerAccountId} is not one of the accounts this proposal recorded, so there is no evidence behind adopting it.`,
        details: [req.providerAccountId],
      };
    }
    const account = accountRow.get(req.storedAccountId) as
      | { id: string; connection_type: string; simplefin_account_id: string | null }
      | undefined;
    if (!account) {
      return {
        ok: false,
        reason: 'unknown_stored_account',
        message: `No account with id ${req.storedAccountId}.`,
        details: [req.storedAccountId],
      };
    }
    if (account.connection_type !== 'simplefin') {
      return {
        ok: false,
        reason: 'stored_account_not_simplefin',
        message: `Account ${req.storedAccountId} is a ${account.connection_type} account. Adopting a SimpleFIN id onto it would change what kind of account it is, which is a different operation from adoption.`,
        details: [req.storedAccountId],
      };
    }
    const holder = holderOf.get(req.providerAccountId) as { id: string } | undefined;
    if (holder && holder.id !== req.storedAccountId && !seenStored.has(holder.id)) {
      return {
        ok: false,
        reason: 'contested_provider_id',
        message: `Provider account ${req.providerAccountId} is already held by account ${holder.id}. Adoption will not take an id off another account.`,
        details: [req.providerAccountId, holder.id],
      };
    }
    planned.push({
      storedAccountId: req.storedAccountId,
      providerAccountId: req.providerAccountId,
      previousSimplefinAccountId: account.simplefin_account_id,
      outcome: account.simplefin_account_id === req.providerAccountId ? 'already_adopted' : 'adopted',
    });
  }

  const adoptedProviderIds = new Set(planned.map((p) => p.providerAccountId));
  const adoptedStoredIds = new Set(planned.map((p) => p.storedAccountId));
  // Every id that was in question is ruled on by this call, including one the owner deliberately
  // left unpaired: that is a decision, and an unrecorded decision is re-asked on the next sync.
  const acknowledged = [...new Set([...providerIdsInQuestion(proposal), ...adoptedProviderIds])];
  const leftUnpairedProviderAccountIds = acknowledged.filter((id) => !adoptedProviderIds.has(id));
  const leftUnpairedStoredAccountIds = [...storedIdsInQuestion(proposal)].filter(
    (id) => !adoptedStoredIds.has(id)
  );

  db.transaction(() => {
    // Release every id in the batch before any of them is claimed. Same lesson mergeAccounts
    // records: UNIQUE plus no deferred constraints means a rotation inside the batch throws
    // mid-statement unless the old ids are gone first.
    const release = db.prepare('UPDATE accounts SET simplefin_account_id = NULL, updated_at = ? WHERE id = ?');
    for (const record of planned) {
      if (record.outcome === 'already_adopted') continue;
      release.run(now, record.storedAccountId);
    }
    const claim = db.prepare('UPDATE accounts SET simplefin_account_id = ?, updated_at = ? WHERE id = ?');
    for (const record of planned) {
      if (record.outcome === 'already_adopted') continue;
      claim.run(record.providerAccountId, now, record.storedAccountId);
    }
    db.prepare(`
      UPDATE simplefin_relink_proposals
      SET status = 'applied', resolved_at = ?, applied_pairs = ?, acknowledged_provider_ids = ?
      WHERE id = ?
    `).run(now, JSON.stringify(planned), JSON.stringify(acknowledged), proposalId);
  })();

  return {
    ok: true,
    proposalId,
    adoptions: planned,
    leftUnpairedStoredAccountIds,
    leftUnpairedProviderAccountIds,
  };
}

export type DismissRelinkResult =
  | { ok: true; proposalId: string; acknowledgedProviderIds: string[] }
  | { ok: false; reason: 'proposal_not_found' | 'proposal_not_pending'; message: string };

/**
 * The owner's answer that these really are new accounts: stop asking, and let the sync run.
 *
 * The ids are recorded rather than the decision being merely forgotten. Without that record the
 * very next sync would see the same unmatched ids, raise the same proposal and block again, which
 * is a standing finding the owner has already acted on and has no way to clear. Detection reads
 * `acknowledged_provider_ids` off resolved rows and stays silent about them.
 *
 * Note what this does NOT do: the stored accounts left behind keep their dead provider ids and stay
 * absent from the response, so `zeroAccountsMissingFromResponse` will zero them on the next sync.
 * That is the correct reading of "these are new accounts and the old ones are gone", and it is the
 * owner's stated decision rather than an inference.
 */
export function dismissRelinkProposal(
  db: Database.Database,
  proposalId: string,
  reason: string,
  now: string
): DismissRelinkResult {
  const proposal = getRelinkProposal(db, proposalId);
  if (!proposal) {
    return { ok: false, reason: 'proposal_not_found', message: `No re-link proposal with id ${proposalId}.` };
  }
  if (proposal.status !== 'pending') {
    return {
      ok: false,
      reason: 'proposal_not_pending',
      message: `Re-link proposal ${proposalId} was already ${proposal.status} at ${proposal.resolvedAt}.`,
    };
  }
  const acknowledged = [...providerIdsInQuestion(proposal)];
  db.prepare(`
    UPDATE simplefin_relink_proposals
    SET status = 'dismissed', resolved_at = ?, acknowledged_provider_ids = ?, dismissed_reason = ?
    WHERE id = ?
  `).run(now, JSON.stringify(acknowledged), reason, proposalId);
  return { ok: true, proposalId, acknowledgedProviderIds: acknowledged };
}

// ---------------------------------------------------------------------------
// 6. The API edge
// ---------------------------------------------------------------------------

/**
 * Cents in, dollars out, converted exactly once, at the boundary the client reads.
 *
 * The proposal is stored in cents because everything in this schema is, and the balances travel
 * inside JSON snapshots rather than columns. This is the only place they are divided.
 */
export function toRelinkProposalView(proposal: SimplefinRelinkProposal): SimplefinRelinkProposalView {
  const policy = RELINK_OUTCOMES[proposal.outcome];
  const provider: SimplefinRelinkProviderAccountView[] = proposal.providerSnapshot.map((p) => ({
    provider_account_id: p.id,
    name: p.name,
    institution_name: p.institutionName,
    currency: p.currency,
    balance: toDollarsOrNull(p.balanceCents),
  }));
  const stored: SimplefinRelinkStoredAccountView[] = proposal.storedSnapshot.map((s) => ({
    account_id: s.id,
    simplefin_account_id: s.simplefinAccountId,
    account_name: s.accountName,
    institution_name: s.institutionName,
    currency: s.currency,
    type: s.type,
    balance: toDollars(s.balanceCents),
    is_liability: s.isLiability,
  }));
  const pairs: SimplefinRelinkPairView[] = proposal.pairs.map((p) => ({
    stored_account_id: p.storedAccountId,
    stored_account_name: p.storedAccountName,
    stored_institution_name: p.storedInstitutionName,
    stored_simplefin_account_id: p.storedSimplefinAccountId,
    provider_account_id: p.providerAccountId,
    provider_account_name: p.providerAccountName,
    provider_institution_name: p.providerInstitutionName,
    strength: p.strength,
    evidence: p.evidence,
    reason: p.reason,
  }));
  const unpairedStored: SimplefinRelinkUnpairedStoredView[] = proposal.unpairedStored.map((u) => ({
    account_id: u.accountId,
    account_name: u.accountName,
    institution_name: u.institutionName,
    simplefin_account_id: u.simplefinAccountId,
    balance: toDollars(u.balanceCents),
    is_liability: u.isLiability,
    reason_code: u.reasonCode,
    reason: u.reason,
  }));
  const unpairedProvider: SimplefinRelinkUnpairedProviderView[] = proposal.unpairedProvider.map((u) => ({
    provider_account_id: u.providerAccountId,
    name: u.name,
    institution_name: u.institutionName,
    currency: u.currency,
    balance: toDollarsOrNull(u.balanceCents),
    reason_code: u.reasonCode,
    reason: u.reason,
  }));

  return {
    id: proposal.id,
    detected_at: proposal.detectedAt,
    outcome: proposal.outcome,
    status: proposal.status,
    headline: policy.headline as string,
    recovery_action: policy.recoveryAction as string,
    resolve_on: RELINK_SCREEN,
    resolve_on_path: RELINK_SCREEN_PATH,
    provider_accounts: provider,
    stored_accounts: stored,
    pairs,
    unpaired_stored: unpairedStored,
    unpaired_provider: unpairedProvider,
    resolved_at: proposal.resolvedAt,
    applied_pairs: proposal.appliedPairs === null ? null : proposal.appliedPairs.map((a) => ({
      stored_account_id: a.storedAccountId,
      provider_account_id: a.providerAccountId,
      previous_simplefin_account_id: a.previousSimplefinAccountId,
      outcome: a.outcome,
    })),
    dismissed_reason: proposal.dismissedReason,
  };
}
