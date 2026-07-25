import fs from 'fs';
import os from 'os';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';

/**
 * Single place the app decides whether it can talk to Anthropic, and how.
 *
 * Every AI path used to hardcode `new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })`, which
 * silently disabled the advisor, the background worker, and category suggestions for anyone
 * authenticating any other way — the key is only ONE of the credentials the SDK understands.
 *
 * The SDK resolves credentials itself, first match wins:
 *   1. ANTHROPIC_API_KEY
 *   2. ANTHROPIC_AUTH_TOKEN        (e.g. a short-lived OAuth access token)
 *   3. an OAuth profile from `ant auth login`, stored under the Anthropic config dir
 *
 * So the client is constructed bare and the SDK picks whichever is present. This function's only
 * job is to answer "is there anything to authenticate with?" without throwing.
 */

function configDir(): string {
  return process.env.ANTHROPIC_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'anthropic');
}

/** True when an `ant auth login` profile exists on disk. */
function hasOAuthProfile(): boolean {
  try {
    const credentials = path.join(configDir(), 'credentials');
    return fs.existsSync(credentials) && fs.readdirSync(credentials).some((f) => f.endsWith('.json'));
  } catch {
    return false; // An unreadable config dir means "no profile", never a crash.
  }
}

export function hasAnthropicCredentials(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    process.env.ANTHROPIC_PROFILE ||
    hasOAuthProfile()
  );
}

/** Describes the credential in use, for settings/status surfaces. Never returns the secret. */
export function anthropicCredentialSource(): 'api_key' | 'auth_token' | 'oauth_profile' | 'none' {
  if (process.env.ANTHROPIC_API_KEY) return 'api_key';
  if (process.env.ANTHROPIC_AUTH_TOKEN) return 'auth_token';
  if (process.env.ANTHROPIC_PROFILE || hasOAuthProfile()) return 'oauth_profile';
  return 'none';
}

/** A client, or null when nothing is configured. Callers must handle null rather than throwing. */
export function getAnthropicClient(): Anthropic | null {
  if (!hasAnthropicCredentials()) return null;
  // Bare constructor on purpose: the SDK applies the resolution order documented above.
  return new Anthropic();
}
