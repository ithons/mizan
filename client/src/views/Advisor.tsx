import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Send,
  Square,
  Trash2,
  ChevronDown,
  ChevronRight,
  BrainCircuit,
  RefreshCw,
  AlertTriangle,
  Check,
} from 'lucide-react';
import type {
  AdvisorAction,
  AdvisorAnalysis,
  AdvisorDraftAction,
  AdvisorToolStatus,
  DataQualitySummary,
  Insight,
} from '@shared/types';
import { aiApi, insightsApi } from '../lib/api';
import { useAiChat } from '../hooks/useAiChat';
import { formatRelativeTime } from '../lib/formatters';

// ── Simple inline markdown renderer ──────────────────────────────────────────

function renderMarkdown(text: string): React.ReactNode[] {
  const lines = text.split('\n');
  const result: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('### ')) {
      result.push(<h3 key={i} className="text-sm font-semibold text-text mt-3 mb-1">{line.slice(4)}</h3>);
    } else if (line.startsWith('## ')) {
      result.push(<h2 key={i} className="text-sm font-semibold text-text mt-3 mb-1">{line.slice(3)}</h2>);
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      result.push(
        <li key={i} className="ml-4 list-disc text-sm">
          {inlineFormat(line.slice(2))}
        </li>
      );
    } else if (line === '') {
      result.push(<div key={i} className="h-2" />);
    } else {
      result.push(<p key={i} className="text-sm">{inlineFormat(line)}</p>);
    }
    i++;
  }

  return result;
}

function inlineFormat(text: string): React.ReactNode {
  // Handle **bold** and `code`
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} className="font-semibold text-text">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={i} className="font-mono text-xs bg-white/10 px-1 py-0.5 rounded">{part.slice(1, -1)}</code>;
    }
    return part;
  });
}

// ── Context Panel ─────────────────────────────────────────────────────────────

function ContextPanel() {
  const [open, setOpen] = useState(false);
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['ai-context'],
    queryFn: aiApi.getContext,
    staleTime: 5 * 60 * 1000,
  });

  return (
    <div className="border border-border rounded-lg overflow-hidden flex-shrink-0">
      <button
        className="w-full flex items-center gap-2 px-3 py-2.5 text-xs text-muted hover:text-text hover:bg-white/5 transition-colors"
        onClick={() => setOpen((p) => !p)}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span className="flex-1 text-left">Local advisor context</span>
        <button
          onClick={(e) => { e.stopPropagation(); refetch(); }}
          className="p-1 rounded hover:bg-white/10 transition-colors"
          title="Refresh context"
        >
          <RefreshCw size={11} className={isLoading ? 'animate-spin' : ''} />
        </button>
      </button>
      {open && (
        <pre className="px-3 py-2 text-[11px] font-mono text-muted whitespace-pre-wrap border-t border-border bg-surface/50 max-h-64 overflow-y-auto leading-relaxed">
          {isLoading ? 'Loading...' : (data?.context ?? 'No context available')}
        </pre>
      )}
    </div>
  );
}

const actionTone: Record<AdvisorAction['severity'], string> = {
  critical: '#e07070',
  warning: '#d4a44c',
  positive: '#4ecba3',
  info: '#5b8dee',
};

const qualityTone: Record<DataQualitySummary['status'], string> = {
  healthy: '#4ecba3',
  review: '#5b8dee',
  stale: '#d4a44c',
  attention: '#e07070',
};

const toolTone: Record<AdvisorToolStatus['status'], string> = {
  available: '#4ecba3',
  empty: '#6b6b7a',
  attention: '#d4a44c',
};

function AdvisorActionsPanel({
  actions,
  onAsk,
}: {
  actions?: AdvisorAction[];
  onAsk: (prompt: string) => void;
}) {
  const navigate = useNavigate();
  const visibleActions = actions ?? [];

  if (visibleActions.length === 0) return null;

  return (
    <div className="border border-border rounded-lg overflow-hidden flex-shrink-0">
      <div className="px-3 py-2.5 border-b border-border">
        <p className="text-xs text-muted font-medium">Suggested Actions</p>
      </div>
      <div className="divide-y divide-border">
        {visibleActions.map((action) => (
          <div key={action.id} className="px-3 py-2.5">
            <div className="flex items-center gap-2 mb-1">
              <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: actionTone[action.severity] }} />
              <p className="text-xs text-text font-medium">{action.label}</p>
            </div>
            <p className="text-[11px] text-muted leading-relaxed mb-2">{action.reason}</p>
            <div className="flex gap-2">
              <button
                className="text-[11px] text-muted hover:text-[#4ecba3]"
                onClick={() => onAsk(action.prompt)}
              >
                Ask
              </button>
              <button
                className="text-[11px] text-muted hover:text-text flex items-center gap-1"
                onClick={() => navigate(action.route)}
              >
                Open <ArrowRight size={10} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DataFreshnessPanel({
  statusLabel,
  statusDetail,
  lastSyncedAt,
}: {
  statusLabel?: string;
  statusDetail?: string;
  lastSyncedAt?: string | null;
}) {
  return (
    <div className="border border-border rounded-lg px-3 py-2.5">
      <p className="text-xs text-muted font-medium mb-1">Data Freshness</p>
      <p className="text-xs text-text">{statusLabel ?? 'Unknown'}</p>
      <p className="text-[11px] text-muted leading-relaxed mt-1">{statusDetail ?? 'Context has not loaded yet.'}</p>
      {lastSyncedAt && (
        <p className="text-[11px] text-muted font-mono mt-2">Last sync {formatRelativeTime(lastSyncedAt)}</p>
      )}
    </div>
  );
}

function AdvisorToolsPanel({ tools }: { tools?: AdvisorToolStatus[] }) {
  if (!tools || tools.length === 0) return null;

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div className="px-3 py-2.5 border-b border-border">
        <p className="text-xs text-muted font-medium">Read Tools</p>
      </div>
      <div className="divide-y divide-border">
        {tools.map((tool) => (
          <Link
            key={tool.id}
            to={tool.route}
            className="flex items-center justify-between gap-3 px-3 py-2 text-xs hover:bg-white/5 transition-colors"
          >
            <span className="text-text">{tool.label}</span>
            <span className="font-mono" style={{ color: toolTone[tool.status] }}>
              {tool.count}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

function AdvisorQualityPanel({
  quality,
  onAsk,
}: {
  quality?: DataQualitySummary;
  onAsk: (prompt: string) => void;
}) {
  const navigate = useNavigate();
  const tone = quality ? qualityTone[quality.status] : '#6b6b7a';
  const visibleIssues = quality?.issues.slice(0, 2) ?? [];

  return (
    <div className="border border-border rounded-lg px-3 py-2.5">
      <div className="flex items-center justify-between gap-3 mb-1">
        <p className="text-xs text-muted font-medium">Data Quality</p>
        <span className="font-mono text-xs" style={{ color: tone }}>
          {quality ? quality.score : '--'}
        </span>
      </div>
      <p className="text-xs text-text">{quality?.status_label ?? 'Checking'}</p>
      <p className="text-[11px] text-muted leading-relaxed mt-1">
        {quality?.status_detail ?? 'Checking the data behind advisor answers.'}
      </p>
      {visibleIssues.length > 0 && (
        <div className="mt-2 space-y-2">
          {visibleIssues.map((issue) => (
            <div key={issue.id} className="border-t border-border pt-2">
              <p className="text-[11px] text-text">{issue.label}</p>
              <p className="text-[11px] text-muted leading-relaxed mt-0.5">{issue.message}</p>
              <div className="flex gap-2 mt-1.5">
                <button
                  className="text-[11px] text-muted hover:text-[#4ecba3]"
                  onClick={() => onAsk(`What should I do about this data quality issue: ${issue.label}?`)}
                >
                  Ask
                </button>
                <button
                  className="text-[11px] text-muted hover:text-text flex items-center gap-1"
                  onClick={() => navigate(issue.route)}
                >
                  Open <ArrowRight size={10} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Message Bubble ────────────────────────────────────────────────────────────

function draftValue(value: string | number | boolean | null): string {
  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return value;
}

function DraftActionsList({ drafts }: { drafts?: AdvisorDraftAction[] }) {
  const queryClient = useQueryClient();
  const [appliedIds, setAppliedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: aiApi.confirmDraft,
    onSuccess: (response) => {
      setAppliedIds((prev) => new Set(prev).add(response.draft.id));
      setError(null);
      void queryClient.invalidateQueries();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Could not apply draft');
    },
  });

  if (!drafts || drafts.length === 0) return null;

  return (
    <div className="mt-3 space-y-2">
      {drafts.map((draft) => {
        const applied = appliedIds.has(draft.id);
        const pending = mutation.isPending && mutation.variables?.id === draft.id;

        return (
          <div key={draft.id} className="border border-border rounded bg-background/40 px-3 py-2.5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs text-text font-medium">{draft.label}</p>
                <p className="text-[11px] text-muted leading-relaxed mt-0.5">{draft.summary}</p>
              </div>
              <button
                onClick={() => mutation.mutate(draft)}
                disabled={applied || pending}
                className="flex items-center gap-1.5 text-[11px] text-[#4ecba3] border border-[#4ecba3]/30 rounded px-2 py-1 hover:bg-[#4ecba3]/10 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {applied ? <Check size={12} /> : null}
                {applied ? 'Applied' : pending ? 'Applying' : 'Apply'}
              </button>
            </div>
            <div className="mt-2 grid grid-cols-1 gap-1">
              {draft.changes.map((change) => (
                <div key={`${draft.id}:${change.field}`} className="flex items-center justify-between gap-3 text-[11px]">
                  <span className="text-muted">{change.field}</span>
                  <span className="font-mono text-text text-right">
                    {draftValue(change.before)} to {draftValue(change.after)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
      {error && <p className="text-[11px] text-[#e07070]">{error}</p>}
    </div>
  );
}

function CitationList({ analysis }: { analysis?: AdvisorAnalysis }) {
  const citations = analysis?.citations ?? [];
  if (citations.length === 0) return null;

  return (
    <div className="mt-3 pt-2 border-t border-border">
      <p className="text-[11px] text-muted mb-2">Evidence</p>
      <div className="flex flex-wrap gap-2">
        {citations.map((citation) => {
          const content = (
            <>
              <span className="text-text">{citation.label}</span>
              {citation.detail && <span className="text-muted"> {citation.detail}</span>}
            </>
          );
          const className = "text-[11px] border border-border rounded px-2 py-1 bg-background/40 hover:border-[#4ecba3]/40 transition-colors";

          return citation.route ? (
            <Link key={citation.id} to={citation.route} className={className}>
              {content}
            </Link>
          ) : (
            <span key={citation.id} className={className}>
              {content}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function MessageBubble({
  role,
  content,
  streaming,
  analysis,
}: {
  role: string;
  content: string;
  streaming?: boolean;
  analysis?: AdvisorAnalysis;
}) {
  const isUser = role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
      {!isUser && (
        <div className="w-6 h-6 rounded-full bg-[#4ecba3]/20 border border-[#4ecba3]/30 flex items-center justify-center flex-shrink-0 mt-0.5 mr-2">
          <BrainCircuit size={12} className="text-[#4ecba3]" />
        </div>
      )}
      <div
        className={`max-w-[80%] rounded-xl px-4 py-3 text-sm leading-relaxed ${
          isUser
            ? 'bg-[#4ecba3]/15 border border-[#4ecba3]/25 text-text ml-8'
            : 'bg-surface border border-border text-text'
        }`}
      >
        {isUser ? (
          <p className="text-sm whitespace-pre-wrap">{content}</p>
        ) : (
          <div className="text-muted space-y-0.5">
            {content ? renderMarkdown(content) : null}
            {streaming && !content && (
              <span className="inline-block w-1.5 h-3.5 bg-[#4ecba3] animate-pulse rounded-sm ml-0.5" />
            )}
            {streaming && content && (
              <span className="inline-block w-1.5 h-3.5 bg-[#4ecba3] animate-pulse rounded-sm ml-0.5 align-middle" />
            )}
            {!streaming && <DraftActionsList drafts={analysis?.drafts} />}
            {!streaming && <CitationList analysis={analysis} />}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Advisor Error State ───────────────────────────────────────────────────────

function AdvisorUnavailable() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-8">
      <div className="w-12 h-12 rounded-full bg-[#e07070]/10 flex items-center justify-center">
        <AlertTriangle size={22} className="text-[#e07070]" />
      </div>
      <div>
        <p className="text-sm font-medium text-text mb-1">Advisor context unavailable</p>
        <p className="text-xs text-muted">
          Mizān could not load local financial context. Check the server and retry.
        </p>
      </div>
    </div>
  );
}

// ── Empty State ───────────────────────────────────────────────────────────────

const SUGGESTED_PROMPTS = [
  'Give me an overview of my financial health',
  'What changed in my cash flow this month?',
  'Which transactions or categories need attention?',
  'Am I on track for my goals?',
  'What upcoming bills should I plan for?',
];

function promptForInsight(insight: Insight): string {
  switch (insight.id) {
    case 'connect-accounts':
      return 'What accounts should I connect first to get a complete financial picture?';
    case 'sync-reconnect':
    case 'sync-stale':
      return 'What parts of my financial picture are least trustworthy until sync is fixed?';
    case 'uncategorized-transactions':
      return 'Help me prioritize my uncategorized transactions and explain what reports they affect.';
    case 'confirm-recurring':
      return 'Which recurring bills or income patterns should I confirm first?';
    case 'budget-over':
    case 'budget-tight':
      return 'What should I do about the budget category that needs attention?';
    case 'cash-projection-negative':
    case 'cash-projection-down':
      return 'Explain my upcoming cash flow risk and what I should adjust this month.';
    case 'goal-deadline':
    case 'goal-close':
      return 'Am I on track for my active goals, and what should I do next?';
    default:
      return `What should I do about this signal: ${insight.title}?`;
  }
}

function buildPrompts(insights?: Insight[]): string[] {
  const signalPrompts = (insights ?? []).slice(0, 3).map(promptForInsight);
  return [...signalPrompts, ...SUGGESTED_PROMPTS].slice(0, 5);
}

function EmptyChat({
  onSend,
  insights,
}: {
  onSend: (text: string) => void;
  insights?: Insight[];
}) {
  const prompts = buildPrompts(insights);

  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 px-8">
      <div className="text-center">
        <div className="w-12 h-12 rounded-full bg-[#4ecba3]/10 border border-[#4ecba3]/20 flex items-center justify-center mx-auto mb-3">
          <BrainCircuit size={22} className="text-[#4ecba3]" />
        </div>
        <p className="text-sm font-medium text-text mb-1">AI Financial Advisor</p>
        <p className="text-xs text-muted">Ask questions about your accounts, transactions, budgets, goals, and recurring cash flow.</p>
      </div>
      <div className="w-full max-w-md space-y-2">
        {prompts.map((prompt) => (
          <button
            key={prompt}
            onClick={() => onSend(prompt)}
            className="w-full text-left px-3 py-2 text-xs text-muted hover:text-text bg-surface border border-border hover:border-border/80 rounded-lg transition-colors"
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Main View ─────────────────────────────────────────────────────────────────

export function Advisor() {
  const { messages, isStreaming, sendMessage, stopStreaming, clearChat } = useAiChat();
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { data: contextStatus, isError: contextError } = useQuery({
    queryKey: ['ai-context'],
    queryFn: aiApi.getContext,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  const { data: insights } = useQuery({
    queryKey: ['insights', 'advisor'],
    queryFn: () => insightsApi.list(),
    staleTime: 5 * 60 * 1000,
  });

  const { data: dataQuality } = useQuery({
    queryKey: ['insights', 'quality', 'advisor'],
    queryFn: () => insightsApi.quality(),
    staleTime: 5 * 60 * 1000,
  });

  const contextUnavailable = contextError;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput('');
    textareaRef.current?.focus();
    await sendMessage(text);
  }, [input, isStreaming, sendMessage]);

  const askPrompt = useCallback((prompt: string) => {
    if (isStreaming) return;
    void sendMessage(prompt);
  }, [isStreaming, sendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <BrainCircuit size={16} className="text-[#4ecba3]" />
          <h1 className="text-sm font-medium text-text">AI Advisor</h1>
          <span className="text-xs text-muted font-mono bg-[#4ecba3]/10 border border-[#4ecba3]/20 px-1.5 py-0.5 rounded">
            local tools
          </span>
        </div>
        {messages.length > 0 && (
          <button
            onClick={clearChat}
            className="flex items-center gap-1.5 text-xs text-muted hover:text-[#e07070] transition-colors"
          >
            <Trash2 size={13} />
            Clear
          </button>
        )}
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Chat area */}
        <div className="flex flex-col flex-1 overflow-hidden">
          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-6 py-4">
            {contextUnavailable ? (
              <AdvisorUnavailable />
            ) : messages.length === 0 ? (
              <EmptyChat insights={insights} onSend={askPrompt} />
            ) : (
              <>
                {messages.map((msg) => (
                  <MessageBubble
                    key={msg.id}
                    role={msg.role}
                    content={msg.content}
                    streaming={msg.streaming}
                    analysis={msg.analysis}
                  />
                ))}
                <div ref={bottomRef} />
              </>
            )}
          </div>

          {/* Input */}
          {!contextUnavailable && (
            <div className="px-6 py-4 border-t border-border flex-shrink-0">
              <div className="flex gap-2 items-end">
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask about your finances (Enter to send, Shift+Enter for newline)"
                  rows={2}
                  className="flex-1 bg-surface border border-border rounded-lg px-3 py-2.5 text-sm text-text placeholder-muted resize-none focus:outline-none focus:border-[#4ecba3]/50 transition-colors"
                  disabled={isStreaming}
                />
                {isStreaming ? (
                  <button
                    onClick={stopStreaming}
                    className="flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-lg bg-[#e07070]/15 border border-[#e07070]/30 text-[#e07070] hover:bg-[#e07070]/25 transition-colors"
                    title="Stop"
                  >
                    <Square size={14} />
                  </button>
                ) : (
                  <button
                    onClick={handleSend}
                    disabled={!input.trim()}
                    className="flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-lg bg-[#4ecba3]/15 border border-[#4ecba3]/30 text-[#4ecba3] hover:bg-[#4ecba3]/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    title="Send (Enter)"
                  >
                    <Send size={14} />
                  </button>
                )}
              </div>
              <p className="text-[10px] text-muted/50 mt-1.5">
                Analysis runs locally against Mizān data. Draft changes still require explicit confirmation.
              </p>
            </div>
          )}
        </div>

        {/* Context sidebar */}
        <div className="w-72 border-l border-border p-4 overflow-y-auto flex-shrink-0 hidden lg:flex lg:flex-col gap-3">
          <p className="text-xs text-muted font-medium">Live Context</p>
          <AdvisorQualityPanel quality={dataQuality} onAsk={askPrompt} />
          <DataFreshnessPanel
            statusLabel={contextStatus?.sync_health.status_label}
            statusDetail={contextStatus?.sync_health.status_detail}
            lastSyncedAt={contextStatus?.sync_health.last_synced_at}
          />
          <AdvisorToolsPanel tools={contextStatus?.tools} />
          <AdvisorActionsPanel actions={contextStatus?.actions} onAsk={askPrompt} />
          <ContextPanel />
        </div>
      </div>
    </div>
  );
}
