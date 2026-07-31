import { Navigate } from 'react-router-dom';

/**
 * `/reports` was the same query set as `/cash-flow` over a shorter window, plus the balance-sheet
 * readings that `/` already owned. It carried its own copy of net worth, and a comment recording
 * the release where that copy disagreed with Today's; there is now one copy on `/`.
 *
 * The redirect carries this screen's default window. Its payoff reading, its asset mix and its
 * category breakdown all moved to `/`; its category sparklines and its per-account net-worth
 * attribution did not, because the account-level story belongs on `/accounts`.
 *
 * Routing is a later track; when `App.tsx` drops the route, delete this file.
 */
export function Reports() {
  return <Navigate to="/?window=this-month" replace />;
}
