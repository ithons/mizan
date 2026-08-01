import { memo } from 'react';
import type { RecurringForecastOccurrence } from '@shared/types';
import { formatCurrency } from '../../lib/formatters';
import { CategoryPicker, CategoryPill } from '../../components/balance';
import {
  FLAG_LABEL,
  PROVENANCE_LABEL,
  isSetAside,
  occurrenceAmount,
  occurrenceMeta,
  proposedCategoryId,
  readDirection,
  readFlags,
  readProvenance,
  sameLedgerRow,
  type LedgerRowHandlers,
  type LedgerRowProps,
} from './spine';

/**
 * The two row shapes on the ledger, kept identical in geometry and different in ink.
 *
 * That is the whole argument for merging Bills into this screen: a scheduled item and a posted
 * entry are the same kind of thing at different distances from now, so they get the same columns,
 * the same alignment and the same day heading, and the estimate colour is what says which one you
 * are looking at. A different card on a different screen said "these are different kinds of fact",
 * which is how a forecast gets read as a fact.
 *
 * The claim used to be false in two ways the eye catches immediately. The scheduled row carried a
 * trailing Skip/Undo column the posted row did not, so the amount column's right edge sat 64px
 * further left above the rule than below it. And the fixed metadata column held the ACCOUNT below
 * the rule and the CATEGORY above it, two different facts stacked in one column with no header on
 * either half to say so. Both are fixed by `LEDGER_COLUMNS` below, and
 * `tests/ledgerGeometry.test.ts` walks the element tree each row returns and fails if they drift
 * apart again.
 */

/**
 * The five columns, declared once.
 *
 * Every row and the header take their widths from here, so "identical geometry both sides" is a
 * property of the markup rather than of two literals that happened to agree the day they were
 * written. `data-col` names each one, which is what the geometry test walks.
 */
export const LEDGER_COLUMNS = {
  select: 'mr-3 h-[14px] w-[14px] flex-shrink-0',
  entry: 'min-w-0 flex-1 pr-3',
  /** Category, on BOTH sides of the rule: it is the one field a forecast and a posting both have. */
  category: 'hidden w-[130px] flex-shrink-0 md:block',
  amount: 'w-[110px] flex-shrink-0 text-right',
  /**
   * Take it off the list, or put it back. Skip/Undo above the rule, Set aside/Undo below, which is
   * the same verb at two distances from now. It used to be rendered empty below the rule, which is
   * what put the two amount columns' right edges apart.
   *
   * 72px rather than the 52px that held Skip alone: "Set aside" sets to about 55px at `text-note`
   * (12.5px), and the buttons carry `whitespace-nowrap` so a too-narrow column would push the
   * posted row a line taller than the scheduled one instead of overflowing visibly.
   */
  action: 'ml-3 w-[72px] flex-shrink-0 text-right',
} as const;

/** Geometry alone is not alignment: the figures also have to be set in the same face and size. */
export const LEDGER_AMOUNT_TYPE = 'font-serif text-sub tabular-nums';

const ROW_FRAME = 'flex items-center px-3 py-2.5';
const HEADER_FRAME = 'flex items-center px-3 pb-1.5 pt-3';

/** Machine-written metadata, set in the mono face because that is what it is. */
function Mark({ children }: { children: string }) {
  return (
    <span className="font-mono text-rule uppercase tracking-[0.14em] text-muted">{children}</span>
  );
}

/**
 * The column names, said once per half.
 *
 * The retired Transactions view had a header and the first draft of this screen dropped it, which
 * left a 130px column of bare strings that the owner had to infer the meaning of. It is rendered
 * above each half rather than once at the top because the rule separates them by a screenful.
 */
export function LedgerColumnHeader() {
  return (
    <div className={`${HEADER_FRAME} text-micro uppercase tracking-[0.18em] text-muted-2`}>
      <span data-col="select" className={LEDGER_COLUMNS.select} aria-hidden />
      <span data-col="entry" className={LEDGER_COLUMNS.entry}>
        Entry
      </span>
      <span data-col="category" className={LEDGER_COLUMNS.category}>
        Category
      </span>
      <span data-col="amount" className={LEDGER_COLUMNS.amount}>
        Amount
      </span>
      <span data-col="action" className={LEDGER_COLUMNS.action} aria-hidden />
    </div>
  );
}

/** Unwrapped so `tests/ledgerGeometry.test.ts` can call it and walk the tree it returns. */
export function LedgerRowInner({
  transaction,
  selected,
  draft,
  isCursor,
  categories,
  busy,
  refusal,
  duplicateGroups,
  transferPairs,
  actions,
}: LedgerRowProps) {
  const merchant = (transaction.merchant_name || transaction.original_name || '').trim() || 'Unknown merchant';
  const mark = readProvenance(transaction);
  const direction = readDirection(transaction);
  const flags = readFlags(transaction);
  const proposed = draft ? proposedCategoryId(draft) : null;
  // Both decisions are about a SET of rows, and both are settled by pointing at one of them. That
  // is why they sit on the row rather than in a separate worklist: "keep this copy" and "these two
  // are one movement" are things you say about the entry you are looking at.
  const duplicateGroup = transaction.duplicate_group_id ? duplicateGroups.get(transaction.duplicate_group_id) : undefined;
  const transferPair = transaction.transfer_pair_id ? transferPairs.get(transaction.transfer_pair_id) : undefined;
  const setAside = isSetAside(transaction);
  // Offered only on a row the queue would otherwise count forever. Setting aside a filed row would
  // say nothing: `getCounts` only ever counts rows with no category.
  const canSetAside = !transaction.category_id && !transaction.pending;

  return (
    <div
      data-cursor={isCursor ? 'on' : undefined}
      className={`relative border-b border-line ${
        isCursor ? 'before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:bg-sage' : ''
      }`}
    >
      {/* Hover washes the row with `well`, the same ground every other list in this app uses.
          It used to raise the row to `card` instead, and the reason given was that `well` could
          not carry the money tones. That reason died with the 2026-08-01 palette and the choice
          it defended became a no-op in the same stroke, so it is reversed here rather than
          re-argued. Both halves, from the exact triplets in client/src/index.css (WCAG 2.1,
          sRGB):

          The no-op. This screen sits directly on `paper` (Layout is `bg-paper`, and `Screen`
          declares no ground), and on light `card` and `paper` are the same pure-white triplet:
          `card` on `paper` is 1.00:1. A `hover:bg-card` row therefore changed nothing at all on
          light, which is the whole affordance gone, not a weak one. `well` on `paper` is 1.11:1
          light and 1.21:1 dark, a step in both.

          The dead reason. `sage-deep` on `well` is 4.65:1 light and 5.14:1 dark, so the
          positive-money token the old note said this wash could not carry clears AA on it. So
          does every other tone this row sets there:
          `ink` is 18.93:1 light and 17.40:1 dark, `muted` 6.82:1 and 7.93:1, `muted-2` 5.41:1
          and 6.42:1. The worst pair in either theme is 4.65. `gold` is the one tone `well` cannot
          carry (index.css records 4.19 / 5.16) and this row sets it nowhere. `CategoryPill` and
          the tinted flag declare grounds of their own; the neutral `set_aside` outline does not,
          and it is `muted`. */}
      <div className={`group transition-colors hover:bg-well ${ROW_FRAME}`}>
        <button
          type="button"
          data-col="select"
          aria-label={selected ? `Deselect ${merchant}` : `Select ${merchant}`}
          aria-pressed={selected}
          onClick={() => actions.toggleSelect(transaction.id)}
          className={`${LEDGER_COLUMNS.select} rounded-full border transition-all ${
            selected ? 'border-sage bg-sage' : 'border-line-3 opacity-0 group-hover:opacity-100 focus:opacity-100'
          }`}
        />
        <button
          type="button"
          data-col="entry"
          onClick={() => actions.open(transaction)}
          className={`${LEDGER_COLUMNS.entry} text-left`}
        >
          <div className="truncate text-body-lg text-ink">{merchant}</div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
            {/* The account sits here, not in a column, because the scheduled half has no account
                to put beside it: a recurring pattern is a merchant and a cadence, and which
                account it lands in is not known until it posts. */}
            <span className="truncate text-note text-muted-2">{transaction.account_name}</span>
            {mark && <Mark>{PROVENANCE_LABEL[mark]}</Mark>}
            {direction === 'credit' && <Mark>credit</Mark>}
            {flags.map((flag) => (
              <span
                key={flag}
                /* An open question is tinted; a decision the owner already made is not. `set_aside`
                   is the second kind, so it carries the neutral outline rather than the review
                   tint, which otherwise puts settled work back in the colour of open work.
                   This one carries no fill, so its ground is the row's: `text-muted` measures
                   7.57:1 on light paper and 6.82:1 on light well,
                   9.57:1 on dark paper and 7.93:1 on dark well,
                   from the triplets in client/src/index.css. */
                className={`rounded-md px-1.5 py-px text-rule uppercase tracking-[0.1em] ${
                  flag === 'set_aside'
                    ? 'border border-line-3 text-muted'
                    : 'border border-review-border bg-review-bg text-review-text'
                }`}
              >
                {FLAG_LABEL[flag]}
              </span>
            ))}
          </div>
        </button>
        <span data-col="category" className={LEDGER_COLUMNS.category}>
          <CategoryPill name={transaction.category_name} className="max-w-full truncate align-middle" />
        </span>
        <span
          data-col="amount"
          className={`${LEDGER_COLUMNS.amount} ${LEDGER_AMOUNT_TYPE} ${
            direction === 'income' ? 'text-sage-deep' : 'text-ink'
          }`}
        >
          {formatCurrency(transaction.amount, { showSign: transaction.amount > 0 })}
        </span>
        <span data-col="action" className={LEDGER_COLUMNS.action}>
          {setAside ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => actions.bringBack(transaction.id)}
              className="whitespace-nowrap text-note text-muted transition-colors hover:text-ink disabled:opacity-40"
            >
              Undo
            </button>
          ) : (
            canSetAside && (
              <button
                type="button"
                disabled={busy}
                onClick={() => actions.setAside(transaction.id)}
                title="Stop counting this entry in the needs-a-category queue"
                className="whitespace-nowrap text-note text-muted opacity-0 transition-opacity hover:text-ink focus:opacity-100 group-hover:opacity-100 disabled:opacity-40"
              >
                Set aside
              </button>
            )
          )}
        </span>
      </div>

      {draft && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pb-2.5 pl-[26px] pr-3">
          <span className="text-note text-estimate">The model suggests</span>
          {proposed !== null ? (
            <CategoryPicker
              value={proposed}
              categories={categories}
              placeholder="Category"
              onChange={(categoryId) => actions.override(draft, categoryId)}
            />
          ) : (
            <span className="text-note text-estimate">{draft.summary}</span>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => actions.accept(draft)}
            className="border-b border-estimate pb-0.5 text-body text-estimate transition-opacity hover:opacity-75 disabled:opacity-40"
          >
            Accept{isCursor ? ' · press a' : ''}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => actions.dismissDraft(draft.id)}
            className="text-body text-muted transition-colors hover:text-ink disabled:opacity-40"
          >
            Dismiss
          </button>
        </div>
      )}

      {duplicateGroup && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pb-2.5 pl-[26px] pr-3">
          <span className="text-note text-muted">
            {duplicateGroup.count} identical charges on {duplicateGroup.account_name}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => actions.keepCopy(duplicateGroup.group_id, transaction.id)}
            className="border-b border-ink pb-0.5 text-body text-ink transition-opacity hover:opacity-75 disabled:opacity-40"
          >
            Keep this copy, stop counting the other {duplicateGroup.count - 1}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => actions.keepBoth(duplicateGroup.group_id)}
            className="text-body text-muted transition-colors hover:text-ink disabled:opacity-40"
          >
            They are separate charges
          </button>
        </div>
      )}

      {transferPair && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pb-2.5 pl-[26px] pr-3">
          <span className="text-note text-muted">
            Looks like {transferPair.from_account_name} to {transferPair.to_account_name}, not spending
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => actions.confirmTransfer(transferPair.pair_id)}
            className="border-b border-ink pb-0.5 text-body text-ink transition-opacity hover:opacity-75 disabled:opacity-40"
          >
            Confirm transfer
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => actions.rejectTransfer(transferPair.pair_id)}
            className="text-body text-muted transition-colors hover:text-ink disabled:opacity-40"
          >
            Not a transfer
          </button>
        </div>
      )}

      {/* A guard that refuses a draft leaves the row exactly as it was and says why. The refusal
          stays on the row instead of in a toast, and the draft stays offered, because hiding a
          suggestion the guards would refuse was built once and reverted: it buried a legitimate
          proposal with no reason and no way to see it. */}
      {refusal && (
        <p className="pb-2.5 pl-[26px] pr-3 text-note text-review-text">Left alone: {refusal}</p>
      )}
    </div>
  );
}

/**
 * Memoized, with the comparison written out so it can be counted.
 *
 * One `j` keypress re-renders this screen. With the comparison holding, exactly two rows re-render
 * out of every row loaded: the one the cursor left and the one it arrived at. Without it, all of
 * them do, and "all of them" reaches 2,588 with the range set to all time. `sameLedgerRow` lives
 * in spine.ts and `tests/ledgerRow.test.ts` drives it over both counts.
 *
 * It did not hold before, and the comment here claimed it did. react-query 5's `useMutation`
 * returns a fresh object literal every render, so the six `useCallback` handlers built on those
 * objects changed identity every render and the comparison failed on every row every time. The
 * handlers now arrive as `actions`, one object created once by `createLedgerRowActions`.
 *
 * One case still re-renders every loaded row, and it is not a keystroke: `busy` flips while a
 * write is in flight, twice per accepted draft. That is two passes per click, which is a cost the
 * list pays at human speed rather than at typing speed.
 */
export const LedgerRow = memo(LedgerRowInner, sameLedgerRow);

interface ScheduledRowProps {
  occurrence: RecurringForecastOccurrence;
  busy: boolean;
  onSkip: (o: RecurringForecastOccurrence) => void;
  onUndoSkip: (o: RecurringForecastOccurrence) => void;
  onConfirmPattern: (o: RecurringForecastOccurrence) => void;
  onDismissPattern: (o: RecurringForecastOccurrence) => void;
}

export function ScheduledRow({
  occurrence,
  busy,
  onSkip,
  onUndoSkip,
  onConfirmPattern,
  onDismissPattern,
}: ScheduledRowProps) {
  const skipped = occurrence.adjustment_action === 'skip';
  const amount = occurrenceAmount(occurrence);
  // A skipped row used to be the whole row at `opacity-50`, which took the amount under AA on
  // every ground it lands on. Re-derived on the 2026-08-01 palette rather than left at what it
  // measured before, because this figure is the only thing stopping `opacity-50` coming back and
  // a dead one stops nothing: source-over composite of the veiled token at 0.5 onto the ground,
  // then WCAG 2.1 against that same ground, gives 2.04:1 over light `paper` and 2.26:1 over dark
  // `well`, the two grounds this row has. Composites carry no subject, so the walker in
  // tests/contrastClaims.test.ts deliberately does not read them; these two are computed by hand
  // from the triplets in client/src/index.css.
  // Line-through plus `muted` says the same thing and stays legible: `muted` is 7.57:1 on light
  // paper, 6.82:1 on light well, 9.57:1 on dark paper and 7.93:1 on dark well.
  const settledInk = skipped ? 'text-muted line-through' : 'text-estimate';

  // Same hover ground as the posted row above, for the same two reasons: `hover:bg-card` was a
  // no-op on light, and every tone this row sets clears AA on `well`. The estimate ink is the
  // one this row adds, and `estimate` on `well` is 4.65:1 light and 5.17:1 dark.
  return (
    <div className={`group border-b border-line transition-colors hover:bg-well ${ROW_FRAME}`}>
      <span data-col="select" className={LEDGER_COLUMNS.select} aria-hidden />
      <div data-col="entry" className={LEDGER_COLUMNS.entry}>
        <div className={`truncate text-body-lg ${settledInk}`}>{occurrence.merchant_name}</div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-note text-muted-2">
            {skipped ? 'Skipped this time' : occurrenceMeta(occurrence)}
          </span>
          {!occurrence.is_confirmed && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => onConfirmPattern(occurrence)}
                className="text-note text-muted transition-colors hover:text-ink disabled:opacity-40"
              >
                Confirm it repeats
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onDismissPattern(occurrence)}
                className="text-note text-muted transition-colors hover:text-ink disabled:opacity-40"
              >
                Not recurring
              </button>
            </>
          )}
        </div>
      </div>
      <span data-col="category" className={LEDGER_COLUMNS.category}>
        <CategoryPill name={occurrence.category_name} className="max-w-full truncate align-middle" />
      </span>
      <span data-col="amount" className={`${LEDGER_COLUMNS.amount} ${LEDGER_AMOUNT_TYPE} ${settledInk}`}>
        {/* A variable-amount pattern stores a median, not a bill. The tilde keeps it from reading
            as a figure the provider actually quoted. */}
        {occurrence.amount_varies ? '~' : ''}
        {formatCurrency(Math.abs(amount), { showSign: occurrence.is_income })}
      </span>
      <span data-col="action" className={LEDGER_COLUMNS.action}>
        {skipped ? (
          <button
            type="button"
            onClick={() => onUndoSkip(occurrence)}
            disabled={busy || !occurrence.adjustment_id}
            className="whitespace-nowrap text-note text-muted transition-colors hover:text-ink disabled:opacity-40"
          >
            Undo
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onSkip(occurrence)}
            disabled={busy}
            className="whitespace-nowrap text-note text-muted opacity-0 transition-opacity hover:text-ink focus:opacity-100 group-hover:opacity-100 disabled:opacity-40"
          >
            Skip
          </button>
        )}
      </span>
    </div>
  );
}

export type { LedgerRowHandlers, LedgerRowProps };
