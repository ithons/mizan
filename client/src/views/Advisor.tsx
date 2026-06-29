import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Send,
  Square,
  Trash2,
  ChevronDown,
  ChevronRight,
  BrainCircuit,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react';
import { aiApi } from '../lib/api';
import { useAiChat } from '../hooks/useAiChat';

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
        <span className="flex-1 text-left">Financial context sent to Claude</span>
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

// ── Message Bubble ────────────────────────────────────────────────────────────

function MessageBubble({ role, content, streaming }: { role: string; content: string; streaming?: boolean }) {
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
          </div>
        )}
      </div>
    </div>
  );
}

// ── No API Key State ──────────────────────────────────────────────────────────

function NoApiKey() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-8">
      <div className="w-12 h-12 rounded-full bg-[#e07070]/10 flex items-center justify-center">
        <AlertTriangle size={22} className="text-[#e07070]" />
      </div>
      <div>
        <p className="text-sm font-medium text-text mb-1">Anthropic API key not configured</p>
        <p className="text-xs text-muted">
          Add <code className="font-mono bg-white/10 px-1 rounded">ANTHROPIC_API_KEY=sk-ant-...</code> to your{' '}
          <code className="font-mono bg-white/10 px-1 rounded">.env</code> file and restart the server.
        </p>
      </div>
    </div>
  );
}

// ── Empty State ───────────────────────────────────────────────────────────────

const SUGGESTED_PROMPTS = [
  'Give me an overview of my financial health',
  'How is my investment portfolio allocated?',
  'Where am I overspending this month?',
  'Do I have enough in my emergency fund?',
  'Which positions have the best and worst returns?',
];

function EmptyChat({ onSend }: { onSend: (text: string) => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 px-8">
      <div className="text-center">
        <div className="w-12 h-12 rounded-full bg-[#4ecba3]/10 border border-[#4ecba3]/20 flex items-center justify-center mx-auto mb-3">
          <BrainCircuit size={22} className="text-[#4ecba3]" />
        </div>
        <p className="text-sm font-medium text-text mb-1">AI Financial Advisor</p>
        <p className="text-xs text-muted">Ask questions about your finances. Claude has access to your accounts, investments, and spending.</p>
      </div>
      <div className="w-full max-w-md space-y-2">
        {SUGGESTED_PROMPTS.map((prompt) => (
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
  const [apiError, setApiError] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { data: contextStatus, isError: contextError } = useQuery({
    queryKey: ['ai-context'],
    queryFn: aiApi.getContext,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    setApiError(contextError || contextStatus?.configured === false);
  }, [contextError, contextStatus?.configured]);

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
            claude-opus-4-8
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
            {apiError ? (
              <NoApiKey />
            ) : messages.length === 0 ? (
              <EmptyChat onSend={(text) => { setInput(''); sendMessage(text); }} />
            ) : (
              <>
                {messages.map((msg) => (
                  <MessageBubble
                    key={msg.id}
                    role={msg.role}
                    content={msg.content}
                    streaming={msg.streaming}
                  />
                ))}
                <div ref={bottomRef} />
              </>
            )}
          </div>

          {/* Input */}
          {!apiError && (
            <div className="px-6 py-4 border-t border-border flex-shrink-0">
              <div className="flex gap-2 items-end">
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask about your finances... (Enter to send, Shift+Enter for newline)"
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
                Financial data is sent to Anthropic's API. Not financial advice - always verify with a professional.
              </p>
            </div>
          )}
        </div>

        {/* Context sidebar */}
        <div className="w-72 border-l border-border p-4 overflow-y-auto flex-shrink-0 hidden lg:flex lg:flex-col gap-3">
          <p className="text-xs text-muted font-medium">Live Context</p>
          <ContextPanel />
        </div>
      </div>
    </div>
  );
}
