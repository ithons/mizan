import type Database from 'better-sqlite3';
import type { AdvisorEffort, AdvisorSettings } from '../../../shared/types';
import { getPreference, setPreference } from './preferences';

export const ADVISOR_MODEL_PREFERENCE_KEY = 'advisor_model';
export const ADVISOR_EFFORT_PREFERENCE_KEY = 'advisor_effort';

// There used to be a third setting here: a per-section allowlist controlling how much of the
// financial snapshot was sent to the model. It existed to limit egress, and it defaulted to
// sending less than everything. With that constraint retired it was pure cost — a dial whose
// only effect was to make the advisor answer worse — so the snapshot is always complete now.

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

export function getAdvisorModel(db: Database.Database): string {
  const value = getPreference(db, ADVISOR_MODEL_PREFERENCE_KEY)?.value;
  return ADVISOR_MODELS.some((m) => m.id === value) ? (value as string) : DEFAULT_ADVISOR_MODEL;
}

export function getAdvisorEffort(db: Database.Database): AdvisorEffort {
  const value = getPreference(db, ADVISOR_EFFORT_PREFERENCE_KEY)?.value;
  return ADVISOR_EFFORTS.includes(value as AdvisorEffort) ? (value as AdvisorEffort) : DEFAULT_ADVISOR_EFFORT;
}

export function getAdvisorSettings(db: Database.Database): AdvisorSettings {
  return {
    model: getAdvisorModel(db),
    effort: getAdvisorEffort(db),
    available: {
      models: ADVISOR_MODELS.map((m) => ({ id: m.id, label: m.label })),
      efforts: ADVISOR_EFFORTS,
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

  if (body.model !== undefined) setPreference(db, ADVISOR_MODEL_PREFERENCE_KEY, body.model);
  if (body.effort !== undefined) setPreference(db, ADVISOR_EFFORT_PREFERENCE_KEY, body.effort);

  return { ok: true, settings: getAdvisorSettings(db) };
}
