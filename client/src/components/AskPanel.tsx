import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import type { AdvisorDraftAction } from '@shared/types';
import { aiApi } from '../lib/api';
import { useAppStore } from '../store';
import type { DisplayMessage, AiChat } from '../hooks/useAiChat';
import { TextButton } from './balance';

/**
 * The conversation, inside the ⌘K sheet.
 *
 * This is everything the `/advisor` tab could do, minus the tab. A sidebar was weighed and refused
 * for a reason worth keeping: a sidebar is a second place to look that competes with the screen and
 * answers next to nothing, while a sheet over the current screen inherits that screen's context, so
 * an answer arrives beside the data it is about.
 *
 * What the tab also carried and this does not: a context card repeating net worth, what is free,
 * the month's spend, the account count and the review backlog. Every one of those is on the screen
 * the sheet is sitting over. Reprinting them inside the sheet was the tab compensating for being
 * somewhere else.
 */

/** The transcript's ground is `card`; `ink` measures 14.46:1 light and 11.21:1 dark on it. */
const PROSE =
  'text-body-lg leading-[1.65] text-ink [&_a]:text-sage-deep [&_a]:underline [&_code]:rounded [&_code]:bg-rail [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-body [&_h1]:mt-4 [&_h1]:text-sub [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:text-body-lg [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:font-semibold [&_hr]:my-3 [&_hr]:border-line [&_li]:mb-1 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-3 [&_p:last-child]:mb-0 [&_strong]:font-semibold [&_table]:my-2 [&_table]:w-full [&_td]:border-b [&_td]:border-line-2 [&_td]:py-1 [&_th]:border-b [&_th]:border-line [&_th]:py-1 [&_th]:text-left [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5';

const FALLBACK_PROMPTS = [
  'Where can I cut $200 a month?',
  'Am I on track for my goals?',
  'Summarize my spending this month',
];

function AssistantMessage({
  message,
  onConfirmDraft,
  confirming,
}: {
  message: DisplayMessage;
  onConfirmDraft: (draft: AdvisorDraftAction) => void;
  confirming: boolean;
}) {
  const drafts = message.analysis?.drafts ?? [];
  const citations = message.analysis?.citations ?? [];

  return (
    <div className="mb-5 flex gap-3.5">
      <span
        className="mt-1 h-6 w-6 flex-shrink-0 rounded-full"
        style={{ background: 'radial-gradient(circle at 38% 34%, var(--mz-sage-soft), var(--mz-sage))' }}
      />
      <div className="min-w-0 flex-1">
        {message.thinkingActive && (
          <div className="mb-1.5 animate-pulse text-micro font-semibold uppercase tracking-[0.16em] text-muted">
            Thinking…
          </div>
        )}
        {message.toolActivity && (
          <div className="mb-1.5 animate-pulse text-micro font-semibold uppercase tracking-[0.16em] text-muted">
            {message.toolActivity}
          </div>
        )}
        {message.thinking && !message.thinkingActive && (
          <details className="mb-1.5">
            <summary className="cursor-pointer list-none text-note text-muted transition-colors hover:text-ink">
              Thought for a moment ›
            </summary>
            <div className="mt-1.5 whitespace-pre-wrap border-l border-line-2 pl-3 text-body leading-relaxed text-muted">
              {message.thinking}
            </div>
          </details>
        )}
        <div className={PROSE}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
            {message.content}
          </ReactMarkdown>
          {message.streaming && (
            <span
              className="ml-0.5 inline-block h-[18px] w-[2px] translate-y-[3px] bg-sage"
              style={{ animation: 'mz-blink 1.1s step-end infinite' }}
            />
          )}
        </div>
        {drafts.length > 0 && !message.streaming && (
          <div className="mt-3.5 flex flex-wrap items-center gap-x-6 gap-y-2 text-body-lg">
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
          <div className="mt-3.5 text-note text-muted">
            Based on {citations.slice(0, 3).map((c) => c.label.toLowerCase()).join(', ')}
            {citations.length > 3 ? ` and ${citations.length - 3} more` : ''}.
          </div>
        )}
      </div>
    </div>
  );
}

function ConversationHistory({
  activeId,
  onSelect,
}: {
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
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
          {/* Opens upward: this control sits on the sheet's bottom edge. */}
          <div className="absolute bottom-full right-0 z-20 mb-2 max-h-80 w-72 overflow-auto rounded-xl border border-line-2 bg-card-alt p-1 shadow-e2">
            {(!conversations || conversations.length === 0) && (
              <div className="px-3 py-3 text-body text-muted">No past conversations.</div>
            )}
            {conversations?.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  onSelect(c.id);
                  setOpen(false);
                }}
                className={`block w-full truncate rounded-lg px-3 py-2 text-left text-body transition-colors hover:bg-well ${
                  c.id === activeId ? 'text-ink' : 'text-muted'
                }`}
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

export function AskPanel({
  chat,
  draft,
  onDraftChange,
}: {
  chat: AiChat;
  /** The composer's text, held by the sheet so a question typed into search survives the handoff. */
  draft: string;
  onDraftChange: (text: string) => void;
}) {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const { messages, isStreaming, conversationId, sendMessage, stopStreaming, clearChat, loadConversation } = chat;
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const { data: context } = useQuery({ queryKey: ['ai-context'], queryFn: () => aiApi.getContext() });

  const confirmDraft = useMutation({
    mutationFn: (action: AdvisorDraftAction) => aiApi.confirmDraft(action),
    onSuccess: (res) => {
      addToast({ type: 'success', message: res.message || 'Applied.' });
      void qc.invalidateQueries();
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const send = (text: string) => {
    if (!text.trim() || isStreaming) return;
    onDraftChange('');
    void sendMessage(text);
  };

  const suggestions = useMemo(() => {
    const actions = (context?.actions ?? []).slice(0, 3).map((a) => a.prompt);
    return actions.length > 0 ? actions : FALLBACK_PROMPTS;
  }, [context]);

  return (
    <>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 pt-5">
        {messages.length === 0 ? (
          <div className="pb-2">
            <p className="font-serif text-sub font-light leading-relaxed text-muted">
              Ask anything about your money. Answers come from your own data, on your own machine.
            </p>
            <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-body text-muted">
              {suggestions.map((p) => (
                <button key={p} type="button" onClick={() => send(p)} className="transition-colors hover:text-ink">
                  {p}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="mb-6 flex justify-end">
                <div className="max-w-[72%] rounded-[14px] rounded-br-[4px] bg-rail px-4 py-3 text-body-lg text-ink">
                  {m.content}
                </div>
              </div>
            ) : (
              <AssistantMessage
                key={m.id}
                message={m}
                onConfirmDraft={(d) => confirmDraft.mutate(d)}
                confirming={confirmDraft.isPending}
              />
            )
          )
        )}
      </div>

      <form
        className="flex flex-shrink-0 items-center gap-3 border-t border-line px-5 py-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
      >
        <span className="h-[7px] w-[7px] flex-shrink-0 rounded-full bg-sage" />
        <input
          ref={inputRef}
          className="w-full border-none bg-transparent p-0 text-body-lg text-ink placeholder:text-muted focus:outline-none focus:ring-0"
          /* `configured === false` is the state where there is no Anthropic credential and the
             chat degrades to the local heuristic. Saying so in the placeholder is the only notice
             the owner gets now that the tab that used to carry it is gone; `undefined` means the
             context has not answered yet and claims nothing. */
          placeholder={
            context?.configured === false ? 'Ask about your money (local answers only)' : 'Ask about your money'
          }
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
        />
        <div className="flex flex-shrink-0 items-center gap-4">
          {messages.length > 0 && <ConversationHistory activeId={conversationId} onSelect={loadConversation} />}
          {messages.length > 0 && !isStreaming && <TextButton onClick={clearChat}>New</TextButton>}
          {isStreaming ? (
            <TextButton onClick={stopStreaming}>Stop</TextButton>
          ) : draft.trim() ? (
            <button type="submit" className="text-body text-ink transition-opacity hover:opacity-75">
              Ask
            </button>
          ) : null}
        </div>
      </form>
    </>
  );
}
