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
 * **1.70:1 light and 3.63:1 dark** (`node` over `--mz-dot-c` / `--mz-rail-c` in index.css,
 * WCAG 2.1 sRGB; the same computation `tests/edgeToken.test.ts` runs). Twelve marks nobody can
 * tell apart, in a value nobody can see, standing in for the only thing on screen that says where
 * you are.
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
              isActive ? 'bg-ink' : 'bg-transparent group-hover:bg-line-3'
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

  const syncLabel =
    syncStatus === 'syncing'
      ? 'Syncing…'
      : syncStatus === 'error'
        ? 'Sync failed'
        : lastSynced
          ? `Synced ${formatCompactRelative(lastSynced)}`
          : 'Not synced yet';

  const runSync = () => {
    syncApi.run().catch((err: unknown) => {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Sync failed' });
    });
  };

  return (
    <nav
      aria-label="Primary"
      className="flex h-full w-[var(--mz-rail-w)] flex-shrink-0 flex-col border-l border-line-2 bg-rail py-[26px]"
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
          {/* Outlined rather than filled: `line` on `rail` is 1.04:1 light, so a chip fill here
              would be an invisible rectangle. The border carries the chip and the text carries
              the contrast (`muted` on `rail`, 4.60:1 light / 7.60:1 dark). */}
          <kbd className="rounded border border-line-3 px-1 py-px font-mono text-micro text-muted">⌘K</kbd>
        </span>
      </button>

      <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto py-2">
        {NAV_ITEMS.map((item) => (
          <RailItem key={item.to} to={item.to} label={item.label} />
        ))}
      </div>

      {/* A rule, because Settings is a different kind of destination from the five above it: those
          are the money, this is the machine that reads it. It says that and nothing else. */}
      <div className="mx-3 border-t border-line-2" />

      <div className="pt-[18px]">
        <RailItem to={SETTINGS_ITEM.to} label={SETTINGS_ITEM.label} />
        <button
          type="button"
          onClick={runSync}
          disabled={syncStatus === 'syncing'}
          /* A failure steps up in value rather than changing hue: `clay` on `rail` measures
             4.43:1 light, under AA at this size, and a colour that cannot be read is not a
             warning. `ink` on `rail` is 9.45:1 against `muted`'s 4.60:1, so the failed state is
             the one that gets darker, and the word says which state it is either way. */
          className={`mt-3 block w-full pl-3 pr-[22px] text-right text-note transition-colors ${
            syncStatus === 'error' ? 'font-medium text-ink' : 'text-muted hover:text-ink'
          }`}
        >
          {syncLabel}
        </button>
      </div>
    </nav>
  );
}
