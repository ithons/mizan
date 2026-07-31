import type Database from 'better-sqlite3';
import type { AdvisorEffort, AdvisorSettings } from '../../../shared/types';
import { getPreference, setPreference } from './preferences';
import { isProviderConfigured, resolveCredential } from './aiProviders/credentials';
import type { AiProviderId, CachingProfile } from './aiProviders/types';

export const ADVISOR_MODEL_PREFERENCE_KEY = 'advisor_model';
export const ADVISOR_EFFORT_PREFERENCE_KEY = 'advisor_effort';

// There used to be a third setting here: a per-section allowlist controlling how much of the
// financial snapshot was sent to the model. It existed to limit egress, and it defaulted to
// sending less than everything. With that constraint retired it was pure cost (a dial whose
// only effect was to make the advisor answer worse), so the snapshot is always complete now.

// ─── Model capabilities ──────────────────────────────────────────────────────
// Every optional request parameter this app sends is a per-model fact, not a constant, and
// since Phase 10 not even a per-provider one. `thinking: {type:'adaptive'}` 400s on pre-4.6
// Claude models; `output_config.effort` 400s on Haiku 4.5; sampling params 400 on Claude 4.7+
// AND on OpenAI's reasoning models; `thinkingConfig` errors on a Gemini model with no
// thinking. The request shape is DERIVED from this table by each provider adapter, so adding
// a model can only produce a request that model accepts.
//
// The provider dimension is the Phase 10 addition. It carries four things that are NOT
// uniform inside a provider, let alone across them: which effort levels exist, whether
// reasoning is configurable and visible, whether structured output is available, and how the
// prefix caches. That last one decides the cost model of this whole design.

export interface ModelCapabilities {
  provider: AiProviderId;
  label: string;
  /** Offered in Settings -> Advisor. Fixed-purpose jobs may use a model that isn't. */
  advisorSelectable: boolean;
  /**
   * Reasoning is configurable and its summary can be streamed. Anthropic spells this
   * `thinking: {type:'adaptive', display:'summarized'}`, OpenAI `reasoning: {effort, summary}`,
   * Gemini `thinkingConfig: {thinkingLevel, includeThoughts}`. False means send nothing.
   */
  reasoning: boolean;
  /**
   * Effort levels this model accepts, named in mizan's vocabulary. Empty means the request
   * must carry no effort at all, and the Settings dial must not render for this model.
   * This is per model, not per provider: Gemini's ladder has no `xhigh` or `max` rung, so
   * offering five would reproduce the exact defect Phase 6.0 removed for Haiku 4.5.
   */
  efforts: readonly AdvisorEffort[];
  /** Accepts a JSON-schema output contract. */
  structuredOutput: boolean;
  caching: CachingProfile;
  /** Input token limit, from the provider's own model page. */
  contextWindow: number;
  /** Output token cap, from the same page. */
  maxOutputTokens: number;
}

const FULL_EFFORT_LADDER: readonly AdvisorEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Gemini's dial is `thinkingLevel`, whose members are `minimal | low | medium | high`
 * (`Object.values(ThinkingLevel)` on the installed @google/genai 2.15.0). Three of those
 * four share a name with a mizan effort; `minimal` has no counterpart and is not offered,
 * and mizan's `xhigh`/`max` have no Gemini counterpart so they are not either. There is no
 * honest five-to-four mapping, so the table states the three that mean the same thing on
 * both sides and the Settings dial renders exactly those.
 */
const GEMINI_THINKING_LADDER: readonly AdvisorEffort[] = ['low', 'medium', 'high'];

// Cache-mechanism facts, each read from the provider's own documentation on 2026-07-31.
// The three profiles are not variations of one mechanism; see aiProviders/types.ts.

const ANTHROPIC_CACHE = (minimumPrefixTokens: number): CachingProfile => ({
  mechanism: 'anthropic_breakpoint',
  minimumPrefixTokens,
  ttl: '5 minutes',
  // platform.claude.com prompt-caching guide: writes 1.25x for the 5-minute TTL, reads ~0.1x.
  writeCostMultiplier: 1.25,
  readCostMultiplier: 0.1,
  hitReportedInUsage: true,
  note: `Caches the whole financial context behind one breakpoint. Nothing to manage, 5-minute lifetime, and the prefix must reach ${minimumPrefixTokens} tokens or it silently will not cache.`,
});

const OPENAI_EXPLICIT_CACHE: CachingProfile = {
  mechanism: 'openai_explicit',
  // developers.openai.com prompt-caching guide: "Caching is available for prefixes containing
  // at least 1,024 tokens. This is a strict minimum." on gpt-5.6 and later.
  minimumPrefixTokens: 1024,
  ttl: '30 minutes minimum',
  writeCostMultiplier: 1.25,
  readCostMultiplier: 0.1,
  hitReportedInUsage: true,
  note: 'Caches the whole financial context behind an explicit breakpoint with a stable cache key. 30-minute minimum lifetime, and cache writes cost 1.25x uncached input.',
};

const GEMINI_EXPLICIT_CACHE: CachingProfile = {
  mechanism: 'gemini_explicit_cache',
  // ai.google.dev/gemini-api/docs/generate-content/caching, fetched 2026-07-31: the minimum
  // input token count listed for Gemini 3.5 Flash and 3.1 Pro Preview is 4096.
  minimumPrefixTokens: 4096,
  // Same page: "If not set, the TTL defaults to 1 hour." This app sets it explicitly, and the
  // TTL is only the backstop: `streamChat` deletes the cache in its own `finally`.
  ttl: '10 minutes, or until the request ends',
  // The published pricing table lists input, output, cached input and a per-hour storage
  // rate, and no write multiplier. Recorded as 1 because that is what the table says; the
  // storage rate is the cost this mechanism has and the other two do not.
  writeCostMultiplier: 1,
  readCostMultiplier: 0.1,
  hitReportedInUsage: true,
  // Says what gemini.ts does, not what the mechanism could do. The cache is built inside
  // `streamChat`, lazily, on the first round that asks for a tool, and deleted in that same
  // request's `finally`. There is no per-conversation object and no reuse across requests.
  note: 'Caches the financial context and the tool list as a server-side object, but only inside a single question, and only once that question has asked for a tool. It is deleted when the question is answered, so nothing carries over to the next one, and a question answered in one round never creates a cache at all. Storage is billed per hour for as long as it lives, and if the prefix does not reach 4096 tokens the cache is refused and the prompt goes inline, uncached.',
};

export const MODEL_CAPABILITIES: Readonly<Record<string, ModelCapabilities>> = {
  // ── Anthropic ──
  'claude-opus-5': {
    provider: 'anthropic',
    label: 'Opus 5 (most capable)',
    advisorSelectable: true,
    reasoning: true,
    efforts: FULL_EFFORT_LADDER,
    structuredOutput: true,
    caching: ANTHROPIC_CACHE(512),
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
  },
  'claude-sonnet-5': {
    provider: 'anthropic',
    label: 'Sonnet 5 (balanced, default)',
    advisorSelectable: true,
    reasoning: true,
    efforts: FULL_EFFORT_LADDER,
    structuredOutput: true,
    caching: ANTHROPIC_CACHE(1024),
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
  },
  // Not advisor-selectable: it takes neither adaptive thinking nor an effort level, so
  // offering it would render an effort dial in Settings that silently does nothing. It is
  // still the right model for bulk classification, which is why it stays in this table.
  'claude-haiku-4-5': {
    provider: 'anthropic',
    label: 'Haiku 4.5 (fastest)',
    advisorSelectable: false,
    reasoning: false,
    efforts: [],
    structuredOutput: true,
    caching: ANTHROPIC_CACHE(4096),
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
  },

  // ── OpenAI ──
  // Context and output figures read from developers.openai.com/api/docs/models on 2026-07-31:
  // all three of the gpt-5.6 family list a 1.05M context window and a 128K max output.
  'gpt-5.6-sol': {
    provider: 'openai',
    label: 'GPT-5.6 Sol (most capable)',
    advisorSelectable: true,
    reasoning: true,
    efforts: FULL_EFFORT_LADDER,
    structuredOutput: true,
    caching: OPENAI_EXPLICIT_CACHE,
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
  },
  'gpt-5.6-terra': {
    provider: 'openai',
    label: 'GPT-5.6 Terra (balanced)',
    advisorSelectable: true,
    reasoning: true,
    efforts: FULL_EFFORT_LADDER,
    structuredOutput: true,
    caching: OPENAI_EXPLICIT_CACHE,
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
  },
  'gpt-5.6-luna': {
    provider: 'openai',
    label: 'GPT-5.6 Luna (fastest)',
    advisorSelectable: true,
    reasoning: true,
    efforts: FULL_EFFORT_LADDER,
    structuredOutput: true,
    caching: OPENAI_EXPLICIT_CACHE,
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
  },

  // ── Gemini ──
  // Context and output figures read from each model's own page on ai.google.dev, 2026-07-31:
  // 1,048,576 input and 65,536 output on both Flash models.
  //
  // The 2.5 family is deliberately absent. Its thinking dial is an integer `thinkingBudget`
  // rather than a level, which is the only reason `efforts` would need a third shape beyond
  // "a list" and "empty", and the 3.x line covers the same ground.
  'gemini-3.6-flash': {
    provider: 'gemini',
    label: 'Gemini 3.6 Flash (balanced)',
    advisorSelectable: true,
    reasoning: true,
    efforts: GEMINI_THINKING_LADDER,
    structuredOutput: true,
    caching: GEMINI_EXPLICIT_CACHE,
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
  },
  'gemini-3.5-flash': {
    provider: 'gemini',
    label: 'Gemini 3.5 Flash',
    advisorSelectable: true,
    reasoning: true,
    efforts: GEMINI_THINKING_LADDER,
    structuredOutput: true,
    caching: GEMINI_EXPLICIT_CACHE,
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
  },
  // Same reason Haiku 4.5 is not selectable, one provider over: it is the cheap classifier,
  // and its documented default thinking level is the one rung mizan's ladder does not name.
  'gemini-3.5-flash-lite': {
    provider: 'gemini',
    label: 'Gemini 3.5 Flash Lite (fastest)',
    advisorSelectable: false,
    reasoning: true,
    efforts: GEMINI_THINKING_LADDER,
    structuredOutput: true,
    caching: GEMINI_EXPLICIT_CACHE,
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
  },
};

export function providerOf(modelId: string): AiProviderId | null {
  return MODEL_CAPABILITIES[modelId]?.provider ?? null;
}

// Server-authoritative model whitelist, derived so it cannot drift from the capability
// table. The chat loop reads its model from a preference, so this list is the security
// boundary: a tampered client can't point the advisor at an arbitrary model string. That
// matters more now than it did: every provider's SDK widens its model type to `string`, so
// the type system stops nothing at any of the three call sites.
export const ADVISOR_MODELS: ReadonlyArray<{ id: string; label: string }> = Object.entries(
  MODEL_CAPABILITIES
)
  .filter(([, caps]) => caps.advisorSelectable)
  .map(([id, caps]) => ({ id, label: caps.label }));

export const DEFAULT_ADVISOR_MODEL = 'claude-sonnet-5';

export const ADVISOR_EFFORTS: AdvisorEffort[] = [...FULL_EFFORT_LADDER];
export const DEFAULT_ADVISOR_EFFORT: AdvisorEffort = 'medium';

/** The ladder a given model actually accepts. Empty means the dial must not render at all. */
export function effortsFor(modelId: string): readonly AdvisorEffort[] {
  return MODEL_CAPABILITIES[modelId]?.efforts ?? [];
}

/**
 * The stored effort, narrowed to what `modelId` accepts.
 *
 * Switching providers can leave a stored effort the new model has no rung for ('max' on a
 * Gemini model). Rather than send a level that 400s or, worse, one the provider quietly
 * ignores, this falls back to the model's own default: `medium` when it has one, otherwise
 * the middle of whatever ladder it does have.
 */
export function clampEffort(modelId: string, effort: AdvisorEffort): AdvisorEffort | undefined {
  const ladder = effortsFor(modelId);
  if (ladder.length === 0) return undefined;
  if (ladder.includes(effort)) return effort;
  return ladder.includes(DEFAULT_ADVISOR_EFFORT)
    ? DEFAULT_ADVISOR_EFFORT
    : ladder[Math.floor((ladder.length - 1) / 2)];
}

// ─── Per-job model assignment ────────────────────────────────────────────────
// Cost is not the constraint; matching the model to the shape of the job is. Sonnet 5 at
// medium effort is the baseline and Haiku 4.5 handles bulk classification and near-lookup
// work. Since Phase 10 the owner may point either job at a different provider entirely: a
// cheap classifier on one and a reasoning model on another is a reasonable thing to want,
// and nothing in the job framework cares which provider answered.

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

const JOB_MODEL_PREFERENCE_KEYS: Readonly<Record<AiJobName, string>> = {
  background_review: 'ai_job_model_background_review',
  bulk_categorization: 'ai_job_model_bulk_categorization',
};

/** Jobs that hand the model a JSON-schema contract; a model without one cannot serve them. */
const JOBS_REQUIRING_STRUCTURED_OUTPUT: ReadonlySet<AiJobName> = new Set(['background_review']);

export interface JobModelOption {
  id: string;
  label: string;
  provider: AiProviderId;
}

/**
 * Every model that could serve `job` ON CAPABILITY GROUNDS, derived from the same table rather
 * than listed twice. Deliberately says nothing about whether the provider has a key: that is a
 * fact about the machine, not about the model, and mixing the two into one list is what makes
 * a stored assignment silently revert when a key goes missing. See `jobAssignmentError`.
 */
export function modelsForJob(job: AiJobName): ReadonlyArray<JobModelOption> {
  return Object.entries(MODEL_CAPABILITIES)
    .filter(([, caps]) => !JOBS_REQUIRING_STRUCTURED_OUTPUT.has(job) || caps.structuredOutput)
    .map(([id, caps]) => ({ id, label: caps.label, provider: caps.provider }));
}

/**
 * Why `modelId` may not be ASSIGNED to `job` right now, or null when it may.
 *
 * Two questions, kept apart on purpose. Capability ("can this model serve this job at all") is
 * a fact about the table above and never changes. Reachability ("does its provider have a
 * credential") is a fact about this machine and can change under a stored assignment at any
 * time. A new assignment has to satisfy both.
 *
 * Refusing the save rather than allowing a visibly-broken one is the deliberate choice, and
 * the reason is that this failure has no visible state to be broken in. Point the ADVISOR at a
 * keyless provider and the next question you ask fails in front of you, which is why that
 * picker can get away with merely disabling the button. Point `background_review` at one and
 * `runAiJob` returns {status:'skipped', reason:'no_credentials'} BEFORE it writes the run row,
 * by design (an install with no key would otherwise accrue an hourly row saying so). The cost
 * of that design is that there is no ai_runs row, nothing in the digest, nothing on any screen,
 * and one console.log an hour. So the knob refuses the value instead of storing one that turns
 * the job off in silence.
 *
 * An assignment that goes STALE afterwards is not rewritten. `getJobModel` still returns the
 * owner's stored choice, because reverting it to a default that may be just as unreachable
 * would be a second invisible decision; `getAdvisorSettings` reports the stale state per job
 * instead, and Settings renders it.
 *
 * `isConfigured` is a parameter so this rule is testable without a keychain.
 */
export function jobAssignmentError(
  job: AiJobName,
  modelId: string,
  isConfigured: (provider: AiProviderId) => boolean
): string | null {
  const option = modelsForJob(job).find((m) => m.id === modelId);
  if (!option) return `model '${modelId}' cannot serve job '${job}'`;
  if (!isConfigured(option.provider)) {
    return `${option.label} needs a credential for ${option.provider}; without one, '${job}' would skip every run without recording it`;
  }
  return null;
}

/**
 * The model and effort a job runs at: the owner's override when it names a model this table
 * knows and that model can serve the job, otherwise the default in JOB_MODELS.
 *
 * Effort is re-derived from the chosen model rather than carried over, so an override to a
 * provider with a shorter ladder cannot ask for a rung that does not exist.
 */
export function getJobModel(db: Database.Database, job: AiJobName): JobModel {
  const fallback = JOB_MODELS[job];
  const stored = getPreference(db, JOB_MODEL_PREFERENCE_KEYS[job])?.value;
  const model =
    typeof stored === 'string' && modelsForJob(job).some((m) => m.id === stored)
      ? stored
      : fallback.model;
  const effort = clampEffort(model, fallback.effort ?? DEFAULT_ADVISOR_EFFORT);
  return effort ? { model, effort } : { model };
}

export function getAdvisorModel(db: Database.Database): string {
  const value = getPreference(db, ADVISOR_MODEL_PREFERENCE_KEY)?.value;
  return ADVISOR_MODELS.some((m) => m.id === value) ? (value as string) : DEFAULT_ADVISOR_MODEL;
}

export function getAdvisorEffort(db: Database.Database): AdvisorEffort {
  const value = getPreference(db, ADVISOR_EFFORT_PREFERENCE_KEY)?.value;
  return ADVISOR_EFFORTS.includes(value as AdvisorEffort) ? (value as AdvisorEffort) : DEFAULT_ADVISOR_EFFORT;
}

/**
 * Everything the Settings surface needs to render knobs that exist and omit ones that do not.
 *
 * `available.models` carries the per-model facts rather than ids alone, because the client
 * cannot import this module and a dial rendered from a provider-wide constant would be wrong
 * for at least one model of every provider here.
 */
export function getAdvisorSettings(db: Database.Database): AdvisorSettings {
  const model = getAdvisorModel(db);
  const storedEffort = getAdvisorEffort(db);
  return {
    model,
    effort: clampEffort(model, storedEffort) ?? storedEffort,
    available: {
      models: ADVISOR_MODELS.map(({ id }) => {
        const caps = MODEL_CAPABILITIES[id];
        return {
          id,
          label: caps.label,
          provider: caps.provider,
          configured: isProviderConfigured(caps.provider),
          reasoning: caps.reasoning,
          efforts: [...caps.efforts],
          context_window: caps.contextWindow,
          max_output_tokens: caps.maxOutputTokens,
          caching_note: caps.caching.note,
        };
      }),
      // Kept as the union of every ladder so a client that has not read the per-model list
      // still renders something valid; the per-model `efforts` above is what it should use.
      efforts: [...ADVISOR_EFFORTS],
      providers: (['anthropic', 'openai', 'gemini'] as const).map((provider) => ({
        id: provider,
        configured: isProviderConfigured(provider),
        credential_source: resolveCredential(provider).source,
      })),
    },
    // `configured` is carried per job AND per option. The per-option flag is what lets the
    // picker mark an unreachable model instead of offering it as if it worked; the per-job flag
    // is the only place a stored assignment whose key was removed afterwards becomes visible,
    // because the run it skips never reaches a row.
    jobs: (Object.keys(JOB_MODELS) as AiJobName[]).map((job) => {
      const assignment = getJobModel(db, job);
      const provider = MODEL_CAPABILITIES[assignment.model].provider;
      return {
        job,
        model: assignment.model,
        effort: assignment.effort ?? null,
        provider,
        configured: isProviderConfigured(provider),
        available: modelsForJob(job).map((m) => ({ ...m, configured: isProviderConfigured(m.provider) })),
      };
    }),
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

  // An effort is checked against the model it will actually run under, which is the incoming
  // one when the same update changes both. Accepting a rung the chosen model has no name for
  // would store a dial position that silently does nothing.
  const targetModel = typeof body.model === 'string' ? body.model : getAdvisorModel(db);
  if (body.effort !== undefined) {
    const ladder = effortsFor(targetModel);
    if (!ladder.includes(body.effort as AdvisorEffort)) {
      return {
        ok: false,
        error: ladder.length === 0
          ? `${targetModel} takes no reasoning effort level`
          : `${targetModel} accepts effort: ${ladder.join(', ')}`,
      };
    }
  }

  if (body.jobs !== undefined) {
    if (typeof body.jobs !== 'object' || body.jobs === null) {
      return { ok: false, error: 'jobs must be an object of job -> model id' };
    }
    for (const [job, modelId] of Object.entries(body.jobs as Record<string, unknown>)) {
      if (!(job in JOB_MODELS)) return { ok: false, error: `unknown job '${job}'` };
      if (typeof modelId !== 'string') return { ok: false, error: `job '${job}' needs a model id` };
      // Capability AND reachability, because a job pointed at a keyless provider turns itself
      // off without leaving a run row to notice. See jobAssignmentError.
      const problem = jobAssignmentError(job as AiJobName, modelId, isProviderConfigured);
      if (problem) return { ok: false, error: problem };
    }
  }

  if (body.model !== undefined) setPreference(db, ADVISOR_MODEL_PREFERENCE_KEY, body.model);
  if (body.effort !== undefined) setPreference(db, ADVISOR_EFFORT_PREFERENCE_KEY, body.effort);
  if (body.jobs !== undefined) {
    for (const [job, modelId] of Object.entries(body.jobs as Record<string, string>)) {
      setPreference(db, JOB_MODEL_PREFERENCE_KEYS[job as AiJobName], modelId);
    }
  }

  return { ok: true, settings: getAdvisorSettings(db) };
}
