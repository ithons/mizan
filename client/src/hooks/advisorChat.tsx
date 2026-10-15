import { createContext, useContext, type ReactNode } from 'react';
import { useAiChat, type AiChat } from './useAiChat';

const AdvisorChatContext = createContext<AiChat | null>(null);

/** One conversation for the whole app, so ⌘K and the Advisor page are two views of the same thread. */
export function AdvisorChatProvider({ children }: { children: ReactNode }) {
  const chat = useAiChat();
  return <AdvisorChatContext.Provider value={chat}>{children}</AdvisorChatContext.Provider>;
}

export function useAdvisorChat(): AiChat {
  const chat = useContext(AdvisorChatContext);
  if (!chat) throw new Error('useAdvisorChat needs an AdvisorChatProvider above it');
  return chat;
}
