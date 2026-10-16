import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { format, isToday, isYesterday, parseISO } from 'date-fns';
import { aiApi } from '../lib/api';
import { useAppStore } from '../store';
import { useAdvisorChat } from '../hooks/advisorChat';
import { AskPanel } from '../components/AskPanel';
import { ConfirmRemoveModal } from '../components/ConfirmRemoveModal';
import { AiActionsList } from '../components/AiActions';
import { SectionLabel, TextButton } from '../components/balance';

type Conversation = Awaited<ReturnType<typeof aiApi.listConversations>>[number];

export function dayGroup(iso: string): string {
  const date = parseISO(iso);
  if (isToday(date)) return 'Today';
  if (isYesterday(date)) return 'Yesterday';
  return format(date, 'MMM d');
}

function groupByDay(conversations: Conversation[]): Array<{ day: string; items: Conversation[] }> {
  const groups: Array<{ day: string; items: Conversation[] }> = [];
  for (const conversation of conversations) {
    const day = dayGroup(conversation.updated_at);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.items.push(conversation);
    else groups.push({ day, items: [conversation] });
  }
  return groups;
}

function ConversationRow({
  conversation,
  active,
  onOpen,
}: {
  conversation: Conversation;
  active: boolean;
  onOpen: () => void;
}) {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const chat = useAdvisorChat();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [title, setTitle] = useState(conversation.title);
  const refresh = () => qc.invalidateQueries({ queryKey: ['ai-conversations'] });

  const rename = useMutation({
    mutationFn: () => aiApi.renameConversation(conversation.id, title),
    onSuccess: () => { setEditing(false); refresh(); },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });
  const remove = useMutation({
    mutationFn: () => aiApi.deleteConversation(conversation.id),
    onSuccess: () => {
      if (active) chat.clearChat();
      refresh();
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  if (editing) {
    return (
      <form
        className="px-2 py-1.5"
        onSubmit={(e) => { e.preventDefault(); if (title.trim()) rename.mutate(); }}
      >
        <input
          aria-label="Conversation title"
          autoFocus
          className="mz-field py-1 text-body"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false); }}
        />
      </form>
    );
  }

  return (
    <div className={`group relative rounded-lg px-2 py-1.5 ${active ? 'bg-well' : 'hover:bg-well/60'}`}>
      <button type="button" onClick={onOpen} className="block w-full truncate text-left text-body text-ink">
        {conversation.title || 'Untitled chat'}
      </button>
      <div className="absolute inset-y-0 right-1 hidden items-center gap-2 rounded-lg bg-well pl-2 pr-1 text-micro text-muted group-hover:flex group-focus-within:flex">
        <button type="button" onClick={() => { setTitle(conversation.title); setEditing(true); }} className="hover:text-ink">
          Rename
        </button>
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="hover:text-clay"
        >
          Delete
        </button>
      </div>
      <ConfirmRemoveModal
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Delete conversation"
        description={`"${conversation.title || 'Untitled chat'}" and its messages are removed. What the advisor changed stays in the change log.`}
        confirmLabel="Delete"
        isPending={remove.isPending}
        onConfirm={() => remove.mutate(undefined, { onSettled: () => setConfirming(false) })}
      />
    </div>
  );
}

function ConversationList({ conversations, onPick }: { conversations: Conversation[]; onPick?: () => void }) {
  const chat = useAdvisorChat();
  const { addToast } = useAppStore();
  const open = (id: string) => {
    chat.loadConversation(id).catch((err: Error) => addToast({ type: 'error', message: err.message }));
    onPick?.();
  };

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <TextButton
        onClick={() => { chat.clearChat(); onPick?.(); }}
        disabled={chat.isStreaming}
        className="self-start"
      >
        New conversation
      </TextButton>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        {conversations.length === 0 && <p className="text-note text-muted-2">No saved conversations yet.</p>}
        {groupByDay(conversations).map((group) => (
          <div key={group.day}>
            <div className="mb-1 px-2 text-micro uppercase tracking-[0.16em] text-muted-2">{group.day}</div>
            {group.items.map((conversation) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                active={conversation.id === chat.conversationId}
                onOpen={() => open(conversation.id)}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

type NarrowPane = 'chat' | 'conversations' | 'changes';

export default function Advisor() {
  const chat = useAdvisorChat();
  const qc = useQueryClient();
  const location = useLocation();
  const [draft, setDraft] = useState(() => {
    const handed = (location.state as { draft?: unknown } | null)?.draft;
    return typeof handed === 'string' ? handed : '';
  });
  const [pane, setPane] = useState<NarrowPane>('chat');
  const navigate = useNavigate();
  // A question handed over from Cmd+K is taken once; a reload must not hand it over again.
  useEffect(() => {
    if (location.state) navigate(location.pathname, { replace: true, state: null });
  }, [location.pathname, location.state, navigate]);
  const { data: conversations = [] } = useQuery({
    queryKey: ['ai-conversations'],
    queryFn: () => aiApi.listConversations(),
  });

  // A settled turn is saved by the chat; the list learns about it here.
  useEffect(() => {
    if (!chat.isStreaming) qc.invalidateQueries({ queryKey: ['ai-conversations'] });
  }, [chat.isStreaming, chat.conversationId, qc]);

  const title = useMemo(
    () => conversations.find((c) => c.id === chat.conversationId)?.title || (chat.messages.length ? 'Untitled chat' : 'New conversation'),
    [conversations, chat.conversationId, chat.messages.length]
  );

  const tab = (id: NarrowPane, label: string) => (
    <button
      key={id}
      type="button"
      onClick={() => setPane(id)}
      className={pane === id ? 'text-ink' : 'text-muted transition-colors hover:text-ink'}
    >
      {label}
    </button>
  );

  return (
    <div className="mz-screen flex h-full min-h-0 flex-col px-4 py-5 lg:px-8 lg:py-7">
      <div className="mb-4 flex flex-shrink-0 items-baseline justify-between gap-4">
        <h1 className="truncate font-serif text-title text-ink">{title}</h1>
        <div className="flex gap-4 text-body min-[1000px]:hidden">
          {tab('chat', 'Chat')}
          {tab('conversations', 'Conversations')}
          {tab('changes', 'Changes')}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 min-[1000px]:grid-cols-[220px_minmax(0,1fr)_300px]">
        <aside className={`min-h-0 flex-col ${pane === 'conversations' ? 'flex' : 'hidden'} min-[1000px]:flex`}>
          <SectionLabel className="mb-2">Conversations</SectionLabel>
          <ConversationList conversations={conversations} onPick={() => setPane('chat')} />
        </aside>

        <section
          aria-label="Conversation"
          className={`min-h-0 flex-col overflow-hidden rounded-xl border border-line-2 bg-card ${pane === 'chat' ? 'flex' : 'hidden'} min-[1000px]:flex`}
        >
          <AskPanel chat={chat} draft={draft} onDraftChange={setDraft} showHistory={false} />
        </section>

        <aside className={`min-h-0 flex-col ${pane === 'changes' ? 'flex' : 'hidden'} min-[1000px]:flex`}>
          <SectionLabel className="mb-2">What the AI has changed</SectionLabel>
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <AiActionsList />
          </div>
        </aside>
      </div>
    </div>
  );
}
