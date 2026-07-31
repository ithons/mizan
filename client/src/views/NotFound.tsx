import { Link, useLocation } from 'react-router-dom';
import { NAV_ITEMS, SETTINGS_ITEM } from '../components/NavRail';
import { Screen } from '../components/balance';

/**
 * The catch-all. There was none, so a typo rendered a blank page under a working nav rail.
 *
 * It states the path it could not resolve and lists every path there is, because after the
 * consolidation there are six and the whole list is shorter than an explanation of it. No apology:
 * an address that does not exist is not a failure anything did, and "Sorry" in the interface's
 * voice would be the app apologising for the owner's keystroke.
 */
export function NotFound() {
  const { pathname } = useLocation();

  return (
    <Screen size="editorial">
      <div className="mz-stagger">
        <h1 className="font-serif text-title font-normal leading-tight text-ink">
          Nothing at <span className="font-mono text-sub text-ink-soft">{pathname}</span>
        </h1>
        <p className="mt-1 text-body text-muted">Mizān has six screens. All of them are here.</p>

        <div className="mt-7 border-t border-line-2">
          {[...NAV_ITEMS, SETTINGS_ITEM].map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="group flex items-baseline justify-between gap-6 border-b border-line py-3.5 transition-colors hover:bg-well"
            >
              <span className="text-sub text-ink">{item.label}</span>
              <span className="font-mono text-note text-muted transition-colors group-hover:text-ink">
                {item.to}
              </span>
            </Link>
          ))}
        </div>

        <p className="mt-6 text-note text-muted">
          Press <kbd className="rounded border border-line-3 px-1 py-px font-mono text-micro">g</kbd>{' '}
          then the first letter of a screen to jump, or{' '}
          <kbd className="rounded border border-line-3 px-1 py-px font-mono text-micro">⌘K</kbd> to
          search and ask.
        </p>
      </div>
    </Screen>
  );
}
