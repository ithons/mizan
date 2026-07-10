import type {
  CredentialStatus,
  SyncHealth,
  TransactionReviewSummary,
} from '@shared/types';

export type OnboardingStepId =
  | 'credentials'
  | 'source'
  | 'sync'
  | 'review'
  | 'dashboard';

export type OnboardingStepStatus = 'complete' | 'active' | 'pending';

export interface OnboardingPlanInput {
  accountCount: number;
  credentialStatus?: CredentialStatus;
  syncHealth?: SyncHealth;
  reviewSummary?: TransactionReviewSummary;
}

export interface OnboardingStep {
  id: OnboardingStepId;
  label: string;
  detail: string;
  status: OnboardingStepStatus;
  route: string;
  actionLabel: string;
}

export interface OnboardingPlan {
  steps: OnboardingStep[];
  currentStep: OnboardingStep;
  completedCount: number;
  totalCount: number;
  percentComplete: number;
}

function stepStatus(done: boolean, active: boolean): OnboardingStepStatus {
  if (done) return 'complete';
  return active ? 'active' : 'pending';
}

export function getOnboardingPlan({
  accountCount,
  credentialStatus,
  syncHealth,
  reviewSummary,
}: OnboardingPlanInput): OnboardingPlan {
  const hasCredentials = credentialStatus?.simplefin ?? false;
  const hasSource = accountCount > 0;
  const hasLiveConnection = (syncHealth?.connection_count ?? 0) > 0;
  const syncNeedsAttention = syncHealth?.status === 'attention' || syncHealth?.status === 'stale';
  const syncReady = hasSource && (!hasLiveConnection || (syncHealth?.status === 'healthy' && !syncNeedsAttention));
  const reviewCount = reviewSummary?.total_open ?? 0;
  const reviewReady = syncReady && reviewCount === 0;

  const credentialsDone = hasCredentials || hasSource;
  const sourceDone = hasSource;
  const syncDone = syncReady;
  const reviewDone = reviewReady;

  const firstOpenId: OnboardingStepId =
    !credentialsDone ? 'credentials'
      : !sourceDone ? 'source'
        : !syncDone ? 'sync'
          : !reviewDone ? 'review'
            : 'dashboard';

  const steps: OnboardingStep[] = [
    {
      id: 'credentials',
      label: 'Credentials',
      detail: hasCredentials
        ? 'SimpleFIN is configured for live bank connections.'
        : 'Configure SimpleFIN, or start with a manual account or CSV import.',
      status: stepStatus(credentialsDone, firstOpenId === 'credentials'),
      route: '/settings?section=connections',
      actionLabel: 'Open settings',
    },
    {
      id: 'source',
      label: 'First source',
      detail: hasSource
        ? `${accountCount} account${accountCount === 1 ? '' : 's'} available for the first dashboard.`
        : 'Connect a bank, add a manual account, connect Coinbase, or import transactions.',
      status: stepStatus(sourceDone, firstOpenId === 'source'),
      route: '/accounts?connect=bank',
      actionLabel: 'Connect bank',
    },
    {
      id: 'sync',
      label: 'First sync',
      detail: syncDone
        ? hasLiveConnection
          ? 'Connected institutions are fresh enough for the first review.'
          : 'Manual or imported data is ready without provider sync.'
        : syncNeedsAttention
          ? syncHealth?.status_detail ?? 'A connected institution needs attention before the dashboard is trusted.'
          : 'Run or finish the first provider sync.',
      status: stepStatus(syncDone, firstOpenId === 'sync'),
      route: '/accounts',
      actionLabel: syncNeedsAttention ? 'Repair sync' : 'Open sync status',
    },
    {
      id: 'review',
      label: 'First review',
      detail: reviewDone
        ? 'The review queue is clear.'
        : `${reviewCount} review item${reviewCount === 1 ? '' : 's'} need confirmation before the dashboard is trusted.`,
      status: stepStatus(reviewDone, firstOpenId === 'review'),
      route: '/transactions',
      actionLabel: 'Review transactions',
    },
    {
      id: 'dashboard',
      label: 'Dashboard',
      detail: reviewDone
        ? 'Your first trusted dashboard is ready.'
        : 'The dashboard unlocks once source, sync, and review are complete.',
      status: firstOpenId === 'dashboard' ? 'active' : 'pending',
      route: '/',
      actionLabel: 'Go to dashboard',
    },
  ];

  const completedCount = steps.filter((step) => step.status === 'complete').length;
  const totalCount = steps.length;
  const currentStep = steps.find((step) => step.status === 'active') ?? steps[steps.length - 1];

  return {
    steps,
    currentStep,
    completedCount,
    totalCount,
    percentComplete: Math.round((completedCount / totalCount) * 100),
  };
}
