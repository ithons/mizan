import { useState, useRef, useCallback, useEffect } from 'react';
import { aiApi } from '../lib/api';
import type { AdvisorAnalysis, ChatMessage } from '@shared/types';

export interface DisplayMessage extends ChatMessage {
  id: string;
  streaming?: boolean;
  analysis?: AdvisorAnalysis;
  thinking?: string;
  thinkingActive?: boolean;
  toolActivity?: string;
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

  // Resume the last conversation on mount, if it still exists.
  useEffect(() => {
    const active = localStorage.getItem(ACTIVE_KEY);
    if (!active) return;
    let cancelled = false;
    aiApi
      .getConversation(active)
      .then((conv) => {
        if (cancelled) return;
        setConversationId(conv.id);
        setMessages(conv.messages.map((m) => ({ ...m, id: crypto.randomUUID() })));
      })
      .catch(() => localStorage.removeItem(ACTIVE_KEY));
    return () => {
      cancelled = true;
    };
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
    const conv = await aiApi.getConversation(id);
    setConversationId(conv.id);
    localStorage.setItem(ACTIVE_KEY, conv.id);
    setMessages(conv.messages.map((m) => ({ ...m, id: crypto.randomUUID() })));
  }, []);

  const sendMessage = useCallback(async (userText: string) => {
    if (isStreaming || !userText.trim()) return;

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

    // Ensure a conversation exists to persist into. Best-effort: if creation fails, chat
    // still works, it just isn't saved.
    let convId = conversationId;
    if (!convId) {
      try {
        const created = await aiApi.createConversation();
        convId = created.id;
        setConversationId(created.id);
        localStorage.setItem(ACTIVE_KEY, created.id);
      } catch (err) {
        console.warn('Failed to create conversation; chat will not be saved', err);
      }
    }

    const controller = new AbortController();
    abortRef.current = controller;

    let assistantAccum = '';
    const updateAssistant = (updater: (m: DisplayMessage) => DisplayMessage) => {
      setMessages((prev) => prev.map((m) => (m.id === assistantId ? updater(m) : m)));
    };

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
      setIsStreaming(false);
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

    // The heuristic /analyze endpoint is the only source of structured citations/drafts;
    // run it alongside the real streamChat call (rather than instead of it) so the chat
    // keeps reasoning over real financial context without losing the citation/draft UI.
    const analysisPromise = aiApi.analyze(userText, controller.signal).catch(() => null);

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
        convId
      );

      const analysis = await analysisPromise;

      if (streamErrorMsg) {
        // No ANTHROPIC_API_KEY or the LLM call failed outright - degrade to the local
        // heuristic's answer text instead of erroring out, if it produced one.
        if (analysis) {
          assistantAccum = analysis.answer;
          updateAssistant((m) => ({ ...m, content: analysis.answer, analysis, streaming: false, thinkingActive: false }));
          await persist();
          finish();
        } else {
          finishWithError(streamErrorMsg);
        }
        return;
      }

      updateAssistant((m) => ({ ...m, analysis: analysis ?? undefined, streaming: false, thinkingActive: false }));
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
