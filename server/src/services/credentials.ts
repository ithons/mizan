import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Entry } from '@napi-rs/keyring';
import { MIZAN_DIR } from '../db/index';

const CREDENTIALS_PATH = path.join(MIZAN_DIR, 'credentials.json');
const KEY_PATH = path.join(MIZAN_DIR, 'mizan.key');

interface EncryptedFile {
  iv: string;
  authTag: string;
  ciphertext: string;
}

export interface CoinbaseCredentials {
  keyName: string;
  privateKey: string;
}

/**
 * API keys for the LLM providers, keyed by `AiProviderId`.
 *
 * Deliberately the same file and the same AES-256-GCM envelope as the bank credentials: a
 * provider key is a secret of exactly the same class, and a second store would be a second
 * thing to get wrong. `.env` still wins, matching the Coinbase precedent (`getCredentials`).
 */
export interface AiProviderKeys {
  anthropic?: string;
  openai?: string;
  gemini?: string;
}

export interface CredentialsStore {
  coinbase?: CoinbaseCredentials;
  simplefin?: { setupToken?: string; accessUrl?: string };
  ai?: AiProviderKeys;
}

let _key: Buffer | null = null;
let _cache: CredentialsStore | null = null;

/**
 * Non-null when `credentials.json` EXISTS but could not be decrypted. Distinct from an empty store.
 *
 * "No credentials file" and "credentials file I cannot read" were the same answer, `{}`, and that
 * one conflation is worth spelling out because it is silent in both directions.
 *
 * Reading: `runFullSync` gates each provider on `if (creds.simplefin?.accessUrl)`. An unreadable
 * file skipped both providers, wrote no `sync_run_items` at all, and finished the run `succeeded`
 * with "Sync complete", so the client toasted success in green and `last_run.incomplete` stayed
 * false, which is what keeps the balance beam calibrated. Every hour, on a sheet no provider had
 * refreshed.
 *
 * Writing: this is the destructive half. Every mutator is load, mutate, save. Loading returned
 * `{}`, so saving wrote a file containing ONLY the field being set. An owner who reacted to
 * "SimpleFIN not connected" by re-linking would have destroyed their Coinbase key and every stored
 * AI provider key, encrypted under the new value, with nothing said.
 */
let _unreadable: string | null = null;

/** The decrypt error when the credentials file exists but cannot be read, else null. */
export function credentialsUnreadable(): string | null {
  return _unreadable;
}

/** Drop the module cache. Tests only: the cache and the unreadable flag both live for the process. */
export function _resetCredentialsCacheForTesting(): void {
  _cache = null;
  _unreadable = null;
}

function getDerivedKey(): Buffer {
  if (_key) return _key;

  const service = 'mizan';
  const account = 'encryption_key';
  
  let entry: Entry | null = null;
  try {
    entry = new Entry(service, account);
    const hexKey = entry.getPassword();
    if (hexKey && hexKey.length === 64) {
      _key = Buffer.from(hexKey, 'hex');
      return _key;
    }
  } catch (err) {
    // If not found or keychain inaccessible, proceed to fallback/generation
  }

  // Fallback to legacy file if it exists, to migrate gracefully
  if (fs.existsSync(KEY_PATH)) {
    console.log('[credentials] Migrating encryption key to native keychain...');
    _key = fs.readFileSync(KEY_PATH);
    const hexKey = _key.toString('hex');
    
    if (entry) {
      try {
        entry.setPassword(hexKey);
        
        // Verify write before deleting the fallback
        const readBack = entry.getPassword();
        if (readBack === hexKey) {
          fs.unlinkSync(KEY_PATH);
          console.log('[credentials] Migration successful, removed legacy key file.');
        } else {
          console.warn('[credentials] Keychain verification failed. Legacy key file retained.');
        }
        return _key;
      } catch (err) {
        console.error('[credentials] Failed to migrate key to keychain:', (err as Error).message);
        return _key;
      }
    }
    return _key;
  }

  // Generate new key
  _key = crypto.randomBytes(32);
  if (entry) {
    try {
      entry.setPassword(_key.toString('hex'));
    } catch (err) {
      console.error('[credentials] Failed to store key in keychain, falling back to file:', (err as Error).message);
      fs.writeFileSync(KEY_PATH, _key, { mode: 0o600 });
    }
  } else {
    fs.writeFileSync(KEY_PATH, _key, { mode: 0o600 });
  }

  return _key;
}

function encrypt(plaintext: string): EncryptedFile {
  const key = getDerivedKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf-8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
}

function decrypt(enc: EncryptedFile): string {
  const key = getDerivedKey();
  const iv = Buffer.from(enc.iv, 'hex');
  const authTag = Buffer.from(enc.authTag, 'hex');
  const ciphertext = Buffer.from(enc.ciphertext, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
}

/**
 * Total by design: read paths ask this only to decide whether a provider is configured, and a
 * throw here would take the whole app down over a locked keychain. The fault is recorded in
 * `_unreadable` instead, where `credentialsUnreadable()` exposes it to startup, to the sync run,
 * and to the write guard below.
 */
export function loadCredentials(): CredentialsStore {
  if (_cache) return _cache;
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    _unreadable = null;
    _cache = {};
    return _cache;
  }
  try {
    const enc: EncryptedFile = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
    _cache = JSON.parse(decrypt(enc)) as CredentialsStore;
    _unreadable = null;
    return _cache;
  } catch (err) {
    _unreadable = (err as Error).message;
    console.error(
      `[credentials] ${CREDENTIALS_PATH} exists but could not be decrypted: ${_unreadable}. ` +
        'Every provider will be treated as not configured until this is resolved, and credential ' +
        'writes are refused so the stored keys are not replaced by whichever one you set next.'
    );
    _cache = {};
    return _cache;
  }
}

/**
 * Refuse to write over a file we could not read.
 *
 * Every mutator is load, mutate, save, so a save while `_unreadable` is set replaces the whole
 * store with the single field being written. Failing loudly is the only option that keeps the
 * other secrets: they are still in the file, and the file is still the only copy.
 */
function assertCredentialsWritable(): void {
  if (_unreadable === null) return;
  throw new Error(
    `Refusing to write ${CREDENTIALS_PATH}: it exists but could not be decrypted (${_unreadable}). ` +
      'Writing now would replace every stored credential with only the one being set. Unlock the OS ' +
      'keychain, or restore the .mizan directory this key belongs to, or move the file aside to start over.'
  );
}

export function saveCredentials(store: CredentialsStore): void {
  assertCredentialsWritable();
  _cache = store;
  const enc = encrypt(JSON.stringify(store));
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(enc), { mode: 0o600 });
}

export function getEnvCredentials(): Partial<CredentialsStore> {
  const result: Partial<CredentialsStore> = {};
  if (process.env.COINBASE_KEY_NAME && process.env.COINBASE_PRIVATE_KEY) {
    result.coinbase = {
      keyName: process.env.COINBASE_KEY_NAME,
      privateKey: process.env.COINBASE_PRIVATE_KEY,
    };
  }
  return result;
}

export function getCredentials(): CredentialsStore {
  const stored = loadCredentials();
  const env = getEnvCredentials();
  return { ...stored, ...env };
}

export function updateCoinbaseCredentials(coinbase: CoinbaseCredentials): void {
  const store = loadCredentials();
  store.coinbase = coinbase;
  saveCredentials(store);
}

export function updateSimplefin(accessUrl: string): void {
  const store = loadCredentials();
  store.simplefin = { ...store.simplefin, accessUrl };
  saveCredentials(store);
}

export function removeSimplefin(): void {
  const store = loadCredentials();
  if (store.simplefin) {
    delete store.simplefin.accessUrl;
    delete store.simplefin.setupToken;
    saveCredentials(store);
  }
}

export function removeCoinbaseCredentials(): void {
  const store = loadCredentials();
  delete store.coinbase;
  saveCredentials(store);
}

/** The stored key for one provider, or undefined. Never reads `.env`; see aiProviders/credentials.ts. */
export function getStoredAiKey(provider: keyof AiProviderKeys): string | undefined {
  const key = loadCredentials().ai?.[provider];
  return key && key.trim() ? key : undefined;
}

export function updateAiKey(provider: keyof AiProviderKeys, apiKey: string): void {
  const store = loadCredentials();
  store.ai = { ...store.ai, [provider]: apiKey };
  saveCredentials(store);
}

export function removeAiKey(provider: keyof AiProviderKeys): void {
  const store = loadCredentials();
  if (!store.ai) return;
  delete store.ai[provider];
  saveCredentials(store);
}

