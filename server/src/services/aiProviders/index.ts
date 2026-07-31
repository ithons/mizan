import { MODEL_CAPABILITIES } from '../advisorSettings';
import { anthropicProvider } from './anthropic';
import { geminiProvider } from './gemini';
import { openaiProvider } from './openai';
import { isProviderConfigured, resolveCredential } from './credentials';
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

/** Per-provider credential status, for the settings surface. Never returns a secret. */
export function providerStatuses(): Array<{
  id: AiProviderId;
  configured: boolean;
  source: ReturnType<typeof resolveCredential>['source'];
}> {
  return AI_PROVIDER_IDS.map((id) => ({
    id,
    configured: isProviderConfigured(id),
    source: resolveCredential(id).source,
  }));
}

export { isProviderConfigured } from './credentials';
export * from './types';
