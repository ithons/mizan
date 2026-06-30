import { useState, useRef, useCallback } from 'react';
import { aiApi } from '../lib/api';
import type { AdvisorAnalysis, ChatMessage } from '@shared/types';

export interface DisplayMessage extends ChatMessage {
  id: string;
  streaming?: boolean;
  analysis?: AdvisorAnalysis;
}

function errorMessage(err: unknown, fallback: string) {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function useAiChat() {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

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
            ? { ...m, content: `Error: ${errMsg}`, streaming: false }
            : m
        )
      );
      finish();
    };

    try {
      const analysis = await aiApi.analyze(userText, controller.signal);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: analysis.answer, analysis, streaming: false }
            : m
        )
      );
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
            m.id === assistantId ? { ...m, streaming: false } : m
          )
        );
        finish();
      }
    }
  }, [isStreaming]);

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setMessages((prev) =>
      prev.map((m) => (m.streaming ? { ...m, streaming: false } : m))
    );
    setIsStreaming(false);
  }, []);

  const clearChat = useCallback(() => {
    stopStreaming();
    setMessages([]);
  }, [stopStreaming]);

  return { messages, isStreaming, sendMessage, stopStreaming, clearChat };
}
