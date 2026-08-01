import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Account, SyncHealthConnection } from '@shared/types';
import { accountsApi, networthApi, syncApi } from '../../lib/api';
import { formatCompactRelative, formatWholeCurrency } from '../../lib/formatters';
import { creditNote, isInCredit, signedAccountBalance } from '../../lib/accountBalance';
import { ACCOUNT_TYPE_LABELS } from '../../lib/constants';
import { invalidateFinancialData } from '../../lib/queryInvalidation';
import { useAppStore } from '../../store';
import { Screen, ScreenHeader, SectionLabel, Card, Figure, Row, TextButton, TrendChart } from '../../components/balance';
import { ConfirmRemoveModal } from '../../components/ConfirmRemoveModal';
import { SkeletonRows } from '../../components/SkeletonLoader';
import { AddManualAccountModal, EditAccountModal, MergeAccountModal } from './Modals';

const GROUPS: Array<{ name: string; match: (a: Account) => boolean }> = [
  { name: 'Cash', match: (a) => !a.is_liability && ['checking', 'savings', 'cash'].includes(a.type) },
  { name: 'Investments', match: (a) => !a.is_liability && ['brokerage', 'ira_traditional', 'ira_roth'].includes(a.type) },
  { name: 'Crypto', match: (a) => !a.is_liability && a.type === 'crypto_wallet' },
  { name: 'Credit cards', match: (a) => a.type === 'credit' },
  { name: 'Loans', match: (a) => a.is_liability && a.type !== 'credit' },
  { name: 'Other', match: () => true },
];

/** Three readings, not two: money you hold, money you owe, and money a card owes you. */
function balanceTone(a: Account): string {
  if (isInCredit(a)) return 'text-sage-deep';
  return signedAccountBalance(a) < 0 ? 'text-clay' : 'text-ink';
}

const CONNECTION_LABELS: Record<Account['connection_type'], string> = {
  simplefin: 'SimpleFIN',
  coinbase: 'Coinbase',
  manual: 'Manual',
};

function accountMeta(a: Account): string {
  const verb = a.connection_type === 'manual' ? 'updated' : 'synced';
  return `${CONNECTION_LABELS[a.connection_type] ?? 'Manual'} · ${verb} ${formatCompactRelative(a.updated_at)}`;
}

/**
 * The badge reflects the shared connection's health, so every account on a connection shows the
 * same state.
 *
 * It carries its own ground, so its ratios are against that ground and not against the row's.
 * Re-derived from the triplets in `client/src/index.css` (WCAG 2.1, sRGB), light / dark:
 *
 *   clay on pill-bg           4.74 / 4.93   the "Reconnect" pill, AA on both themes
 *   gold on pill-bg           3.97 / 5.98   what the two caution pills used to be, sub-AA on light
 *   review-text on review-bg  4.93 / 5.53   the pair the palette already declares for caution
 *
 * `text-rule` is 11px, so the large-text exemption does not apply and 4.5:1 is the bar.
 *
 * The two caution states moved onto the review pair rather than recolouring `gold`, and the reason
 * is not that `gold` is fine elsewhere. It is not: on light it measures 3.71 on `rail`, 3.09 on
 * `track` and 4.07 on `well`, so `pill-bg` is the fourth ground it fails rather than the only one,
 * and `DataSection.tsx` sets `text-gold` on `rail` today. The reason is that `gold` is load-bearing
 * elsewhere as an ink and moving the token would move all of it. Counted 2026-07-31 with (the
 * second `grep` drops this block's own prose)
 *
 *   grep -rnE 'text-(gold|warning)' client/src | grep -vE ':[0-9]+: \*'
 *   -> 13 that day, being 7 `text-gold` and 6 `text-warning`, the legacy alias for the same triplet
 *
 * That is a dated reading of a figure that moves as views are added, and the command is beside it
 * so it can be re-run rather than trusted. What does not move is the shape: gold is an ink across
 * eight modules, so recolouring the token is never a local change, and changing one pill's ground
 * changes one pill.
 *
 * The `review` pair is not borrowed from the AI. It is what this palette uses for an open question
 * the owner has not settled, and only two of its five call sites are about the model:
 * `ledger/rows.tsx` puts a row's "possible duplicate", "possible transfer" and "pending" flags on
 * it, and `Ledger.tsx` tints the selected review filter chip with it. `set_aside` deliberately
 * does NOT take it, because a decision the owner already made is not an open question. A connection
 * that has never synced or has gone stale is that same open question, which is why these two pills
 * take it and the "Reconnect" pill, which is a failure rather than a question, stays on `clay`.
 *
 * What this does NOT claim: that `pill-bg` is now clean. Two other call sites still set sub-AA ink
 * on it at `text-micro` (11.5px), measured from the same triplets, light / dark:
 *   `CategoryPill.tsx` uncategorized  `text-muted-2`  3.92 / 4.77
 *   `CategoriesSection.tsx` Badge tone 'sage'  `text-sage-deep`  4.27 / 6.78
 * Neither is this file's, both are recorded rather than passed over, and
 * `tests/accountsRowContrast.test.ts` recomputes every figure above from the CSS.
 */
const BADGE_BASE = 'flex-shrink-0 rounded border px-1.5 py-px text-rule';
const BADGE_CAUTION = `${BADGE_BASE} border-review-border bg-review-bg text-review-text`;

function SyncBadge({ conn }: { conn?: SyncHealthConnection }) {
  if (!conn) return null;
  if (conn.freshness === 'attention') {
    return (
      <span className={`${BADGE_BASE} border-pill-border bg-pill-bg text-clay`} title={conn.status_detail}>
        Reconnect
      </span>
    );
  }
  if (conn.freshness === 'never') {
    return <span className={BADGE_CAUTION} title={conn.status_detail}>Never synced</span>;
  }
  if (conn.freshness === 'stale') {
    return <span className={BADGE_CAUTION} title={conn.status_detail}>Stale</span>;
  }
  return null;
}

export function Accounts() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [searchParams] = useSearchParams();
  const handledSetupActionRef = useRef(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [merging, setMerging] = useState<Account | null>(null);
  const [removing, setRemoving] = useState<Account | null>(null);

  const { data: accounts, isLoading } = useQuery({ queryKey: ['accounts'], queryFn: () => accountsApi.list() });
  const { data: snapshots } = useQuery({
    queryKey: ['networth', 'history', 12],
    queryFn: () => networthApi.history(12),
    retry: false,
  });
  // `covered_accounts` is NULL on rows written before migration 044, and undefined there rather
  // than zero: the chart draws a coverage change only where it has two counts to compare.
  const netWorthHistory = useMemo(
    () =>
      (snapshots ?? []).map((s) => ({
        date: s.date,
        value: s.net_worth,
        estimated: Boolean(s.is_estimated),
        coverage: s.covered_accounts ?? undefined,
      })),
    [snapshots]
  );
  const { data: syncHealth } = useQuery({ queryKey: ['sync', 'health'], queryFn: () => syncApi.health(), retry: false });
  const healthByConnection = useMemo(() => {
    const map = new Map<string, SyncHealthConnection>();
    for (const c of syncHealth?.connections ?? []) map.set(c.id, c);
    return map;
  }, [syncHealth]);

  // Handle onboarding deep links: ?connect=bank routes to connections, ?manual=1 opens the add modal.
  useEffect(() => {
    if (handledSetupActionRef.current) return;
    const connect = searchParams.get('connect');
    const manual = searchParams.get('manual');
    if (connect !== 'bank' && manual !== '1') return;
    handledSetupActionRef.current = true;
    navigate('/accounts', { replace: true });
    if (connect === 'bank') {
      navigate('/settings?section=connections');
      return;
    }
    setShowAddModal(true);
  }, [navigate, searchParams]);

  const visible = useMemo(() => (accounts ?? []).filter((a) => !a.is_hidden), [accounts]);
  const hidden = useMemo(() => (accounts ?? []).filter((a) => a.is_hidden), [accounts]);
  // Closed accounts stay in net-worth HISTORY but are kept out of the live sections and the
  // current net-worth totals, and surfaced in their own collapsed section instead.
  const closed = useMemo(() => visible.filter((a) => a.type === 'closed'), [visible]);
  const liveVisible = useMemo(() => visible.filter((a) => a.type !== 'closed'), [visible]);

  const groups = useMemo(() => {
    const remaining = new Set(liveVisible.map((a) => a.id));
    return GROUPS.map((g) => {
      const rows = liveVisible.filter((a) => remaining.has(a.id) && g.match(a));
      rows.forEach((a) => remaining.delete(a.id));
      const total = rows.reduce((s, a) => s + signedAccountBalance(a), 0);
      // A subtotal over nothing but liabilities that comes out positive is a net credit, and
      // "$3,948" under "Credit cards" would otherwise read as the debt it is the opposite of.
      return { name: g.name, rows, total, inCredit: total > 0 && rows.every((a) => a.is_liability) };
    }).filter((g) => g.rows.length > 0);
  }, [liveVisible]);

  // Split by ROLE, the way snapshot.ts computes the same three figures on the server. Splitting by
  // sign cannot survive a card in credit: that is a positive number belonging to a liability, and
  // counting it as an asset would put this screen back at odds with the net worth it prints.
  const assets = liveVisible.filter((a) => !a.is_liability).reduce((s, a) => s + a.current_balance, 0);
  const owed = liveVisible.filter((a) => a.is_liability).reduce((s, a) => s + a.current_balance, 0);
  const netWorth = assets - owed;

  const selected = (accounts ?? []).find((a) => a.id === selectedId) ?? null;

  const syncAll = useMutation({
    mutationFn: () => syncApi.run(),
    onSuccess: () => addToast({ type: 'info', message: 'Sync started' }),
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const toggleHidden = useMutation({
    mutationFn: (a: Account) => accountsApi.update(a.id, { is_hidden: !a.is_hidden }),
    onSuccess: () => invalidateFinancialData(qc),
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const deleteAccount = useMutation({
    mutationFn: (a: Account) => accountsApi.delete(a.id),
    onSuccess: () => {
      invalidateFinancialData(qc);
      addToast({ type: 'success', message: 'Account removed' });
      setRemoving(null);
      setSelectedId(null);
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  /**
   * The selected row's fill is a SURFACE, not chrome.
   *
   * It was `bg-rail`. `rail` is the navigation's ground, a track and a code chip; `index.css` says
   * of it "every call site pairs it with `text-ink`; do not start putting secondary text on it",
   * and this row puts a money numeral, a merchant line and a caption on it. Every tone the row can
   * carry, against each ground it can get, re-derived from the triplets in `client/src/index.css`
   * (WCAG 2.1, sRGB), light / dark:
   *
   *                  rail            card            paper (unselected)
   *   ink            9.45 / 14.60    14.46 / 11.21   11.66 / 13.34
   *   muted          4.60 /  7.60     7.04 /  5.84    5.67 /  6.95   the initial in the avatar
   *   muted-2        3.67 /  6.46     5.61 /  4.96    4.52 /  5.90   the sync/institution line
   *   sage-deep      3.99 /  9.18     6.11 /  7.05    4.93 /  8.38   a card in credit, and its note
   *   clay           4.43 /  6.68     6.78 /  5.13    5.47 /  6.10   a balance that is owed
   *
   * Three of the five failed AA on light, and two of those three are the money numeral itself
   * (`sage-deep` 3.99, `clay` 4.43) with the row's secondary line (`muted-2` 3.67) below them. On
   * `card` the worst pair in either theme is 4.96. Nothing here is large text: the numeral is
   * `text-sub` and the rest is smaller.
   *
   * Selection now reads as a raised surface plus a `sage` edge (4.85 / 5.85 against `card`, well
   * clear of the 3:1 that a non-text boundary needs), because `card` on `paper` is only 1.24 / 1.19
   * and a surface step alone is not a selection signal. `tests/accountsRowContrast.test.ts`
   * recomputes every figure above from the CSS and fails if a tone in this row stops clearing AA.
   *
   * The table above is the row at rest and at full strength. Two things it does not cover, measured
   * and left alone rather than passed over in silence:
   *
   *   - `Row`'s own `hover:bg-well` / `focus-visible:bg-well` replaces the ground for as long as the
   *     pointer is on the row, and `muted-2` on `well` is 4.02 / 4.14. That is every `Row` on every
   *     screen, so it belongs to the primitive and not to this view.
   *   - `dimmed` is `opacity-55`, which the closed and hidden sections apply to the whole row.
   *     Composited over the ground beneath it that puts EVERY tone below AA, `ink` included:
   *     on light/paper ink 3.34, muted 2.32, muted-2 2.10, sage-deep 2.21, clay 2.38. No opacity
   *     fixes it, because `muted-2` on `paper` is 4.52 at full strength and any alpha below 1 takes
   *     it under; a de-emphasis that keeps AA has to be a different tone rather than a veil. Both
   *     sections are behind an explicit "show" toggle and both say what they hold, so this is
   *     recorded here and in `tests/accountsRowContrast.test.ts` rather than fixed in passing.
   *
   * The veil composites the SELECTION too, and that part is not recorded, it is fixed. `opacity` on
   * the element applies to its `box-shadow`, so the `ring-sage` edge above went down with the text:
   * at 55% over the veiled card fill it measures 1.97 light and 3.07 dark, against a surface step
   * of 1.13 light and 1.10 dark, so on light nothing at all marked which row the detail panel was
   * describing. Both closed and hidden rows keep the same `onClick`, so a veiled row can be the
   * selected one; `renderRow(a, true)` is where that happens. A selected row is therefore not
   * dimmed. De-emphasis is for rows the owner is not looking at, and the one they just clicked is
   * the row they are looking at, so this costs nothing that the veil was there to buy.
   */
  const renderRow = (a: Account, dimmed = false) => (
    <Row
      key={a.id}
      onClick={() => setSelectedId(a.id === selectedId ? null : a.id)}
      className={`justify-between px-3 py-3.5 ${dimmed && selectedId !== a.id ? 'opacity-55' : ''} ${
        selectedId === a.id ? 'bg-card ring-1 ring-inset ring-sage' : ''
      }`}
    >
      <div className="flex min-w-0 items-center gap-3.5">
        <span className="flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-lg bg-rail font-serif text-body-lg text-muted">
          {(a.institution_name || a.account_name).charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0">
          <div className="truncate text-body-lg text-ink">{a.account_name}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-note text-muted-2">
            <span className="truncate">{accountMeta(a)}</span>
            {a.connection_id && <SyncBadge conn={healthByConnection.get(a.connection_id)} />}
          </div>
        </div>
      </div>
      <div className="flex flex-shrink-0 flex-col items-end">
        <span className={`font-serif text-sub tabular-nums ${balanceTone(a)}`}>
          {formatWholeCurrency(signedAccountBalance(a))}
        </span>
        {isInCredit(a) && (
          <span className="mt-0.5 text-rule uppercase tracking-[0.09em] text-sage-deep">In credit</span>
        )}
      </div>
    </Row>
  );

  return (
    <Screen>
      <ScreenHeader
        title="Accounts"
        sub={
          <>
            {visible.length} account{visible.length === 1 ? '' : 's'} · net worth{' '}
            <span className="tabular-nums">{formatWholeCurrency(netWorth)}</span>
          </>
        }
        actions={
          <>
            <TextButton onClick={() => syncAll.mutate()} disabled={syncAll.isPending}>
              Sync all
            </TextButton>
            <button
              type="button"
              onClick={() => setShowAddModal(true)}
              className="text-body text-ink transition-opacity hover:opacity-75"
            >
              + Add account
            </button>
          </>
        }
        className="mb-6"
      />

      {/* Net worth is the subject; assets and liabilities are the two terms it is made of. */}
      <div className="mb-8 flex-shrink-0 space-y-3 lg:space-y-4">
        <Card padding="lg" elevation={2}>
          <Figure scale="subject" label="Net worth">{formatWholeCurrency(netWorth)}</Figure>
        </Card>
        <div className="grid gap-3 sm:grid-cols-2 lg:gap-4">
          <Card padding="lg">
            <Figure scale="lead" label="Assets">{formatWholeCurrency(assets)}</Figure>
          </Card>
          <Card padding="lg">
            {/* `owed` is a NET over liabilities, so it can land either side of zero and the word
                above it cannot be hardcoded. Individual cards in credit are not enough to flip it:
                on this ledger three of the five cards are in credit and the net is still owed,
                because one card outweighs all three.

                  sqlite3 .mizan/mizan.db "select account_name, current_balance from accounts
                    where is_liability=1 and is_hidden=0 and type!='closed';"
                  -> Chase Freedom Flex -27612 · Chase Sapphire 511502 · BofA Cash Rewards -582
                     Capital One Savor 888 · Discover -56326        sum = 427870 cents

                So today this renders "Liabilities $4,278.70 / you owe the banks". The label and the
                state sentence are computed rather than written because the sign is the one thing
                the eye skips, and the case where it flips is real. */}
            <Figure
              scale="lead"
              label={owed < 0 ? 'Card credit' : 'Liabilities'}
              value={-owed}
              states={{ positive: 'the banks owe you', negative: 'you owe the banks', zero: 'nothing outstanding' }}
            >
              {formatWholeCurrency(Math.abs(owed))}
            </Figure>
          </Card>
        </div>
      </div>

      {netWorthHistory.length >= 2 && (
        <div className="mb-8 flex-shrink-0">
          <SectionLabel className="mb-2">Net worth · last 12 months</SectionLabel>
          <TrendChart history={netWorthHistory} height={90} label="Net worth" />
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-10 lg:flex-row lg:gap-12">
        {/* Grouped account list */}
        <div className="min-w-0 flex-1">
          {isLoading && <SkeletonRows rows={5} />}
          {!isLoading && liveVisible.length === 0 && closed.length === 0 && (
            <div className="py-10 text-body-lg text-muted">
              No accounts yet.{' '}
              <button
                type="button"
                onClick={() => navigate('/settings?section=connections')}
                className="text-ink underline underline-offset-2"
              >
                Connect SimpleFIN or Coinbase
              </button>{' '}
              or add one manually.
            </div>
          )}
          {groups.map((g) => (
            <div key={g.name} className="mb-6">
              <SectionLabel
                underline
                summary={`${formatWholeCurrency(g.total)}${g.inCredit ? ' in credit' : ''}`}
                className="mb-1.5"
              >
                {g.name}
              </SectionLabel>
              {g.rows.map((a) => renderRow(a))}
            </div>
          ))}
          {closed.length > 0 && (
            <div className="mb-6">
              <button
                type="button"
                onClick={() => setShowClosed((v) => !v)}
                className="mb-1.5 text-note text-muted-2 transition-colors hover:text-ink"
              >
                {closed.length} closed account{closed.length === 1 ? '' : 's'} · {showClosed ? 'collapse' : 'show'}
              </button>
              {showClosed && closed.map((a) => renderRow(a, true))}
            </div>
          )}
          {hidden.length > 0 && (
            <div className="mb-6">
              <button
                type="button"
                onClick={() => setShowHidden((v) => !v)}
                className="mb-1.5 text-note text-muted-2 transition-colors hover:text-ink"
              >
                {hidden.length} hidden account{hidden.length === 1 ? '' : 's'} · {showHidden ? 'collapse' : 'show'}
              </button>
              {showHidden && hidden.map((a) => renderRow(a, true))}
            </div>
          )}
        </div>

        {/* Detail panel */}
        {selected && (
          <div className="w-full flex-shrink-0 self-start border-t border-line-2 pt-6 lg:sticky lg:top-6 lg:w-[300px] lg:border-t-0 lg:pt-0">
            <div className="mb-4 flex items-baseline justify-between">
              <span className="text-micro font-semibold uppercase tracking-[0.16em] text-muted-2">
                {selected.account_name}
              </span>
            </div>
            <div className={`font-serif text-hero font-light leading-none tabular-nums ${balanceTone(selected)}`}>
              {formatWholeCurrency(signedAccountBalance(selected))}
            </div>
            {isInCredit(selected) && (
              <div className="mt-2 text-note text-sage-deep">{creditNote(selected)}</div>
            )}
            <div className="mt-6">
              {[
                { label: 'Institution', value: selected.institution_name || 'Not recorded' },
                { label: 'Type', value: ACCOUNT_TYPE_LABELS[selected.type] ?? selected.type },
                { label: 'Connection', value: CONNECTION_LABELS[selected.connection_type] ?? 'Manual' },
                { label: 'Updated', value: formatCompactRelative(selected.updated_at) },
              ].map((row, i, arr) => (
                <div
                  key={row.label}
                  className={`flex items-baseline justify-between py-2 ${i < arr.length - 1 ? 'border-b border-line' : ''}`}
                >
                  <span className="text-body text-muted">{row.label}</span>
                  <span className="text-body text-ink">{row.value}</span>
                </div>
              ))}
            </div>
            <div className="mt-6 flex flex-col items-start gap-3">
              <TextButton variant="primary" onClick={() => navigate(`/accounts/${selected.id}`)}>
                View details
              </TextButton>
              <TextButton onClick={() => setEditing(selected)}>Edit account</TextButton>
              <TextButton onClick={() => toggleHidden.mutate(selected)}>
                {selected.is_hidden ? 'Unhide from lists' : 'Hide from lists'}
              </TextButton>
              {(accounts?.length ?? 0) > 1 && (
                <TextButton onClick={() => setMerging(selected)}>Merge into…</TextButton>
              )}
              <TextButton onClick={() => setRemoving(selected)} className="hover:!text-clay">
                Remove…
              </TextButton>
            </div>
          </div>
        )}
      </div>

      <AddManualAccountModal open={showAddModal} onClose={() => setShowAddModal(false)} />
      <EditAccountModal open={editing != null} account={editing} onClose={() => setEditing(null)} />
      <MergeAccountModal
        open={merging != null}
        source={merging}
        accounts={accounts ?? []}
        onClose={() => setMerging(null)}
        onMerged={() => setSelectedId(null)}
      />
      <ConfirmRemoveModal
        open={removing != null}
        onClose={() => setRemoving(null)}
        title="Remove account"
        description={`This removes "${removing?.account_name}" and all of its transactions from Mizān. It does not touch the real account.`}
        confirmLabel="Remove account"
        onConfirm={() => removing && deleteAccount.mutate(removing)}
        isPending={deleteAccount.isPending}
      />
    </Screen>
  );
}
