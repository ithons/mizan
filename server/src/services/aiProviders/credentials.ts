import fs from 'fs';
import os from 'os';
import path from 'path';
import { getStoredAiKey, removeAiKey, updateAiKey } from '../credentials';
import type { AiProviderId } from './types';

/**
 * Where each provider's credential comes from, resolved in one place.
 *
 * Precedence is `.env` then the encrypted store, matching the Coinbase precedent in
 * `getCredentials()`. Anthropic has a third source the other two do not have at all: an
 * `ant auth login` profile on disk, which the SDK resolves for itself. That is why
 * `CredentialSource` has an `oauth_profile` member that only ever applies to Anthropic.
 *
 * `apiKey` carries a literal key whenever this module knows one, which is the stored case
 * always and the environment case only when the variable genuinely holds an API key.
 * `ANTHROPIC_AUTH_TOKEN` deliberately does not qualify: it is a bearer token, and handing it
 * to the SDK as `apiKey` would send the wrong header.
 *
 * Whether an adapter USES that key differs by SDK, and the difference is measured, not
 * assumed. `@anthropic-ai/sdk` and `openai` both resolve their own environment variables, so
 * those adapters construct bare when the source is `env` rather than re-implement (and
 * eventually mis-order) that resolution.
 *
 * `@google/genai` is the one that always gets the key passed explicitly, and NOT because it
 * cannot read the environment. Measured against the installed 2.15.0, both `dist/node/index.cjs`
 * and `dist/node/index.mjs` carry a `getEnv` helper over `process.env`, called with
 * GOOGLE_API_KEY, GEMINI_API_KEY, GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION,
 * GOOGLE_GENAI_USE_ENTERPRISE, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_VERTEX_BASE_URL and
 * GOOGLE_GEMINI_BASE_URL, and the constructor does `this.apiKey = options.apiKey ?? envApiKey`.
 * It resolves plenty; it resolves it DIFFERENTLY. `getApiKeyFromEnv` prefers GOOGLE_API_KEY
 * over GEMINI_API_KEY and warns when both are set, where `envCredential` below prefers
 * GEMINI_API_KEY. Passing the key explicitly is what makes this app's stated precedence the
 * one that applies, on the env source as much as the stored one.
 */

export type CredentialSource = 'env' | 'oauth_profile' | 'stored' | 'none';

export interface ResolvedCredential {
  source: CredentialSource;
  /** Never logged, never returned over the wire. Absent for an OAuth profile or a bearer token. */
  apiKey?: string;
}

function anthropicConfigDir(): string {
  return process.env.ANTHROPIC_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'anthropic');
}

/** True when an `ant auth login` profile exists on disk. */
function hasAnthropicOAuthProfile(): boolean {
  try {
    const credentials = path.join(anthropicConfigDir(), 'credentials');
    return fs.existsSync(credentials) && fs.readdirSync(credentials).some((f) => f.endsWith('.json'));
  } catch {
    return false; // An unreadable config dir means "no profile", never a crash.
  }
}

/** An environment credential, and whether it is an API key or a bearer token. */
function envCredential(provider: AiProviderId): ResolvedCredential | null {
  if (provider === 'anthropic') {
    if (process.env.ANTHROPIC_API_KEY) return { source: 'env', apiKey: process.env.ANTHROPIC_API_KEY };
    if (process.env.ANTHROPIC_AUTH_TOKEN) return { source: 'env' };
    return null;
  }
  if (provider === 'openai') {
    return process.env.OPENAI_API_KEY ? { source: 'env', apiKey: process.env.OPENAI_API_KEY } : null;
  }
  const gemini = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  return gemini ? { source: 'env', apiKey: gemini } : null;
}

export function resolveCredential(provider: AiProviderId): ResolvedCredential {
  const fromEnv = envCredential(provider);
  if (fromEnv) return fromEnv;
  if (provider === 'anthropic' && (process.env.ANTHROPIC_PROFILE || hasAnthropicOAuthProfile())) {
    return { source: 'oauth_profile' };
  }
  const stored = getStoredAiKey(provider);
  return stored ? { source: 'stored', apiKey: stored } : { source: 'none' };
}

export function isProviderConfigured(provider: AiProviderId): boolean {
  return resolveCredential(provider).source !== 'none';
}

export function setProviderKey(provider: AiProviderId, apiKey: string): void {
  updateAiKey(provider, apiKey);
}

export function clearProviderKey(provider: AiProviderId): void {
  removeAiKey(provider);
}
