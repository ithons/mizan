export type AdvisorPromptSource =
  | 'dashboard'
  | 'reports'
  | 'budget'
  | 'transaction'
  | 'account'
  | 'investment'
  | 'sync'
  | 'review';

export interface AdvisorRoutePrompt {
  source: AdvisorPromptSource;
  prompt: string;
  recordKind?: string;
  recordId?: string;
  params?: Record<string, string | number | boolean | null>;
}

export interface AdvisorRouteState {
  advisorPrompt: AdvisorRoutePrompt;
}

export function advisorRouteState(prompt: AdvisorRoutePrompt): AdvisorRouteState {
  return { advisorPrompt: prompt };
}

export function isAdvisorRouteState(value: unknown): value is AdvisorRouteState {
  if (typeof value !== 'object' || value === null || !('advisorPrompt' in value)) return false;
  const prompt = (value as { advisorPrompt?: unknown }).advisorPrompt;
  if (typeof prompt !== 'object' || prompt === null) return false;
  const candidate = prompt as { source?: unknown; prompt?: unknown };
  return typeof candidate.source === 'string' && typeof candidate.prompt === 'string' && candidate.prompt.trim().length > 0;
}
