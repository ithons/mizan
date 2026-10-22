import { useState, useRef, useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { aiApi } from '../lib/api';
import { createTurnGate } from '../lib/turnGate';
import type { AdvisorDraftAction, ChatMessage } from '@shared/types';

export interface DisplayMessage extends ChatMessage {
  id: string;
  streaming?: boolean;
  thinking?: string;
  thinkingActive?: boolean;
  toolActivity?: string;
  /** Changes the model put in front of the owner during this answer. */
  proposals?: AdvisorDraftAction[];
}

// Friendly labels for the read-only DB tools the advisor can call, shown while it queries.
const TOOL_LABELS: Record<string, string> = {
  list_transactions: 'Looking through your transactions…',
  spending_by_category: 'Tallying spending by category…',
  monthly_cashflow: 'Checking your monthly cash flow…',
  get_budgets: 'Reviewing your budgets…',
  list_goals: 'Checking your goals…',
  list_holdings: 'Looking at your investments…',
  get_upcoming_bills: 'Checking upcoming bills…',
  get_net_worth_history: 'Tracing your net-worth history…',
  describe_schema: 'Inspecting your data model…',
  run_sql_query: 'Querying your financial data…',
  get_merchant_rules: 'Reading your merchant rules…',
  get_provenance_summary: 'Checking how categories were set…',
  get_transaction_full: 'Opening the transaction…',
  get_my_action_history: 'Reading what it has changed…',
  get_holding_history: 'Tracing a holding…',
  get_sync_runs: 'Checking recent syncs…',
  get_reconciliation: 'Reconciling balances…',
  categorize_transactions: 'Filing transactions…',
  create_merchant_rule: 'Writing a merchant rule…',
  propose_changes: 'Preparing changes for you…',
  get_accounts: 'Reading your accounts…',
  get_categories: 'Reading your categories…',
  get_safe_to_spend: 'Working out what is free to spend…',
  get_recurring_patterns: 'Reviewing recurring items…',
  get_insights: 'Looking for anything unusual…',
  get_memories: 'Recalling what you have told it…',
  remember: 'Noting that down…',
  forget: 'Forgetting that…',
  get_open_proposals: 'Checking what is already waiting for you…',
  run_simulation: 'Running the numbers…',
  explain_month: 'Comparing the month with the ones before…',
  get_funding_mix: 'Working out what is paying for what…',
  get_account_coverage: 'Checking each account can meet what is scheduled…',
  find_reimbursements: 'Looking for money friends paid back…',
  get_counterparties: 'Adding up money between you and other people…',
  get_retirement_room: 'Working out IRA room for the year…',
  get_card_review: 'Reviewing what each card returned and cost…',
  get_investment_returns: 'Working out annualized returns…',
  get_notifications: 'Reading your inbox…',
  get_notification_rules: 'Checking what you are notified about…',
};

// The active conversation id is remembered across reloads so the thread resumes; the
// messages themselves live on the server (services/conversations.ts).
const ACTIVE_KEY = 'mizan.advisor.activeConversation';

/**
 * Shown on the screen when an exchange did NOT reach the stored history.
 *
 * The next turn is rebuilt server-side from that history, so an exchange that never landed is one
 * the model will not see. Leaving the transcript looking complete while the model's context is
 * missing a turn is the disagreement this exists to close; the other half of the fix is that a
 * stopped answer with real text IS saved, exactly as displayed, and therefore needs no note.
 */
const NOT_SAVED_NOTE = '\n\n(Not saved, so the advisor will not see this exchange next turn.)';

function errorMessage(err: unknown, fallback: string) {
  return err instanceof Error && err.message ? err.message : fallback;
}

/**
 * The whole chat surface, as one value.
 *
 * Named because the sheet holds this hook and passes it down: `useAiChat` lives at the ⌘K root so a
 * conversation survives closing the sheet and reopening it over a different screen, and `AskPanel`
 * is a leaf that renders whatever it is handed.
 */
export type AiChat = ReturnType<typeof useAiChat>;

export function useAiChat() {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const turns = useRef(createTurnGate()).current;
  const queryClient = useQueryClient();

  // Resume the last conversation on mount, if it still exists.
  useEffect(() => {
    const active = localStorage.getItem(ACTIVE_KEY);
    if (!active) return;
    let cancelled = false;
    const isCurrent = turns.begin();
    aiApi
      .getConversation(active)
      .then((conv) => {
        if (cancelled || !isCurrent()) return;
        setConversationId(conv.id);
        setMessages(conv.messages.map((m) => ({ ...m, id: crypto.randomUUID() })));
      })
      .catch(() => {
        if (isCurrent() && localStorage.getItem(ACTIVE_KEY) === active) localStorage.removeItem(ACTIVE_KEY);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    const isCurrent = turns.begin();
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
    const conv = await aiApi.getConversation(id);
    if (!isCurrent()) return;
    setConversationId(conv.id);
    localStorage.setItem(ACTIVE_KEY, conv.id);
    setMessages(conv.messages.map((m) => ({ ...m, id: crypto.randomUUID() })));
  }, []);

  const sendMessage = useCallback(async (userText: string) => {
    if (isStreaming || !userText.trim()) return;
    const isCurrent = turns.begin();

    const userMsg: DisplayMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: userText.trim(),
    };

    const assistantId = crypto.randomUUID();
    const assistantMsg: DisplayMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      streaming: true,
    };

    const history: ChatMessage[] = [...messages, userMsg].map((m) => ({
      role: m.role,
      content: m.content,
    }));

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setIsStreaming(true);
    const updateAssistant = (updater: (m: DisplayMessage) => DisplayMessage) => {
      setMessages((prev) => prev.map((m) => (m.id === assistantId ? updater(m) : m)));
    };

    // Ensure a conversation exists to persist into. Best-effort: if creation fails, chat
    // still works, it just isn't saved.
    let convId = conversationId;
    if (!convId) {
      try {
        const created = await aiApi.createConversation();
        convId = created.id;
        if (isCurrent()) {
          setConversationId(created.id);
          localStorage.setItem(ACTIVE_KEY, created.id);
        } else {
          aiApi.deleteConversation(created.id).catch((err) =>
            console.warn('Failed to remove a conversation created for a stopped turn', err));
        }
      } catch (err) {
        console.warn('Failed to create conversation; chat will not be saved', err);
      }
    }

    if (!isCurrent()) {
      updateAssistant((m) => ({ ...m, streaming: false, thinkingActive: false, content: m.content + NOT_SAVED_NOTE }));
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;

    let assistantAccum = '';

    /**
     * Save the exchange, and say on screen when it could not be saved.
     *
     * Awaited by every caller: this used to be fire-and-forget with `finish()` running immediately
     * after, so a fast follow-up turn could be sent before the append landed and reach the model
     * without the turn before it.
     */
    const persist = async (): Promise<void> => {
      if (!convId || !assistantAccum) {
        updateAssistant((m) => ({ ...m, content: m.content + NOT_SAVED_NOTE }));
        return;
      }
      try {
        await aiApi.appendMessages(convId, [
          { role: 'user', content: userMsg.content },
          { role: 'assistant', content: assistantAccum },
        ]);
      } catch (err) {
        console.warn('Failed to persist chat exchange', err);
        updateAssistant((m) => ({ ...m, content: m.content + NOT_SAVED_NOTE }));
      }
    };

    let settled = false;
    const finish = () => {
      settled = true;
      if (isCurrent()) setIsStreaming(false);
      if (abortRef.current === controller) abortRef.current = null;
    };
    // Nothing is persisted here: `Error: ...` is this client's status line, not something the model
    // said, and writing it into the history would put words in the model's mouth next turn.
    const finishWithError = (errMsg: string) => {
      updateAssistant((m) => ({
        ...m,
        content: `Error: ${errMsg}${NOT_SAVED_NOTE}`,
        streaming: false,
        thinkingActive: false,
      }));
      finish();
    };

    let streamErrorMsg: string | null = null;

    try {
      await aiApi.streamChat(
        history,
        (chunkText) => {
          assistantAccum += chunkText;
          // Text is arriving, so any "querying your data" activity is done.
          updateAssistant((m) => ({ ...m, content: m.content + chunkText, toolActivity: undefined }));
        },
        () => {},
        (errMsg) => { streamErrorMsg = errMsg; },
        controller.signal,
        () => updateAssistant((m) => ({ ...m, thinkingActive: true })),
        (thinkingText) => updateAssistant((m) => ({ ...m, thinking: (m.thinking ?? '') + thinkingText })),
        () => updateAssistant((m) => ({ ...m, thinkingActive: false })),
        (toolName) => updateAssistant((m) => ({
          ...m,
          toolActivity: TOOL_LABELS[toolName] ?? 'Looking things up…',
        })),
        // The server rebuilds the earlier turns from this conversation; only the new one is sent.
        convId,
        {
          onProposals: (drafts) => updateAssistant((m) => ({ ...m, proposals: [...(m.proposals ?? []), ...drafts] })),
          onWrote: () => void queryClient.invalidateQueries(),
        }
      );

      if (streamErrorMsg) {
        // No API key, or the model call failed outright: fall back to the local heuristic's answer
        // text. Only the text: its drafts and citations describe what the heuristic matched, not
        // anything the model read, and in chat a write comes only from propose_changes.
        const analysis = await aiApi.analyze(userText, controller.signal).catch(() => null);
        if (analysis) {
          assistantAccum = analysis.answer;
          updateAssistant((m) => ({ ...m, content: analysis.answer, streaming: false, thinkingActive: false }));
          await persist();
          finish();
        } else {
          finishWithError(streamErrorMsg);
        }
        return;
      }

      updateAssistant((m) => ({ ...m, streaming: false, thinkingActive: false }));
      await persist();
      finish();
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      if (!isAbort) {
        finishWithError(errorMessage(err, 'AI request failed'));
        return;
      }
      // Stop mid-answer. Whatever arrived is a real partial answer and stays on screen, so it is
      // saved verbatim and the model's next context matches what the owner is looking at. Stopped
      // before any text, there is no exchange to save and the note says so.
      updateAssistant((m) => ({ ...m, streaming: false, thinkingActive: false }));
      await persist();
      finish();
    } finally {
      if (!settled && abortRef.current === controller) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, streaming: false, thinkingActive: false } : m
          )
        );
        finish();
      }
    }
  }, [isStreaming, messages, conversationId]);

  const stopStreaming = useCallback(() => {
    turns.supersede();
    abortRef.current?.abort();
    abortRef.current = null;
    setMessages((prev) =>
      prev.map((m) => (m.streaming ? { ...m, streaming: false, thinkingActive: false } : m))
    );
    setIsStreaming(false);
  }, []);

  const clearChat = useCallback(() => {
    stopStreaming();
    setMessages([]);
    setConversationId(null);
    localStorage.removeItem(ACTIVE_KEY);
  }, [stopStreaming]);

  return { messages, isStreaming, conversationId, sendMessage, stopStreaming, clearChat, loadConversation };
}
