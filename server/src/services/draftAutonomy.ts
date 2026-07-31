import type { AdvisorDraftActionKind } from '../../../shared/types';

/**
 * Which model-authored writes land without the owner, and the argument for each one.
 *
 * WHY THIS IS A TABLE AND NOT A SET. It used to be `new Set(['categorize_transaction',
 * 'create_merchant_rule'])`. Adding a kind to a set is one line and costs its author nothing: no
 * argument, no reason, no confrontation with the boundary. Worse, a set says nothing about the
 * kinds outside it, so a NEW draft kind was proposal-only by accident rather than by decision, and
 * the two facts read identically.
 *
 * Every kind now declares its own autonomy with the reasoning attached, and the autonomous set is
 * DERIVED from that. Two properties follow, and both are enforced by the compiler rather than by a
 * reviewer noticing:
 *
 *  - The declaration is a `Record` over the whole `AdvisorDraftActionKind` union, so a new kind
 *    that declares nothing is a type error. It cannot default into autonomy by omission, and it
 *    cannot default OUT of the argument either.
 *  - A proposal-only kind must name the criterion it fails. "Not autonomous" without a reason is
 *    exactly the state a future contributor deletes because nothing in the repo defends it.
 *
 * THE BOUNDARY, in the owner's words: a write earns autonomy when it is an observation about data
 * that already exists, has an exact mechanical inverse, has a bounded and enumerable blast radius,
 * and does not overwrite a number the owner set.
 *
 * This replaces a self-reported `confidence >= 0.9` gate. That number was written by the model,
 * about the model, in the same JSON blob as the change it was proposing, which makes it a boundary
 * the model asserts rather than one the owner set.
 */

export type DraftAutonomy = 'autonomous' | 'proposal_only';

/** The four tests a write has to pass. A proposal-only kind names the ones it fails. */
export type AutonomyCriterion =
  /** It reports something already true of stored data rather than deciding something new. */
  | 'observation'
  /** Undo by action id restores the exact prior state, from a record, not a reconstruction. */
  | 'exact_inverse'
  /** What it touches can be listed before it runs, and the list is small. */
  | 'bounded_radius'
  /** It does not replace a figure or a target the owner chose. */
  | 'not_owner_number';

interface AutonomousDeclaration {
  autonomy: 'autonomous';
  /** How all four criteria are met, naming the code that enforces each. */
  argument: string;
}

interface ProposalOnlyDeclaration {
  autonomy: 'proposal_only';
  /** Every criterion this write fails today. Never empty. */
  fails: readonly AutonomyCriterion[];
  argument: string;
  /**
   * Fixed proposal-only by the owner, not by the state of the code.
   *
   * The other proposal-only kinds fail a criterion that infrastructure could in principle close.
   * These do not: the principle behind the carve-out is that the AI never overwrites a number the
   * owner set, and no amount of provenance changes what the write IS.
   */
  ownerCarveOut?: true;
}

export type DraftAutonomyDeclaration = AutonomousDeclaration | ProposalOnlyDeclaration;

export const DRAFT_KIND_AUTONOMY: Readonly<Record<AdvisorDraftActionKind, DraftAutonomyDeclaration>> = {
  categorize_transaction: {
    autonomy: 'autonomous',
    argument:
      'Reading a merchant name and saying what it is, about a row that already exists. The inverse '
      + 'is exact and recorded: every write appends to transaction_category_revisions with the prior '
      + 'category AND the prior source, and undoAdvisorAction replays it by action id. The radius is '
      + 'one row. partitionByAuthorship refuses any row the owner categorized by hand, and the '
      + 'proposal pool excludes rows whose category_source is NULL, because migration 041 says NULL '
      + 'means the author was never recorded, not that a machine wrote it. The pool also excludes '
      + 'every row that already carries a category revision the model wrote, so the model gets one '
      + 'answer per row and never re-litigates it. Reading category_source alone did not hold that: '
      + '"Re-check all transactions" (recategorizeAll) and undoAdvisorAction both restore a refiled '
      + 'row to category_source = \'rule\', which handed it straight back to the pool and had the '
      + 'next hourly pass reverse an action the owner had just taken.',
  },

  create_merchant_rule: {
    autonomy: 'autonomous',
    argument:
      'A standing statement about a merchant the ledger already carries. Rows it sweeps in are '
      + 'stamped with the action id, so one undo takes back the whole blast radius, and that radius '
      + 'is counted BEFORE the write by countMerchantRuleImpact and capped by checkBlastRadius. '
      + 'checkRuleDoesNotContradictOwnerRule and checkRuleAgreesWithHistory keep it off the owner\'s '
      + 'own rules and off settled history, and applyMerchantRuleToMatchingTransactions skips every '
      + 'hand-categorized row.',
  },

  retire_merchant_rule: {
    autonomy: 'autonomous',
    argument:
      'Taking back one of the model\'s OWN rules. checkRuleIsRetirableByAi refuses any rule the '
      + 'owner wrote and any rule that currently holds a transaction, so the radius is exactly zero '
      + 'rows and is proved zero before the write rather than after. retireMerchantRule appends a '
      + '\'retire\' row to merchant_rule_revisions carrying the action id, and undoAdvisorAction '
      + 'un-retires from that record. Nothing the owner set is touched: an owner rule is out of '
      + 'scope by the guard, and retiring an AI rule that holds nothing changes no category. Its '
      + 'reach into rows that do not exist yet is the same reach create_merchant_rule already has '
      + 'and is bounded the same way: the rule stays visible and restorable in Settings, and every '
      + 'change to it is a revision row.',
  },

  update_budget: {
    autonomy: 'proposal_only',
    ownerCarveOut: true,
    fails: ['observation', 'not_owner_number'],
    argument:
      'A budget is a target the owner chose. The model can see what was spent; it cannot see why '
      + 'the number is what it is, and rewriting it is a decision rather than an observation.',
  },

  update_goal_target: {
    autonomy: 'proposal_only',
    ownerCarveOut: true,
    fails: ['observation', 'not_owner_number'],
    argument:
      'A goal target is the owner\'s intention stated as a number. Nothing in the ledger makes it '
      + 'true or false, so there is no observation to make about it.',
  },

  set_manual_cost_basis: {
    autonomy: 'proposal_only',
    ownerCarveOut: true,
    fails: ['observation', 'not_owner_number'],
    argument:
      'A manual cost basis exists precisely because the provider did not report one and the owner '
      + 'supplied it. It is the owner\'s figure by construction, and it feeds every gain the '
      + 'Investments screen reports.',
  },

  confirm_recurring: {
    autonomy: 'proposal_only',
    fails: ['exact_inverse'],
    argument:
      'The observation is sound and the radius is one recurring_patterns row: at four or more '
      + 'occurrences the cadence is a fact about rows that already exist, and buildRecurringForecast '
      + 'already includes a pattern at three or more regardless of is_confirmed, so confirming moves '
      + 'neither the scheduled net the conservation guard reads nor the income and bills totals it '
      + 'is made of. Those three are the whole of what was checked, and the claim used to be wider '
      + 'than that. What confirming DOES move is which confidence bucket the occurrence is counted '
      + 'in, because forecastBucket reads is_confirmed directly: likely_bills becomes '
      + 'confirmed_bills. review_count happens not to move, and not for a reason worth leaning on: '
      + 'an unconfirmed pattern only reaches the forecast at three occurrences or more, which puts '
      + 'its label at \'likely\', and needs_review is already false there. Proposal-only, so nothing '
      + 'acts on any of it. It fails on the inverse. Nothing records that the model set is_confirmed, '
      + 'so an undo would flip it back with no way to tell whether the owner had confirmed it in the '
      + 'meantime. That is the single-slot scheme migration 042 replaced for categories, and it is '
      + 'not worth re-introducing for this. A revision log for the field is what this needs, not a '
      + 'wider set.',
  },

  set_sector_metadata: {
    autonomy: 'proposal_only',
    fails: ['exact_inverse', 'not_owner_number'],
    argument:
      'A security\'s sector is a public fact and the radius is one securities row, so two criteria '
      + 'hold. setSecurityMetadata writes sector and sector_source with no record of what they held, '
      + 'so undoAdvisorAction cannot reach it and the digest has nothing to show. It also overwrites '
      + 'sector_source = \'manual\', which is the owner\'s own entry, and the column carries no way '
      + 'to refuse that without also refusing every legitimate first write.',
  },

  create_recurring_adjustment: {
    autonomy: 'proposal_only',
    fails: ['observation'],
    argument:
      'Skipping, snoozing or repricing an occurrence is a statement about what will happen next '
      + 'month, not a report about what the ledger holds. It also changes the scheduled-net headline '
      + 'the conservation guard treats as invariant, which is the figure the owner plans against.',
  },

  create_budget_group: {
    autonomy: 'proposal_only',
    fails: ['observation'],
    argument:
      'A budget group is how the owner wants their own budgets arranged. There is no fact in the '
      + 'ledger that makes one arrangement right.',
  },

  rename_budget_group: {
    autonomy: 'proposal_only',
    fails: ['observation'],
    argument: 'Renaming the owner\'s own label for their own grouping is not an observation about data.',
  },

  assign_category_to_budget_group: {
    autonomy: 'proposal_only',
    fails: ['observation'],
    argument:
      'Moving a category between groups rearranges the owner\'s view of their budgets, and it '
      + 'silently removes the category from whatever group held it before.',
  },
};

/**
 * Writes inside the owner's carve-out that have no draft kind today.
 *
 * Recorded here so the carve-out is complete rather than only as complete as the current union. If
 * one of these ever becomes a draft kind, the `Record` above forces it to declare, and this list is
 * what a test reads to insist the declaration is proposal-only.
 */
export const CARVE_OUT_WRITES_WITHOUT_A_DRAFT_KIND = [
  'merge_category',
  'delete_category',
  'reparent_category',
] as const;

function kinds(): AdvisorDraftActionKind[] {
  return Object.keys(DRAFT_KIND_AUTONOMY) as AdvisorDraftActionKind[];
}

/** Derived, never hand-listed. The declarations above are the only place autonomy is decided. */
export const AUTONOMOUS_DRAFT_KINDS: ReadonlySet<AdvisorDraftActionKind> = new Set(
  kinds().filter((kind) => DRAFT_KIND_AUTONOMY[kind].autonomy === 'autonomous')
);

/** The kinds the owner fixed as proposal-only. Derived from the same table for the same reason. */
export const OWNER_CARVE_OUT_KINDS: ReadonlySet<AdvisorDraftActionKind> = new Set(
  kinds().filter((kind) => {
    const declaration = DRAFT_KIND_AUTONOMY[kind];
    return declaration.autonomy === 'proposal_only' && declaration.ownerCarveOut === true;
  })
);

export function isAutonomousDraftKind(kind: string): boolean {
  return AUTONOMOUS_DRAFT_KINDS.has(kind as AdvisorDraftActionKind);
}

export function draftAutonomyDeclaration(kind: string): DraftAutonomyDeclaration | null {
  return DRAFT_KIND_AUTONOMY[kind as AdvisorDraftActionKind] ?? null;
}

/**
 * The sentence the worker's prompt uses to tell the model which of ITS OWN allowed kinds apply
 * unattended.
 *
 * Generated from the table rather than written beside it. The prompt, the structured-output schema
 * and the enforced set were three lists that could disagree, and the one that decides is the set:
 * a model told it may apply a kind that queues will hedge on a proposal it should have made, and a
 * model told a kind queues when it applies will phrase a done thing as a suggestion.
 */
export function describeAutonomyForPrompt(allowedKinds: readonly AdvisorDraftActionKind[]): string {
  const applies = allowedKinds.filter((kind) => isAutonomousDraftKind(kind));
  const queues = allowedKinds.filter((kind) => !isAutonomousDraftKind(kind));
  const list = (values: readonly string[]): string => values.map((value) => `'${value}'`).join(', ');

  if (applies.length === 0) {
    return `Every kind you may emit (${list(queues)}) waits for the user to confirm it.`;
  }
  if (queues.length === 0) {
    return `Every kind you may emit (${list(applies)}) is APPLIED IMMEDIATELY, with no human review.`;
  }
  return `${list(applies)} drafts are APPLIED IMMEDIATELY, with no human review. Every other kind you may emit (${list(queues)}) waits for the user to confirm it.`;
}
