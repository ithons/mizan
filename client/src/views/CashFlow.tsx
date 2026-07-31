import { Navigate } from 'react-router-dom';

/**
 * `/cash-flow` was never a screen, it was a window.
 *
 * It ran the same cash-flow and spending queries as Reports over a longer stretch of time, which is
 * the whole argument for the consolidation: one selector on `/` reshapes the same query set. The
 * redirect carries the window this screen defaulted to, so a bookmark or a link from another view
 * lands on the reading it was pointing at rather than on the month.
 *
 * `replace` so the back button leaves the app's history alone instead of bouncing between the two.
 * Routing is a later track; when `App.tsx` drops the route, delete this file.
 */
export function CashFlow() {
  return <Navigate to="/?window=six-months" replace />;
}
