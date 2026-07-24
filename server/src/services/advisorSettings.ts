import type Database from 'better-sqlite3';
import type { AdvisorEffort, AdvisorSettings } from '../../../shared/types';
import { getPreference, setPreference } from './preferences';

export const ADVISOR_MODEL_PREFERENCE_KEY = 'advisor_model';
export const ADVISOR_EFFORT_PREFERENCE_KEY = 'advisor_effort';
export const ADVISOR_CONTEXT_SECTIONS_PREFERENCE_KEY = 'advisor_context_sections';

// Server-authoritative model whitelist. The chat loop reads its model from a preference,
// so this list is the security boundary: a tampered client can't point the advisor at an
// arbitrary or nonexistent model string. Keep in sync with the current Claude family.
export const ADVISOR_MODELS = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8 — most capable' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5 — balanced (default)' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5 — fastest' },
] as const;

export const DEFAULT_ADVISOR_MODEL = 'claude-sonnet-5';

export const ADVISOR_EFFORTS: AdvisorEffort[] = ['low', 'medium', 'high'];
export const DEFAULT_ADVISOR_EFFORT: AdvisorEffort = 'medium';

// Toggleable context sections. The account/net-worth summary and the user's personal profile
// are always included (they're the core of "what the advisor knows"), so they're not listed.
export const ADVISOR_CONTEXT_SECTIONS = [
  { id: 'data_freshness', label: 'Data freshness & sync health' },
  { id: 'cash_flow', label: 'Cash flow (3-month average)' },
  { id: 'report_summary', label: 'Monthly report summary' },
  { id: 'forecast', label: 'Forward cash-flow forecast' },
  { id: 'top_spending', label: 'Top spending categories' },
  { id: 'goals', label: 'Goals' },
  { id: 'review_queue', label: 'Review queue & rule suggestions' },
  { id: 'investments', label: 'Investment portfolio' },
  { id: 'net_worth_trend', label: 'Net-worth trend' },
  { id: 'recent_transactions', label: 'Recent transactions' },
] as const;

export type AdvisorContextSection = (typeof ADVISOR_CONTEXT_SECTIONS)[number]['id'];

const ALL_SECTION_IDS = ADVISOR_CONTEXT_SECTIONS.map((s) => s.id);
const VALID_SECTION_IDS = new Set<string>(ALL_SECTION_IDS);

export function getAdvisorModel(db: Database.Database): string {
  const value = getPreference(db, ADVISOR_MODEL_PREFERENCE_KEY)?.value;
  return ADVISOR_MODELS.some((m) => m.id === value) ? (value as string) : DEFAULT_ADVISOR_MODEL;
}

export function getAdvisorEffort(db: Database.Database): AdvisorEffort {
  const value = getPreference(db, ADVISOR_EFFORT_PREFERENCE_KEY)?.value;
  return ADVISOR_EFFORTS.includes(value as AdvisorEffort) ? (value as AdvisorEffort) : DEFAULT_ADVISOR_EFFORT;
}

// Unset preference means "all sections on" (the historical default), not "none".
export function getEnabledContextSections(db: Database.Database): Set<AdvisorContextSection> {
  const value = getPreference(db, ADVISOR_CONTEXT_SECTIONS_PREFERENCE_KEY)?.value;
  if (!Array.isArray(value)) return new Set(ALL_SECTION_IDS);
  const enabled = value.filter((s): s is AdvisorContextSection => typeof s === 'string' && VALID_SECTION_IDS.has(s));
  return new Set(enabled);
}

export function getAdvisorSettings(db: Database.Database): AdvisorSettings {
  return {
    model: getAdvisorModel(db),
    effort: getAdvisorEffort(db),
    context_sections: [...getEnabledContextSections(db)],
    available: {
      models: ADVISOR_MODELS.map((m) => ({ id: m.id, label: m.label })),
      efforts: ADVISOR_EFFORTS,
      sections: ADVISOR_CONTEXT_SECTIONS.map((s) => ({ id: s.id, label: s.label })),
    },
  };
}

interface UpdateResult {
  ok: boolean;
  error?: string;
  settings?: AdvisorSettings;
}

// Validates every provided field against its whitelist before persisting; a single invalid
// value rejects the whole update so the stored config is never left partially applied.
export function updateAdvisorSettings(db: Database.Database, update: unknown): UpdateResult {
  if (typeof update !== 'object' || update === null) {
    return { ok: false, error: 'settings object is required' };
  }
  const body = update as Record<string, unknown>;

  if (body.model !== undefined && !ADVISOR_MODELS.some((m) => m.id === body.model)) {
    return { ok: false, error: `model must be one of: ${ADVISOR_MODELS.map((m) => m.id).join(', ')}` };
  }
  if (body.effort !== undefined && !ADVISOR_EFFORTS.includes(body.effort as AdvisorEffort)) {
    return { ok: false, error: `effort must be one of: ${ADVISOR_EFFORTS.join(', ')}` };
  }
  if (body.context_sections !== undefined) {
    if (!Array.isArray(body.context_sections) ||
        !body.context_sections.every((s) => typeof s === 'string' && VALID_SECTION_IDS.has(s))) {
      return { ok: false, error: 'context_sections must be an array of valid section ids' };
    }
  }

  if (body.model !== undefined) setPreference(db, ADVISOR_MODEL_PREFERENCE_KEY, body.model);
  if (body.effort !== undefined) setPreference(db, ADVISOR_EFFORT_PREFERENCE_KEY, body.effort);
  if (body.context_sections !== undefined) {
    setPreference(db, ADVISOR_CONTEXT_SECTIONS_PREFERENCE_KEY, body.context_sections);
  }

  return { ok: true, settings: getAdvisorSettings(db) };
}
