import { useQuery } from '@tanstack/react-query';
import { NavLink, useNavigate } from 'react-router-dom';
import { syncApi } from '../lib/api';
import { formatCompactRelative } from '../lib/formatters';
import { useShortcuts, type ShortcutHandlers, type ShortcutId } from '../lib/keyboard';
import { useAppStore } from '../store';

/**
 * Six words, labelled at every width.
 *
 * What this replaces: eleven destinations plus Settings, each rendered as a 7px dot with its label
 * behind `xl:block`. Under 1280px, which includes any laptop window that is not maximised, the
 * whole navigation was twelve identical dots. Measured from the shipped tokens, `dot` on `rail` is
 * **2.68:1 light and 3.38:1 dark** (`--mz-dot-c` over `--mz-rail-c` in index.css, WCAG 2.1 sRGB;
 * `tests/navigation.test.ts` recomputes both from this file's own triplets and fails if either
 * moves). Under AA in both themes, and on light under the 3:1 floor a non-text mark would need.
 * Twelve marks nobody can tell apart, in a value nobody can see, standing in for the only thing on
 * screen that says where you are.
 *
 * Six is few enough to spend real type on, so the labels are the navigation and there is no icon
 * or dot at all. Two decisions carry it:
 *
 *   RIGHT-ALIGNED, because the rail is on the right. The ragged edge faces the content, which is
 *   where the eye is coming from, and six items is short enough that a ragged left edge costs
 *   nothing to scan.
 *
 *   A LEADER, not a marker. The active item carries a hairline running left out of the word,
 *   toward the screen it names, in a fixed-width gutter so nothing shifts when it moves. A rule
 *   that points is a statement about position; a dot that changes colour is a legend you have to
 *   learn.
 *
 * The sync line at the bottom carries no dot either, and that is the same argument: the dot it
 * replaces rendered `sage-soft` whenever status was not `'error'`, including while the label
 * beside it read "Not synced yet". A word that says the state cannot disagree with itself.
 */

interface NavItem {
  to: string;
  label: string;
  /**
   * The chord that goes here, as a row in the one shortcut table. The letters live there rather
   * than in this file so that a screen claiming `a` for itself collides with `g a` at import time
   * instead of on the owner's ledger.
   */
  shortcut: ShortcutId;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: 'Balance', shortcut: 'nav.balance' },
  { to: '/ledger', label: 'Ledger', shortcut: 'nav.ledger' },
  { to: '/accounts', label: 'Accounts', shortcut: 'nav.accounts' },
  { to: '/investments', label: 'Investments', shortcut: 'nav.investments' },
  { to: '/plan', label: 'Plan', shortcut: 'nav.plan' },
];

export const SETTINGS_ITEM: NavItem = { to: '/settings', label: 'Settings', shortcut: 'nav.settings' };

export const ALL_NAV_ITEMS: readonly NavItem[] = [...NAV_ITEMS, SETTINGS_ITEM];

/**
 * `g` then a letter, rather than a modifier.
 *
 * Every modifier combination this app used to take was already owned by the browser: ⌘1 through ⌘9
 * switch tabs in Chrome, Firefox and Safari, ⌘0 resets zoom, ⌘R reloads, ⌘P prints, ⌘S saves the
 * page. A prefix key owns nothing, so nothing has to be taken.
 *
 * The rail no longer listens for it. It registers six intentions with `lib/keyboard`, which is the
 * only thing in the app holding a `keydown` listener: this file's own listener called
 * `preventDefault()` and not `stopImmediatePropagation()`, so `g` `a` reached the ledger's listener
 * on the same dispatch and accepted the AI draft under its cursor while navigating away from it.
 */
function useNavShortcuts(onNavigate: (to: string) => void): void {
  const handlers: ShortcutHandlers = {};
  for (const item of ALL_NAV_ITEMS) handlers[item.shortcut] = () => onNavigate(item.to);
  useShortcuts('nav-rail', handlers);
}

function RailItem({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className="group grid grid-cols-[18px_1fr] items-center gap-x-2 py-[7px] pl-3 pr-[22px]"
    >
      {({ isActive }) => (
        <>
          <span
            aria-hidden
            className={`h-px w-full transition-colors ${
              isActive ? 'bg-sage' : 'bg-transparent group-hover:bg-line-3'
            }`}
          />
          <span
            className={`text-right text-sub transition-colors ${
              isActive ? 'font-medium text-ink' : 'text-muted group-hover:text-ink'
            }`}
          >
            {label}
          </span>
        </>
      )}
    </NavLink>
  );
}

export function NavRail() {
  const navigate = useNavigate();
  const { syncStatus, lastSynced, addToast } = useAppStore();

  useNavShortcuts(navigate);

  // `lastSynced` in the store is session state: it is null on mount and only ever written by an
  // SSE `sync_complete` arriving in THIS tab. So every page load said "Not synced yet" on a ledger
  // with 186 recorded sync runs whose latest completion is a column in the database, and the rail
  // held that claim until the next sync happened to land while the tab was open.
  //
  // `syncApi.health()` already returned it and had zero callers, which is this repo's documented
  // shape for a dropped capability rather than dead code. The key is ['sync', 'health'] so the
  // existing 'sync' entry in FINANCIAL_QUERY_KEYS refreshes it after a run without a second list
  // to keep in step.
  const { data: syncHealth } = useQuery({
    queryKey: ['sync', 'health'],
    queryFn: syncApi.health,
    staleTime: 60_000,
  });

  // The store wins when it has a value, because it can only hold a sync that finished after this
  // query was fetched. The server answers for every load before that.
  const lastSyncedAt = lastSynced ?? syncHealth?.last_synced_at ?? null;

  const syncLabel =
    syncStatus === 'syncing'
      ? 'Syncing…'
      : syncStatus === 'error'
        ? 'Sync failed'
        : lastSyncedAt
          ? `Synced ${formatCompactRelative(lastSyncedAt)}`
          : 'Not synced yet';

  const runSync = () => {
    syncApi.run().catch((err: unknown) => {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Sync failed' });
    });
  };

  return (
    <nav
      aria-label="Primary"
      /* The boundary between chrome and money, on `faint` rather than `line-2`.
         A 1px rule between two grounds is seen against both of them, and this one has `paper` on
         the content side and `rail` under itself. `line-2` clears the 3:1 non-text floor against
         the page and misses it against the rail it sits on: `line-2` on `rail`, 2.93:1 light and
         3.47:1 dark, measured in the browser off the rendered element (borderLeftColor
         rgb(145,145,145) against backgroundColor rgb(246,246,246)). `faint` on `rail`, 3.40:1
         light and 4.06:1 dark, and `faint` on `paper`, 3.58:1 light and 4.27:1 dark: both sides,
         both themes.
         `faint` and not `line-3`, which also clears everywhere, because `line-3` is spoken for:
         it is e3's border in `Card.tsx`, the elevation that carries money, and the `closing` rule
         under a sum. Chrome must not read at the weight of the app's highest elevation. `faint` is
         the quietest token that clears every ground (min 3.46 against `well` light) and index.css
         already gives it a non-text contract, rendering it as TrendChart's zero rule.
         `.claude/plans/rebuild-part-3.md` Phase 13 move 2 called this boundary "1.10:1 in the
         current light theme" and sent it TO `line-2`. Both halves were measured against a palette
         that never shipped; see the dated block beside Gate 0 in that file. */
      className="flex h-full w-[var(--mz-rail-w)] flex-shrink-0 flex-col border-l border-faint bg-rail py-[26px]"
    >
      {/* The one place ⌘K is advertised. It is in the navigation because that is where an owner
          looks for where things are, and it costs no region of its own: search, jump and ask are
          one gesture and this is the mark for all three. */}
      <button
        type="button"
        onClick={() => window.dispatchEvent(new Event('mizan:open-palette'))}
        className="flex items-center justify-between gap-2 pb-[22px] pl-3 pr-[22px]"
      >
        <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-ink text-body-lg font-semibold text-paper">
          م
        </span>
        <span className="flex items-baseline gap-2">
          <span className="font-serif text-sub text-ink">mizān</span>
          {/* Outlined rather than filled: `line` on `rail` is 1.16:1 light, so a chip fill here
              would be an invisible rectangle. The border carries the chip and the text carries
              the contrast (`muted` on `rail`, 6.67:1 light / 7.38:1 dark). */}
          <kbd className="rounded border border-line-3 px-1 py-px font-mono text-micro text-muted">⌘K</kbd>
        </span>
      </button>

      <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto py-2">
        {NAV_ITEMS.map((item) => (
          <RailItem key={item.to} to={item.to} label={item.label} />
        ))}
      </div>

      {/* A rule, because Settings is a different kind of destination from the five above it: those
          are the money, this is the machine that reads it. It says that and nothing else.

          `faint`, not `line-2`, for the same reason the rail's own left boundary is: this is a
          structural rule and it sits on `rail` with `rail` on both sides, where `line-2` measures
          2.93:1 light and 3.47:1 dark. It misses the 3:1 non-text floor on the theme most people
          read in. `faint` on `rail` is 3.40:1 light and 4.06:1 dark. The left boundary was
          corrected in 9554379 and this one was missed, which is what `ruleLadder.test.ts` now
          walks the whole file for rather than checking the one element by name. */}
      <div className="mx-3 border-t border-faint" />

      <div className="pt-[18px]">
        <RailItem to={SETTINGS_ITEM.to} label={SETTINGS_ITEM.label} />
        <button
          type="button"
          onClick={runSync}
          disabled={syncStatus === 'syncing'}
          /* A failure steps up in value rather than changing hue. `clay` on `rail` measures
              5.85:1 light /  7.85:1 dark, so it would be legible here and this is a stated choice
             rather than a contrast finding: a hue is a legend the owner has to learn, and one that
             says "error" only if they already know it does. `ink` on `rail` is 16.10:1 against
             `muted`'s 6.67:1, so the failed state is the one that gets darker, and the word says
             which state it is either way. */
          className={`mt-3 block w-full pl-3 pr-[22px] text-right text-note transition-colors ${
            syncStatus === 'error' ? 'font-medium text-ink' : 'text-muted hover:text-ink'
          }`}
          // The one line on every screen that changes on its own. A screen reader hears the new
          // state when a sync finishes or fails without the owner having to go looking; 'polite'
          // because nothing here is urgent enough to interrupt what they were reading.
          aria-live="polite"
        >
          {syncLabel}
        </button>
      </div>
    </nav>
  );
}
