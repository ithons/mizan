/**
 * The provider-key inputs are the only in-app way to give the advisor a key, so they must be
 * reachable exactly when no key is configured, and the Advisor row must judge the key for the
 * provider the selected model actually calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AdvisorModelOption, AdvisorProviderStatus, AdvisorSettings, AiProviderId } from '../shared/types';
import { AdvisorModelPanel, advisorKeyLine } from '../client/src/views/settings/Settings';

function model(id: string, label: string, provider: AiProviderId, configured: boolean): AdvisorModelOption {
  return {
    id,
    label,
    provider,
    configured,
    reasoning: true,
    efforts: ['low', 'medium', 'high'],
    context_window: 200_000,
    max_output_tokens: 32_000,
    caching_note: '',
  };
}

function settingsWith(selected: string, providers: AdvisorProviderStatus[]): AdvisorSettings {
  const configured = (p: AiProviderId) => providers.find((s) => s.id === p)?.configured ?? false;
  return {
    model: selected,
    effort: 'medium',
    available: {
      models: [
        model('claude-x', 'Claude X', 'anthropic', configured('anthropic')),
        model('gpt-x', 'GPT X', 'openai', configured('openai')),
      ],
      efforts: ['low', 'medium', 'high'],
      providers,
    },
    jobs: [],
  };
}

const NO_KEYS: AdvisorProviderStatus[] = [
  { id: 'anthropic', configured: false, credential_source: 'none' },
  { id: 'openai', configured: false, credential_source: 'none' },
];

function renderPanel(settings: AdvisorSettings): string {
  const client = new QueryClient();
  client.setQueryData(['ai-settings'], settings);
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(AdvisorModelPanel, { open: true, onToggle: () => undefined })
    )
  );
}

test('with no key at all, the open panel offers a key input for every provider', () => {
  const markup = renderPanel(settingsWith('claude-x', NO_KEYS));
  assert.equal(markup.match(/placeholder="Paste an API key"/g)?.length, 2);
});

test('Settings renders the Model & effort panel whether or not a key is configured', () => {
  const src = readFileSync(join(__dirname, '..', 'client/src/views/settings/Settings.tsx'), 'utf8');
  const render = src.match(/^\s*(.*)<AdvisorModelPanel open=/m);
  assert.ok(render, 'Settings no longer renders AdvisorModelPanel');
  assert.doesNotMatch(src, /configured\s*&&\s*\(\s*<AdvisorModelPanel/);
  assert.doesNotMatch(src, /title="Anthropic API key"/);
});

test('the Advisor row names the selected model provider when only another provider has a key', () => {
  const line = advisorKeyLine(
    settingsWith('claude-x', [
      { id: 'anthropic', configured: false, credential_source: 'none' },
      { id: 'openai', configured: true, credential_source: 'stored' },
    ])
  );
  assert.match(line, /^No Anthropic key for Claude X/);
});

test('HEALTHY: a keyed non-Anthropic advisor reads as configured and names its own provider', () => {
  const line = advisorKeyLine(
    settingsWith('gpt-x', [
      { id: 'anthropic', configured: false, credential_source: 'none' },
      { id: 'openai', configured: true, credential_source: 'stored' },
    ])
  );
  assert.doesNotMatch(line, /\bNo\b/);
  assert.doesNotMatch(line, /Anthropic/);
  assert.match(line, /OpenAI key stored, encrypted/);
});
