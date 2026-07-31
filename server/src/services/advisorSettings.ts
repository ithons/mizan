import type Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import type { AdvisorEffort, AdvisorSettings } from '../../../shared/types';
import { getPreference, setPreference } from './preferences';

export const ADVISOR_MODEL_PREFERENCE_KEY = 'advisor_model';
export const ADVISOR_EFFORT_PREFERENCE_KEY = 'advisor_effort';

// There used to be a third setting here: a per-section allowlist controlling how much of the
// financial snapshot was sent to the model. It existed to limit egress, and it defaulted to
// sending less than everything. With that constraint retired it was pure cost (a dial whose
// only effect was to make the advisor answer worse), so the snapshot is always complete now.

// ─── Model capabilities ──────────────────────────────────────────────────────
// Every optional request parameter this app sends is a per-model fact, not a constant.
// `thinking: {type:'adaptive'}` 400s on pre-4.6 models; `output_config.effort` 400s on
// Haiku 4.5 and Sonnet 4.5; sampling params 400 on 4.7+. The chat route used to build
// `thinking` and `output_config` with no reference to the model it had just read, which
// meant the whitelist and the request shape were two hardcoded lists that had to agree by
// hand, the same "repair the data, leave the invariant out of the write path" shape that
// made migrations 033/039/040 decay. Here the request shape is DERIVED from this table, so
// adding a model can only produce a request that model accepts.

export interface ModelCapabilities {
  label: string;
  /** Offered in Settings -> Advisor. Fixed-purpose jobs may use a model that isn't. */
  advisorSelectable: boolean;
  /** Accepts `thinking: {type:'adaptive'}`. Pre-4.6 models reject it. */
  adaptiveThinking: boolean;
  /** Effort levels accepted. Empty means `output_config.effort` must not be sent at all. */
  efforts: readonly AdvisorEffort[];
  /** Accepts `output_config.format` (structured outputs). */
  structuredOutput: boolean;
}

const FULL_EFFORT_LADDER: readonly AdvisorEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export const MODEL_CAPABILITIES: Readonly<Record<string, ModelCapabilities>> = {
  'claude-opus-5': {
    label: 'Opus 5 (most capable)',
    advisorSelectable: true,
    adaptiveThinking: true,
    efforts: FULL_EFFORT_LADDER,
    structuredOutput: true,
  },
  'claude-sonnet-5': {
    label: 'Sonnet 5 (balanced, default)',
    advisorSelectable: true,
    adaptiveThinking: true,
    efforts: FULL_EFFORT_LADDER,
    structuredOutput: true,
  },
  // Not advisor-selectable: it takes neither adaptive thinking nor an effort level, so
  // offering it would render an effort dial in Settings that silently does nothing. It is
  // still the right model for bulk classification, which is why it stays in this table.
  'claude-haiku-4-5': {
    label: 'Haiku 4.5 (fastest)',
    advisorSelectable: false,
    adaptiveThinking: false,
    efforts: [],
    structuredOutput: true,
  },
};

// Server-authoritative model whitelist, derived so it cannot drift from the capability
// table. The chat loop reads its model from a preference, so this list is the security
// boundary: a tampered client can't point the advisor at an arbitrary model string.
export const ADVISOR_MODELS: ReadonlyArray<{ id: string; label: string }> = Object.entries(
  MODEL_CAPABILITIES
)
  .filter(([, caps]) => caps.advisorSelectable)
  .map(([id, caps]) => ({ id, label: caps.label }));

export const DEFAULT_ADVISOR_MODEL = 'claude-sonnet-5';

export const ADVISOR_EFFORTS: AdvisorEffort[] = [...FULL_EFFORT_LADDER];
export const DEFAULT_ADVISOR_EFFORT: AdvisorEffort = 'medium';

// ─── Per-job model assignment ────────────────────────────────────────────────
// Cost is not the constraint; matching the model to the shape of the job is. Sonnet 5 at
// medium effort is the baseline, Haiku 4.5 handles bulk classification and near-lookup
// work, and Opus 5 is reserved for self-audit and monthly synthesis (Phase 6.3: no such
// job exists yet, so there is no entry for it here rather than an unused one).
export interface JobModel {
  model: string;
  /** Omitted where the model takes no effort level, so the table states no dial it lacks. */
  effort?: AdvisorEffort;
}

export type AiJobName = 'background_review' | 'bulk_categorization';

export const JOB_MODELS: Readonly<Record<AiJobName, JobModel>> = {
  background_review: { model: 'claude-sonnet-5', effort: 'medium' },
  bulk_categorization: { model: 'claude-haiku-4-5' },
};

// ─── Derived request shape ───────────────────────────────────────────────────

export interface ModelRequestShape {
  thinking?: Anthropic.ThinkingConfigParam;
  output_config?: Anthropic.OutputConfig;
}

export interface ModelRequestOptions {
  effort?: AdvisorEffort;
  /** 'summarized' returns readable reasoning text; the API default returns empty blocks. */
  thinkingDisplay?: 'summarized' | 'omitted';
  outputFormat?: Anthropic.JSONOutputFormat;
}

/**
 * Builds the optional parameters a request to `modelId` may carry, dropping any the model
 * does not accept. A model absent from the capability table gets a bare request: no
 * optional parameter is valid on every model, so "unknown" has to mean "send nothing".
 */
export function buildModelRequestShape(
  modelId: string,
  options: ModelRequestOptions = {}
): ModelRequestShape {
  const caps = MODEL_CAPABILITIES[modelId];
  const shape: ModelRequestShape = {};

  if (caps?.adaptiveThinking) {
    shape.thinking = options.thinkingDisplay
      ? { type: 'adaptive', display: options.thinkingDisplay }
      : { type: 'adaptive' };
  }

  const outputConfig: Anthropic.OutputConfig = {};
  if (options.effort && caps?.efforts.includes(options.effort)) outputConfig.effort = options.effort;
  if (options.outputFormat && caps?.structuredOutput) outputConfig.format = options.outputFormat;
  if (Object.keys(outputConfig).length > 0) shape.output_config = outputConfig;

  return shape;
}

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
      efforts: [...ADVISOR_EFFORTS],
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
