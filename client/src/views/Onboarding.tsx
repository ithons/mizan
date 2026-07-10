import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { accountsApi, settingsApi, syncApi, transactionsApi } from '../lib/api';
import { getOnboardingPlan, type OnboardingStep } from '../lib/onboarding';
import { PageLoader } from '../components/LoadingSpinner';
import { SyncActivityPanel } from '../components/SyncActivityPanel';
import { Screen, ProgressBar, InkButton, TextButton } from '../components/balance';

function StepRow({ step, index, last, onSelect }: {
  step: OnboardingStep;
  index: number;
  last: boolean;
  onSelect: (route: string) => void;
}) {
  const active = step.status === 'active';
  const complete = step.status === 'complete';

  return (
    <button
      type="button"
      onClick={() => onSelect(step.route)}
      className={`flex w-full items-baseline gap-5 px-1 py-4 text-left transition-colors hover:bg-rail ${
        last ? '' : 'border-b border-line'
      } ${active ? '' : ''}`}
    >
      <span
        className={`w-6 flex-shrink-0 text-center font-serif text-[17px] ${
          complete ? 'text-sage' : active ? 'text-ink' : 'text-muted-2'
        }`}
      >
        {complete ? '✓' : index + 1}
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block text-[15.5px] ${complete ? 'text-muted line-through decoration-line-3' : 'text-ink'}`}>
          {step.label}
        </span>
        <span className="mt-0.5 block text-[13px] leading-normal text-muted-2">{step.detail}</span>
      </span>
      {active && <span className="flex-shrink-0 text-[13px] text-sage-deep">{step.actionLabel} →</span>}
    </button>
  );
}

export function Onboarding() {
  const navigate = useNavigate();

  const { data: accounts = [], isLoading: accountsLoading } = useQuery({
    queryKey: ['accounts', 'onboarding'],
    queryFn: accountsApi.list,
  });
  const { data: credentials, isLoading: credentialsLoading } = useQuery({
    queryKey: ['credential-status', 'onboarding'],
    queryFn: settingsApi.getCredentials,
  });
  const { data: syncHealth, isLoading: syncLoading } = useQuery({
    queryKey: ['sync', 'health', 'onboarding'],
    queryFn: syncApi.health,
  });
  const { data: reviewSummary, isLoading: reviewLoading } = useQuery({
    queryKey: ['transactions', 'review', 'onboarding'],
    queryFn: transactionsApi.review,
  });
  const { data: syncRuns } = useQuery({
    queryKey: ['sync', 'history', 'onboarding'],
    queryFn: () => syncApi.history(4),
  });

  if (accountsLoading || credentialsLoading || syncLoading || reviewLoading) {
    return <PageLoader />;
  }

  const visibleAccounts = accounts.filter((account) => !account.is_hidden);
  const plan = getOnboardingPlan({
    accountCount: visibleAccounts.length,
    credentialStatus: credentials,
    syncHealth,
    reviewSummary,
  });
  const current = plan.currentStep;

  return (
    <Screen size="editorial">
      <div className="mz-stagger">
        <h1 className="font-serif text-[32px] font-light leading-tight text-ink">
          Welcome to Mizān.
        </h1>
        <p className="mt-2 max-w-[480px] text-[15px] leading-relaxed text-muted">
          A few steps and your money is in one calm place — on your machine, no account, no cloud.
        </p>

        <div className="mt-8 flex items-center gap-4">
          <ProgressBar fraction={plan.percentComplete / 100} tone="sage" height={6} className="max-w-[220px] flex-1" />
          <span className="text-[13px] tabular-nums text-muted">
            {plan.completedCount} of {plan.totalCount} done
          </span>
        </div>

        <div className="mt-8">
          {plan.steps.map((step, index) => (
            <StepRow
              key={step.id}
              step={step}
              index={index}
              last={index === plan.steps.length - 1}
              onSelect={navigate}
            />
          ))}
        </div>

        <div className="mt-8 flex items-center gap-6">
          <InkButton onClick={() => navigate(current.route)}>{current.actionLabel}</InkButton>
          <TextButton onClick={() => navigate('/')}>Skip to dashboard →</TextButton>
        </div>

        <div className="mt-10 border-t border-line-2 pt-5 text-[13px] text-muted">
          Other ways in:{' '}
          <button type="button" onClick={() => navigate('/accounts?manual=1')} className="text-ink underline underline-offset-2">
            manual account
          </button>
          {' · '}
          <button type="button" onClick={() => navigate('/settings?section=coinbase')} className="text-ink underline underline-offset-2">
            Coinbase
          </button>
          {' · '}
          <button type="button" onClick={() => navigate('/settings?section=data')} className="text-ink underline underline-offset-2">
            CSV import
          </button>
        </div>

        {syncRuns && syncRuns.length > 0 && (
          <div className="mt-8">
            <SyncActivityPanel runs={syncRuns} />
          </div>
        )}
      </div>
    </Screen>
  );
}
