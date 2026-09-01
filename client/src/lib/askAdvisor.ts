/**
 * How a screen hands a question to the ⌘K sheet.
 *
 * This replaces route state. A contextual "ask" used to `navigate('/advisor', { state })`, which
 * meant the answer arrived on a different screen from the thing it was about: you left the sync run
 * you were reading in order to ask about the sync run you were reading. There is no `/advisor` any
 * more, and the sheet opens over whatever you are standing on, so the question no longer moves you.
 *
 * An event rather than a store slice or a context: the sheet is mounted once, in `Layout`, and the
 * senders are leaves several levels down in unrelated trees. A window event is the narrowest thing
 * that reaches from one to the other, and it is already how `mizan:open-palette` works.
 */

export type AdvisorPromptSource = 'import' | 'sync';

export interface AdvisorRoutePrompt {
  source: AdvisorPromptSource;
  prompt: string;
  recordKind?: string;
  recordId?: string;
  params?: Record<string, string | number | boolean | null>;
}

export const ASK_EVENT = 'mizan:ask';

/** True for a payload that carries a question worth opening the sheet for. */
export function isAdvisorAsk(value: unknown): value is AdvisorRoutePrompt {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { source?: unknown; prompt?: unknown };
  return (
    typeof candidate.source === 'string' &&
    typeof candidate.prompt === 'string' &&
    candidate.prompt.trim().length > 0
  );
}

/**
 * Open the sheet with this question in the composer.
 *
 * It is not sent. The owner sees the words that were built for them and can edit or discard them,
 * which is the difference between a shortcut and the app asking a question on their behalf.
 * A malformed payload is dropped here rather than at the listener, so a caller that built nothing
 * useful does not open an empty sheet over the screen.
 */
export function askAdvisor(prompt: AdvisorRoutePrompt): void {
  if (!isAdvisorAsk(prompt)) return;
  window.dispatchEvent(new CustomEvent<AdvisorRoutePrompt>(ASK_EVENT, { detail: prompt }));
}
