import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedTestDb } from './helpers/schema';
import {
  getAdvisorSettings,
  updateAdvisorSettings,
  jobAssignmentError,
  modelsForJob,
  DEFAULT_ADVISOR_MODEL,
  DEFAULT_ADVISOR_EFFORT,
} from '../server/src/services/advisorSettings';
import type { AiProviderId } from '../server/src/services/aiProviders/types';

// The per-section context allowlist is gone. It existed to limit how much of the financial
// snapshot reached the model, and it defaulted to sending a subset, so its only effect was a
// worse answer. The snapshot is always complete now; model and effort remain configurable.

const freshDb = migratedTestDb;

test('defaults when nothing is stored', () => {
  const db = freshDb();
  const s = getAdvisorSettings(db);
  assert.equal(s.model, DEFAULT_ADVISOR_MODEL);
  assert.equal(s.effort, DEFAULT_ADVISOR_EFFORT);
});

test('valid updates persist and round-trip', () => {
  const db = freshDb();
  const r = updateAdvisorSettings(db, { model: 'claude-opus-5', effort: 'xhigh' });
  assert.ok(r.ok);
  const s = getAdvisorSettings(db);
  assert.equal(s.model, 'claude-opus-5');
  assert.equal(s.effort, 'xhigh');
});

test('REJECTS an off-whitelist model (the security boundary) and does not persist', () => {
  const db = freshDb();
  const r = updateAdvisorSettings(db, { model: 'gpt-4o' });
  assert.equal(r.ok, false);
  assert.ok(r.error);
  assert.equal(getAdvisorSettings(db).model, DEFAULT_ADVISOR_MODEL);
});

// This asserted 'max' was rejected, which only ever tested that the validator worked.
// 'max' is a real effort level, and the ladder now runs to it. The validator is still the
// thing under test; the value that exercises it just has to be one no model accepts.
test('REJECTS an invalid effort', () => {
  const db = freshDb();
  assert.equal(updateAdvisorSettings(db, { effort: 'maximum' }).ok, false);
  assert.equal(getAdvisorSettings(db).effort, DEFAULT_ADVISOR_EFFORT);
});

test('the whole effort ladder is accepted', () => {
  const db = freshDb();
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
    assert.equal(updateAdvisorSettings(db, { effort }).ok, true, `${effort} should be accepted`);
    assert.equal(getAdvisorSettings(db).effort, effort);
  }
});

// ─── Per-job model assignment ────────────────────────────────────────────────
// The defect these cover: the job picker offered models whose provider had no key, and saving
// one succeeded. Every hourly pass then returned {status:'skipped', reason:'no_credentials'}
// BEFORE the run row was written, so there was no ai_runs row, nothing in the digest and
// nothing on any screen. The AI was off and the only trace was a console.log.
//
// `jobAssignmentError` takes the configuration probe as a parameter precisely so this can be
// asserted without a keychain, an env var, or a `.mizan/credentials.json` on the machine.

const ALL_CONFIGURED = () => true;
const NONE_CONFIGURED = () => false;
const ONLY: (provider: AiProviderId) => (p: AiProviderId) => boolean = (provider) => (p) => p === provider;

test('a job may not be assigned a model whose provider has no credential', () => {
  const openaiModel = modelsForJob('background_review').find((m) => m.provider === 'openai');
  assert.ok(openaiModel, 'the capability table no longer offers an OpenAI model for this job');

  const refused = jobAssignmentError('background_review', openaiModel.id, ONLY('anthropic'));
  assert.ok(refused, 'an OpenAI model was accepted with no OpenAI credential');
  assert.match(refused, /credential for openai/, 'the refusal must name the provider missing a key');

  assert.equal(jobAssignmentError('background_review', openaiModel.id, ALL_CONFIGURED), null);
});

test('capability and reachability are separate refusals, and both are stated', () => {
  // The two checks answer different questions and neither substitutes for the other: an
  // unknown model is refused even with every key present, and a known one is refused without.
  assert.match(
    jobAssignmentError('background_review', 'gpt-4o', ALL_CONFIGURED) ?? '',
    /cannot serve job/
  );
  assert.match(
    jobAssignmentError('background_review', 'claude-sonnet-5', NONE_CONFIGURED) ?? '',
    /credential for anthropic/
  );
});

test('modelsForJob answers capability only, so a missing key cannot rewrite a stored choice', () => {
  // If configuration were filtered in here, `getJobModel` would silently revert the owner's
  // assignment the moment a key went missing, which is a second invisible decision on top of
  // the one this whole area exists to remove.
  const forReview = modelsForJob('background_review');
  assert.ok(forReview.length > 0);
  for (const option of forReview) {
    assert.ok(option.provider, `${option.id} carries no provider`);
    assert.ok(!('configured' in option), `${option.id} leaked a configuration flag into a capability list`);
  }
});

test('the settings payload carries the configured flag the job picker renders from', () => {
  // Env keys beat the encrypted store in `resolveCredential`, so setting all three makes the
  // "configured" side of this hermetic on any machine.
  const saved = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  };
  process.env.ANTHROPIC_API_KEY = 'test-key-never-used';
  process.env.OPENAI_API_KEY = 'test-key-never-used';
  process.env.GEMINI_API_KEY = 'test-key-never-used';
  try {
    const db = freshDb();
    const settings = getAdvisorSettings(db);
    assert.ok(settings.jobs.length > 0);
    for (const job of settings.jobs) {
      assert.equal(job.configured, true, `${job.job} reports unreachable with every key set`);
      assert.ok(job.provider, `${job.job} states no provider`);
      assert.ok(job.available.length > 0, `${job.job} offers no models`);
      for (const option of job.available) {
        assert.equal(option.configured, true, `${option.id} reports unreachable with every key set`);
      }
    }

    // And a cross-provider assignment round-trips, which is the feature the flag protects
    // rather than removes.
    const gemini = settings.jobs
      .find((j) => j.job === 'bulk_categorization')
      ?.available.find((m) => m.provider === 'gemini');
    assert.ok(gemini, 'no Gemini model is offered for bulk categorization');
    assert.equal(updateAdvisorSettings(db, { jobs: { bulk_categorization: gemini.id } }).ok, true);
    assert.equal(
      getAdvisorSettings(db).jobs.find((j) => j.job === 'bulk_categorization')?.model,
      gemini.id
    );
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('a job update rejects an unknown job and a non-string model id', () => {
  const db = freshDb();
  assert.equal(updateAdvisorSettings(db, { jobs: { not_a_job: 'claude-sonnet-5' } }).ok, false);
  assert.equal(updateAdvisorSettings(db, { jobs: { background_review: 42 } }).ok, false);
  assert.equal(updateAdvisorSettings(db, { jobs: { background_review: '' } }).ok, false);
});
