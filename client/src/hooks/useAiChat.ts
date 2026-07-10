import { useState, useRef, useCallback, useEffect } from 'react';
import { aiApi } from '../lib/api';
import type { AdvisorAnalysis, ChatMessage } from '@shared/types';

export interface DisplayMessage extends ChatMessage {
  id: string;
  streaming?: boolean;
  analysis?: AdvisorAnalysis;
  thinking?: string;
  thinkingActive?: boolean;
}

// Conversation survives navigating away and back within the tab, but not a new session.
const STORAGE_KEY = 'mizan.advisor.chat';

function loadStoredMessages(): DisplayMessage[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DisplayMessage[]) : [];
  } catch (err) {
    console.warn('Failed to restore advisor chat', err);
    return [];
  }
}

function errorMessage(err: unknown, fallback: string) {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function useAiChat() {
  const [messages, setMessages] = useState<DisplayMessage[]>(loadStoredMessages);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (isStreaming) return;
    try {
      if (messages.length === 0) {
        sessionStorage.removeItem(STORAGE_KEY);
      } else {
        const settled = messages.map((m) => ({ ...m, streaming: false, thinkingActive: false }));
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(settled));
      }
    } catch (err) {
      console.warn('Failed to persist advisor chat', err);
    }
  }, [messages, isStreaming]);

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

    const controller = new AbortController();
    abortRef.current = controller;

    let settled = false;
    const finish = () => {
      settled = true;
      setIsStreaming(false);
      if (abortRef.current === controller) abortRef.current = null;
    };
    const finishWithError = (errMsg: string) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: `Error: ${errMsg}`, streaming: false, thinkingActive: false }
            : m
        )
      );
      finish();
    };
    const updateAssistant = (updater: (m: DisplayMessage) => DisplayMessage) => {
      setMessages((prev) => prev.map((m) => (m.id === assistantId ? updater(m) : m)));
    };

    // The heuristic /analyze endpoint is the only source of structured citations/drafts;
    // run it alongside the real streamChat call (rather than instead of it) so the chat
    // keeps reasoning over real financial context without losing the citation/draft UI.
    const analysisPromise = aiApi.analyze(userText, controller.signal).catch(() => null);

    let streamErrorMsg: string | null = null;

    try {
      await aiApi.streamChat(
        history,
        (chunkText) => updateAssistant((m) => ({ ...m, content: m.content + chunkText })),
        () => {},
        (errMsg) => { streamErrorMsg = errMsg; },
        controller.signal,
        () => updateAssistant((m) => ({ ...m, thinkingActive: true })),
        (thinkingText) => updateAssistant((m) => ({ ...m, thinking: (m.thinking ?? '') + thinkingText })),
        () => updateAssistant((m) => ({ ...m, thinkingActive: false }))
      );

      const analysis = await analysisPromise;

      if (streamErrorMsg) {
        // No ANTHROPIC_API_KEY or the LLM call failed outright - degrade to the local
        // heuristic's answer text instead of erroring out, if it produced one.
        if (analysis) {
          updateAssistant((m) => ({ ...m, content: analysis.answer, analysis, streaming: false, thinkingActive: false }));
          finish();
        } else {
          finishWithError(streamErrorMsg);
        }
        return;
      }

      updateAssistant((m) => ({ ...m, analysis: analysis ?? undefined, streaming: false, thinkingActive: false }));
      finish();
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      if (!isAbort) {
        finishWithError(errorMessage(err, 'AI request failed'));
      } else {
        finish();
      }
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
  }, [isStreaming, messages]);

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
  }, [stopStreaming]);

  return { messages, isStreaming, sendMessage, stopStreaming, clearChat };
}
