import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  CheckCircle2,
  Circle,
  CreditCard,
  Database,
  FileInput,
  LayoutDashboard,
  RefreshCw,
  Settings,
  Wallet,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { accountsApi, settingsApi, syncApi, transactionsApi } from '../lib/api';
import { getOnboardingPlan, type OnboardingStep, type OnboardingStepId } from '../lib/onboarding';
import { PageLoader } from '../components/LoadingSpinner';
import { SyncActivityPanel } from '../components/SyncActivityPanel';

const STEP_ICONS: Record<OnboardingStepId, LucideIcon> = {
  credentials: Settings,
  source: CreditCard,
  sync: RefreshCw,
  review: CheckCircle2,
  dashboard: LayoutDashboard,
};

function stepTone(step: OnboardingStep): string {
  if (step.status === 'complete') return '#c9963a';
  if (step.status === 'active') return '#7c8b99';
  return '#7a6c5d';
}

function OnboardingStepRow({ step, index, onSelect }: {
  step: OnboardingStep;
  index: number;
  onSelect: (route: string) => void;
}) {
  const Icon = STEP_ICONS[step.id];
  const tone = stepTone(step);
  const StatusIcon = step.status === 'complete' ? CheckCircle2 : Circle;

  return (
    <button
      className={`w-full text-left rounded border px-4 py-3 transition-colors ${
        step.status === 'active'
          ? 'border-info/40 bg-info/10'
          : 'border-border bg-surface hover:bg-positive/5'
      }`}
      onClick={() => onSelect(step.route)}
    >
      <div className="flex items-start gap-3">
        <div
          className="w-8 h-8 rounded flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: `${tone}18`, color: tone }}
        >
          <Icon size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-text">
              {index + 1}. {step.label}
            </p>
            <StatusIcon size={14} style={{ color: tone }} />
          </div>
          <p className="text-xs text-muted leading-relaxed mt-1">{step.detail}</p>
        </div>
      </div>
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
  const CurrentIcon = STEP_ICONS[current.id];

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-text">First Setup</h1>
          <p className="text-sm text-muted mt-1">
            {plan.completedCount} of {plan.totalCount} setup steps complete
          </p>
        </div>
        <button
          className="flex items-center gap-1.5 text-xs text-muted hover:text-positive"
          onClick={() => navigate('/')}
        >
          Dashboard <ArrowRight size={11} />
        </button>
      </div>

      <div className="h-2 rounded-full bg-border overflow-hidden">
        <div
          className="h-full bg-positive transition-all"
          style={{ width: `${plan.percentComplete}%` }}
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-5">
        <div className="space-y-3">
          {plan.steps.map((step, index) => (
            <OnboardingStepRow
              key={step.id}
              step={step}
              index={index}
              onSelect={navigate}
            />
          ))}
        </div>

        <div className="space-y-4">
          <div className="border border-border bg-surface rounded p-4">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded bg-info/10 text-info flex items-center justify-center flex-shrink-0">
                <CurrentIcon size={17} />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-text">{current.label}</p>
                <p className="text-xs text-muted leading-relaxed mt-1">{current.detail}</p>
              </div>
            </div>
            <button
              className="mt-4 w-full flex items-center justify-center gap-2 rounded bg-text text-surface px-3 py-2 text-sm font-medium hover:opacity-90"
              onClick={() => navigate(current.route)}
            >
              {current.actionLabel} <ArrowRight size={13} />
            </button>
          </div>

          <div className="border border-border bg-surface rounded p-4">
            <p className="text-xs text-muted mb-3">Other entry points</p>
            <div className="grid grid-cols-1 gap-2">
              <button
                className="flex items-center justify-between gap-3 rounded border border-border px-3 py-2 text-sm text-text hover:bg-positive/5"
                onClick={() => navigate('/accounts?manual=1')}
              >
                <span className="flex items-center gap-2"><Database size={14} /> Manual account</span>
                <ArrowRight size={12} className="text-muted" />
              </button>
              <button
                className="flex items-center justify-between gap-3 rounded border border-border px-3 py-2 text-sm text-text hover:bg-positive/5"
                onClick={() => navigate('/settings?section=coinbase')}
              >
                <span className="flex items-center gap-2"><Wallet size={14} /> Coinbase</span>
                <ArrowRight size={12} className="text-muted" />
              </button>
              <button
                className="flex items-center justify-between gap-3 rounded border border-border px-3 py-2 text-sm text-text hover:bg-positive/5"
                onClick={() => navigate('/settings?section=data')}
              >
                <span className="flex items-center gap-2"><FileInput size={14} /> CSV import</span>
                <ArrowRight size={12} className="text-muted" />
              </button>
            </div>
          </div>

          <div className="border border-border bg-surface rounded p-4">
            <p className="text-xs text-muted mb-3">Current state</p>
            <div className="space-y-2 text-xs">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted">SimpleFIN</span>
                <span className="font-mono text-text">{credentials?.simplefin ? 'configured' : 'not configured'}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted">Accounts</span>
                <span className="font-mono text-text">{visibleAccounts.length}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted">Sync</span>
                <span className="font-mono text-text">{syncHealth?.status_label ?? 'Unknown'}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted">Review</span>
                <span className="font-mono text-text">{reviewSummary?.total_open ?? 0} open</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <SyncActivityPanel runs={syncRuns} />
    </div>
  );
}
