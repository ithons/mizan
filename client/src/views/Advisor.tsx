import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import type { AdvisorDraftAction } from '@shared/types';
import { accountsApi, aiApi, budgetsApi, goalsApi, networthApi, recurringApi, reportsApi, transactionsApi } from '../lib/api';
import { formatWholeCurrency } from '../lib/formatters';
import { computeSafeToSpend } from '../lib/safeToSpend';
import { isAdvisorRouteState } from '../lib/advisorRouteState';
import { useAiChat, type DisplayMessage } from '../hooks/useAiChat';
import { useAppStore } from '../store';
import { Screen, ScreenHeader, SectionLabel, TextButton } from '../components/balance';

const FALLBACK_PROMPTS = [
  'Where can I cut $200 a month?',
  'Am I on track for my goals?',
  'Summarize my spending this month',
];

function AssistantMessage({ message, onConfirmDraft, confirming }: {
  message: DisplayMessage;
  onConfirmDraft: (draft: AdvisorDraftAction) => void;
  confirming: boolean;
}) {
  const drafts = message.analysis?.drafts ?? [];
  const citations = message.analysis?.citations ?? [];

  return (
    <div className="mb-5 flex gap-3.5">
      <span
        className="mt-1 h-7 w-7 flex-shrink-0 rounded-full"
        style={{ background: 'radial-gradient(circle at 38% 34%, var(--mz-sage-soft), var(--mz-sage))' }}
      />
      <div className="min-w-0 flex-1">
        {message.thinkingActive && (
          <div className="mb-1.5 animate-pulse text-[13px] italic text-muted">Thinking…</div>
        )}
        {message.thinking && !message.thinkingActive && (
          <details className="mb-1.5">
            <summary className="cursor-pointer list-none text-[12.5px] text-muted-2 transition-colors hover:text-muted">
              Thought for a moment ›
            </summary>
            <div className="mt-1.5 whitespace-pre-wrap border-l border-line-2 pl-3 text-[13px] leading-relaxed text-muted">
              {message.thinking}
            </div>
          </details>
        )}
        <div className="text-[15.5px] leading-[1.65] text-ink [&_a]:text-sage-deep [&_a]:underline [&_code]:rounded [&_code]:bg-rail [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[13px] [&_h1]:mt-4 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:font-semibold [&_hr]:my-3 [&_hr]:border-line [&_li]:mb-1 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-3 [&_p:last-child]:mb-0 [&_strong]:font-semibold [&_table]:my-2 [&_table]:w-full [&_td]:border-b [&_td]:border-line-2 [&_td]:py-1 [&_th]:border-b [&_th]:border-line [&_th]:py-1 [&_th]:text-left [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
            {message.content}
          </ReactMarkdown>
          {message.streaming && (
            <span className="ml-0.5 inline-block h-[18px] w-[2px] translate-y-[3px] bg-sage" style={{ animation: 'mz-blink 1.1s step-end infinite' }} />
          )}
        </div>
        {drafts.length > 0 && !message.streaming && (
          <div className="mt-3.5 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            {drafts.map((draft) => (
              <button
                key={draft.id}
                type="button"
                disabled={confirming}
                onClick={() => onConfirmDraft(draft)}
                className="border-b border-ink pb-0.5 text-ink transition-opacity hover:opacity-75 disabled:opacity-40"
              >
                {draft.label}
              </button>
            ))}
          </div>
        )}
        {citations.length > 0 && !message.streaming && (
          <div className="mt-3.5 text-xs text-muted-2">
            Based on {citations.slice(0, 3).map((c) => c.label.toLowerCase()).join(', ')}
            {citations.length > 3 ? ` and ${citations.length - 3} more` : ''}.
          </div>
        )}
      </div>
    </div>
  );
}

function ConversationHistory({ activeId, onSelect }: { activeId: string | null; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const { data: conversations } = useQuery({
    queryKey: ['ai-conversations'],
    queryFn: () => aiApi.listConversations(),
    enabled: open,
  });
  return (
    <div className="relative">
      <TextButton onClick={() => setOpen((v) => !v)}>History</TextButton>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-2 max-h-80 w-72 overflow-auto rounded-xl border border-line-2 bg-card p-1 shadow-lg">
            {(!conversations || conversations.length === 0) && (
              <div className="px-3 py-3 text-[13px] text-muted-2">No past conversations.</div>
            )}
            {conversations?.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => { onSelect(c.id); setOpen(false); }}
                className={`block w-full truncate rounded-lg px-3 py-2 text-left text-[13.5px] transition-colors hover:bg-rail ${c.id === activeId ? 'text-ink' : 'text-muted'}`}
              >
                {c.title || 'Untitled chat'}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function Advisor() {
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const { messages, isStreaming, conversationId, sendMessage, stopStreaming, clearChat, loadConversation } = useAiChat();

  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const handledRoutePrompt = useRef(false);

  const currentMonth = format(new Date(), 'yyyy-MM');
  const { data: context } = useQuery({ queryKey: ['ai-context'], queryFn: () => aiApi.getContext() });
  const { data: snapshot } = useQuery({ queryKey: ['networth', 'snapshot'], queryFn: () => networthApi.snapshot(), retry: false });
  const { data: cashflow } = useQuery({ queryKey: ['cashflow', 'advisor'], queryFn: () => reportsApi.cashflow() });
  const { data: reviewSummary } = useQuery({ queryKey: ['transactions', 'review'], queryFn: () => transactionsApi.review() });
  const { data: forecast } = useQuery({ queryKey: ['recurring', 'forecast', 30], queryFn: () => recurringApi.forecast(30) });
  const { data: budgets } = useQuery({ queryKey: ['budgets', currentMonth], queryFn: () => budgetsApi.getMonth(currentMonth) });
  const { data: goals } = useQuery({ queryKey: ['goals'], queryFn: () => goalsApi.list() });
  const { data: accounts } = useQuery({ queryKey: ['accounts'], queryFn: () => accountsApi.list() });

  // Prefill from cross-view "Ask advisor" navigations.
  useEffect(() => {
    if (handledRoutePrompt.current) return;
    if (isAdvisorRouteState(location.state)) {
      handledRoutePrompt.current = true;
      setInput(location.state.advisorPrompt.prompt);
      navigate(location.pathname, { replace: true });
    }
  }, [location, navigate]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const confirmDraft = useMutation({
    mutationFn: (draft: AdvisorDraftAction) => aiApi.confirmDraft(draft),
    onSuccess: (res) => {
      addToast({ type: 'success', message: res.message || 'Applied.' });
      qc.invalidateQueries();
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const send = (text: string) => {
    if (!text.trim() || isStreaming) return;
    setInput('');
    void sendMessage(text);
  };

  const suggestions = useMemo(() => {
    const actions = (context?.actions ?? []).slice(0, 3).map((a) => a.prompt);
    return actions.length > 0 ? actions : FALLBACK_PROMPTS;
  }, [context]);

  const monthCF = (cashflow?.months ?? []).find((m) => m.month === currentMonth);
  const safeToSpend = computeSafeToSpend({ snapshot, forecast, budgets, goals });

  const contextRows = [
    { label: 'Net worth', value: formatWholeCurrency(snapshot?.net_worth ?? 0) },
    { label: 'Safe to spend', value: formatWholeCurrency(safeToSpend) },
    { label: 'This month spend', value: formatWholeCurrency(Math.abs(monthCF?.expenses ?? 0)) },
    { label: 'Accounts', value: String((accounts ?? []).filter((a) => !a.is_hidden).length) },
    { label: 'To review', value: String(reviewSummary?.total_open ?? 0) },
  ];

  return (
    <Screen size="wide" contained>
      <ScreenHeader
        title="Advisor"
        sub={
          context?.configured
            ? 'Runs on your machine · sends data to the model only when you ask'
            : 'Local heuristics only · add an Anthropic API key in Settings for conversational answers'
        }
        actions={
          <div className="flex items-center gap-4">
            <ConversationHistory activeId={conversationId} onSelect={loadConversation} />
            {messages.length > 0 && <TextButton onClick={clearChat}>+ New chat</TextButton>}
          </div>
        }
        className="mb-6"
      />

      <div className="flex min-h-0 flex-1 flex-col gap-10 lg:flex-row lg:gap-12">
        {/* Conversation */}
        <div className="flex min-h-[50vh] min-w-0 max-w-[760px] flex-1 flex-col">
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto pr-2">
            {messages.length === 0 && (
              <div className="pt-4 font-serif text-[19px] font-light leading-relaxed text-muted">
                Ask anything about your money. Answers come from your own data,
                on your own machine.
              </div>
            )}
            {messages.map((m) =>
              m.role === 'user' ? (
                <div key={m.id} className="mb-6 flex justify-end">
                  <div className="max-w-[72%] rounded-[14px] rounded-br-[4px] bg-rail px-4 py-3 text-[14.5px] text-ink">{m.content}</div>
                </div>
              ) : (
                <AssistantMessage key={m.id} message={m} onConfirmDraft={(d) => confirmDraft.mutate(d)} confirming={confirmDraft.isPending} />
              )
            )}
          </div>

          {/* Suggestions + input */}
          <div className="mt-4 flex-shrink-0">
            {messages.length === 0 && (
              <div className="mb-4 flex flex-wrap gap-x-5 gap-y-2 text-[13px] text-muted">
                {suggestions.map((p) => (
                  <button key={p} type="button" onClick={() => send(p)} className="transition-colors hover:text-ink">
                    {p}
                  </button>
                ))}
              </div>
            )}
            <form
              className="flex items-center gap-3 border-t border-line-3 px-0.5 py-4"
              onSubmit={(e) => {
                e.preventDefault();
                send(input);
              }}
            >
              <span className="h-[7px] w-[7px] flex-shrink-0 rounded-full bg-sage" />
              <input
                className="w-full border-none bg-transparent p-0 text-[15.5px] text-ink placeholder:text-muted-2 focus:outline-none focus:ring-0"
                placeholder="Ask about your money"
                value={input}
                onChange={(e) => setInput(e.target.value)}
              />
              {isStreaming ? (
                <TextButton onClick={stopStreaming} className="flex-shrink-0">
                  Stop
                </TextButton>
              ) : input ? (
                <button type="submit" className="flex-shrink-0 text-[13.5px] text-ink transition-opacity hover:opacity-75">
                  Ask
                </button>
              ) : (
                <span className="inline-block h-[18px] w-[2px] flex-shrink-0 bg-sage" style={{ animation: 'mz-blink 1.1s step-end infinite' }} />
              )}
            </form>
          </div>
        </div>

        {/* Context card */}
        <div className="w-full flex-shrink-0 self-start border-t border-line-2 pt-6 lg:sticky lg:top-6 lg:w-[240px] lg:border-t-0 lg:pt-0">
          <SectionLabel className="mb-4">Context</SectionLabel>
          {contextRows.map((row, i) => (
            <div
              key={row.label}
              className={`flex justify-between py-[9px] ${i < contextRows.length - 1 ? 'border-b border-line' : ''}`}
            >
              <span className="text-[13.5px] text-muted">{row.label}</span>
              <span className="text-sm tabular-nums text-ink">{row.value}</span>
            </div>
          ))}
          <div className="mt-4 text-xs leading-[1.55] text-muted-2">
            This snapshot stays on your machine. A question sends only what's needed to answer it.
          </div>
        </div>
      </div>
    </Screen>
  );
}
