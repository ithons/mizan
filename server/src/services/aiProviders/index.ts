import { MODEL_CAPABILITIES } from '../advisorSettings';
import { anthropicProvider } from './anthropic';
import { geminiProvider } from './gemini';
import { openaiProvider } from './openai';
import { isProviderConfigured, resolveCredential } from './credentials';
import type { AdvisorProviderStatus } from '../../../../shared/types';
import { AI_PROVIDER_IDS, type AiProvider, type AiProviderId } from './types';

const PROVIDERS: Readonly<Record<AiProviderId, AiProvider>> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  gemini: geminiProvider,
};

export function getProvider(id: AiProviderId): AiProvider {
  return PROVIDERS[id];
}

/**
 * The provider that owns `modelId`.
 *
 * Throws rather than guessing. Every SDK here widens its model parameter to `string`, so a
 * model the capability table does not know would otherwise reach a provider that cannot
 * serve it and fail as an opaque 404 mid-stream. The table is the whitelist.
 */
export function providerForModel(modelId: string): AiProvider {
  const caps = MODEL_CAPABILITIES[modelId];
  if (!caps) throw new Error(`No provider is configured for model '${modelId}'.`);
  return PROVIDERS[caps.provider];
}

/**
 * Per-provider credential status, for the settings surface. Never returns a secret.
 * Typed as the shared interface because the client reads these responses as it; an inline
 * shape here once sent `source` where the client reads `credential_source`.
 */
export function providerStatuses(): AdvisorProviderStatus[] {
  return AI_PROVIDER_IDS.map((id) => ({
    id,
    configured: isProviderConfigured(id),
    credential_source: resolveCredential(id).source,
  }));
}

export { isProviderConfigured } from './credentials';
export * from './types';
