import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Check } from 'lucide-react';
import { accountsApi, settingsApi, syncApi, transactionsApi } from '../../lib/api';
import { getOnboardingPlan, type OnboardingStep } from '../../lib/onboarding';
import { ProgressBar } from '../../components/balance';

/**
 * What `/onboarding` was, folded into Settings.
 *
 * The route was an orphan: nothing in the app linked to it, and in an always-logged-in single-owner
 * app there is no moment at which a welcome screen is the thing on screen. It is folded rather than
 * deleted because the reading underneath it is not a welcome, it is a status: which of credentials,
 * a source, a sync and the review queue are not done yet. That is a Settings question, and it is
 * asked more than once, because a connection can lapse long after the first week.
 *
 * What was dropped with the screen: the "Welcome to Mizān" heading, the "Skip to dashboard" button
 * and the duplicate list of other ways in (manual account, Coinbase, CSV), all three of which are
 * rows in this same panel. `getOnboardingPlan` is unchanged and still the only thing deciding what
 * is done.
 */
function StepRow({ step, index, last }: { step: OnboardingStep; index: number; last: boolean }) {
  const complete = step.status === 'complete';
  const active = step.status === 'active';

  return (
    <Link
      to={step.route}
      className={`flex items-baseline gap-4 py-3 transition-colors hover:bg-well ${
        last ? '' : 'border-b border-line'
      }`}
    >
      <span
        className={`w-5 flex-shrink-0 text-center font-serif text-body-lg ${
          complete ? 'text-sage-deep' : active ? 'text-ink' : 'text-muted'
        }`}
      >
        {complete ? <Check size={13} className="mx-auto" aria-label="done" /> : index + 1}
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block text-body-lg ${complete ? 'text-muted line-through decoration-line-3' : 'text-ink'}`}>
          {step.label}
        </span>
        <span className="mt-0.5 block text-note leading-normal text-muted">{step.detail}</span>
      </span>
      {active && <span className="flex-shrink-0 text-note text-sage-deep">{step.actionLabel}</span>}
    </Link>
  );
}

/** The plan, or null while any of its four inputs is still loading. */
export function useSetupPlan() {
  const { data: accounts, isLoading: accountsLoading } = useQuery({
    queryKey: ['accounts'],
    queryFn: accountsApi.list,
  });
  const { data: credentials, isLoading: credentialsLoading } = useQuery({
    queryKey: ['credential-status'],
    queryFn: settingsApi.getCredentials,
  });
  const { data: syncHealth, isLoading: syncLoading } = useQuery({
    queryKey: ['sync', 'health'],
    queryFn: syncApi.health,
  });
  const { data: reviewSummary, isLoading: reviewLoading } = useQuery({
    queryKey: ['transactions', 'review'],
    queryFn: transactionsApi.review,
  });

  if (accountsLoading || credentialsLoading || syncLoading || reviewLoading) return null;

  return getOnboardingPlan({
    accountCount: (accounts ?? []).filter((account) => !account.is_hidden).length,
    credentialStatus: credentials,
    syncHealth,
    reviewSummary,
  });
}

export function SetupSection() {
  const plan = useSetupPlan();
  if (!plan) return <p className="text-body text-muted">Reading what is set up…</p>;

  return (
    <div>
      <div className="mb-4 flex items-center gap-4">
        <ProgressBar
          fraction={plan.percentComplete / 100}
          tone="sage"
          height={6}
          className="max-w-[220px] flex-1"
        />
        <span className="text-body tabular-nums text-muted">
          {plan.completedCount} of {plan.totalCount} done
        </span>
      </div>
      {plan.steps.map((step, index) => (
        <StepRow key={step.id} step={step} index={index} last={index === plan.steps.length - 1} />
      ))}
    </div>
  );
}
